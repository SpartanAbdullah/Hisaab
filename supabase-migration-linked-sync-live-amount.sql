-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — A pending "Sync this record" mirrors the loan AS IT IS at accept
-- time (backlog 2026-09-22, item 5)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor. In production run this file on its own,
-- then re-run supabase-migration-p3-rpc-execute-grants.sql (it creates one
-- trigger function; the sweep revokes it from the client roles — this file
-- already does so itself, the re-run only keeps the sweep's §5 honest).
--
-- Apply AFTER supabase-migration-audit-p0-settlement-row-locks.sql, which owns
-- the LATEST definition of accept_linked_request(text, text) replaced below
-- (no later file replaces it: p2-trust-safety adds a BEFORE UPDATE trigger on
-- the state transition instead, and that trigger is untouched here). Canonical
-- slot: supabase/tests/apply-order.txt, after daily-close, before
-- p3-invariant-monitoring and the grants sweep.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before the
-- trigger. One transaction, self-verifying (§4): if a check fails, nothing is
-- applied. Same signature as before, so every existing grant survives.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY — the incident (2026-09-21)
-- ═══════════════════════════════════════════════════════════════════════════
-- The founder sent Ghulam a "Sync this record" request for a loan of
-- AED 1,581.80 (linked_transaction_requests.pre_existing_loan_id set, status
-- 'pending'; linkedRequestStore.syncPastRecords sends the loan's remaining at
-- SEND time as `amount`). While it sat pending the founder recorded two
-- repayments (1,440 and 93) on that loan: they applied locally at once and
-- were mirrored nowhere, because there is no linked pair until accept. Local
-- remaining: 48.80.
--
-- The accept RPC (audit-p0-settlement-row-locks.sql:457-491) then read only
-- the loan's STATUS, and created the receiver's mirror with
--     total_amount = remaining_amount = v_req.amount        -- 1,581.80
-- so Ghulam's copy would have started 1,533.00 too high, and the pair would
-- have been born diverged (exactly what p3-invariant-monitoring's
-- linked_pair_divergence check flags). The founder had to withdraw and
-- re-sync by hand.
--
-- Two more holes on the same path, found while reading it:
--   · a SOFT-DELETED loan (loansDb.delete only stamps deleted_at; status stays
--     'active') was still mirrored onto the receiver;
--   · the loan's currency was never compared with the request's.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FIX
-- ═══════════════════════════════════════════════════════════════════════════
-- §1 accept_linked_request(text, text) — body copied VERBATIM from
--    audit-p0-settlement-row-locks.sql:257-529 (lock order loans → accounts,
--    every guard, every error string, every insert), with five marked changes:
--      [S1] DECLARE: v_loan_remaining, v_loan_currency, v_loan_deleted_at,
--           v_amount.
--      [S2] fresh-loan path: v_amount := v_req.amount (behaviour unchanged).
--      [S3] sync path: the locked read now takes status, remaining_amount,
--           currency and deleted_at, and refuses
--             deleted / gone         → 'ltr: pre_existing loan no longer available'
--             not active / nothing
--             left (≤ 0.00001)       → 'ltr: pre_existing loan has been settled or archived'
--             currency changed       → 'ltr: pre_existing loan changed currency'
--           All three RAISE, like every other refusal in this RPC (it returns
--           the request row, so there is no status envelope to put them in);
--           src/lib/linkedErrorMap.ts turns them into bilingual copy.
--      [S4] sync path: v_amount := the loan's CURRENT remaining_amount. The
--           receiver's mirror is total = remaining = v_amount, which is the
--           same "what is open between us" representation a sync request
--           always carried (it sent the remaining, never the original total);
--           now it is simply current. The sender's loan is not touched — it
--           keeps its full history (total, repayments) as before.
--      [S5] the final UPDATE stores amount = v_amount on the accepted row, so
--           the request, the receiver's loan, the receiver's transaction and
--           the "Shared loan confirmed" notification (tg_ltr_notify reads
--           NEW.amount) all show the mirrored figure.
--    The loan row is already locked FOR UPDATE by [A1] before anything reads
--    it, so a repayment racing the accept either commits first (and the
--    accept mirrors the new remaining) or waits for the accept to commit.
--
-- §2 tg_loans_refresh_pending_sync — AFTER UPDATE OF remaining_amount ON
--    loans. When the sender's loan moves while its sync request is pending,
--    the request's `amount` follows it. This is what the RECEIVER sees: they
--    cannot read the sender's loan (RLS), so without it their Incoming card
--    and confirm sheet would still say 1,581.80. Rules:
--      · only pending rows with pre_existing_loan_id = this loan, same owner,
--        same currency;
--      · only when the new remaining is > 0 (ltr_amount_bounded needs
--        amount > 0; a settled loan is refused at accept by [S3] instead);
--      · `FOR UPDATE SKIP LOCKED` — it NEVER waits on a request row. accept /
--        reject / cancel lock the request row first and the loan second; a
--        repayment holds the loan and would then wait on the request →
--        ABBA deadlock. Skipping is safe: a row being accepted right now is
--        about to mirror the live remaining through [S4] anyway;
--      · it swallows its own errors (p2-notification-maturity RULE 4: nothing
--        new may break a money write). The accept-time read is the real
--        guarantee; this trigger only keeps the displayed figure fresh.
--    No RLS changes: the requester still has no UPDATE policy on
--    linked_transaction_requests; only this SECURITY DEFINER trigger writes.
--    Firing it does not notify anyone: tg_ltr_notify only reacts to INSERT
--    and pending → accepted/rejected, and tg_ltr_block_accept only to
--    → accepted.
--
-- BOTH DIRECTIONS / BOTH MODES
--   Fixed on the server, so it holds whoever recorded the repayment and in
--   whichever app mode (past-record syncs are ledger-only on both sides by
--   design: no account ids, so splits_only users take the same path).
--
-- CLIENT TOLERANCE
--   The client ships independently: before this file is applied the Outgoing
--   card already shows the loan's live remaining ("sent 1,581.80 · now
--   48.80") from the sender's own loans, but an accept would still mirror the
--   stale amount — so apply this before anyone accepts an old sync.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- §0 Legacy 1-arg signature must not survive (ambiguous PostgREST overload).
-- No-op since cross-user-account-effects; kept for a partially migrated DB.
drop function if exists public.accept_linked_request(text);

-- ═══════════════════════════════════════════════════════════════════════════
-- §1 accept_linked_request — mirrors the sender's loan as it is now  [S1-S5]
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.accept_linked_request(
  request_id text,
  responder_account_id text default null
)
returns public.linked_transaction_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req       public.linked_transaction_requests;
  v_from_name text;
  v_to_name   text;
  v_sender_person_name   text;
  v_sender_person_id     text;
  v_receiver_person_id   text;
  v_requester_loan_id    text;
  v_responder_loan_id    text;
  v_requester_txn_id     text;
  v_responder_txn_id     text;
  v_requester_loan_type  text;
  v_responder_loan_type  text;
  v_requester_txn_type   text;
  v_responder_txn_type   text;
  v_loan_status          text;
  -- [S1] the sender's loan as it is NOW (sync path) and the amount mirrored.
  v_loan_remaining       numeric;
  v_loan_currency        text;
  v_loan_deleted_at      timestamptz;
  v_amount               numeric;
  v_r_acct               public.accounts;
  v_p_acct               public.accounts;
  v_now                  timestamptz := now();
begin
  select * into v_req
    from public.linked_transaction_requests
   where id = request_id
   for update;
  if not found then
    raise exception 'ltr: request not found';
  end if;
  if v_req.status <> 'pending' then
    return v_req;
  end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'ltr: only the target user can accept';
  end if;

  -- Past-record syncs are ledger-only on both sides (see trigger).
  if v_req.pre_existing_loan_id is not null and responder_account_id is not null then
    raise exception 'ltr: past-record sync is ledger-only';
  end if;

  -- [A1] LOCK ORDER: loans first, before any account row. The sync path below
  -- reads this loan's status and then adopts it as the requester side of the
  -- pair, so the row must be pinned for the whole transaction — otherwise a
  -- concurrent repayment can settle it while the receiver's mirror is being
  -- inserted at the full amount.
  if v_req.pre_existing_loan_id is not null then
    perform 1
      from public.loans
     where id = v_req.pre_existing_loan_id
       and user_id = v_req.from_user_id
     order by id
     for update;
  end if;

  -- [A2] LOCK ORDER: both account rows, ascending id, in ONE statement, after
  -- the loan lock. NULL ids match nothing, so ledger-only sides are unaffected.
  perform 1
    from public.accounts
   where id in (v_req.requester_account_id, responder_account_id)
   order by id
   for update;

  -- Sender-side opted-in account: re-validate at accept time. Raising here
  -- (rather than silently downgrading to ledger-only) follows the
  -- settlement precedent — the sender must cancel and resend rather than
  -- have their stated account effect silently dropped.
  if v_req.requester_account_id is not null then
    select * into v_r_acct
      from public.accounts
     where id = v_req.requester_account_id
     for update;
    if not found then
      raise exception 'ltr: requester account not found';
    end if;
    if v_r_acct.user_id <> v_req.from_user_id then
      raise exception 'ltr: requester account not owned';
    end if;
    if v_r_acct.deleted_at is not null then
      raise exception 'ltr: requester account was deleted';
    end if;
    if v_r_acct.currency <> v_req.currency then
      raise exception 'ltr: requester account currency mismatch';
    end if;
  end if;

  -- Receiver-side account: the acceptor just picked it, so any failure is
  -- immediate feedback, not a bricked request.
  if responder_account_id is not null then
    select * into v_p_acct
      from public.accounts
     where id = responder_account_id
     for update;
    if not found then
      raise exception 'ltr: responder account not found';
    end if;
    if v_p_acct.user_id <> v_req.to_user_id then
      raise exception 'ltr: responder account not owned';
    end if;
    if v_p_acct.deleted_at is not null then
      raise exception 'ltr: responder account was deleted';
    end if;
    if v_p_acct.currency <> v_req.currency then
      raise exception 'ltr: responder account currency mismatch';
    end if;
  end if;

  -- Direction from sender kind.
  if v_req.kind = 'lent' then
    v_requester_loan_type := 'given';
    v_responder_loan_type := 'taken';
    v_requester_txn_type  := 'loan_given';
    v_responder_txn_type  := 'loan_taken';
  else
    v_requester_loan_type := 'taken';
    v_responder_loan_type := 'given';
    v_requester_txn_type  := 'loan_taken';
    v_responder_txn_type  := 'loan_given';
  end if;

  -- Sender + receiver display-name cache.
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_to_name
    from public.profiles p where p.id = v_req.to_user_id;

  -- Sender's person row (may be null if unlinked after creation).
  select p.id, coalesce(nullif(trim(p.name), ''), v_to_name)
    into v_sender_person_id, v_sender_person_name
    from public.persons p
   where p.id = v_req.person_id
     and p.user_id = v_req.from_user_id;

  -- Receiver's person row: find-or-create against the Phase 2A unique
  -- partial index on (user_id, linked_profile_id) where not null.
  select p.id into v_receiver_person_id
    from public.persons p
   where p.user_id = v_req.to_user_id
     and p.linked_profile_id = v_req.from_user_id
   limit 1;

  if v_receiver_person_id is null then
    v_receiver_person_id := gen_random_uuid()::text;
    begin
      insert into public.persons(id, user_id, name, phone, linked_profile_id, created_at, updated_at)
      values (v_receiver_person_id, v_req.to_user_id, v_from_name, null, v_req.from_user_id, v_now, v_now);
    exception when unique_violation then
      select p.id into v_receiver_person_id
        from public.persons p
       where p.user_id = v_req.to_user_id
         and p.linked_profile_id = v_req.from_user_id
       limit 1;
    end;
  end if;

  -- Receiver-side mirror IDs (always fresh).
  v_responder_loan_id := gen_random_uuid()::text;
  v_responder_txn_id  := gen_random_uuid()::text;

  if v_req.pre_existing_loan_id is null then
    -- ─── Fresh-loan path: brand-new loan on both sides ───
    -- [S2] a fresh request mirrors exactly what was asked, as before.
    v_amount := v_req.amount;
    v_requester_loan_id := gen_random_uuid()::text;
    v_requester_txn_id  := gen_random_uuid()::text;

    insert into public.loans(
      id, user_id, person_name, person_id, type,
      total_amount, remaining_amount, currency, status, notes, created_at
    ) values (
      v_requester_loan_id, v_req.from_user_id,
      coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_type,
      v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
    );

    -- Sender-side mirrored transaction, now carrying the opted-in account.
    insert into public.transactions(
      id, user_id, type, amount, currency,
      source_account_id, destination_account_id,
      related_person, person_id, related_loan_id, related_goal_id,
      conversion_rate, category, notes, created_at
    ) values (
      v_requester_txn_id, v_req.from_user_id, v_requester_txn_type, v_req.amount, v_req.currency,
      case when v_requester_txn_type = 'loan_given' then v_req.requester_account_id else null end,
      case when v_requester_txn_type = 'loan_taken' then v_req.requester_account_id else null end,
      coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_id, null,
      null, '', v_req.note, v_now
    );

    -- Sender balance: lent = money left, borrowed = money arrived.
    if v_req.requester_account_id is not null then
      update public.accounts
         set balance = balance + case when v_req.kind = 'lent' then -v_req.amount else v_req.amount end
       where id = v_req.requester_account_id
         and user_id = v_req.from_user_id
         and deleted_at is null;
    end if;
  else
    -- ─── Past-record sync path: reuse sender-side loan + transaction ───
    -- [A3] `for update` (row already pinned by [A1]; explicit here so the
    -- read-then-adopt shape stays obviously locked).
    -- [S3] read the loan AS IT IS NOW: remaining, currency and tombstone too,
    -- not just status. The request's amount is the remaining at SEND time;
    -- repayments recorded while the request sat pending moved the loan.
    select status, remaining_amount, currency, deleted_at
      into v_loan_status, v_loan_remaining, v_loan_currency, v_loan_deleted_at
      from public.loans
     where id = v_req.pre_existing_loan_id
       and user_id = v_req.from_user_id
     for update;
    -- A soft-deleted loan keeps status 'active' (loansDb.delete only stamps
    -- deleted_at), so the tombstone must be checked on its own.
    if v_loan_status is null or v_loan_deleted_at is not null then
      raise exception 'ltr: pre_existing loan no longer available';
    end if;
    if v_loan_status <> 'active' or coalesce(v_loan_remaining, 0) <= 0.00001 then
      raise exception 'ltr: pre_existing loan has been settled or archived';
    end if;
    if v_loan_currency is distinct from v_req.currency then
      raise exception 'ltr: pre_existing loan changed currency';
    end if;

    -- [S4] mirror the live remaining, not the stale request amount.
    v_amount := v_loan_remaining;

    v_requester_loan_id := v_req.pre_existing_loan_id;

    select id into v_requester_txn_id
      from public.transactions
     where related_loan_id = v_requester_loan_id
       and user_id = v_req.from_user_id
       and type in ('loan_given', 'loan_taken')
     order by created_at asc
     limit 1;
  end if;

  -- Receiver-side mirrored loan.
  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_responder_loan_id, v_req.to_user_id,
    v_from_name, v_receiver_person_id, v_responder_loan_type,
    v_amount, v_amount, v_req.currency, 'active', v_req.note, v_now
  );

  -- Receiver-side mirrored transaction, carrying the acceptor's account.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_responder_txn_id, v_req.to_user_id, v_responder_txn_type, v_amount, v_req.currency,
    case when v_responder_txn_type = 'loan_given' then responder_account_id else null end,
    case when v_responder_txn_type = 'loan_taken' then responder_account_id else null end,
    v_from_name, v_receiver_person_id, v_responder_loan_id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver balance: they accepted "borrowed" = money arrived; accepted
  -- "they borrowed from me" = money left.
  if responder_account_id is not null then
    update public.accounts
       set balance = balance + case when v_responder_txn_type = 'loan_taken' then v_amount else -v_amount end
     where id = responder_account_id
       and user_id = v_req.to_user_id
       and deleted_at is null;
  end if;

  -- [S5] the accepted row records the amount actually mirrored, so the
  -- request, the receiver's loan and the "confirmed" notification agree.
  update public.linked_transaction_requests
     set status = 'accepted',
         amount = v_amount,
         responded_at = v_now,
         requester_loan_id = v_requester_loan_id,
         responder_loan_id = v_responder_loan_id,
         requester_txn_id  = v_requester_txn_id,
         responder_txn_id  = v_responder_txn_id,
         responder_account_id = accept_linked_request.responder_account_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

revoke all on function public.accept_linked_request(text, text) from public, anon;
grant execute on function public.accept_linked_request(text, text) to authenticated;

COMMENT ON FUNCTION public.accept_linked_request(text, text) IS
  'Accepts a linked loan request. Locks the sender''s pre-existing loan (sync path) before any account row (loans -> accounts). A past-record sync mirrors the sender''s loan AS IT IS at accept time (current remaining; refuses a deleted, settled or re-currencied loan) and stores the mirrored amount on the request (backlog 2026-09-22 item 5).';

-- ═══════════════════════════════════════════════════════════════════════════
-- §2 A pending sync request follows its loan's remaining
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_loans_refresh_pending_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null
     and new.remaining_amount > 0.00001
     and new.remaining_amount < 1e12 then
    update public.linked_transaction_requests r
       set amount = new.remaining_amount
     where r.id in (
       select q.id
         from public.linked_transaction_requests q
        where q.pre_existing_loan_id = new.id
          and q.status = 'pending'
          and q.from_user_id = new.user_id
          and q.currency = new.currency
          and q.amount is distinct from new.remaining_amount
        for update skip locked
     );
  end if;
  return null;  -- AFTER trigger: return value ignored.
exception when others then
  -- Never break the repayment that fired this. The accept RPC re-reads the
  -- loan anyway ([S3]/[S4]); a stale display figure is the worst case.
  raise warning 'tg_loans_refresh_pending_sync: % (%)', sqlerrm, sqlstate;
  return null;
end $$;

drop trigger if exists loans_refresh_pending_sync on public.loans;
create trigger loans_refresh_pending_sync
  after update of remaining_amount on public.loans
  for each row
  when (new.remaining_amount is distinct from old.remaining_amount)
  execute function public.tg_loans_refresh_pending_sync();

-- Trigger bodies are never client RPCs (p3-rpc-execute-grants §2c).
revoke all on function public.tg_loans_refresh_pending_sync() from public, anon, authenticated;

COMMENT ON FUNCTION public.tg_loans_refresh_pending_sync() IS
  'Keeps a pending past-record sync request''s amount equal to its loan''s current remaining (display for the receiver, who cannot read the sender''s loan). SKIP LOCKED: never waits on a request row. Backlog 2026-09-22 item 5.';

-- ═══════════════════════════════════════════════════════════════════════════
-- §3 Self-verification — any failure aborts the whole transaction
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_src  text;
  v_fn   record;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_linked_request'
     AND pg_get_function_identity_arguments(p.oid) = 'request_id text, responder_account_id text';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linked-sync-live-amount: accept_linked_request(text, text) is missing';
  END IF;
  v_src := v_fn.prosrc;
  IF NOT v_fn.prosecdef OR NOT ('search_path=public' = ANY (v_fn.proconfig)) THEN
    RAISE EXCEPTION 'linked-sync-live-amount: accept_linked_request lost SECURITY DEFINER / search_path';
  END IF;
  IF v_src NOT LIKE '%v_amount := v_loan_remaining;%'
     OR v_src NOT LIKE '%amount = v_amount,%'
     OR v_src NOT LIKE '%v_loan_deleted_at is not null%'
     OR v_src NOT LIKE '%ltr: pre_existing loan changed currency%'
     OR v_src NOT ILIKE '%where id = v_req.pre_existing_loan_id%for update%' THEN
    RAISE EXCEPTION 'linked-sync-live-amount: accept_linked_request body is not the live-amount version';
  END IF;
  IF to_regprocedure('public.accept_linked_request(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'linked-sync-live-amount: legacy 1-arg accept_linked_request still exists';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.accept_linked_request(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.accept_linked_request(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'linked-sync-live-amount: accept_linked_request grants are wrong';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.loans'::regclass
       AND t.tgname = 'loans_refresh_pending_sync'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'linked-sync-live-amount: loans_refresh_pending_sync trigger is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_loans_refresh_pending_sync()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_loans_refresh_pending_sync()', 'EXECUTE') THEN
    RAISE EXCEPTION 'linked-sync-live-amount: the trigger function is executable by a client role';
  END IF;

  RAISE NOTICE 'linked-sync-live-amount: OK';
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual)
-- ════════════════════════════════════════════════════════════════════════════
--   1. DROP TRIGGER IF EXISTS loans_refresh_pending_sync ON public.loans;
--      DROP FUNCTION IF EXISTS public.tg_loans_refresh_pending_sync();
--   2. Re-run SECTION 1 + SECTION 3 of
--      supabase-migration-audit-p0-settlement-row-locks.sql (lines 250-529
--      and the accept_linked_request grant/comment) to restore the previous
--      accept body — i.e. mirror the SEND-time amount again.
--   Rows already accepted under this version keep their (correct) amounts.
--   The client needs no rollback: its live-remaining line reads the sender's
--   own loans and the two new error mappings simply stop matching.
