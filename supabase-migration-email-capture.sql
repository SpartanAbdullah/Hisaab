-- ════════════════════════════════════════════════════════════════════════════
-- Email capture — forward a bank email to your own Hisaab address
-- (2026-10-18, docs/bank-alert-capture.md §"Route 3")
--
-- The share sheet and the Android notification listener (PR #3) keep every
-- captured alert on the phone. This route is the cross-platform one: each
-- user gets a private address `hisaab-<token>@<inbound_domain>`; a mail
-- forwarded there reaches the `inbound-email` edge function through the
-- inbound-mail provider's webhook, which calls _capture_candidate_received()
-- with the service role. That queues ONE row in capture_candidates (the
-- email's text, capped) and writes ONE notification whose tap opens the
-- "Record this?" sheet (`/?capture_email=<id>`). Nothing is recorded until the
-- user taps Record in Quick Entry.
--
-- Privacy consequences, deliberately:
--   * the forwarded email's TEXT is stored server-side — the Data Safety form's
--     "Messages → Emails" row becomes Collected = Yes (not shared, optional);
--   * raw_text is capped at 8000 chars, HTML stripped before storage;
--   * a candidate is pruned 7 days after it is recorded/dismissed and 30 days
--     after arrival if never opened (prune_capture_candidates, nightly);
--   * rotating the address makes the old one dead immediately;
--   * ON DELETE CASCADE from auth.users — account deletion removes everything.
--
-- Apply in Supabase Studio, then re-run supabase-migration-p3-rpc-execute-grants.sql.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Config: which domain the addresses live on ────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.capture_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "capture_config readable" ON public.capture_config;
CREATE POLICY "capture_config readable"
  ON public.capture_config FOR SELECT TO authenticated USING (true);
-- Clients never write it; the founder sets it in Studio when the provider is live.
INSERT INTO public.capture_config (key, value)
VALUES ('inbound_domain', 'in.usehisaab.com')
ON CONFLICT (key) DO NOTHING;

-- ── 2. One private address per user ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_addresses (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{12}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);
ALTER TABLE public.capture_addresses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "capture_addresses own select" ON public.capture_addresses;
CREATE POLICY "capture_addresses own select"
  ON public.capture_addresses FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
-- No client INSERT/UPDATE/DELETE: the two RPCs below are the only writers.

-- ── 3. Queued candidates ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_candidates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'email' CHECK (source IN ('email')),
  from_address TEXT CHECK (from_address IS NULL OR length(from_address) <= 320),
  subject      TEXT CHECK (subject IS NULL OR length(subject) <= 500),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_text     TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 8000),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'recorded', 'dismissed')),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capture_candidates_user_status
  ON public.capture_candidates (user_id, status, created_at DESC);
ALTER TABLE public.capture_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "capture_candidates own select" ON public.capture_candidates;
CREATE POLICY "capture_candidates own select"
  ON public.capture_candidates FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "capture_candidates own resolve" ON public.capture_candidates;
CREATE POLICY "capture_candidates own resolve"
  ON public.capture_candidates FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
-- No client INSERT (the edge function inserts through the service role) and
-- no client DELETE (the nightly prune owns retention).

-- The UPDATE policy lets a user touch their own row; this trigger narrows
-- that to `status` alone, so the stored email can never be rewritten.
CREATE OR REPLACE FUNCTION public.tg_capture_candidates_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.user_id      IS DISTINCT FROM OLD.user_id
  OR NEW.source       IS DISTINCT FROM OLD.source
  OR NEW.from_address IS DISTINCT FROM OLD.from_address
  OR NEW.subject      IS DISTINCT FROM OLD.subject
  OR NEW.received_at  IS DISTINCT FROM OLD.received_at
  OR NEW.raw_text     IS DISTINCT FROM OLD.raw_text
  OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'capture_candidates: only status may change'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.resolved_at := CASE
    WHEN NEW.status = 'pending' THEN NULL
    ELSE COALESCE(OLD.resolved_at, now())
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS capture_candidates_guard ON public.capture_candidates;
CREATE TRIGGER capture_candidates_guard
  BEFORE UPDATE ON public.capture_candidates
  FOR EACH ROW EXECUTE FUNCTION public.tg_capture_candidates_guard();

-- ── 4. Address RPCs (authenticated) ─────────────────────────────────────────
-- 12 hex chars = 48 bits from a v4 UUID's randomness — unguessable for an
-- address, cheap to type if someone must. Unique is enforced by the table.
CREATE OR REPLACE FUNCTION public._capture_new_token()
RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v TEXT;
BEGIN
  LOOP
    v := substr(md5(gen_random_uuid()::TEXT || clock_timestamp()::TEXT), 1, 12);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.capture_addresses WHERE token = v);
  END LOOP;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_capture_address()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_token TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT token INTO v_token FROM public.capture_addresses WHERE user_id = v_uid;
  IF v_token IS NULL THEN
    INSERT INTO public.capture_addresses (user_id, token)
    VALUES (v_uid, public._capture_new_token())
    ON CONFLICT (user_id) DO NOTHING;
    SELECT token INTO v_token FROM public.capture_addresses WHERE user_id = v_uid;
  END IF;
  RETURN v_token;
END;
$$;

-- A new address; mail to the old one is dropped from the next message on.
CREATE OR REPLACE FUNCTION public.rotate_capture_address()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_token TEXT := public._capture_new_token();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.capture_addresses (user_id, token, rotated_at)
  VALUES (v_uid, v_token, now())
  ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, rotated_at = now();
  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public._capture_new_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_or_create_capture_address() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_capture_address() TO authenticated;
REVOKE ALL ON FUNCTION public.rotate_capture_address() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_capture_address() TO authenticated;

-- ── 5. The inbound webhook's entry point (service_role only) ────────────────
-- Returns the candidate id, or NULL when nothing was queued: unknown or
-- rotated token, deleted account, empty text, or the per-user flood cap. The
-- caller answers the provider 200 either way so an attacker probing addresses
-- learns nothing and the provider stops retrying.
CREATE OR REPLACE FUNCTION public._capture_candidate_received(
  p_token TEXT, p_from TEXT, p_subject TEXT, p_text TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user UUID;
  v_id   UUID;
  v_lang TEXT;
  v_from TEXT := left(coalesce(p_from, ''), 320);
  v_text TEXT := left(coalesce(p_text, ''), 8000);
  v_domain TEXT;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{12}$' OR length(btrim(v_text)) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT a.user_id INTO v_user
    FROM public.capture_addresses a
    JOIN public.profiles p ON p.id = a.user_id
   WHERE a.token = p_token
     AND COALESCE(p.is_deleted, FALSE) = FALSE;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  -- Flood cap: a forwarding filter gone wrong (or someone who found the
  -- address) cannot fill the inbox. 60 in a rolling day is far beyond any
  -- real bank's volume.
  IF (SELECT count(*) FROM public.capture_candidates
       WHERE user_id = v_user AND created_at > now() - INTERVAL '24 hours') >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.capture_candidates (user_id, source, from_address, subject, raw_text)
  VALUES (v_user, 'email', NULLIF(v_from, ''), left(NULLIF(coalesce(p_subject, ''), ''), 500), v_text)
  RETURNING id INTO v_id;

  -- One inbox row + push, composed in the READER's language. The tray text
  -- names only the sender's domain — never the amount or the subject — the
  -- same lock-screen rule as the widget and the Android listener.
  SELECT COALESCE(p.lang, 'ur') INTO v_lang FROM public.profiles p WHERE p.id = v_user;
  -- The domain only: "Alerts <alerts@bank.com>" and "alerts@bank.com" both → bank.com.
  v_domain := NULLIF(lower(regexp_replace(split_part(v_from, '@', 2), '[>\s].*$', '')), '');
  INSERT INTO public.notifications (
    id, user_id, group_id, event_id, type, title, body, template, params, actor_id, href, read_at, created_at
  ) VALUES (
    gen_random_uuid()::TEXT, v_user, NULL, NULL, 'capture_email',
    CASE WHEN v_lang = 'en' THEN 'Record this bank email?' ELSE 'Yeh bank email record karein?' END,
    CASE WHEN v_domain IS NULL THEN
           CASE WHEN v_lang = 'en' THEN 'Tap to see what Hisaab read from it.' ELSE 'Tap karein — Hisaab ne kya parha, dekhein.' END
         ELSE
           CASE WHEN v_lang = 'en' THEN 'From ' || v_domain || '. Tap to see what Hisaab read from it.'
                ELSE v_domain || ' se. Tap karein — Hisaab ne kya parha, dekhein.' END
    END,
    'capture_email',
    jsonb_build_object('fromName', v_domain, 'candidateId', v_id),
    NULL,
    '/?capture_email=' || v_id::TEXT,
    NULL, now()
  );
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._capture_candidate_received(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._capture_candidate_received(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ── 6. Channel: a capture offer is money the reader must act on ─────────────
-- Re-declared with the one extra case; body otherwise identical to
-- supabase-migration-p2-notification-maturity.sql §3.
CREATE OR REPLACE FUNCTION public.notification_channel_for(p_type TEXT, p_template TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(p_template, '') LIKE 'kameti\_%' THEN 'kameti'
    WHEN p_type = 'kameti'                          THEN 'kameti'
    WHEN p_type IN ('linked_request', 'linked_settlement', 'capture_email') THEN 'money'
    ELSE 'groups'
  END;
$$;

-- ── 7. Retention ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prune_capture_candidates()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH gone AS (
    DELETE FROM public.capture_candidates
     WHERE (status <> 'pending' AND resolved_at < now() - INTERVAL '7 days')
        OR (status = 'pending'  AND created_at  < now() - INTERVAL '30 days')
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM gone;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_capture_candidates() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('hisaab-prune-capture-candidates');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- 03:53 UTC: after the record-edits prune (03:41), before the day starts in PK/UAE.
    PERFORM cron.schedule(
      'hisaab-prune-capture-candidates', '53 3 * * *',
      'SELECT public.prune_capture_candidates();'
    );
    RAISE NOTICE 'email-capture: pg_cron job scheduled (hisaab-prune-capture-candidates)';
  ELSE
    RAISE NOTICE 'email-capture: pg_cron NOT installed — schedule SELECT public.prune_capture_candidates(); daily from Studio → Integrations → Cron';
  END IF;
END;
$$;

COMMIT;
