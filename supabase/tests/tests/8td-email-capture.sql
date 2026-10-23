-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ LOCAL TEST HARNESS ONLY (./supabase/tests/run.sh, psql). NOT a migration —
--   never paste into Supabase Studio: it creates throwaway auth users.
--   The migration it covers is supabase-migration-email-capture.sql.
-- ════════════════════════════════════════════════════════════════════════════
-- 8td · Email capture — a private forwarding address per user, candidates
--       written only by the inbound-email function, offers in the reader's
--       language, nothing a client can forge or read across users.
--
-- Claims:
--   (a) catalog: tables, trigger, cron job; the service-role entry point and
--       the token helper are closed to clients; the two address RPCs are open;
--   (b) an address is created once and is stable; rotating replaces it;
--   (c) a client cannot insert or delete candidates, nor read another user's;
--   (d) the entry point queues a candidate + one notification with the
--       deep-link href, in the reader's language, channelled as money;
--   (e) unknown / rotated token, deleted profile, empty text → nothing queued;
--   (f) the owner may change status only; the stored text is immutable;
--   (g) the flood cap stops the 61st email in a day;
--   (h) prune removes resolved rows after 7 days and stale pending after 30.
--
-- Fresh users (5f000000-…-21 forwarder F, -22 other O, -23 deleted D).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8td-email-capture');

\set uF '5f000000-0000-4000-8000-000000000021'
\set uO '5f000000-0000-4000-8000-000000000022'
\set uD '5f000000-0000-4000-8000-000000000023'

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  (:'uF', 'capture-forwarder@hisaab.test'),
  (:'uO', 'capture-other@hisaab.test'),
  (:'uD', 'capture-deleted@hisaab.test')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET name = 'Forwarder', lang = 'en' WHERE id = :'uF';
UPDATE profiles SET name = 'Other',     lang = 'ur' WHERE id = :'uO';
UPDATE profiles SET name = 'Deleted',   is_deleted = TRUE WHERE id = :'uD';

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  to_regclass('public.capture_addresses') IS NOT NULL
  AND to_regclass('public.capture_candidates') IS NOT NULL
  AND to_regclass('public.capture_config') IS NOT NULL,
  'the three capture tables exist');

SELECT test.assert(
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'public.capture_candidates'::regclass
      AND tgname = 'capture_candidates_guard' AND NOT tgisinternal) = 1,
  'the status-only guard trigger exists');

SELECT test.assert(
  NOT has_function_privilege('authenticated', 'public._capture_candidate_received(text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public._capture_candidate_received(text, text, text, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public._capture_candidate_received(text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._capture_new_token()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.prune_capture_candidates()', 'EXECUTE'),
  'the entry point is service_role only; the helper and the prune are closed to clients');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.get_or_create_capture_address()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.rotate_capture_address()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.get_or_create_capture_address()', 'EXECUTE'),
  'the two address RPCs are authenticated-only');

SELECT test.assert(
  (SELECT value FROM public.capture_config WHERE key = 'inbound_domain') IS NOT NULL,
  'capture_config carries the inbound domain');

-- The harness has no pg_cron; the migration schedules the job only when the
-- extension exists (and says so). Assert the function the job calls instead.
SELECT test.assert(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'prune_capture_candidates') = 1,
  'the prune function the nightly job calls exists');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) ADDRESS — created once, stable, rotatable
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uF');

SELECT test.assert(
  (SELECT public.get_or_create_capture_address()) ~ '^[a-f0-9]{12}$',
  'F gets a 12-hex token');
SELECT test.assert(
  (SELECT public.get_or_create_capture_address()) = (SELECT token FROM public.capture_addresses WHERE user_id = :'uF'),
  'calling again returns the same token');

SELECT test.assert(
  (SELECT value FROM public.capture_config WHERE key = 'inbound_domain') IS NOT NULL,
  'a signed-in user can read the inbound domain');

SELECT test.assert_raises(format(
  $q$ INSERT INTO public.capture_addresses (user_id, token) VALUES (%L, 'aaaaaaaaaaaa') $q$, :'uF'),
  'row-level security',
  'a client cannot write capture_addresses directly');

-- Remember the first token, then rotate.
RESET ROLE;
SELECT token AS first_token FROM public.capture_addresses WHERE user_id = :'uF' \gset
SET ROLE authenticated;
SELECT test.as_user(:'uF');
SELECT test.assert(
  (SELECT public.rotate_capture_address()) <> :'first_token',
  'rotate hands out a different token');
SELECT test.assert(
  (SELECT rotated_at FROM public.capture_addresses WHERE user_id = :'uF') IS NOT NULL,
  'rotation is stamped');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) CLIENTS cannot insert / delete candidates, nor see each other's
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises(format(
  $q$ INSERT INTO public.capture_candidates (user_id, raw_text) VALUES (%L, 'AED 10 at X') $q$, :'uF'),
  'row-level security',
  'a client cannot insert a candidate for themselves');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) THE ENTRY POINT queues one candidate + one notification (service role)
-- ════════════════════════════════════════════════════════════════════════════
-- The harness's service_role has no BYPASSRLS, so read the live token as the
-- superuser first; production's edge function gets it from the mail itself.
RESET ROLE;
SELECT token AS live_token FROM public.capture_addresses WHERE user_id = :'uF' \gset
SET ROLE service_role;
SELECT test.assert(
  (SELECT public._capture_candidate_received(
     :'live_token',
     'Alerts <alerts@emiratesnbd.com>', 'Card transaction alert',
     'Purchase of AED 120.50 at CARREFOUR with card ending 4599.')) IS NOT NULL,
  'a mail to the live token queues a candidate');
RESET ROLE;

SELECT test.assert(
  (SELECT count(*) FROM public.capture_candidates WHERE user_id = :'uF' AND status = 'pending') = 1,
  'exactly one pending candidate for F');
SELECT test.assert(
  (SELECT from_address FROM public.capture_candidates WHERE user_id = :'uF') = 'Alerts <alerts@emiratesnbd.com>'
  AND (SELECT subject FROM public.capture_candidates WHERE user_id = :'uF') = 'Card transaction alert',
  'sender and subject are stored as given');

SELECT test.assert(
  (SELECT count(*) FROM public.notifications
    WHERE user_id = :'uF' AND type = 'capture_email' AND template = 'capture_email') = 1,
  'one capture_email notification for F');
SELECT test.assert(
  (SELECT href FROM public.notifications WHERE user_id = :'uF' AND type = 'capture_email')
    = '/?capture_email=' || (SELECT id::text FROM public.capture_candidates WHERE user_id = :'uF'),
  'the notification deep-links to the candidate');
SELECT test.assert(
  (SELECT title FROM public.notifications WHERE user_id = :'uF' AND type = 'capture_email') = 'Record this bank email?'
  AND (SELECT body FROM public.notifications WHERE user_id = :'uF' AND type = 'capture_email') LIKE 'From emiratesnbd.com.%',
  'composed in the reader''s language (en) and names only the sender domain');
SELECT test.assert(
  (SELECT params->>'fromName' FROM public.notifications WHERE user_id = :'uF' AND type = 'capture_email') = 'emiratesnbd.com',
  'params carry the sender domain for the client template');
SELECT test.assert(
  public.notification_channel_for('capture_email', 'capture_email') = 'money',
  'capture offers ride the money channel');
SELECT test.assert(
  (SELECT actor_id FROM public.notifications WHERE user_id = :'uF' AND type = 'capture_email') IS NULL,
  'actor_id stays NULL (it feeds the group rate limiter)');

-- The other user sees nothing of F's.
SET ROLE authenticated;
SELECT test.as_user(:'uO');
SELECT test.assert_zero_rows(
  $q$ SELECT 1 FROM public.capture_candidates $q$,
  'O cannot see F''s candidate');
SELECT test.assert_zero_rows(
  $q$ SELECT 1 FROM public.capture_addresses $q$,
  'O cannot see F''s address');
RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- (e) NOTHING QUEUED for an unknown / rotated token, a deleted profile, empty text
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE service_role;
SELECT test.assert(
  public._capture_candidate_received(:'first_token', 'x@y.com', 's', 'AED 5 spent') IS NULL,
  'the rotated (old) token is dead');
SELECT test.assert(
  public._capture_candidate_received('000000000000', 'x@y.com', 's', 'AED 5 spent') IS NULL,
  'an unknown token queues nothing');
SELECT test.assert(
  public._capture_candidate_received('zz', 'x@y.com', 's', 'AED 5 spent') IS NULL,
  'a malformed token queues nothing');
SELECT test.assert(
  public._capture_candidate_received(:'live_token', 'x@y.com', 's', '   ') IS NULL,
  'empty text queues nothing');
RESET ROLE;

-- A deleted profile's address is dead even though the row exists.
SET ROLE authenticated;
SELECT test.as_user(:'uD');
SELECT public.get_or_create_capture_address();
RESET ROLE;
SELECT token AS deleted_token FROM public.capture_addresses WHERE user_id = :'uD' \gset
SET ROLE service_role;
SELECT test.assert(
  public._capture_candidate_received(:'deleted_token', 'x@y.com', 's', 'AED 5 spent') IS NULL,
  'a deleted profile receives nothing');
RESET ROLE;

SELECT test.assert(
  (SELECT count(*) FROM public.capture_candidates) = 1,
  'still exactly one candidate in the table');

-- ════════════════════════════════════════════════════════════════════════════
-- (f) THE OWNER may change status only
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uF');
SELECT test.assert_ok(
  $q$ UPDATE public.capture_candidates SET status = 'recorded' WHERE user_id = auth.uid() $q$,
  'F can mark the candidate recorded');
SELECT test.assert(
  (SELECT resolved_at FROM public.capture_candidates WHERE user_id = :'uF') IS NOT NULL,
  'resolving stamps resolved_at');
SELECT test.assert_raises(
  $q$ UPDATE public.capture_candidates SET raw_text = 'AED 999 at NOWHERE' WHERE user_id = auth.uid() $q$,
  'only status may change',
  'the stored email text is immutable');
SELECT test.assert_raises(format(
  $q$ UPDATE public.capture_candidates SET user_id = %L WHERE user_id = auth.uid() $q$, :'uO'),
  'only status may change',
  'a candidate cannot be handed to another user');
-- No DELETE policy: RLS filters the statement to zero rows rather than erroring.
DELETE FROM public.capture_candidates WHERE user_id = auth.uid();
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM public.capture_candidates WHERE user_id = :'uF') = 1,
  'a client DELETE removes nothing');
SET ROLE authenticated;
SELECT test.as_user(:'uF');
-- O cannot resolve F's row (RLS hides it: zero rows updated, no error).
SELECT test.as_user(:'uO');
UPDATE public.capture_candidates SET status = 'dismissed' WHERE user_id = :'uF';
RESET ROLE;
SELECT test.assert(
  (SELECT status FROM public.capture_candidates WHERE user_id = :'uF') = 'recorded',
  'O''s update touched nothing');

-- ════════════════════════════════════════════════════════════════════════════
-- (g) FLOOD CAP — 60 per rolling day
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE service_role;
SELECT public._capture_candidate_received(:'live_token', 'x@y.com', 's', 'AED ' || g || ' spent')
FROM generate_series(1, 59) g;
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM public.capture_candidates WHERE user_id = :'uF') = 60,
  '59 more bring F to 60 in the day');
SET ROLE service_role;
SELECT test.assert(
  public._capture_candidate_received(:'live_token', 'x@y.com', 's', 'AED 61 spent') IS NULL,
  'the 61st in a day is dropped');
RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- (h) PRUNE
-- ════════════════════════════════════════════════════════════════════════════
-- Age two rows by hand (superuser; the guard trigger would refuse created_at).
ALTER TABLE public.capture_candidates DISABLE TRIGGER capture_candidates_guard;
UPDATE public.capture_candidates SET resolved_at = now() - INTERVAL '8 days'
 WHERE user_id = :'uF' AND status = 'recorded';
UPDATE public.capture_candidates SET created_at = now() - INTERVAL '31 days'
 WHERE user_id = :'uF' AND status = 'pending' AND raw_text = 'AED 1 spent';
ALTER TABLE public.capture_candidates ENABLE TRIGGER capture_candidates_guard;
SELECT test.assert(
  public.prune_capture_candidates() = 2,
  'prune removes the old resolved row and the stale pending row');
SELECT test.assert(
  (SELECT count(*) FROM public.capture_candidates WHERE user_id = :'uF') = 58,
  'fresh pending rows survive the prune');

