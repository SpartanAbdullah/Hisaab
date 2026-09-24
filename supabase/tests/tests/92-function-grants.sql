-- ════════════════════════════════════════════════════════════════════════════
-- 92 · Function EXECUTE grants + search_path
--
-- Covers `supabase-migration-p3-rpc-execute-grants.sql` — the least-privilege
-- sweep over `public.*` functions, and the three Supabase Security Advisor
-- findings it closes (advisor run against PRODUCTION 2026-09-03):
--
--   (a) SECURITY DEFINER functions EXECUTE-able by `anon`
--   (b) trigger functions EXECUTE-able by `authenticated`
--   (c) `function_search_path_mutable`
--
-- Two kinds of assertion here, and both are needed:
--
--   • CATALOG assertions (`RESET ROLE`, reading `pg_proc` / `pg_default_acl`).
--     They prove the ACL shape. They are deliberately written as *set*
--     queries — "no function anywhere in public is X" — not as a list of
--     names, so a future migration that adds an anon-executable definer
--     function fails this suite without anybody remembering to update it.
--
--   • BEHAVIOURAL assertions (`SET ROLE authenticated` / `anon`). They prove
--     the ACL shape is the RIGHT one: that revoking a trigger function does
--     not stop the trigger firing, and that the two RLS-policy helpers kept
--     their grant (revoking those turns every table read into a 42501 —
--     the one regression in this file that would take the whole app down).
--
-- Runs at 92-, LAST before `99-summary.sql`, for two reasons. (1) The grants
-- it asserts are exactly the grants every earlier suite was exercising: if
-- 00- through 90- are green under this migration, the allowlist is not missing
-- a client RPC. (2) `7z-atomic-investments-single-leg.sql` installs the
-- `dblink` extension into `public` mid-suite; the search_path assertion has to
-- see that state to prove it excludes extension-owned functions correctly.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('92-function-grants');

RESET ROLE;

-- ── The documented anon allowlist. TWO names, each justified inline in the
--    migration's §2. Kept here as a literal so a widening of the migration's
--    array without a matching, deliberate edit here fails the suite.
CREATE TEMP TABLE _anon_allow (n TEXT);
INSERT INTO _anon_allow VALUES
  ('get_committee_witness'),        -- public /kameti/witness/:token page
  ('get_khata_view');               -- public /khata/:token page

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ADVISOR (a) — no SECURITY DEFINER function is anon-executable, except
--    the two allowlisted capability-URL names.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _anon_leaks AS
SELECT p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
   AND p.proname NOT IN (SELECT n FROM _anon_allow);

SELECT test.assert((SELECT count(*) FROM _anon_leaks) = 0,
  'no SECURITY DEFINER function in public is anon-executable outside the allowlist',
  'leaked: ' || COALESCE((SELECT string_agg(proname, ', ' ORDER BY proname)
                            FROM _anon_leaks), '(none)'));

-- The allowlist is an allowlist, not a wish: each name must actually still be
-- callable by anon, or the two public pages 404 for every signed-out reader.
SELECT test.assert(
  has_function_privilege('anon', 'public.get_committee_witness(text)', 'EXECUTE'),
  'anon keeps EXECUTE on get_committee_witness (public kameti witness page)');

SELECT test.assert(
  has_function_privilege('anon', 'public.get_khata_view(text)', 'EXECUTE'),
  'anon keeps EXECUTE on get_khata_view (public khata link page)');

-- Named negatives — the advisor's own worst offenders, asserted individually
-- so a failure names the regression instead of a count.
SELECT test.assert(
  NOT has_function_privilege('anon', 'public.register_push_token(text, text)', 'EXECUTE'),
  'anon cannot execute register_push_token');

SELECT test.assert(
  NOT has_function_privilege('anon', 'public.lookup_hisaab_users_by_phone(text[])', 'EXECUTE'),
  'anon cannot execute lookup_hisaab_users_by_phone (phone-enumeration oracle)');

SELECT test.assert(
  NOT has_function_privilege('anon', 'public.create_settlement_request(text, text, text, text, uuid, numeric, text, text, text)', 'EXECUTE'),
  'anon cannot execute create_settlement_request');

SELECT test.assert(
  NOT has_function_privilege('anon', 'public.respond_contact_link(text, boolean)', 'EXECUTE'),
  'anon cannot execute respond_contact_link');

SELECT test.assert(
  NOT has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE'),
  'anon cannot execute handle_new_user');

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ADVISOR (b) — no trigger function is executable by a client role.
--    `tg\_%` plus the four that predate the naming convention.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _trigger_fns AS
SELECT p.oid, p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND (p.proname LIKE 'tg\_%'
        OR p.proname IN ('handle_new_user',
                         'enforce_group_expense_reconciliation_payer',
                         'hisaab_broadcast_money_change',
                         'touch_app_config_updated_at'));

SELECT test.assert((SELECT count(*) FROM _trigger_fns) >= 45,
  'the trigger-function set is populated (guards against a vacuous pass)',
  'found: ' || (SELECT count(*) FROM _trigger_fns)::text);

SELECT test.assert(
  (SELECT count(*) FROM _trigger_fns
    WHERE has_function_privilege('authenticated', oid, 'EXECUTE')) = 0,
  'no tg_* / internal trigger function is executable by authenticated',
  'still executable: ' || COALESCE(
    (SELECT string_agg(proname, ', ' ORDER BY proname) FROM _trigger_fns
      WHERE has_function_privilege('authenticated', oid, 'EXECUTE')), '(none)'));

SELECT test.assert(
  (SELECT count(*) FROM _trigger_fns
    WHERE has_function_privilege('anon', oid, 'EXECUTE')) = 0,
  'no tg_* / internal trigger function is executable by anon',
  'still executable: ' || COALESCE(
    (SELECT string_agg(proname, ', ' ORDER BY proname) FROM _trigger_fns
      WHERE has_function_privilege('anon', oid, 'EXECUTE')), '(none)'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ADVISOR (c) — every function in public pins a search_path.
-- ═══════════════════════════════════════════════════════════════════════════
-- Extension-owned functions are excluded, exactly as the migration's §1
-- excludes them. `7z-atomic-investments-single-leg.sql` does
-- `CREATE EXTENSION IF NOT EXISTS dblink` for its two-session lock race, which
-- drops ~40 C functions into `public` AFTER the migration has run — none of
-- them ours to ALTER, and the same shape any `CREATE EXTENSION … WITH SCHEMA
-- public` produces in production.
CREATE TEMP TABLE _no_search_path AS
SELECT p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND (p.proconfig IS NULL
        OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c
                        WHERE c LIKE 'search\_path=%'))
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass
                      AND d.objid = p.oid AND d.deptype = 'e');

SELECT test.assert((SELECT count(*) FROM _no_search_path) = 0,
  'every function in public pins a search_path (function_search_path_mutable)',
  'mutable: ' || COALESCE((SELECT string_agg(proname, ', ' ORDER BY proname)
                             FROM _no_search_path), '(none)'));

-- The advisor's five production names, individually, so a regression is named.
SELECT test.assert(
  (SELECT p.proconfig IS NOT NULL FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'),
  'handle_new_user pins a search_path (SECURITY DEFINER definer-hijack shape)');

SELECT test.assert(
  (SELECT bool_and(p.proconfig IS NOT NULL)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('tg_persons_touch', 'tg_accounts_touch',
                        'tg_block_archived_person_reference', 'tg_touch_updated_at')),
  'the four advisor-named trigger functions pin a search_path');

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. THE RLS-POLICY HELPERS KEPT THEIR `authenticated` GRANT (guard R1)
--    Postgres privilege-checks a policy expression against the QUERYING role.
--    Revoking either of these from `authenticated` makes every table read a
--    42501 for every signed-in user — the one regression in this migration
--    that would take the whole app down.
--
--    They are deliberately NOT granted to `anon`: the only table this app
--    reads with no session is `app_config`, whose policy is
--    `TO anon, authenticated USING (true)` — no function call
--    (`p1-app-config.sql:166`), so nothing anon-reachable evaluates them.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  has_function_privilege('authenticated', 'public.is_current_profile_active()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_current_profile_active()', 'EXECUTE'),
  'is_current_profile_active: authenticated YES (RLS policy dependency), anon NO');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.is_group_member(text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_group_member(text, uuid)', 'EXECUTE'),
  'is_group_member: authenticated YES (RLS policy dependency), anon NO (closes a membership oracle)');

-- The one table the app really does read with no session must stay readable
-- by anon, and its policy must stay function-free.
SELECT test.assert(
  EXISTS (SELECT 1 FROM pg_policy pp JOIN pg_class c ON c.oid = pp.polrelid
           WHERE c.relname = 'app_config'
             AND pg_get_expr(pp.polqual, pp.polrelid) = 'true'),
  'app_config keeps a function-free USING (true) read policy (the version gate runs before auth)');

-- R2: two SECURITY DEFINER helpers called from SECURITY INVOKER triggers, so
-- they run with the WRITING USER's privileges. Neither is a client RPC.
SELECT test.assert(
  has_function_privilege('authenticated',
    'public.group_settlement_cap(text, text, text, boolean)', 'EXECUTE'),
  'group_settlement_cap keeps authenticated EXECUTE (tg_group_settlements_enforce_cap calls it)');

SELECT test.assert(
  has_function_privilege('authenticated',
    'public.group_member_net_balances(text)', 'EXECUTE'),
  'group_member_net_balances keeps authenticated EXECUTE (tg_split_groups_guard_delete calls it)');

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. THE CLIENT RPC SURFACE IS INTACT
--    Every name `supabase.rpc('…')` uses in src/ that exists in this database
--    must still be executable by `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _client_rpcs (n TEXT);
INSERT INTO _client_rpcs VALUES
  ('accept_group_invite'),('accept_group_membership'),('accept_linked_request'),
  ('accept_settlement_request'),('add_committee_member'),('add_group_guest'),
  ('analytics_daily_series'),('analytics_monthly_summary'),('analytics_top_expenses'),
  ('apply_account_balance_delta'),('apply_goal_saved_delta'),('apply_loan_remaining_delta'),
  ('archive_contact_if_settled'),('archive_group'),('cancel_linked_request'),
  ('cancel_settlement_request'),('contribute_to_goal'),('create_khata_link'),
  ('create_loan_with_leg'),('create_settlement_request'),('decline_group_membership'),
  ('delete_current_user'),('get_committee_witness'),('get_khata_view'),
  ('join_group_by_code'),('leave_group'),('link_contact_by_code'),
  ('link_contact_by_discovery'),('list_pending_group_memberships'),
  ('lookup_hisaab_users_by_phone'),('lookup_profile_by_code'),('merge_person'),
  ('notify_contact_linked'),('pay_card_bill'),('perform_committee_draw'),
  ('preview_group_by_code'),('reconcile_group_expense'),('record_group_settlement'),
  ('record_investment_trade'),('record_loan_repayment'),('record_single_leg_entry'),
  ('register_push_token'),('reject_linked_request'),('reject_settlement_request'),
  ('remove_committee_member'),('remove_group_guest'),('respond_contact_link'),
  ('revoke_committee_witness_token'),('revoke_khata_link'),
  ('rotate_committee_witness_token'),('set_group_admin'),('transfer_between_accounts'),
  ('transfer_group_ownership'),('unarchive_contact'),('unarchive_group'),
  ('unlink_contact_profile'),('update_committee'),
  ('apply_own_settlement_request'),('record_received_repayment'),
  ('set_settlement_repayment_account'),('undo_received_repayment');

-- Every listed RPC must exist in this corpus. (If one does not, either the
-- client calls a function nobody wrote, or apply-order.txt lost a file.)
CREATE TEMP TABLE _rpc_absent AS
SELECT r.n FROM _client_rpcs r
 WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = r.n);

SELECT test.assert((SELECT count(*) FROM _rpc_absent) = 0,
  'every supabase.rpc() name in src/ exists in the migrated database',
  'absent: ' || COALESCE((SELECT string_agg(n, ', ' ORDER BY n) FROM _rpc_absent), '(none)'));

CREATE TEMP TABLE _rpc_denied AS
SELECT r.n FROM _client_rpcs r
 WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = r.n)
   AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = r.n
                      AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));

SELECT test.assert((SELECT count(*) FROM _rpc_denied) = 0,
  'every client RPC is executable by authenticated',
  'denied: ' || COALESCE((SELECT string_agg(n, ', ' ORDER BY n) FROM _rpc_denied), '(none)'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. DEFAULT PRIVILEGES — the next CREATE FUNCTION is safe by default
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
           WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'),
  'a default ACL for FUNCTIONS exists in schema public');

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
               WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
                 AND array_to_string(d.defaclacl, ' ') ~ '(^| )anon='),
  'default FUNCTION privileges no longer grant anon',
  'defaclacl: ' || COALESCE((SELECT array_to_string(d.defaclacl, ' ')
                               FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
                              WHERE n.nspname = 'public' AND d.defaclobjtype = 'f' LIMIT 1), '(none)'));

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
               WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
                 AND array_to_string(d.defaclacl, ' ') ~ '(^| )=X'),
  'default FUNCTION privileges no longer grant PUBLIC');

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ADVISOR (d), INFO — RLS-with-no-client-policy is BY DESIGN. Asserted,
--    not changed: both tables are touched only by SECURITY DEFINER code,
--    which bypasses RLS as the owner. A policy could only widen the exposure.
--
--    NOTE the difference between production and this branch: production has
--    zero policies on BOTH tables (that is what the advisor reported).
--    `audit-p0-consent-guards.sql:302` adds ONE explicit deny-all policy to
--    `phone_lookup_attempts` (`FOR ALL USING (false) WITH CHECK (false)`) so a
--    future "add a policy for debugging" cannot quietly widen it. Same
--    enforcement, said out loud. The assertion below is therefore written as
--    "RLS on, and no policy that grants anything", not "zero policies".
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT c.relrowsecurity AND (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) = 0
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'app_push_config'),
  'app_push_config: RLS on, zero policies (FCM key readable only by tg_notifications_push)');

SELECT test.assert(
  (SELECT c.relrowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_policy pp
                       WHERE pp.polrelid = c.oid
                         AND COALESCE(pg_get_expr(pp.polqual, pp.polrelid), '') <> 'false')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'phone_lookup_attempts'),
  'phone_lookup_attempts: RLS on, every policy is an explicit deny-all (rate-limit ledger is not client state)',
  'policies: ' || COALESCE((SELECT string_agg(pp.polname || ' USING ' ||
                                   COALESCE(pg_get_expr(pp.polqual, pp.polrelid), '(none)'), '; ')
                              FROM pg_policy pp
                              JOIN pg_class c ON c.oid = pp.polrelid
                             WHERE c.relname = 'phone_lookup_attempts'), '(none)'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. BEHAVIOUR — the ACL shape actually works
--
-- Everything above is catalog introspection. These run through the same door
-- PostgREST does.
-- ═══════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user('44444444-4444-4444-4444-444444444444');

-- 8.1 A revoked trigger function is not callable as a bare RPC …
SELECT test.assert_raises(
  $$ SELECT public.tg_notifications_push() $$,
  'permission denied',
  'authenticated cannot POST /rpc/tg_notifications_push');

SELECT test.assert_raises(
  $$ SELECT public.handle_new_user() $$,
  'permission denied',
  'authenticated cannot POST /rpc/handle_new_user');

SELECT test.assert_raises(
  $$ SELECT public.hisaab_broadcast_money_change() $$,
  'permission denied',
  'authenticated cannot POST /rpc/hisaab_broadcast_money_change');

-- 8.2 … but the triggers still FIRE. Postgres checks EXECUTE on a trigger
--     function once, at CREATE TRIGGER time — never at fire time. `accounts`
--     carries trg_broadcast_accounts_ins/upd/del (hisaab_broadcast_money_change,
--     SECURITY DEFINER) and trg_accounts_touch (tg_touch_updated_at, SECURITY
--     INVOKER) — all three revoked from `authenticated` above.
SELECT test.assert_ok(
  $$ INSERT INTO public.accounts (id, user_id, name, type, currency, balance)
     VALUES ('ACC-GRANTS-90', auth.uid(), 'Grants probe', 'cash', 'AED', 10) $$,
  'an INSERT still fires its revoked trigger functions (EXECUTE is checked at CREATE TRIGGER, not at fire)');

SELECT test.assert_ok(
  $$ UPDATE public.accounts SET balance = 20 WHERE id = 'ACC-GRANTS-90' $$,
  'an UPDATE still fires tg_touch_updated_at with EXECUTE revoked');

SELECT test.assert(
  (SELECT updated_at > created_at FROM public.accounts WHERE id = 'ACC-GRANTS-90'),
  'tg_touch_updated_at actually ran (updated_at moved) despite the revoke');

-- 8.3 The RLS-policy helper is exercised on every one of those reads. If
--     is_current_profile_active had lost its grant, 8.2 would already have
--     failed with 42501 — assert it positively anyway, cheaply.
SELECT test.assert_ok(
  $$ SELECT count(*) FROM public.accounts $$,
  'a plain table read still works (is_current_profile_active policy helper is callable)');

-- 8.4 The public pages' RPCs remain callable with NO session at all. A bad
--     token answers NULL, not an error — that is the contract, and it is what
--     makes them safe to leave anon-executable.
RESET ROLE;
SET ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false);

SELECT test.assert_ok(
  $$ SELECT public.get_committee_witness('not-a-real-token') $$,
  'anon can still call get_committee_witness (public witness page)');

SELECT test.assert_ok(
  $$ SELECT public.get_khata_view('not-a-real-token') $$,
  'anon can still call get_khata_view (public khata page)');

SELECT test.assert(
  (SELECT public.get_committee_witness('not-a-real-token')) IS NULL,
  'get_committee_witness answers NULL for a bad token (not an existence oracle)');

-- 8.5 anon is shut out of the money/identity surface.
SELECT test.assert_raises(
  $$ SELECT public.lookup_hisaab_users_by_phone(ARRAY['+971500000000']) $$,
  'permission denied',
  'anon cannot call lookup_hisaab_users_by_phone');

SELECT test.assert_raises(
  $$ SELECT public.register_push_token('tok', 'android') $$,
  'permission denied',
  'anon cannot call register_push_token');

SELECT test.assert_raises(
  $$ SELECT public.delete_current_user() $$,
  'permission denied',
  'anon cannot call delete_current_user');

-- 8.6 …and the app_config version gate still works with no session, which is
--     the whole reason the two RLS helpers could be taken away from anon.
SELECT test.assert_ok(
  $$ SELECT count(*) FROM public.app_config $$,
  'anon can still read app_config (the pre-auth version gate)');

-- ── cleanup: leave the fixture database as we found it ─────────────────────
RESET ROLE;
DELETE FROM public.accounts WHERE id = 'ACC-GRANTS-90';
DROP TABLE IF EXISTS _anon_allow, _anon_leaks, _trigger_fns, _no_search_path,
                     _client_rpcs, _rpc_absent, _rpc_denied;
