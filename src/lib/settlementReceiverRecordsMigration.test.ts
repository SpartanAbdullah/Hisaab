import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pins what the 2026-09-24 settlement model relies on in
// supabase-migration-settlement-receiver-records.sql. The migration is
// hand-applied in Supabase Studio, so this is the automated check that the SQL
// still says what the client assumes. The behaviour itself is exercised by the
// DB harness (supabase/tests/tests/8s-settlement-receiver-records.sql).
const migration = readFileSync('supabase-migration-settlement-receiver-records.sql', 'utf8');
const grantsSweep = readFileSync('supabase-migration-p3-rpc-execute-grants.sql', 'utf8');
const grantsTest = readFileSync('supabase/tests/tests/92-function-grants.sql', 'utf8');
const applyOrder = readFileSync('supabase/tests/apply-order.txt', 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const body = migration.slice(migration.indexOf('\nBEGIN;'), migration.indexOf('\nCOMMIT;'));

function fn(name: string): string {
  const start = body.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf('end $$;', start));
}

const CLIENT_RPCS = [
  'record_received_repayment',
  'apply_own_settlement_request',
  'undo_received_repayment',
  'set_settlement_repayment_account',
];

describe('settlement-receiver-records migration', () => {
  it('is one self-verifying transaction in LF', () => {
    expect(migration.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(migration.match(/\nCOMMIT;/g)).toHaveLength(1);
    expect(body).toContain("RAISE NOTICE 'settlement-receiver-records: OK'");
    expect(migration).not.toMatch(/\r\n/);
  });

  it('never redefines accept_settlement_request (its body is pinned by production checks)', () => {
    expect(body).not.toMatch(/create or replace function public\.accept_settlement_request/i);
  });

  it('an INSERT can never carry the new flags or a responder account', () => {
    const validator = fn('tg_lsr_validate_insert');
    expect(validator).toContain('new.recorded_by_receiver := false;');
    expect(validator).toContain('new.undone_at := null;');
    expect(validator).toContain('new.responder_account_id := null;');
    expect(validator).toContain("new.status := 'pending';");
  });

  it('the receiver path is the GIVEN side only, locks before inserting, and stays quiet at insert', () => {
    const record = fn('record_received_repayment');
    expect(record).toContain("if v_r_loan.type <> 'given' then");
    expect(record).toContain("raise exception 'lsr: only the person receiving the money can record it'");
    expect(record.indexOf('_lsr_lock_rows(')).toBeLessThan(record.indexOf('insert into public.linked_settlement_requests'));
    expect(record).toContain("perform set_config('hisaab.lsr_quiet_insert', p_request_id, true);");
    expect(record).toContain('recorded_by_receiver = true');
  });

  it('an account is a destination on a GIVEN loan and a source on a TAKEN loan — never the reverse', () => {
    const side = fn('_lsr_apply_side');
    expect(side).toContain("case when v_loan.type = 'taken' then p_account_id else null end");
    expect(side).toContain("case when v_loan.type = 'given' then p_account_id else null end");
    const attach = fn('set_settlement_repayment_account');
    expect(attach).toContain("if v_loan.type = 'given' then");
    expect(attach).toContain('update public.transactions set destination_account_id = p_account_id');
    expect(attach).toContain('update public.transactions set source_account_id = p_account_id');
  });

  it('"Add to an account" only touches rows an accepted settlement points at, on my side', () => {
    const attach = fn('set_settlement_repayment_account');
    expect(attach).toContain("r.status = 'accepted'");
    expect(attach).toContain('r.requester_txn_id = p_txn_id and r.from_user_id = v_uid');
    expect(attach).toContain('r.responder_txn_id = p_txn_id and r.to_user_id = v_uid');
    expect(attach).toContain('v_txn.source_account_id is not null');
    expect(attach).toContain('v_txn.destination_account_id is not null');
  });

  it('Undo is the recorder only, 10 minutes from responded_at, refused once the payer attached', () => {
    const undo = fn('undo_received_repayment');
    expect(undo).toContain("v_now > v_req.responded_at + interval '10 minutes'");
    expect(undo).toContain('if v_req.responder_account_id is not null then');
    expect(undo).toContain('if v_req.from_user_id <> v_uid then');
    expect(undo).toContain("set status    = 'cancelled',");
  });

  it('the payer notice is a new linked_info type (not a request mirror), money channel, error-safe', () => {
    const notice = fn('_lsr_notify_info');
    expect(notice).toContain("'linked_info'");
    expect(notice).toContain("'money', '/inbox'");
    expect(notice).toContain('exception when others then');
    const trigger = fn('tg_lsr_notify');
    expect(trigger).toContain("current_setting('hisaab.lsr_quiet_insert', true)");
    expect(trigger).toContain("perform public._lsr_notify_info(new, 'lsr_recorded');");
    expect(trigger).toContain("perform public._lsr_notify_info(new, 'lsr_undone');");
    // the two original branches are still there
    expect(trigger).toContain("'Repayment to confirm'");
    expect(trigger).toContain("'Repayment confirmed'");
  });

  it('helpers are closed to every client role; the four RPCs are authenticated-only', () => {
    for (const helper of ['_lsr_lock_rows', '_lsr_apply_side', '_lsr_reverse_side', '_lsr_apply_pair', '_lsr_notify_info']) {
      expect(body).toMatch(new RegExp(`revoke all on function public\\.${helper}\\([^)]*\\) from public, anon, authenticated;`));
    }
    for (const rpc of CLIENT_RPCS) {
      expect(body).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([^)]*\\) to authenticated;`));
      expect(body).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\) from public, anon;`));
    }
  });

  it('the grants sweep and its test keep the four RPCs (and never the helpers)', () => {
    for (const rpc of CLIENT_RPCS) {
      expect(grantsSweep).toContain(`'${rpc}'`);
      expect(grantsTest).toContain(`('${rpc}')`);
    }
    expect(grantsSweep).not.toMatch(/'_lsr_/);
  });

  it('sits after linked-sync-live-amount and before the grants sweep in apply-order.txt', () => {
    const at = (f: string) => applyOrder.indexOf(f);
    const me = at('supabase-migration-settlement-receiver-records.sql');
    expect(me).toBeGreaterThan(-1);
    expect(me).toBeGreaterThan(at('supabase-migration-linked-sync-live-amount.sql'));
    expect(me).toBeGreaterThan(at('supabase-migration-audit-p0-settlement-row-locks.sql'));
    expect(me).toBeLessThan(at('supabase-migration-p3-rpc-execute-grants.sql'));
    expect(applyOrder[applyOrder.length - 1]).toBe('supabase-migration-p3-rpc-execute-grants.sql');
  });
});
