import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pins what makes a pending "Sync this record" mirror the loan as it is at
// accept time (backlog 2026-09-22 item 5). The migration is hand-applied in
// Supabase Studio, so this is the automated check that the SQL still says
// what the fix relies on. The behaviour itself is exercised by the DB harness
// (supabase/tests/tests/8t-linked-sync-live-amount.sql).
const migration = readFileSync('supabase-migration-linked-sync-live-amount.sql', 'utf8');
const applyOrder = readFileSync('supabase/tests/apply-order.txt', 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const body = migration.slice(migration.indexOf('\nBEGIN;'), migration.indexOf('\nCOMMIT;'));
const accept = body.slice(
  body.indexOf('create or replace function public.accept_linked_request('),
  body.indexOf('end $$;', body.indexOf('create or replace function public.accept_linked_request(')),
);
const trigger = body.slice(body.indexOf('create or replace function public.tg_loans_refresh_pending_sync()'));

describe('linked-sync-live-amount migration', () => {
  it('is one idempotent, self-verifying transaction in LF', () => {
    expect(migration.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(migration.match(/\nCOMMIT;/g)).toHaveLength(1);
    expect(body).toContain("RAISE NOTICE 'linked-sync-live-amount: OK'");
    expect(body).toContain('drop trigger if exists loans_refresh_pending_sync on public.loans;');
    expect(migration).not.toMatch(/\r\n/);
  });

  it('keeps the accept RPC signature, definer rights, search_path and grants', () => {
    expect(accept).toMatch(/accept_linked_request\(\s*request_id text,\s*responder_account_id text default null\s*\)/);
    expect(accept).toContain('returns public.linked_transaction_requests');
    expect(accept).toContain('security definer set search_path = public');
    expect(body).toContain('grant execute on function public.accept_linked_request(text, text) to authenticated;');
    expect(body).toContain('revoke all on function public.accept_linked_request(text, text) from public, anon;');
  });

  it('keeps the loans → accounts lock order (the row lock precedes every account lock)', () => {
    const loanLock = accept.indexOf('where id = v_req.pre_existing_loan_id');
    const acctLock = accept.indexOf('from public.accounts');
    expect(loanLock).toBeGreaterThan(-1);
    expect(loanLock).toBeLessThan(acctLock);
  });

  it('THE FIX: the sync path mirrors the loan’s current remaining, not the request amount', () => {
    expect(accept).toContain('select status, remaining_amount, currency, deleted_at');
    expect(accept).toContain('v_amount := v_loan_remaining;');
    // the receiver's loan, transaction and balance all use v_amount
    expect(accept).toContain('v_amount, v_amount, v_req.currency');
    expect(accept).toContain('v_responder_txn_type, v_amount, v_req.currency');
    expect(accept).toContain("then v_amount else -v_amount end");
    // the accepted row records what was mirrored
    expect(accept).toContain('amount = v_amount,');
    // the fresh-loan path is unchanged
    expect(accept).toContain('v_amount := v_req.amount;');
  });

  it('refuses a deleted, settled or re-currencied loan with mapped error strings', () => {
    expect(accept).toContain('v_loan_deleted_at is not null');
    expect(accept).toContain("raise exception 'ltr: pre_existing loan no longer available'");
    expect(accept).toContain("coalesce(v_loan_remaining, 0) <= 0.00001");
    expect(accept).toContain("raise exception 'ltr: pre_existing loan has been settled or archived'");
    expect(accept).toContain("raise exception 'ltr: pre_existing loan changed currency'");
  });

  it('the refresh trigger never waits on a request row and never breaks a money write', () => {
    expect(trigger).toContain('for update skip locked');
    expect(trigger).toContain("q.status = 'pending'");
    expect(trigger).toContain('q.from_user_id = new.user_id');
    expect(trigger).toContain('new.remaining_amount > 0.00001');
    expect(trigger).toContain('exception when others then');
    expect(trigger).toContain('after update of remaining_amount on public.loans');
    expect(trigger).toContain(
      'revoke all on function public.tg_loans_refresh_pending_sync() from public, anon, authenticated;',
    );
  });

  it('opens no RLS door on linked_transaction_requests', () => {
    expect(body).not.toMatch(/create policy/i);
    expect(body).not.toMatch(/grant (update|insert|all)[^;]*linked_transaction_requests/i);
  });

  it('sits after the file it replaces and before the grants sweep in apply-order.txt', () => {
    const at = (f: string) => applyOrder.indexOf(f);
    const me = at('supabase-migration-linked-sync-live-amount.sql');
    expect(me).toBeGreaterThan(-1);
    expect(me).toBeGreaterThan(at('supabase-migration-audit-p0-settlement-row-locks.sql'));
    expect(me).toBeGreaterThan(at('supabase-migration-p2-trust-safety.sql'));
    expect(me).toBeLessThan(at('supabase-migration-p3-rpc-execute-grants.sql'));
    expect(applyOrder[applyOrder.length - 1]).toBe('supabase-migration-p3-rpc-execute-grants.sql');
  });
});
