import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pins what makes the daily-close markers private and safe to re-run. The
// migration is hand-applied in Supabase Studio, so this is the automated
// check that the SQL still says what the feature relies on.
const migration = readFileSync('supabase-migration-daily-close.sql', 'utf8');
const applyOrder = readFileSync('supabase/tests/apply-order.txt', 'utf8');
const body = migration.slice(migration.indexOf('\nBEGIN;'), migration.indexOf('\nCOMMIT;'));

describe('daily-close migration', () => {
  it('is one idempotent, self-verifying transaction in LF', () => {
    expect(body).toContain('CREATE TABLE IF NOT EXISTS public.daily_closes');
    expect(body).toContain("RAISE NOTICE 'daily-close: OK'");
    expect(migration).not.toMatch(/\r\n/);
  });

  it('one row per user per day, two kinds only', () => {
    expect(body).toContain('PRIMARY KEY (user_id, day)');
    expect(body).toContain("CHECK (kind IN ('no_spend', 'closed'))");
    expect(body).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
  });

  it('is self-only for every verb, with auth.uid() hoisted', () => {
    expect(body).toContain('ENABLE ROW LEVEL SECURITY');
    for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(body).toMatch(new RegExp(`FOR ${verb} TO authenticated`));
    }
    expect(body).not.toMatch(/user_id = auth\.uid\(\)/);
    expect(body).toContain('REVOKE ALL ON public.daily_closes FROM anon;');
  });

  it('is listed in apply-order.txt', () => {
    expect(applyOrder.split('\n')).toContain('supabase-migration-daily-close.sql');
  });
});
