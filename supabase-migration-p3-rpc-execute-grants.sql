-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3: RPC EXECUTE grants + search_path pinning
--   the least-privilege sweep over public.* functions
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run, and it is
-- MEANT to be re-run — it is a *sweep* over pg_proc, not a set of hand-written
-- grants, so re-running it after any future migration re-closes whatever that
-- migration left open.
--
-- ── APPLY AFTER ─────────────────────────────────────────────────────────────
-- Canonical order: `supabase/tests/apply-order.txt` (see
-- docs/audit-2026-09/APPLY-ORDER.md §2b — that file wins over prose).
--
-- **THIS FILE IS LAST.** It must be applied AFTER every other file in the
-- corpus, and specifically AFTER
-- `supabase-migration-p3-invariant-monitoring.sql` (previously last), because:
--
--   1. It sweeps `pg_proc`. A function created by a file applied *after* this
--      one is not covered by the REVOKE sweep, and — for a trigger function —
--      would keep the `authenticated` EXECUTE that Supabase's default
--      privileges hand it. §4's `ALTER DEFAULT PRIVILEGES` closes the
--      PUBLIC/`anon` half for future functions, but nothing can retroactively
--      revoke `authenticated` on a function that does not exist yet.
--   2. `p3-invariant-monitoring` creates five of the eleven functions §1 has
--      to pin a `search_path` onto (`_recon_urldecode`, `_recon_numeric`,
--      `_recon_note_meta`, `_recon_mapped_types`, `_recon_cron_status`), and
--      `p1-app-config` creates a sixth (`touch_app_config_updated_at`).
--
-- Hard prerequisites: none beyond "the rest of the corpus is applied". This
-- file CREATEs nothing and REPLACEs no function body. It only changes ACLs and
-- `proconfig`. If a function named below is absent, the sweep simply does not
-- see it.
--
-- ── WHAT THIS FIXES — evidence ──────────────────────────────────────────────
-- Supabase's Security Advisor, run against PRODUCTION on 2026-09-03 (base
-- schema + the 40 historical migrations; none of the audit-p0/p1/p2/p3 batch):
--
--   (a) `security_definer_function_executable_by_anon` — 19 SECURITY DEFINER
--       functions in `public` are EXECUTE-able by the `anon` role, i.e. by
--       anybody holding the publishable anon key, with no session at all.
--   (b) 31 SECURITY DEFINER functions are EXECUTE-able by `authenticated`.
--       That is correct for a real client RPC and wrong for a trigger
--       function: `tg_notifications_push()`, `handle_new_user()`,
--       `tg_ltr_validate_insert()` and friends are reachable as bare
--       `POST /rest/v1/rpc/<name>` calls today.
--   (c) `function_search_path_mutable` — five functions carry no
--       `SET search_path`, so they resolve unqualified names against the
--       caller's session `search_path`. On a SECURITY DEFINER function
--       (`handle_new_user`) that is the classic definer-hijack shape.
--
-- The audit-p0/p1/p2/p3 branch closes some of this incidentally (every file
-- from `audit-p0-*` onward writes an explicit
-- `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated;` pair for
-- the functions it owns) and *adds* new instances of the same class along the
-- way. Measured against the fully-migrated database (all 74 lines of
-- `apply-order.txt` applied to a throwaway `postgres:15`, 2026-09-03):
--
--   • 27 SECURITY DEFINER functions still EXECUTE-able by `anon`
--     (16 of the advisor's original 19, plus 11 introduced by the branch:
--      get_khata_view, hisaab_broadcast_money_change,
--      tg_group_members_block_guard, tg_group_members_notify_left,
--      tg_ltr_block_accept, tg_reports_validate, tg_committees_notify_draw,
--      tg_group_expenses_notify, tg_group_members_notify,
--      tg_group_members_notify_invited, tg_group_settlements_notify).
--   • 11 functions with no `search_path` (the advisor's 5, plus 6 the branch
--     added).
--   • Every SECURITY INVOKER `tg_*` trigger function EXECUTE-able by
--     `authenticated` as well.
--
-- Three of the advisor's 19 need no action here: `reject_linked_request` and
-- `reject_settlement_request` are already revoked from `anon` by
-- `supabase-migration-fix-settlement-cancel-reject.sql` /
-- `supabase-migration-p2-trust-safety.sql`, and `rls_auto_enable` does not
-- exist anywhere in this repository's SQL — it is a Supabase-platform helper,
-- not a Hisaab object. Leave it alone; it is not ours to revoke.
--
-- ── THE TWO THINGS THAT MAKE THIS NOT A ONE-LINER ───────────────────────────
-- Both were established empirically against the fully-migrated harness
-- database, not assumed:
--
--   R1. **An RLS policy expression IS privilege-checked against the querying
--       role.** `REVOKE EXECUTE ON FUNCTION public.is_current_profile_active()
--       FROM authenticated` turns *every* `SELECT` on `accounts`,
--       `transactions`, `loans`, `profiles`, … into
--       `ERROR: permission denied for function is_current_profile_active`
--       (34 policies reference it; 9 reference `is_group_member`). Those two
--       functions therefore stay granted to `authenticated` — see §2's
--       `v_internal_keep`. They do NOT stay granted to `anon`; §2 spells out
--       why that is safe (the only table this app reads with no session is
--       `app_config`, whose policy is a bare `USING (true)`).
--
--   R2. **A SECURITY INVOKER trigger function runs as the writing user, so a
--       SECURITY DEFINER helper it calls still needs that user's EXECUTE.**
--       Four such edges exist:
--         tg_group_settlements_enforce_cap()      → group_settlement_cap()
--         tg_split_groups_guard_delete()          → group_member_net_balances()
--         tg_group_expenses_require_connected_members()  → is_group_member()
--         tg_group_settlements_require_connected_members() → is_group_member()
--       Revoking those callees from `authenticated` would break the settlement
--       cap and group deletion for every user. They are in §2's
--       `v_internal_keep` and are NOT client RPCs — they are granted to
--       `authenticated` for the trigger's sake alone, and to `anon` never.
--
--   Trigger *firing* itself needs no EXECUTE: Postgres checks EXECUTE on a
--   trigger function once, at `CREATE TRIGGER` time. That is why every `tg_*`
--   function can be — and is — revoked from both client roles below.
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
-- None intended, and none observed: the `authenticated` allowlist in §2 is
-- the exact set of names `grep -rhoE "\.rpc\(\s*['\"][a-z0-9_]+['\"]" src/`
-- returns (56 names, 2026-09-03), plus the four §2-R1/R2 internals above
-- (`is_current_profile_active`, `is_group_member`, `group_settlement_cap`,
-- `group_member_net_balances` — `authenticated` only, never `anon`).
-- If a future client adds an `supabase.rpc('…')` call to a function this file
-- revoked, it will fail with `42501 permission denied for function …` — the
-- fix is to add the name to §2's `v_client_rpcs` array and re-run this file,
-- NOT to hand-GRANT it (a hand grant is invisible to §5's verification).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- At the bottom of this file.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Pin `search_path` on every public function that lacks one
--
-- Advisor item (c). A function with `proconfig IS NULL` resolves unqualified
-- names against the *caller's* `search_path`. Combined with SECURITY DEFINER
-- that is a privilege-escalation primitive (`handle_new_user()` is the live
-- instance); on a SECURITY INVOKER function it is "merely" a correctness
-- hazard, but the advisor flags both and there is no reason to keep either.
--
-- Value: `public, extensions, pg_temp`.
--   • `public`      — the repo's established convention (131 of 148 functions
--                     already carry exactly `search_path=public`).
--   • `extensions`  — Supabase puts pgcrypto there and sets the DATABASE-level
--                     search_path to `"$user", public, extensions`. Every
--                     function this section touches is currently resolving
--                     against that; dropping `extensions` would be a silent
--                     behaviour change, so it is preserved.
--   • `pg_temp`     — last, explicitly. Naming it pins it to the END of the
--                     search order, which is the whole point: a caller cannot
--                     shadow `public.foo` with a `pg_temp.foo`.
-- Existing `proconfig` values are NEVER overwritten — a function that already
-- declares `search_path = public, realtime, pg_temp` keeps it.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r        RECORD;
  v_path   TEXT;
  v_fixed  INT := 0;
BEGIN
  -- Degrade gracefully if `extensions` is absent (a bare postgres, not a
  -- Supabase project). Nothing this section touches uses pgcrypto today, but
  -- the schema list has to be resolvable or ALTER FUNCTION would still succeed
  -- and then fail at call time.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    v_path := 'public, extensions, pg_temp';
  ELSE
    v_path := 'public, pg_temp';
  END IF;

  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND (p.proconfig IS NULL
            OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c
                            WHERE c LIKE 'search\_path=%'))
       -- Never touch a function an EXTENSION owns. `CREATE EXTENSION … WITH
       -- SCHEMA public` (dblink, postgis, pg_trgm …) drops dozens of C
       -- functions into `public`; they are the extension's to manage, an
       -- ALTER here would be lost on the next `ALTER EXTENSION … UPDATE`,
       -- and Supabase's advisor scopes its search_path finding the same way.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY p.proname
  LOOP
    -- ALTER FUNCTION requires ownership. On Supabase, Studio's SQL Editor
    -- runs as `postgres` and owns everything in `public`; if a project has a
    -- function owned by another role, warn by name rather than aborting the
    -- whole file — §5's V3 will still fail loudly with the same name, so
    -- nothing is silently skipped.
    BEGIN
      EXECUTE format('ALTER FUNCTION public.%I(%s) SET search_path = %s',
                     r.proname, r.args, v_path);
      v_fixed := v_fixed + 1;
      RAISE NOTICE '[p3-rpc-execute-grants] search_path pinned: %(%)',
                   r.proname, r.args;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[p3-rpc-execute-grants] could NOT pin search_path on %(%): %',
                    r.proname, r.args, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '[p3-rpc-execute-grants] §1: % function(s) pinned to "%"',
               v_fixed, v_path;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. The EXECUTE sweep
--
-- Three passes over `public`:
--
--   2a. Every SECURITY DEFINER function        → REVOKE FROM PUBLIC, anon
--       …except `v_anon_rpcs` (documented one by one, below).
--
--   2b. Every SECURITY DEFINER function        → REVOKE FROM authenticated
--       …except `v_client_rpcs` ∪ `v_internal_keep`.
--
--   2c. Every trigger function, SECURITY DEFINER *or not*
--       (`tg_*` + the four that predate the naming convention)
--                                              → REVOKE FROM PUBLIC, anon,
--                                                authenticated.
--       Trigger firing does not check EXECUTE; only a direct
--       `POST /rest/v1/rpc/tg_ltr_validate_insert` does, and that call has no
--       legitimate caller.
--
-- `service_role` is never touched. It is the key the edge function
-- (`supabase/functions/push-notify`) and any future admin job hold, it is
-- never shipped to a client, and revoking it here would break push delivery.
--
-- Deliberately UNGUARDED, unlike §1 and §4: a GRANT/REVOKE this role cannot
-- make is a genuine "you cannot apply this file" and must abort loudly, not
-- warn. (§1 has V3 as its backstop and §4 only governs future functions, so
-- both degrade to a named WARNING instead.)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r RECORD;

  -- ── THE anon ALLOWLIST ────────────────────────────────────────────────────
  -- TWO names, and only two. Each is reachable, by design, with no session.
  --
  --  1. get_committee_witness(TEXT)
  --       The public kameti witness page. `src/App.tsx:820` renders
  --       `/kameti/witness/:token` ABOVE every gate (version → auth → email
  --       verification → onboarding → PIN) precisely so a relative with no
  --       Hisaab account can open the shared link in any browser.
  --       `src/lib/supabaseDb.ts:3012`. The token is the capability: it is
  --       256-bit, SHA-256-stored and expiring (p2-trust-safety §7), and the
  --       function returns NULL — not an error — for a wrong, revoked or
  --       expired one, so it is not an existence oracle.
  --
  --  2. get_khata_view(TEXT)
  --       The public khata (per-counterparty ledger) page, `/khata/:token`,
  --       `src/App.tsx:832`, `src/lib/supabaseDb.ts:5248`. Same capability-URL
  --       pattern, same reasoning: p3-khata-link built it deliberately for a
  --       reader who "usually has no account at all".
  --
  -- NOT on this list, and the reasoning matters because it is the one place
  -- this file could plausibly have been wrong:
  --
  --   is_current_profile_active() / is_group_member(TEXT, UUID)
  --     Both are RLS-policy helpers (34 and 9 policies), and R1 in the header
  --     proves a policy expression IS privilege-checked against the querying
  --     role — so for `authenticated` they are mandatory (see v_internal_keep).
  --     For `anon` they are NOT, and granting them would be a widening:
  --       • `is_current_profile_active` is ALREADY revoked from `anon` by an
  --         earlier file in this branch. Every table carrying the "Active
  --         profiles only" policy therefore already answers an anon read with
  --         `42501` rather than 0 rows — and the whole corpus is green, which
  --         is the evidence that the app performs no anon table read.
  --       • The ONE table this app really does read with no session is
  --         `app_config` (the version gate, `src/App.tsx`, deliberately above
  --         the auth gate). Its policy is `TO anon, authenticated USING (true)`
  --         (`p1-app-config.sql:166`) — no function call, so it is unaffected.
  --       • The two public pages above call ONLY the two SECURITY DEFINER RPCs
  --         in this array, which execute as the owner and bypass RLS anyway.
  --     So `is_group_member` loses `anon` here (it had it), closing a
  --     membership oracle for a caller who knows a group id and a user uuid,
  --     and buying up nothing the client uses.
  v_anon_rpcs TEXT[] := ARRAY[
    'get_committee_witness',
    'get_khata_view'
  ];

  -- ── THE authenticated ALLOWLIST ───────────────────────────────────────────
  -- Every name `supabase.rpc('…')` appears with in `src/`, as of 2026-09-03.
  -- Regenerate with:
  --   grep -rhoE "\.rpc\(\s*['\"][a-z0-9_]+['\"]" src/ \
  --     | sed -E "s/.*['\"]([a-z0-9_]+)['\"]/\1/" | sort -u
  -- Includes the branch's new RPCs (analytics_*, add_group_guest,
  -- remove_group_guest, update_committee, add_committee_member,
  -- remove_committee_member, create_khata_link, revoke_khata_link,
  -- get_khata_view, preview_group_by_code, and the six atomic-money engines:
  -- transfer_between_accounts, record_loan_repayment, create_loan_with_leg,
  -- contribute_to_goal, pay_card_bill, record_single_leg_entry,
  -- record_investment_trade, apply_goal_saved_delta).
  -- 2026-09-19: + set_group_admin (supabase-migration-group-admins.sql).
  -- 2026-09-24: + record_received_repayment, apply_own_settlement_request,
  --   undo_received_repayment, set_settlement_repayment_account
  --   (supabase-migration-settlement-receiver-records.sql). Its _lsr_* helpers
  --   are internal and must NEVER be added here.
  v_client_rpcs TEXT[] := ARRAY[
    'accept_group_invite',            'accept_group_membership',
    'accept_linked_request',          'accept_settlement_request',
    'add_committee_member',           'add_group_guest',
    'analytics_daily_series',         'analytics_monthly_summary',
    'analytics_top_expenses',         'apply_account_balance_delta',
    'apply_goal_saved_delta',         'apply_loan_remaining_delta',
    'apply_own_settlement_request',   'record_received_repayment',
    'set_settlement_repayment_account', 'undo_received_repayment',
    'archive_contact_if_settled',     'archive_group',
    'cancel_linked_request',          'cancel_settlement_request',
    'contribute_to_goal',             'create_khata_link',
    'create_loan_with_leg',           'create_settlement_request',
    'decline_group_membership',       'delete_current_user',
    'get_committee_witness',          'get_khata_view',
    'join_group_by_code',             'leave_group',
    'link_contact_by_code',           'link_contact_by_discovery',
    'list_pending_group_memberships', 'lookup_hisaab_users_by_phone',
    'lookup_profile_by_code',         'merge_person',
    'notify_contact_linked',          'pay_card_bill',
    'perform_committee_draw',         'preview_group_by_code',
    'reconcile_group_expense',        'record_group_settlement',
    'record_investment_trade',        'record_loan_repayment',
    'record_single_leg_entry',        'register_push_token',
    'reject_linked_request',          'reject_settlement_request',
    'remove_committee_member',        'remove_group_guest',
    'respond_contact_link',           'revoke_committee_witness_token',
    'revoke_khata_link',              'rotate_committee_witness_token',
    'set_group_admin',
    'transfer_between_accounts',      'transfer_group_ownership',
    'unarchive_contact',              'unarchive_group',
    'unlink_contact_profile',         'update_committee'
  ];

  -- ── INTERNALS THAT MUST KEEP `authenticated` ANYWAY ───────────────────────
  -- None of these is ever called from `src/`. Each is required because some
  -- caller-privileged code path (an RLS policy, or a SECURITY INVOKER trigger)
  -- calls it as the writing user. See R1/R2 in the header.
  --
  --   is_current_profile_active  — 34 RLS policies ("Active profiles only")
  --   is_group_member            — 9 RLS policies + tg_group_expenses_
  --                                require_connected_members + its settlements
  --                                twin (both SECURITY INVOKER)
  --   group_settlement_cap       — tg_group_settlements_enforce_cap()
  --                                (SECURITY INVOKER; the overpayment cap)
  --   group_member_net_balances  — tg_split_groups_guard_delete()
  --                                (SECURITY INVOKER; group deletion guard)
  --   is_group_admin             — 4 owner-or-admin RLS policies on
  --                                split_groups / group_members /
  --                                group_invites (supabase-migration-group-
  --                                admins.sql §4). Revoking it would 42501
  --                                every group edit, the owner's included.
  v_internal_keep TEXT[] := ARRAY[
    'is_current_profile_active',
    'is_group_member',
    'group_settlement_cap',
    'group_member_net_balances',
    'is_group_admin'
  ];

  -- ── TRIGGER FUNCTIONS THAT PREDATE THE `tg_` PREFIX ───────────────────────
  -- Swept by 2c alongside `tg\_%`. They are trigger bodies, nothing more.
  v_extra_triggers TEXT[] := ARRAY[
    'handle_new_user',                            -- AFTER INSERT auth.users
    'enforce_group_expense_reconciliation_payer', -- BEFORE UPDATE group_expenses
    'hisaab_broadcast_money_change',              -- AFTER * accounts/txns/loans
    'touch_app_config_updated_at'                 -- BEFORE UPDATE app_config
  ];

  v_rev_anon INT := 0;
  v_rev_auth INT := 0;
  v_rev_trig INT := 0;
  v_gr_anon  INT := 0;
  v_gr_auth  INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef,
           (p.proname LIKE 'tg\_%' OR p.proname = ANY(v_extra_triggers)) AS is_trigger_fn
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       -- Same exclusion as §1: an extension's own functions are not ours to
       -- re-ACL. (None is SECURITY DEFINER or `tg_`-prefixed today; the
       -- exclusion is here so a future `CREATE EXTENSION … WITH SCHEMA public`
       -- cannot make this sweep start rewriting somebody else's grants.)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY p.proname
  LOOP
    -- ── 2c. trigger functions: nothing client-facing, ever ──────────────────
    IF r.is_trigger_fn THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
        r.proname, r.args);
      v_rev_trig := v_rev_trig + 1;
      CONTINUE;
    END IF;

    -- ── 2a/2b apply to SECURITY DEFINER functions only ──────────────────────
    -- A SECURITY INVOKER function is bounded by the caller's own RLS; the
    -- advisor does not flag it and neither do we. (`apply_account_balance_delta`
    -- and the four notification-text helpers live here.)
    IF NOT r.prosecdef THEN
      CONTINUE;
    END IF;

    -- 2a. anon
    IF r.proname = ANY(v_anon_rpcs) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO anon',
                     r.proname, r.args);
      v_gr_anon := v_gr_anon + 1;
    ELSE
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon',
        r.proname, r.args);
      v_rev_anon := v_rev_anon + 1;
    END IF;

    -- 2b. authenticated
    IF r.proname = ANY(v_client_rpcs) OR r.proname = ANY(v_internal_keep) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated',
                     r.proname, r.args);
      v_gr_auth := v_gr_auth + 1;
    ELSE
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM authenticated',
        r.proname, r.args);
      v_rev_auth := v_rev_auth + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '[p3-rpc-execute-grants] §2: % trigger fn(s) closed to both client roles',
               v_rev_trig;
  RAISE NOTICE '[p3-rpc-execute-grants] §2: definer fns — anon: % revoked / % granted; authenticated: % revoked / % granted',
               v_rev_anon, v_gr_anon, v_rev_auth, v_gr_auth;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Client RPCs that are SECURITY INVOKER
--
-- `apply_account_balance_delta` is the one client RPC that is NOT SECURITY
-- DEFINER (it is the optimistic-lock CAS; RLS on `accounts` is what scopes
-- it). §2 skips SECURITY INVOKER functions entirely, so it is untouched — but
-- state the grant explicitly rather than relying on Supabase's default
-- privileges, which §4 is about to narrow.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('apply_account_balance_delta')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated',
                   r.proname, r.args);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon',
                   r.proname, r.args);
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Make the DEFAULT safe, so the next migration cannot reopen this
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role` in `public`. That is why every one of the
-- 27 anon-executable definer functions got that way: nobody granted anything,
-- the default did. Narrowing the default is the only fix that survives the
-- next `CREATE FUNCTION` written by somebody who did not read this file.
--
-- DEFAULT PRIVILEGES ARE PER CREATING ROLE. An `ALTER DEFAULT PRIVILEGES`
-- with no `FOR ROLE` applies to `current_user` only — which would silently do
-- nothing for functions created by a different role. So: apply it to every
-- role that actually owns a function in `public` today, plus `current_user`.
-- In practice that is `postgres` in both environments — Supabase Studio's SQL
-- Editor runs as `postgres`, and `supabase/tests/run.sh` connects as
-- `postgres` (`psql -U postgres`, run.sh:83).
--
-- `authenticated` is deliberately LEFT in the default. New client RPCs are the
-- common case and PostgREST is useless without it; `anon` and PUBLIC are the
-- ones with no legitimate default. A future function that genuinely needs
-- `anon` must say so with an explicit GRANT — and be added to §2's
-- `v_anon_rpcs`, or the next run of this file will take it away again.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r     RECORD;
  v_n   INT := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT rolname
      FROM (
        SELECT pg_get_userbyid(p.proowner) AS rolname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
        UNION
        SELECT current_user
      ) s
     WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = s.rolname)
     ORDER BY 1
  LOOP
    -- `ALTER DEFAULT PRIVILEGES FOR ROLE x` requires membership in x. On
    -- Supabase, `postgres` is not a superuser; if a project turns out to own
    -- functions as a role `postgres` is not a member of, warn by name instead
    -- of aborting — the per-function ACLs in §2 are already correct either
    -- way, and this section only governs FUTURE functions.
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', r.rolname);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE EXECUTE ON FUNCTIONS FROM anon', r.rolname);
      v_n := v_n + 1;
      RAISE NOTICE '[p3-rpc-execute-grants] §4: default EXECUTE closed to PUBLIC+anon for role %',
                   r.rolname;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[p3-rpc-execute-grants] §4: could NOT narrow default privileges for role %: %',
                    r.rolname, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE '[p3-rpc-execute-grants] §4: % role(s) updated', v_n;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. VERIFICATION — runs as part of the apply. RAISEs on drift.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_anon_defs   TEXT;
  v_auth_trig   TEXT;
  v_no_path     TEXT;
  v_missing_rpc TEXT;
  v_allow       TEXT[] := ARRAY['get_committee_witness','get_khata_view'];
BEGIN
  -- V1. No SECURITY DEFINER function in public is anon-executable, except the
  --     two documented capability-URL names.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_anon_defs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT (p.proname = ANY(v_allow));
  IF v_anon_defs IS NOT NULL THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V1 FAILED — anon can still execute: %', v_anon_defs;
  END IF;

  -- V2. No trigger function is executable by anon or authenticated.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_auth_trig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'tg\_%'
          OR p.proname IN ('handle_new_user','enforce_group_expense_reconciliation_payer',
                           'hisaab_broadcast_money_change','touch_app_config_updated_at'))
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_auth_trig IS NOT NULL THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V2 FAILED — a client role can still execute trigger fn(s): %', v_auth_trig;
  END IF;

  -- V3. Every function in public pins a search_path.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_no_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'))
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass
                        AND d.objid = p.oid AND d.deptype = 'e');
  IF v_no_path IS NOT NULL THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V3 FAILED — no search_path on: %', v_no_path;
  END IF;

  -- V4. Every RLS-policy-referenced helper is still executable by
  --     `authenticated` (the R1 regression guard — this is the one that takes
  --     the app down, and it must be checked, not assumed).
  IF NOT (has_function_privilege('authenticated', 'public.is_current_profile_active()', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.is_group_member(text, uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V4 FAILED — an RLS-policy helper lost EXECUTE for authenticated; every table read is now a 42501';
  END IF;
  -- is_group_admin arrives with supabase-migration-group-admins.sql, so it is
  -- checked only where it exists (nested IF: has_function_privilege RAISES on
  -- a missing signature, and AND is not promised to short-circuit).
  IF to_regprocedure('public.is_group_admin(text, uuid)') IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', 'public.is_group_admin(text, uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'p3-rpc-execute-grants V4 FAILED — is_group_admin lost EXECUTE for authenticated; every owner-or-admin group write is now a 42501';
    END IF;
  END IF;

  -- V5. The two SECURITY INVOKER trigger callees (R2) kept `authenticated`.
  IF NOT (has_function_privilege('authenticated', 'public.group_settlement_cap(text, text, text, boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.group_member_net_balances(text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V5 FAILED — a SECURITY INVOKER trigger callee lost EXECUTE; the settlement cap / group-deletion guard will 42501';
  END IF;

  -- V6. Every client RPC that EXISTS is executable by authenticated. (A name
  --     in the allowlist with no matching function is reported, not fatal —
  --     the client tolerates PGRST202 for the flag-gated engines.)
  SELECT string_agg(x.n, ', ' ORDER BY x.n) INTO v_missing_rpc
    FROM unnest(ARRAY[
      'accept_group_invite','accept_group_membership','accept_linked_request',
      'accept_settlement_request','add_committee_member','add_group_guest',
      'analytics_daily_series','analytics_monthly_summary','analytics_top_expenses',
      'apply_account_balance_delta','apply_goal_saved_delta','apply_loan_remaining_delta',
      'archive_contact_if_settled','archive_group','cancel_linked_request',
      'cancel_settlement_request','contribute_to_goal','create_khata_link',
      'create_loan_with_leg','create_settlement_request','decline_group_membership',
      'delete_current_user','get_committee_witness','get_khata_view',
      'join_group_by_code','leave_group','link_contact_by_code',
      'link_contact_by_discovery','list_pending_group_memberships',
      'lookup_hisaab_users_by_phone','lookup_profile_by_code','merge_person',
      'notify_contact_linked','pay_card_bill','perform_committee_draw',
      'preview_group_by_code','reconcile_group_expense','record_group_settlement',
      'record_investment_trade','record_loan_repayment','record_single_leg_entry',
      'register_push_token','reject_linked_request','reject_settlement_request',
      'remove_committee_member','remove_group_guest','respond_contact_link',
      'revoke_committee_witness_token','revoke_khata_link',
      'rotate_committee_witness_token','set_group_admin','transfer_between_accounts',
      'transfer_group_ownership','unarchive_contact','unarchive_group',
      'unlink_contact_profile','update_committee',
      'apply_own_settlement_request','record_received_repayment',
      'set_settlement_repayment_account','undo_received_repayment']) AS x(n)
   WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = x.n)
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = x.n
                        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_missing_rpc IS NOT NULL THEN
    RAISE EXCEPTION 'p3-rpc-execute-grants V6 FAILED — client RPC(s) not executable by authenticated: %', v_missing_rpc;
  END IF;

  RAISE NOTICE '[p3-rpc-execute-grants] V1-V6 verification passed.';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATOR QUERIES — read-only, run by hand after applying.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- V7. THE ADVISOR'S OWN QUERY. Re-run Supabase Studio → Advisors → Security
--     after applying; `security_definer_function_executable_by_anon` should
--     report EXACTLY the two allowlisted names (get_committee_witness,
--     get_khata_view), and
--     `function_search_path_mutable` should report zero rows in `public`.
--     The SQL equivalent, so you can diff it without the dashboard:
--
--   SELECT p.proname,
--          pg_get_function_identity_arguments(p.oid)               AS args,
--          p.prosecdef                                             AS security_definer,
--          has_function_privilege('anon',          p.oid,'EXECUTE') AS anon_can,
--          has_function_privilege('authenticated', p.oid,'EXECUTE') AS auth_can,
--          coalesce(array_to_string(p.proconfig, ','), '(none)')    AS proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--    ORDER BY p.prosecdef DESC, anon_can DESC, p.proname;
--
-- V8. THE DEFAULT-PRIVILEGE STATE §4 installed. Expect one row per owning
--     role, and NO `anon=X` and no bare `=X` (PUBLIC) entry in `defaclacl`
--     for `defaclobjtype = 'f'`.
--
--   SELECT pg_get_userbyid(defaclrole) AS for_role, defaclobjtype, defaclacl
--     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
--    WHERE n.nspname = 'public';
--
-- V9. DRIFT WATCH — run after ANY future migration. If it returns rows, that
--     migration reopened something; re-run THIS file (it is idempotent) and
--     add any genuinely-new client RPC to §2's `v_client_rpcs` first.
--
--   SELECT p.proname, p.prosecdef,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND ( (p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
--             AND p.proname NOT IN ('get_committee_witness','get_khata_view'))
--         OR (p.proname LIKE 'tg\_%'
--             AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--         OR p.proconfig IS NULL );
--
-- V10. THE anon SMOKE TEST — the one thing V1-V6 cannot prove, because it
--      needs a real token. After applying, open a shared kameti witness link
--      and a shared khata link in a signed-out private window. Both must
--      still render. If either 404s or shows a permission error, §2's
--      `v_anon_rpcs` is short a name.
--
-- ── RLS-with-no-policies, confirmed BY DESIGN (advisor INFO item (d)) ───────
-- The advisor flagged `app_push_config` and `phone_lookup_attempts` as
-- "RLS enabled, zero policies". That is correct, intentional, and NOT changed
-- by this file. Both are touched only by SECURITY DEFINER code, which bypasses
-- RLS as the table owner; a policy could only ever widen the exposure.
--
--   • `app_push_config` (connections-push-discovery:447) holds the FCM server
--     key/endpoint that `tg_notifications_push()` reads. Still zero policies
--     after the whole branch.
--   • `phone_lookup_attempts` (connections-push-discovery, tightened by
--     audit-p0-consent-guards) is the rate-limit ledger behind
--     `lookup_hisaab_users_by_phone` / `lookup_profile_by_code`.
--     Client-readable it is an enumeration oracle; client-writable it is the
--     rate limit's own off switch.
--
--     **CORRECTION for anyone diffing production against this branch:** the
--     "zero policies" state is production's. `audit-p0-consent-guards.sql:302`
--     adds ONE policy to `phone_lookup_attempts` —
--     `"no client access to phone_lookup_attempts" FOR ALL USING (false)
--      WITH CHECK (false)` — an explicit deny-all. Its own comment says why:
--     "The original shipped with RLS on and no policies at all, which already
--     denies every client. An explicit deny-all says so out loud … so a future
--     'add a policy for debugging' cannot quietly widen it." So after applying
--     the branch, the advisor's INFO for that table disappears and is REPLACED
--     by a visible `USING (false)` policy. Same enforcement, louder. Do not
--     "fix" it back to zero policies.
--
-- Verify both are still shut:
--
--   SELECT c.relname, c.relrowsecurity,
--          (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) AS policies,
--          (SELECT count(*) FROM pg_policy pp
--            WHERE pp.polrelid = c.oid
--              AND coalesce(pg_get_expr(pp.polqual, pp.polrelid), '') <> 'false')
--            AS non_deny_policies
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN ('app_push_config', 'phone_lookup_attempts');
--   -- expect: relrowsecurity = t and non_deny_policies = 0 for both;
--   --         policies = 0 for app_push_config, 1 for phone_lookup_attempts.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- This file only narrows ACLs and pins search_path. To restore the (unsafe)
-- Supabase defaults exactly as they were:
--
--   DO $r$
--   DECLARE r RECORD;
--   BEGIN
--     FOR r IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) a
--                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--               WHERE n.nspname = 'public'
--     LOOP
--       EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO anon, authenticated',
--                      r.proname, r.a);
--     END LOOP;
--   END $r$;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--   -- search_path pins are left in place; unpinning is never the fix.
-- ════════════════════════════════════════════════════════════════════════════
