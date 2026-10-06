-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — a loan can be shared with the other person only ONCE (2026-10-06)
-- ----------------------------------------------------------------------------
-- The Ghulam exercise found one loan of Abdullah's (100 AED, "Kal din ko liye
-- that") mirrored into Ghulam's books TWICE: once as a normal shared loan
-- (23 Apr) and again by "Sync past records" (26 May). Each copy was repaid
-- once, so the totals were right — but his history read like he had borrowed
-- 100 twice, and that is exactly the kind of record that makes a person doubt
-- the whole ledger.
--
-- The app has since stopped OFFERING an already-shared loan for sync
-- (src/lib/syncableLoans.ts). The database did not refuse it: its only guard
-- is a unique index on pre_existing_loan_id WHILE PENDING
-- (supabase-migration-phase2d-sync-past-records.sql), which says nothing about
-- a loan that is already half of an ACCEPTED pair. An old app build, a retry,
-- or a raw API call could still create the duplicate. This file makes it
-- impossible — the idempotency rule lives where the data lives:
--
--   A loan may be referenced by at most ONE live (pending or accepted) linked
--   request — as its requester_loan_id, responder_loan_id or
--   pre_existing_loan_id. Rejected / cancelled requests free it again.
--
-- Enforced twice, both on state transitions rather than by re-transcribing
-- accept_linked_request's concurrency-critical body (same reasoning as
-- tg_ltr_block_accept in supabase-migration-p2-trust-safety.sql):
--   1. BEFORE INSERT — a "sync past record" request for an already-shared
--      loan is refused ('ltr: loan is already shared'). The loan row is
--      locked first so two concurrent syncs serialise.
--   2. BEFORE UPDATE pending → accepted — a sync that slipped in before this
--      file (or any future path) cannot be ACCEPTED into a second mirror.
--      Reject and cancel are never blocked, so such a request can always be
--      cleared out of both inboxes.
--
-- Existing data is untouched (production has exactly one historical
-- duplicate, left in place by decision and labelled in the person ledger);
-- no pending request was affected when this was written (verified
-- read-only, 2026-10-06).
--
-- Safe to re-run. Apply in Supabase Studio (paste THIS file — nothing under
-- supabase/tests/), then re-run supabase-migration-p3-rpc-execute-grants.sql.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. The rule, as one helper
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._ltr_loan_shared_elsewhere(
  p_loan_id text,
  p_request_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.linked_transaction_requests r
     where r.id is distinct from p_request_id
       and r.status in ('pending', 'accepted')
       and (r.requester_loan_id = p_loan_id
         or r.responder_loan_id = p_loan_id
         or r.pre_existing_loan_id = p_loan_id)
  );
$$;

revoke all on function public._ltr_loan_shared_elsewhere(text, text) from public, anon, authenticated;

comment on function public._ltr_loan_shared_elsewhere(text, text) is
  'True when the loan is already half of another live (pending/accepted) linked request — the one-share-per-loan rule (supabase-migration-ltr-no-duplicate-sync.sql).';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. Refuse the duplicate at INSERT
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_ltr_refuse_duplicate_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pre_existing_loan_id is not null then
    -- Serialise concurrent syncs of the same loan: the second waits here,
    -- then sees the first one's committed row in the check below.
    perform 1 from public.loans where id = new.pre_existing_loan_id for update;
    if public._ltr_loan_shared_elsewhere(new.pre_existing_loan_id, new.id) then
      raise exception 'ltr: loan is already shared';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ltr_refuse_duplicate_sync on public.linked_transaction_requests;
create trigger ltr_refuse_duplicate_sync
  before insert on public.linked_transaction_requests
  for each row execute function public.tg_ltr_refuse_duplicate_sync();

comment on function public.tg_ltr_refuse_duplicate_sync() is
  'Refuses a past-record sync for a loan that is already half of a live linked request (one share per loan).';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Refuse the duplicate at ACCEPT (pending → accepted only)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_ltr_refuse_duplicate_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted'
     and old.status is distinct from 'accepted'
     and new.pre_existing_loan_id is not null
     and public._ltr_loan_shared_elsewhere(new.pre_existing_loan_id, new.id) then
    raise exception 'ltr: loan is already shared';
  end if;
  return new;
end;
$$;

drop trigger if exists ltr_refuse_duplicate_accept on public.linked_transaction_requests;
create trigger ltr_refuse_duplicate_accept
  before update on public.linked_transaction_requests
  for each row execute function public.tg_ltr_refuse_duplicate_accept();

comment on function public.tg_ltr_refuse_duplicate_accept() is
  'Refuses accepting a past-record sync whose loan is already half of another live linked request. Reject/cancel are never blocked.';

-- Trigger functions are invoked by their triggers, never by a client.
revoke all on function public.tg_ltr_refuse_duplicate_sync() from public, anon, authenticated;
revoke all on function public.tg_ltr_refuse_duplicate_accept() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Self-check — any failure rolls the whole file back
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if (select count(*) from pg_trigger
       where tgrelid = 'public.linked_transaction_requests'::regclass
         and tgname in ('ltr_refuse_duplicate_sync', 'ltr_refuse_duplicate_accept')
         and not tgisinternal) <> 2 then
    raise exception 'ltr-no-duplicate-sync: triggers missing';
  end if;
  if has_function_privilege('authenticated', 'public._ltr_loan_shared_elsewhere(text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public._ltr_loan_shared_elsewhere(text, text)', 'EXECUTE') then
    raise exception 'ltr-no-duplicate-sync: helper is client-executable';
  end if;
end $$;
