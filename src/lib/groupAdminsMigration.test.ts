import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pins the properties that make co-admins safe (founder report 2026-09-19:
// "making someone else an admin removed me"). The migration is hand-applied in
// Supabase Studio, so this — together with supabase/tests/tests/8u-group-
// admins.sql in the DB harness — is the automated check that the SQL still
// says what the fix requires (groupInviteJoinMigration.test precedent).
const migration = readFileSync('supabase-migration-group-admins.sql', 'utf8');
const applyOrder = readFileSync('supabase/tests/apply-order.txt', 'utf8');
const grantsSweep = readFileSync('supabase-migration-p3-rpc-execute-grants.sql', 'utf8');

// Everything between the BEGIN and the COMMIT — the executable part. The
// header and the rollback notes quote SQL as prose, which would otherwise
// satisfy (or defeat) these probes.
const body = migration.slice(migration.indexOf('\nBEGIN;'), migration.indexOf('\nCOMMIT;'));

/** One CREATE FUNCTION statement, up to its closing dollar-quote. */
function functionSource(name: string): string {
  const start = body.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const tag = body.slice(start).match(/AS (\$[a-z]*\$)/)?.[1] ?? '$$';
  const open = body.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  return body.slice(start, body.indexOf(tag, open) + tag.length);
}

describe('group co-admins migration', () => {
  it('adds the flag idempotently and is one self-verifying transaction', () => {
    expect(body).toContain('ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('\nBEGIN;');
    expect(migration).toContain('\nCOMMIT;');
    // The verification block sits INSIDE the transaction, so drift aborts it.
    expect(body).toContain("RAISE NOTICE 'group-admins: OK'");
    expect(migration).not.toMatch(/\r\n/); // SQL files are LF-only (tasks/lessons.md)
  });

  it('is_group_admin is the owner OR a connected, flagged member — and authenticated-only', () => {
    const helper = functionSource('is_group_admin');
    expect(helper).toContain('SECURITY DEFINER');
    expect(helper).toContain('SET search_path = public');
    expect(helper).toContain('g.user_id = p_uid');
    expect(helper).toContain("gm.status = 'connected'");
    expect(helper).toContain('AND gm.is_admin');
    expect(body).toContain('REVOKE ALL ON FUNCTION public.is_group_admin(TEXT, UUID) FROM PUBLIC, anon;');
    expect(body).toContain('GRANT EXECUTE ON FUNCTION public.is_group_admin(TEXT, UUID) TO authenticated;');
  });

  it('set_group_admin is owner-only, never touches the owner, and returns data', () => {
    const rpc = functionSource('set_group_admin');
    expect(rpc).toContain('SECURITY DEFINER');
    expect(rpc).toContain('v_group.user_id IS DISTINCT FROM v_uid');
    expect(rpc).not.toContain('is_group_admin'); // admins cannot mint admins
    expect(rpc).not.toContain('RAISE EXCEPTION');
    for (const status of [
      "'status', 'NOT_AUTHENTICATED'",
      "'status', 'INVALID_REQUEST'",
      "'status', 'NOT_GROUP_OWNER'",
      "'status', 'MEMBER_NOT_FOUND'",
      "'status', 'TARGET_IS_OWNER'",
      "'status', 'NOT_ELIGIBLE'",
      "'status', 'ok'",
    ]) {
      expect(rpc).toContain(status);
    }
    // Serialized with transfer_group_ownership through the same row lock.
    expect(rpc).toContain('FOR UPDATE;');
    expect(rpc).toContain("'member_admin_granted'");
    expect(rpc).toContain("'member_admin_revoked'");
    expect(body).toContain('REVOKE ALL ON FUNCTION public.set_group_admin(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;');
    expect(body).toContain('GRANT EXECUTE ON FUNCTION public.set_group_admin(TEXT, TEXT, BOOLEAN) TO authenticated;');
  });

  it('the flag can only come from the RPC and never outlives the membership', () => {
    const guard = functionSource('tg_group_members_admin_flag');
    expect(guard).toContain("NEW.is_admin := false;");
    expect(guard).toContain('GROUP_ADMIN_RPC_ONLY');
    expect(guard).toContain("NEW.status IS DISTINCT FROM 'connected' OR NEW.profile_id IS NULL");
    expect(body).toContain('BEFORE INSERT OR UPDATE ON public.group_members');
    expect(body).toContain('REVOKE ALL ON FUNCTION public.tg_group_members_admin_flag() FROM PUBLIC, anon, authenticated;');
  });

  it('an admin cannot take the group by PATCHing the owner column', () => {
    const freeze = functionSource('tg_split_groups_protect_ownership');
    expect(freeze).toContain('NEW.user_id IS DISTINCT FROM OLD.user_id');
    expect(freeze).toContain('NEW.created_by IS DISTINCT FROM OLD.created_by');
    expect(freeze).toContain('GROUP_OWNERSHIP_RPC_ONLY');
    expect(body).toContain('CREATE TRIGGER split_groups_protect_ownership');
  });

  it('widens the four management policies to owner-or-admin, pre-hoisted', () => {
    expect(body).toContain('CREATE POLICY "Owners can update own groups"');
    expect(body).toContain('CREATE POLICY "Group admins can update members"');
    expect(body).toContain('CREATE POLICY "Group admins can create invites"');
    expect(body).toContain('CREATE POLICY "Group admins can update invites"');
    // The owner-only names they replace are dropped.
    expect(body).toContain('DROP POLICY IF EXISTS "Group owners can update members" ON public.group_members;');
    expect(body).toContain('DROP POLICY IF EXISTS "Group owners can create invites" ON public.group_invites;');
    expect(body).toContain('DROP POLICY IF EXISTS "Group owners can update invites" ON public.group_invites;');
    // An invite is minted in the caller's own name.
    expect(body).toContain('created_by = (SELECT auth.uid())');
    // Every auth.uid() in an executable policy is hoisted into an InitPlan
    // (90-performance-hardening.sql asserts none is bare).
    const policies = body.split('CREATE POLICY').slice(1).map((p) => p.slice(0, p.indexOf(';')));
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(policy).toContain('is_group_admin');
      expect(policy.replace(/\(SELECT auth\.uid\(\)\)/g, '')).not.toContain('auth.uid()');
    }
  });

  it('keeps deletion, transfer, admin choice and direct member insertion owner-only', () => {
    // Named in a comment as "not changed, on purpose" — but never dropped or
    // re-created.
    expect(body).not.toMatch(/(DROP|CREATE) POLICY[^;]*"Owners can delete own groups"/);
    expect(body).not.toMatch(/(DROP|CREATE) POLICY[^;]*"Group owners can add members"/);
    const transfer = functionSource('transfer_group_ownership');
    expect(transfer).toContain('v_group.user_id IS DISTINCT FROM v_uid');
    expect(transfer).not.toContain('is_group_admin');
    // …but the previous owner stays an admin instead of becoming a plain member.
    expect(transfer).toMatch(/SET role = 'member',\s+is_admin = true/);
    expect(transfer).toMatch(/SET role = 'owner',\s+is_admin = false/);
  });

  it('archive, reopen and guest removal ask is_group_admin', () => {
    for (const name of ['archive_group', 'unarchive_group']) {
      const fn = functionSource(name);
      expect(fn).toContain('NOT public.is_group_admin(p_group_id, v_uid)');
      expect(fn).toContain("'reason_code', 'NOT_GROUP_ADMIN'");
      expect(fn).not.toContain('v_group.user_id IS DISTINCT FROM v_uid');
    }
    const remove = functionSource('remove_group_guest');
    expect(remove).toContain('IF NOT public.is_group_admin(p_group_id, v_uid)');
    expect(remove).toContain('v_member.invited_by IS DISTINCT FROM v_uid');
    expect(remove).toContain("'status', 'GUEST_HAS_LEDGER'");
  });

  it('is in the canonical apply order after the initplan sweep, and the grants sweep keeps its functions', () => {
    const lines = applyOrder.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const at = (file: string) => lines.indexOf(file);
    expect(at('supabase-migration-group-admins.sql')).toBeGreaterThan(at('supabase-migration-p3-rls-initplan-and-indexes.sql'));
    expect(at('supabase-migration-group-admins.sql')).toBeGreaterThan(at('supabase-migration-p2-guest-members.sql'));
    expect(at('supabase-migration-group-admins.sql')).toBeLessThan(at('supabase-migration-p3-rpc-execute-grants.sql'));
    // A re-run of the least-privilege sweep must not revoke either function.
    expect(grantsSweep).toContain("'set_group_admin',");
    expect(grantsSweep).toMatch(/v_internal_keep TEXT\[\] := ARRAY\[[^\]]*'is_group_admin'[^\]]*\];/);
  });
});
