-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — The person who RECEIVED the money records it: both ledgers update
-- at once. Plus Undo (10 minutes) and "Add to an account" for record-only
-- settlements. (2026-09-24, Release A of the settlement model change)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor, on its own, then RE-RUN
-- supabase-migration-p3-rpc-execute-grants.sql (its allowlist names the four
-- new client RPCs; this file already grants/revokes them itself, the re-run
-- keeps the sweep's checks honest).
--
-- Apply AFTER supabase-migration-linked-sync-live-amount.sql. Canonical slot:
-- supabase/tests/apply-order.txt, right after linked-sync-live-amount, before
-- p3-invariant-monitoring and the grants sweep.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraints, CREATE OR REPLACE
-- FUNCTION. One transaction, self-verifying (§6): if a check fails, nothing is
-- applied. Safe to apply before the matching client ships — old clients never
-- call the new RPCs, and every existing RPC keeps its signature and behaviour.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY — the incident (2026-09-24)
-- ═══════════════════════════════════════════════════════════════════════════
-- Ghulam repaid AED 3,000 in cash; the founder deposited it into Mashreq Bank
-- and recorded it with "Settle across all loans". That flow's "Apply to one
-- of my accounts" switch was OFF by default, so create_settlement_request got
-- requester_account_id = NULL and accept_settlement_request wrote the
-- founder's repayment rows with BOTH account ids NULL ("record only"). The
-- 3,000 never reached Mashreq in Hisaab, the founder could not record the two
-- card bills paid from it, and nothing could fix it afterwards (repayments
-- are not editable). And the founder's own books had to WAIT for Ghulam — a
-- casual web user who gets no push — to confirm.
--
-- Founder decision (2026-09-24): "Receiver records = instant". A repayment
-- recorded by the person who RECEIVED the money only ever helps the payer, so
-- it needs no one's consent: it applies to both ledgers immediately and the
-- payer is simply told. A payer's claim still waits for the receiver's OK.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS ADDS
-- ═══════════════════════════════════════════════════════════════════════════
-- §1 linked_settlement_requests.recorded_by_receiver + undone_at (+ CHECKs).
--    Applied rows stay status 'accepted' (everything already reads that as
--    "applied on both ledgers"); an undone row is 'cancelled' + undone_at, so
--    no new status value exists and old clients show "Cancelled".
-- §2 tg_lsr_validate_insert re-created VERBATIM from
--    supabase-migration-fix-bidirectional-linked-settlements.sql:67-149 with
--    one marked change [V1]: an INSERT can never carry the new flags or a
--    responder account (a raw client insert stays allowed by lsr_insert_own).
-- §3 Internal helpers (SECURITY DEFINER, closed to every client role):
--      _lsr_lock_rows, _lsr_apply_side, _lsr_reverse_side, _lsr_apply_pair,
--      _lsr_notify_info.
--    _lsr_apply_side is accept_settlement_request's per-side body (repayment
--    row, balance, atomic remaining delta, EMI coverage). accept itself is NOT
--    touched here: production verification scripts pin its body
--    (audit-p0-settlement-row-locks.sql §4.3, supabase-audit-p0-verification
--    .sql). The DB harness proves the helpers produce the same rows.
-- §4 Client RPCs:
--      record_received_repayment      — the receiver records; applies at once
--      apply_own_settlement_request   — the receiver applies their own PENDING
--                                       request (unsticks casual payers)
--      undo_received_repayment        — 10-minute undo of a receiver record
--      set_settlement_repayment_account — "Add to an account": attach an
--                                       account to MY side of an accepted
--                                       settlement that was record-only
-- §5 tg_lsr_notify: a receiver record says nothing at INSERT (it would be a
--    false "Repayment to confirm") and tells the PAYER on apply/undo, with a
--    NEW notification type 'linked_info' (the client hides 'linked_settlement'
--    rows as request mirrors). Existing branches unchanged.
-- §6 Self-check.
--
-- LOCK ORDER, repo-wide: request row → loans (id asc) → accounts (id asc) →
-- transactions (id asc). record_received_repayment locks BEFORE its INSERT
-- because the insert validator takes FOR SHARE on the account.
--
-- APP MODES: nothing here depends on the mode. A ledger-only (splits_only)
-- user sends no account (NULL = record only) and never sees "Add to an
-- account"; a full-tracker user picks one. Each side's account touches only
-- that side's books.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Columns + constraints
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.linked_settlement_requests
  add column if not exists recorded_by_receiver boolean not null default false;
alter table public.linked_settlement_requests
  add column if not exists undone_at timestamptz;

comment on column public.linked_settlement_requests.recorded_by_receiver is
  'TRUE when the person who RECEIVED the money recorded it (record_received_repayment / apply_own_settlement_request): applied to both ledgers at once, no confirmation. Set only by those RPCs; tg_lsr_validate_insert forces FALSE on every INSERT.';
comment on column public.linked_settlement_requests.undone_at is
  'When a receiver-recorded repayment was undone (undo_received_repayment, 10-minute window). Status is then ''cancelled''.';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'lsr_recorded_status_chk'
                    and conrelid = 'public.linked_settlement_requests'::regclass) then
    alter table public.linked_settlement_requests
      add constraint lsr_recorded_status_chk
      check (not recorded_by_receiver or status in ('accepted', 'cancelled')) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'lsr_undone_chk'
                    and conrelid = 'public.linked_settlement_requests'::regclass) then
    alter table public.linked_settlement_requests
      add constraint lsr_undone_chk
      check (undone_at is null or (recorded_by_receiver and status = 'cancelled')) not valid;
  end if;
end $$;

alter table public.linked_settlement_requests validate constraint lsr_recorded_status_chk;
alter table public.linked_settlement_requests validate constraint lsr_undone_chk;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. tg_lsr_validate_insert — verbatim + [V1]
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_lsr_validate_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_pair text;
  v_p_pair text;
  v_acct   public.accounts;
begin
  if new.from_user_id <> auth.uid() then
    raise exception 'lsr: from_user_id must be caller';
  end if;
  if new.from_user_id = new.to_user_id then
    raise exception 'lsr: self-settlement not allowed';
  end if;

  select * into v_r_loan from public.loans where id = new.requester_loan_id;
  if not found then
    raise exception 'lsr: requester loan not found';
  end if;
  if v_r_loan.user_id <> new.from_user_id then
    raise exception 'lsr: requester loan does not belong to sender';
  end if;

  select * into v_p_loan from public.loans where id = new.responder_loan_id;
  if not found then
    raise exception 'lsr: responder loan not found';
  end if;
  if v_p_loan.user_id <> new.to_user_id then
    raise exception 'lsr: responder loan does not belong to receiver';
  end if;

  select ltr.id into v_r_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_r_loan.id or ltr.responder_loan_id = v_r_loan.id);
  select ltr.id into v_p_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_p_loan.id or ltr.responder_loan_id = v_p_loan.id);
  if v_r_pair is null or v_p_pair is null or v_r_pair <> v_p_pair then
    raise exception 'lsr: loans do not share the same linked pair';
  end if;
  if new.loan_pair_id <> v_r_pair then
    raise exception 'lsr: loan_pair_id does not match the loans';
  end if;

  if v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: both loans must be active';
  end if;
  if v_r_loan.currency <> v_p_loan.currency or new.currency <> v_r_loan.currency then
    raise exception 'lsr: currency mismatch';
  end if;
  if new.amount > v_r_loan.remaining_amount or new.amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining';
  end if;
  if v_r_loan.type = v_p_loan.type then
    raise exception 'lsr: linked loan directions are invalid';
  end if;

  if new.requester_account_id is not null then
    select * into v_acct
      from public.accounts
     where id = new.requester_account_id
     for share;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_acct.user_id <> new.from_user_id then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_acct.currency <> new.currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  -- [V1] An INSERT is always a plain pending request. Only the SECURITY
  -- DEFINER RPCs below may mark a row receiver-recorded, undo it, or stamp a
  -- responder account — and they do it with an UPDATE (there is no UPDATE
  -- policy, so no client can).
  new.recorded_by_receiver := false;
  new.undone_at := null;
  new.responder_account_id := null;
  return new;
end $$;

drop trigger if exists lsr_validate_insert on public.linked_settlement_requests;
create trigger lsr_validate_insert before insert on public.linked_settlement_requests
for each row execute function public.tg_lsr_validate_insert();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Internal helpers — never client-callable
--
-- The CALLER owns authorization, validation and the request row's state; the
-- helpers only do the arithmetic every path must do identically. They are
-- SECURITY DEFINER on purpose: the grants sweep skips SECURITY INVOKER
-- functions and Supabase's default privileges would leave an INVOKER helper
-- executable by `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════

-- Canonical lock order: loans (id asc) first, then accounts (id asc), each in
-- ONE statement. NULL ids match nothing, so a record-only side locks no
-- account.
create or replace function public._lsr_lock_rows(p_loan_ids text[], p_account_ids text[])
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.loans
   where id = any (p_loan_ids)
   order by id
   for update;
  perform 1 from public.accounts
   where id = any (p_account_ids)
   order by id
   for update;
end $$;

-- One side of an applied settlement: exactly accept_settlement_request's
-- per-side effects (audit-p0-settlement-row-locks.sql:670-741). The account,
-- when given, is the source on a TAKEN loan and the destination on a GIVEN
-- loan — never a destination on a taken loan, which the client reads as a
-- card credit. Returns the new repayment transaction id.
create or replace function public._lsr_apply_side(
  p_user uuid,
  p_loan_id text,
  p_account_id text,
  p_amount numeric,
  p_currency text,
  p_counterparty_name text,
  p_person_id text,
  p_note text,
  p_now timestamptz
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_loan          public.loans;
  v_txn_id        text := gen_random_uuid()::text;
  v_new_remaining numeric;
  v_rows          int;
begin
  select * into v_loan
    from public.loans
   where id = p_loan_id and user_id = p_user;
  if not found then
    raise exception 'lsr: loan missing at apply';
  end if;

  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_txn_id, p_user, 'repayment', p_amount, p_currency,
    case when v_loan.type = 'taken' then p_account_id else null end,
    case when v_loan.type = 'given' then p_account_id else null end,
    p_counterparty_name, p_person_id, v_loan.id, null,
    null, '', coalesce(p_note, ''), p_now
  );

  if p_account_id is not null then
    update public.accounts
       set balance = balance + case when v_loan.type = 'given' then p_amount else -p_amount end
     where id = p_account_id
       and user_id = p_user
       and deleted_at is null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'lsr: account missing at apply';
    end if;
  end if;

  -- Atomic delta against the row's live value; same clamp and epsilon as
  -- accept [B3]/[B5].
  update public.loans
     set remaining_amount = greatest(0, remaining_amount - p_amount),
         status = case when remaining_amount - p_amount <= 0.00001
                         then 'settled' else 'active' end
   where id = v_loan.id
  returning remaining_amount into v_new_remaining;

  -- EMI schedule follows the money (accept [B4]/[B6]).
  update public.emi_schedules e
     set status = 'paid'
    from (
      select id,
             sum(amount) over (order by installment_number asc, id asc) as cum
        from public.emi_schedules
       where loan_id = v_loan.id
         and user_id = p_user
    ) c
   where e.id = c.id
     and e.loan_id = v_loan.id
     and e.user_id = p_user
     and e.status <> 'paid'
     and c.cum <= (v_loan.total_amount - v_new_remaining) + 0.00001;

  return v_txn_id;
end $$;

-- The exact inverse of _lsr_apply_side. The transaction is tombstoned
-- (deleted_at — incremental sync ships it as a deletion), the balance leg is
-- reversed, the loan re-opens, and EMIs past the new coverage go back to
-- 'upcoming' ('late' is never stored; it is derived at display time). The
-- EMI rule is recomputed, not restored from a snapshot, so an interleaved
-- later payment keeps its instalments paid — the SQL twin of
-- statusSyncToPaid (src/lib/emiCoverage.ts).
create or replace function public._lsr_reverse_side(
  p_user uuid,
  p_loan_id text,
  p_txn_id text,
  p_account_id text,
  p_amount numeric,
  p_now timestamptz
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_loan          public.loans;
  v_new_remaining numeric;
  v_rows          int;
begin
  select * into v_loan
    from public.loans
   where id = p_loan_id and user_id = p_user;
  if not found then
    raise exception 'lsr: loan missing at undo';
  end if;

  update public.transactions
     set deleted_at = p_now
   where id = p_txn_id
     and user_id = p_user
     and deleted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;

  if p_account_id is not null then
    update public.accounts
       set balance = balance + case when v_loan.type = 'given' then -p_amount else p_amount end
     where id = p_account_id
       and user_id = p_user
       and deleted_at is null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'lsr: account missing at undo';
    end if;
  end if;

  update public.loans
     set remaining_amount = least(total_amount, remaining_amount + p_amount),
         status = 'active'
   where id = v_loan.id
  returning remaining_amount into v_new_remaining;

  update public.emi_schedules e
     set status = 'upcoming'
    from (
      select id,
             sum(amount) over (order by installment_number asc, id asc) as cum
        from public.emi_schedules
       where loan_id = v_loan.id
         and user_id = p_user
    ) c
   where e.id = c.id
     and e.loan_id = v_loan.id
     and e.user_id = p_user
     and e.status = 'paid'
     and c.cum > (v_loan.total_amount - v_new_remaining) + 0.00001;
end $$;

-- Both sides of one settlement, requester first — the same names and person
-- ids accept_settlement_request writes (audit-p0-settlement-row-locks.sql
-- :652-667). Returns {requester_txn_id, responder_txn_id}.
create or replace function public._lsr_apply_pair(
  p_req public.linked_settlement_requests,
  p_requester_account_id text,
  p_responder_account_id text,
  p_now timestamptz
)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_from_name          text;
  v_to_name            text;
  v_sender_person_id   text;
  v_receiver_person_id text;
  v_req_txn_id         text;
  v_res_txn_id         text;
begin
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_from_name
    from public.profiles p where p.id = p_req.from_user_id;
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_to_name
    from public.profiles p where p.id = p_req.to_user_id;

  select p.id into v_sender_person_id
    from public.persons p
   where p.user_id = p_req.from_user_id
     and p.linked_profile_id = p_req.to_user_id
   limit 1;
  select p.id into v_receiver_person_id
    from public.persons p
   where p.user_id = p_req.to_user_id
     and p.linked_profile_id = p_req.from_user_id
   limit 1;

  v_req_txn_id := public._lsr_apply_side(
    p_req.from_user_id, p_req.requester_loan_id, p_requester_account_id,
    p_req.amount, p_req.currency, v_to_name, v_sender_person_id, p_req.note, p_now);
  v_res_txn_id := public._lsr_apply_side(
    p_req.to_user_id, p_req.responder_loan_id, p_responder_account_id,
    p_req.amount, p_req.currency, v_from_name, v_receiver_person_id, p_req.note, p_now);

  return array[v_req_txn_id, v_res_txn_id];
end $$;

-- Informational notice to the PAYER (to_user) — no action needed. Composed in
-- the recipient's own language (profiles.lang, p1-profile-lang) because the
-- push tray renders this text verbatim; the in-app card re-renders from
-- template + params. RULE 4 (p2-notification-maturity): a notice is never
-- worth rolling back money, so every error is swallowed.
create or replace function public._lsr_notify_info(
  p_req public.linked_settlement_requests,
  p_template text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor  text;
  v_lang   text;
  v_amount text := p_req.currency || ' ' || trim(to_char(p_req.amount, 'FM999999999990.00'));
  v_title  text;
  v_body   text;
begin
  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_actor
    from public.profiles p where p.id = p_req.from_user_id;
  select coalesce(p.lang, 'ur') into v_lang
    from public.profiles p where p.id = p_req.to_user_id;
  v_actor := coalesce(v_actor, 'A Hisaab user');

  if p_template = 'lsr_recorded' then
    if v_lang = 'en' then
      v_title := 'Repayment recorded';
      v_body  := v_actor || ' recorded your repayment of ' || v_amount || '. Nothing to confirm.';
    else
      v_title := 'Repayment record ho gayi';
      v_body  := v_actor || ' ne aap ki ' || v_amount || ' ki repayment record kar di. Kuch confirm nahi karna.';
    end if;
  else
    if v_lang = 'en' then
      v_title := 'Repayment removed';
      v_body  := v_actor || ' removed the repayment of ' || v_amount || ' they had recorded.';
    else
      v_title := 'Repayment hata di gayi';
      v_body  := v_actor || ' ne ' || v_amount || ' ki record ki hui repayment hata di.';
    end if;
  end if;

  insert into public.notifications(
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, channel_id, href, created_at
  ) values (
    gen_random_uuid()::text, p_req.to_user_id, null, null, 'linked_info',
    left(v_title, 200), left(v_body, 1000),
    p_template,
    jsonb_build_object('actorName', v_actor, 'amount', p_req.amount,
                       'currency', p_req.currency, 'requestId', p_req.id),
    p_req.from_user_id, 'money', '/inbox', now()
  );
exception when others then
  raise warning 'lsr notify (%) skipped: %', p_template, sqlerrm;
end $$;

revoke all on function public._lsr_lock_rows(text[], text[]) from public, anon, authenticated;
revoke all on function public._lsr_apply_side(uuid, text, text, numeric, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public._lsr_reverse_side(uuid, text, text, text, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public._lsr_apply_pair(public.linked_settlement_requests, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public._lsr_notify_info(public.linked_settlement_requests, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Client RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- 4.1 The receiver records a repayment: both ledgers update now.
create or replace function public.record_received_repayment(
  p_request_id text,
  p_loan_pair_id text,
  p_requester_loan_id text,
  p_responder_loan_id text,
  p_to_user_id uuid,
  p_amount numeric,
  p_currency text,
  p_note text default '',
  p_requester_account_id text default null
)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_pair text;
  v_p_pair text;
  v_acct   public.accounts;
  v_req    public.linked_settlement_requests;
  v_txns   text[];
  v_now    timestamptz := now();
begin
  if v_uid is null then
    raise exception 'lsr: not authenticated';
  end if;
  if coalesce(trim(p_request_id), '') = '' then
    raise exception 'lsr: request id required';
  end if;
  if p_to_user_id is null or v_uid = p_to_user_id then
    raise exception 'lsr: self-settlement not allowed';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'lsr: amount must be positive';
  end if;

  -- LOCK ORDER: loans → account, BEFORE the insert below (its validator
  -- takes FOR SHARE on the account; inserting first would lock the account
  -- ahead of the loans and could deadlock against a concurrent accept).
  perform public._lsr_lock_rows(
    array[p_requester_loan_id, p_responder_loan_id],
    array[p_requester_account_id]);

  select * into v_r_loan from public.loans where id = p_requester_loan_id;
  if not found or v_r_loan.user_id <> v_uid then
    raise exception 'lsr: requester loan does not belong to sender';
  end if;
  if v_r_loan.type <> 'given' then
    raise exception 'lsr: only the person receiving the money can record it';
  end if;
  select * into v_p_loan from public.loans where id = p_responder_loan_id;
  if not found or v_p_loan.user_id <> p_to_user_id then
    raise exception 'lsr: responder loan does not belong to receiver';
  end if;
  if v_p_loan.type <> 'taken' then
    raise exception 'lsr: linked loan directions are invalid';
  end if;
  if v_r_loan.deleted_at is not null or v_p_loan.deleted_at is not null
     or v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: both loans must be active';
  end if;
  if v_r_loan.currency <> v_p_loan.currency or p_currency <> v_r_loan.currency then
    raise exception 'lsr: currency mismatch';
  end if;
  if p_amount > v_r_loan.remaining_amount or p_amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining';
  end if;

  select ltr.id into v_r_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_r_loan.id or ltr.responder_loan_id = v_r_loan.id);
  select ltr.id into v_p_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_p_loan.id or ltr.responder_loan_id = v_p_loan.id);
  if v_r_pair is null or v_p_pair is null or v_r_pair <> v_p_pair then
    raise exception 'lsr: loans do not share the same linked pair';
  end if;
  if p_loan_pair_id is distinct from v_r_pair then
    raise exception 'lsr: loan_pair_id does not match the loans';
  end if;

  if p_requester_account_id is not null then
    select * into v_acct from public.accounts where id = p_requester_account_id;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_acct.user_id <> v_uid then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_acct.deleted_at is not null then
      raise exception 'lsr: requester account was deleted';
    end if;
    if v_acct.currency <> p_currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  -- Transaction-local: tg_lsr_notify skips "Repayment to confirm" for THIS
  -- insert only (it compares the id). Precedent: audit-p0-kameti-draw.sql.
  perform set_config('hisaab.lsr_quiet_insert', p_request_id, true);

  insert into public.linked_settlement_requests(
    id, loan_pair_id, requester_loan_id, responder_loan_id,
    from_user_id, to_user_id, amount, currency, note, requester_account_id
  ) values (
    p_request_id, p_loan_pair_id, p_requester_loan_id, p_responder_loan_id,
    v_uid, p_to_user_id, p_amount, p_currency, coalesce(p_note, ''), p_requester_account_id
  )
  returning * into v_req;

  v_txns := public._lsr_apply_pair(v_req, p_requester_account_id, null, v_now);

  update public.linked_settlement_requests
     set status               = 'accepted',
         responded_at         = v_now,
         recorded_by_receiver = true,
         requester_txn_id     = v_txns[1],
         responder_txn_id     = v_txns[2]
   where id = p_request_id
  returning * into v_req;

  return v_req;
end $$;

-- 4.2 The receiver applies their OWN pending request now (e.g. one sent
-- before this model existed, stuck on a casual payer).
create or replace function public.apply_own_settlement_request(p_request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_req    public.linked_settlement_requests;
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_acct   public.accounts;
  v_txns   text[];
  v_now    timestamptz := now();
begin
  if v_uid is null then
    raise exception 'lsr: not authenticated';
  end if;

  select * into v_req
    from public.linked_settlement_requests
   where id = p_request_id
   for update;
  if not found then
    raise exception 'lsr: request not found';
  end if;
  if v_req.status <> 'pending' then
    return v_req;
  end if;
  if v_req.from_user_id <> v_uid then
    raise exception 'lsr: only the sender can apply it now';
  end if;

  perform public._lsr_lock_rows(
    array[v_req.requester_loan_id, v_req.responder_loan_id],
    array[v_req.requester_account_id]);

  select * into v_r_loan from public.loans where id = v_req.requester_loan_id;
  if not found or v_r_loan.user_id <> v_req.from_user_id then
    raise exception 'lsr: requester loan missing or reassigned';
  end if;
  if v_r_loan.type <> 'given' then
    raise exception 'lsr: only the person receiving the money can record it';
  end if;
  select * into v_p_loan from public.loans where id = v_req.responder_loan_id;
  if not found or v_p_loan.user_id <> v_req.to_user_id then
    raise exception 'lsr: responder loan missing or reassigned';
  end if;
  if v_r_loan.deleted_at is not null or v_p_loan.deleted_at is not null
     or v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: loan is no longer active';
  end if;
  if v_r_loan.currency <> v_req.currency or v_p_loan.currency <> v_req.currency then
    raise exception 'lsr: currency mismatch at accept';
  end if;
  if v_req.amount > v_r_loan.remaining_amount or v_req.amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining on one side';
  end if;
  if v_r_loan.type = v_p_loan.type then
    raise exception 'lsr: linked loan directions are invalid';
  end if;

  if v_req.requester_account_id is not null then
    select * into v_acct from public.accounts where id = v_req.requester_account_id;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_acct.user_id <> v_req.from_user_id then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_acct.deleted_at is not null then
      raise exception 'lsr: requester account was deleted';
    end if;
    if v_acct.currency <> v_req.currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  v_txns := public._lsr_apply_pair(v_req, v_req.requester_account_id, null, v_now);

  update public.linked_settlement_requests
     set status               = 'accepted',
         responded_at         = v_now,
         recorded_by_receiver = true,
         requester_txn_id     = v_txns[1],
         responder_txn_id     = v_txns[2]
   where id = p_request_id
  returning * into v_req;

  return v_req;
end $$;

-- 4.3 Undo a receiver record within 10 minutes. After that, a correction goes
-- to the payer as an ordinary lend request they accept.
create or replace function public.undo_received_repayment(p_request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_req    public.linked_settlement_requests;
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_txn  public.transactions;
  v_p_txn  public.transactions;
  v_now    timestamptz := now();
begin
  if v_uid is null then
    raise exception 'lsr: not authenticated';
  end if;

  select * into v_req
    from public.linked_settlement_requests
   where id = p_request_id
   for update;
  if not found then
    raise exception 'lsr: request not found';
  end if;
  if v_req.undone_at is not null then
    return v_req;
  end if;
  if v_req.from_user_id <> v_uid then
    raise exception 'lsr: only the person who recorded it can undo it';
  end if;
  if v_req.status <> 'accepted' or not v_req.recorded_by_receiver then
    raise exception 'lsr: only a payment you recorded can be undone';
  end if;
  -- responded_at, not created_at: the RPC stamps it; created_at is whatever
  -- the inserting client sent.
  if v_req.responded_at is null or v_now > v_req.responded_at + interval '10 minutes' then
    raise exception 'lsr: the undo window has passed';
  end if;
  if v_req.responder_account_id is not null then
    raise exception 'lsr: they already added it to an account';
  end if;

  perform public._lsr_lock_rows(
    array[v_req.requester_loan_id, v_req.responder_loan_id],
    array[v_req.requester_account_id]);
  perform 1 from public.transactions
   where id in (v_req.requester_txn_id, v_req.responder_txn_id)
   order by id
   for update;

  select * into v_r_txn from public.transactions where id = v_req.requester_txn_id;
  if not found then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;
  select * into v_p_txn from public.transactions where id = v_req.responder_txn_id;
  if not found then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;
  if v_r_txn.deleted_at is not null or v_p_txn.deleted_at is not null
     or v_r_txn.amount <> v_req.amount or v_p_txn.amount <> v_req.amount
     or v_r_txn.related_loan_id is distinct from v_req.requester_loan_id
     or v_p_txn.related_loan_id is distinct from v_req.responder_loan_id
     or v_r_txn.source_account_id is not null
     or v_r_txn.destination_account_id is distinct from v_req.requester_account_id
     or v_p_txn.source_account_id is not null
     or v_p_txn.destination_account_id is not null then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;

  select * into v_r_loan from public.loans where id = v_req.requester_loan_id;
  if not found or v_r_loan.deleted_at is not null
     or v_r_loan.remaining_amount + v_req.amount > v_r_loan.total_amount + 0.00001 then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;
  select * into v_p_loan from public.loans where id = v_req.responder_loan_id;
  if not found or v_p_loan.deleted_at is not null
     or v_p_loan.remaining_amount + v_req.amount > v_p_loan.total_amount + 0.00001 then
    raise exception 'lsr: this payment was changed since it was recorded';
  end if;

  if v_req.requester_account_id is not null and not exists (
       select 1 from public.accounts
        where id = v_req.requester_account_id
          and user_id = v_req.from_user_id
          and deleted_at is null) then
    raise exception 'lsr: requester account was deleted';
  end if;

  perform public._lsr_reverse_side(
    v_req.from_user_id, v_req.requester_loan_id, v_req.requester_txn_id,
    v_req.requester_account_id, v_req.amount, v_now);
  perform public._lsr_reverse_side(
    v_req.to_user_id, v_req.responder_loan_id, v_req.responder_txn_id,
    null, v_req.amount, v_now);

  update public.linked_settlement_requests
     set status    = 'cancelled',
         undone_at = v_now
   where id = p_request_id
  returning * into v_req;

  return v_req;
end $$;

-- 4.4 "Add to an account": attach an account to MY side of an ACCEPTED
-- settlement that was recorded as record-only. Only rows a settlement points
-- at (requester_txn_id / responder_txn_id on my side) qualify, so ledger-mode
-- repayments and card-bill-covered rows — legitimately account-less — never
-- can. Given loan → destination (+amount); taken loan → source (−amount).
-- No sufficiency check (record reality, like accept). Returns the balance.
create or replace function public.set_settlement_repayment_account(
  p_txn_id text,
  p_account_id text
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_uid          uuid := auth.uid();
  v_txn          public.transactions;
  v_req          public.linked_settlement_requests;
  v_loan         public.loans;
  v_acct         public.accounts;
  v_is_requester boolean;
  v_side_account text;
  v_balance      numeric;
begin
  if v_uid is null then
    raise exception 'lsr: not authenticated';
  end if;
  if coalesce(trim(p_account_id), '') = '' then
    raise exception 'lsr: choose an account';
  end if;

  select * into v_txn from public.transactions where id = p_txn_id;
  if not found or v_txn.user_id <> v_uid then
    raise exception 'lsr: repayment not found';
  end if;

  -- LOCK ORDER: request row → loan → account → transaction.
  select * into v_req
    from public.linked_settlement_requests r
   where r.status = 'accepted'
     and ((r.requester_txn_id = p_txn_id and r.from_user_id = v_uid)
       or (r.responder_txn_id = p_txn_id and r.to_user_id = v_uid))
   limit 1
   for update;
  if not found then
    raise exception 'lsr: only a confirmed settlement repayment can be added to an account';
  end if;
  v_is_requester := (v_req.requester_txn_id = p_txn_id and v_req.from_user_id = v_uid);
  v_side_account := case when v_is_requester
                         then v_req.requester_account_id
                         else v_req.responder_account_id end;

  select * into v_loan
    from public.loans
   where id = v_txn.related_loan_id and user_id = v_uid
   for update;
  if not found then
    raise exception 'lsr: loan missing';
  end if;
  perform 1 from public.accounts where id = p_account_id for update;
  select * into v_txn from public.transactions where id = p_txn_id for update;

  if v_side_account is not null then
    -- Safe retry of the same attach returns the balance; anything else is
    -- refused (moving money between accounts is a different operation).
    if v_side_account = p_account_id
       and (v_txn.source_account_id = p_account_id or v_txn.destination_account_id = p_account_id) then
      select balance into v_balance from public.accounts where id = p_account_id;
      return v_balance;
    end if;
    raise exception 'lsr: this repayment is already in an account';
  end if;

  if v_txn.deleted_at is not null
     or v_txn.type <> 'repayment'
     or v_txn.source_account_id is not null
     or v_txn.destination_account_id is not null
     or v_txn.conversion_rate is not null
     or v_txn.amount <> v_req.amount then
    raise exception 'lsr: this repayment can''t be added to an account';
  end if;

  select * into v_acct from public.accounts where id = p_account_id;
  if not found or v_acct.user_id <> v_uid then
    raise exception 'lsr: account not found';
  end if;
  if v_acct.deleted_at is not null then
    raise exception 'lsr: account was deleted';
  end if;
  if v_acct.currency <> v_txn.currency then
    raise exception 'lsr: account currency mismatch';
  end if;

  if v_loan.type = 'given' then
    update public.transactions set destination_account_id = p_account_id where id = p_txn_id;
    update public.accounts set balance = balance + v_txn.amount
     where id = p_account_id
    returning balance into v_balance;
  else
    update public.transactions set source_account_id = p_account_id where id = p_txn_id;
    update public.accounts set balance = balance - v_txn.amount
     where id = p_account_id
    returning balance into v_balance;
  end if;

  -- The Inbox and LoanDetail lines read the request row, not the transaction.
  if v_is_requester then
    update public.linked_settlement_requests set requester_account_id = p_account_id where id = v_req.id;
  else
    update public.linked_settlement_requests set responder_account_id = p_account_id where id = v_req.id;
  end if;

  return v_balance;
end $$;

revoke all on function public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text) from public, anon;
grant execute on function public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text) to authenticated;
revoke all on function public.apply_own_settlement_request(text) from public, anon;
grant execute on function public.apply_own_settlement_request(text) to authenticated;
revoke all on function public.undo_received_repayment(text) from public, anon;
grant execute on function public.undo_received_repayment(text) to authenticated;
revoke all on function public.set_settlement_repayment_account(text, text) from public, anon;
grant execute on function public.set_settlement_repayment_account(text, text) to authenticated;

comment on function public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text) is
  'The person who RECEIVED the money records a linked repayment: applies to both ledgers at once (repayment rows, remaining, EMIs, the receiver''s optional account) and notifies the payer. 2026-09-24 settlement model.';
comment on function public.apply_own_settlement_request(text) is
  'The receiver applies their own PENDING settlement request now (no confirmation needed for a repayment that only helps the payer).';
comment on function public.undo_received_repayment(text) is
  'Undo a receiver-recorded repayment within 10 minutes of recording it, while nothing on either side has changed since.';
comment on function public.set_settlement_repayment_account(text, text) is
  'Add to an account: attach an account to the caller''s side of an accepted, record-only settlement repayment and apply the balance delta.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. tg_lsr_notify — [R1] quiet insert, [R2] recorded, [R3] undone;
--            the two original branches are unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_lsr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_amount text;
begin
  v_amount := new.currency || ' ' || trim(to_char(new.amount, 'FM999999999990.00'));

  if tg_op = 'INSERT' then
    -- [R1] record_received_repayment inserts, applies and flips the row to
    -- accepted in one transaction: "Repayment to confirm" would be false.
    if coalesce(current_setting('hisaab.lsr_quiet_insert', true), '') = new.id then
      return null;
    end if;
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_settlement',
      'Repayment to confirm',
      v_name || ' recorded a repayment of ' || v_amount || '. Open Inbox to confirm.',
      now()
    );
  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status = 'accepted'
        and new.recorded_by_receiver then
    -- [R2] The receiver recorded it (or applied their own request): tell the
    -- payer; nobody has anything to confirm, so no "confirmed" notice either.
    perform public._lsr_notify_info(new, 'lsr_recorded');
  elsif tg_op = 'UPDATE'
        and old.status = 'accepted'
        and new.status = 'cancelled'
        and new.undone_at is not null then
    -- [R3] Undone within the window.
    perform public._lsr_notify_info(new, 'lsr_undone');
  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_settlement',
      case when new.status = 'accepted' then 'Repayment confirmed' else 'Repayment declined' end,
      v_name || case when new.status = 'accepted'
                     then ' confirmed the repayment of ' || v_amount || '.'
                     else ' declined the repayment of ' || v_amount || '.' end,
      now()
    );
  end if;
  return null;
end $$;

drop trigger if exists lsr_notify on public.linked_settlement_requests;
create trigger lsr_notify
  after insert or update on public.linked_settlement_requests
  for each row execute function public.tg_lsr_notify();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. Self-check — any failure rolls the whole file back
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_name text;
  v_src  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'linked_settlement_requests'
                    AND column_name = 'recorded_by_receiver')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'linked_settlement_requests'
                       AND column_name = 'undone_at') THEN
    RAISE EXCEPTION 'settlement-receiver-records: new columns missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.linked_settlement_requests'::regclass
         AND conname IN ('lsr_recorded_status_chk', 'lsr_undone_chk')
         AND convalidated) <> 2 THEN
    RAISE EXCEPTION 'settlement-receiver-records: CHECK constraints missing or not validated';
  END IF;

  -- Helpers: definer, search_path pinned, closed to every client role.
  FOREACH v_name IN ARRAY ARRAY['_lsr_lock_rows', '_lsr_apply_side', '_lsr_reverse_side',
                                '_lsr_apply_pair', '_lsr_notify_info'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_name
                      AND p.prosecdef AND 'search_path=public' = ANY (p.proconfig)) THEN
      RAISE EXCEPTION 'settlement-receiver-records: helper % missing or not definer/pinned', v_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_name
                  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    OR has_function_privilege('anon', p.oid, 'EXECUTE'))) THEN
      RAISE EXCEPTION 'settlement-receiver-records: helper % is executable by a client role', v_name;
    END IF;
  END LOOP;

  -- Client RPCs: definer, pinned, authenticated yes, anon no.
  FOREACH v_name IN ARRAY ARRAY['record_received_repayment', 'apply_own_settlement_request',
                                'undo_received_repayment', 'set_settlement_repayment_account'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_name
                      AND p.prosecdef AND 'search_path=public' = ANY (p.proconfig)
                      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'settlement-receiver-records: RPC % missing or mis-granted', v_name;
    END IF;
  END LOOP;

  -- The insert validator forces the new columns clean.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_lsr_validate_insert';
  IF v_src NOT LIKE '%new.recorded_by_receiver := false;%'
     OR v_src NOT LIKE '%new.undone_at := null;%'
     OR v_src NOT LIKE '%new.responder_account_id := null;%'
     OR v_src NOT LIKE '%new.status := ''pending'';%' THEN
    RAISE EXCEPTION 'settlement-receiver-records: tg_lsr_validate_insert is not the [V1] version';
  END IF;

  -- The notify trigger knows the quiet insert and the two new templates.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_lsr_notify';
  IF v_src NOT LIKE '%hisaab.lsr_quiet_insert%'
     OR v_src NOT LIKE '%lsr_recorded%'
     OR v_src NOT LIKE '%lsr_undone%'
     OR v_src NOT LIKE '%Repayment to confirm%' THEN
    RAISE EXCEPTION 'settlement-receiver-records: tg_lsr_notify is not the [R1-R3] version';
  END IF;

  -- accept_settlement_request is untouched: the markers its own verification
  -- (audit-p0-settlement-row-locks.sql §4.3) keys on are all still there.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_settlement_request'
     AND pg_get_function_identity_arguments(p.oid) = 'request_id text, responder_account_id text';
  IF v_src IS NULL
     OR (length(v_src) - length(replace(lower(v_src), 'for update;', ''))) / 11 <> 7
     OR v_src NOT ILIKE '%lsr: amount exceeds remaining on one side%'
     OR v_src NOT ILIKE '%greatest(0, remaining_amount - v_req.amount)%' THEN
    RAISE EXCEPTION 'settlement-receiver-records: accept_settlement_request changed unexpectedly';
  END IF;

  RAISE NOTICE 'settlement-receiver-records: OK';
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only, safe on production)
-- ════════════════════════════════════════════════════════════════════════════
--   select count(*) filter (where recorded_by_receiver) as recorded,
--          count(*) filter (where undone_at is not null) as undone
--     from public.linked_settlement_requests;
--   -- after the client ships, both grow; "undone" stays small.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual)
-- ════════════════════════════════════════════════════════════════════════════
--   1. drop function if exists public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text),
--      public.apply_own_settlement_request(text), public.undo_received_repayment(text),
--      public.set_settlement_repayment_account(text, text);
--   2. Re-run supabase-migration-linked-notifications-realtime.sql §2 (tg_lsr_notify) and
--      supabase-migration-fix-bidirectional-linked-settlements.sql lines 67-152 (the validator).
--   3. drop function if exists public._lsr_notify_info(public.linked_settlement_requests, text),
--      public._lsr_apply_pair(public.linked_settlement_requests, text, text, timestamptz),
--      public._lsr_reverse_side(uuid, text, text, text, numeric, timestamptz),
--      public._lsr_apply_side(uuid, text, text, numeric, text, text, text, text, timestamptz),
--      public._lsr_lock_rows(text[], text[]);
--   The two columns can stay (defaults are inert). Rows already recorded keep
--   their correct, applied state — nothing to undo in the data.
