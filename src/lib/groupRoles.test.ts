import { describe, expect, it } from 'vitest';
import {
  adminCandidates,
  canManageGroup,
  groupRoleOf,
  groupSupportsAdmins,
  isAdminCandidate,
  isGroupAdmin,
  isGroupOwner,
  missingAdminRpcResult,
  parseSetGroupAdminResult,
  setGroupAdminFailureCopy,
  transferCandidates,
} from './groupRoles';
import type { GroupMember } from '../db';

// The founder (2026-09-19): "if one person is owner and he marks other person
// as admin, the owner shall also stay as admin". These pin the client half of
// supabase-migration-group-admins.sql: isGroupAdmin must say exactly what
// public.is_group_admin says, and a database without the migration must look
// exactly like the old owner-only world.

const OWNER: GroupMember = { id: 'm-o', name: 'Omar', isOwner: true, role: 'owner', profileId: 'u-o', status: 'connected', isAdmin: false };
const ADMIN: GroupMember = { id: 'm-p', name: 'Parveen', isOwner: false, role: 'member', profileId: 'u-p', status: 'connected', isAdmin: true };
const MEMBER: GroupMember = { id: 'm-q', name: 'Qasim', isOwner: false, role: 'member', profileId: 'u-q', status: 'connected', isAdmin: false };
const GUEST: GroupMember = { id: 'm-g', name: 'Gul', isOwner: false, role: 'member', profileId: null, status: 'connected', isAdmin: false };
const INVITED: GroupMember = { id: 'm-i', name: 'Iqra', isOwner: false, role: 'member', profileId: 'u-i', status: 'invited', isAdmin: false };
const LEFT_ADMIN: GroupMember = { id: 'm-l', name: 'Laila', isOwner: false, role: 'member', profileId: 'u-l', status: 'left', isAdmin: true };

describe('isGroupAdmin / canManageGroup — public.is_group_admin, client-side', () => {
  it('the owner is always an admin, whatever the flag says', () => {
    expect(isGroupAdmin(OWNER)).toBe(true);
    expect(isGroupAdmin({ ...OWNER, isAdmin: undefined })).toBe(true);
    expect(canManageGroup(OWNER)).toBe(true);
  });

  it('THE FIX: making someone an admin leaves the owner managing the group too', () => {
    // Two managers at once — the old model could only ever have one.
    expect([OWNER, ADMIN].every((member) => canManageGroup(member))).toBe(true);
    expect(groupRoleOf(OWNER)).toBe('owner');
    expect(groupRoleOf(ADMIN)).toBe('admin');
  });

  it('a flagged, connected, profile-linked member is an admin', () => {
    expect(isGroupAdmin(ADMIN)).toBe(true);
  });

  it('a plain member, a guest and an invitee are not', () => {
    for (const member of [MEMBER, GUEST, INVITED]) {
      expect(isGroupAdmin(member)).toBe(false);
      expect(canManageGroup(member)).toBe(false);
      expect(groupRoleOf(member)).toBe('member');
    }
  });

  it('a stale flag on a seat that left, or on a guest seat, is not trusted', () => {
    expect(isGroupAdmin(LEFT_ADMIN)).toBe(false);
    expect(isGroupAdmin({ ...GUEST, isAdmin: true })).toBe(false);
  });

  it('nobody is signed in → nothing to manage', () => {
    expect(canManageGroup(undefined)).toBe(false);
    expect(canManageGroup(null)).toBe(false);
  });

  it('recognises the owner by role even when isOwner was not set', () => {
    expect(isGroupOwner({ isOwner: false, role: 'owner' })).toBe(true);
    expect(isGroupOwner({ isOwner: false, role: 'member' })).toBe(false);
  });
});

describe('backward compatibility — a database without the migration', () => {
  // The mapper leaves isAdmin undefined when the column does not exist.
  const legacy = [OWNER, ADMIN, MEMBER].map((member) => ({ ...member, isAdmin: undefined }));

  it('is detected, so copy can stay honest', () => {
    expect(groupSupportsAdmins(legacy)).toBe(false);
    expect(groupSupportsAdmins([OWNER, MEMBER])).toBe(true);
  });

  it('collapses management to exactly the old owner check', () => {
    expect(legacy.filter((member) => canManageGroup(member)).map((member) => member.id)).toEqual(['m-o']);
  });
});

describe('who can be chosen', () => {
  const members = [MEMBER, GUEST, OWNER, INVITED, LEFT_ADMIN, ADMIN];

  it('admin candidates: connected, on Hisaab, not the owner — admins first, then by name', () => {
    expect(isAdminCandidate(OWNER)).toBe(false);
    expect(isAdminCandidate(GUEST)).toBe(false);
    expect(isAdminCandidate(INVITED)).toBe(false);
    expect(isAdminCandidate(LEFT_ADMIN)).toBe(false);
    expect(adminCandidates(members).map((member) => member.id)).toEqual(['m-p', 'm-q']);
  });

  it('transfer candidates mirror transfer_group_ownership: connected, linked, not me', () => {
    expect(transferCandidates(members, 'u-o').map((member) => member.id)).toEqual(['m-q', 'm-p']);
    // An admin can be handed the group; the caller themselves cannot.
    expect(transferCandidates(members, 'u-p').map((member) => member.id)).toEqual(['m-q', 'm-o']);
  });
});

describe('set_group_admin result', () => {
  it('parses the RPC answer', () => {
    expect(parseSetGroupAdminResult({ status: 'ok', member_id: 'm-p', is_admin: true, changed: true })).toEqual({
      status: 'ok', memberId: 'm-p', isAdmin: true, changed: true,
    });
    expect(parseSetGroupAdminResult({ status: 'ok', member_id: 'm-p', is_admin: true, changed: false }).changed).toBe(false);
  });

  it('keeps every server refusal as data', () => {
    for (const status of ['NOT_AUTHENTICATED', 'INVALID_REQUEST', 'NOT_GROUP_OWNER', 'MEMBER_NOT_FOUND', 'TARGET_IS_OWNER', 'NOT_ELIGIBLE']) {
      expect(parseSetGroupAdminResult({ status }).status).toBe(status);
    }
  });

  it('never trusts an unknown or missing status', () => {
    expect(parseSetGroupAdminResult({ status: 'SOMETHING_NEW' }).status).toBe('UNKNOWN');
    expect(parseSetGroupAdminResult(null).status).toBe('UNKNOWN');
    expect(parseSetGroupAdminResult('nope').status).toBe('UNKNOWN');
  });

  it('a missing RPC (migration not applied) is its own, explainable status', () => {
    expect(missingAdminRpcResult()).toEqual({ status: 'NEEDS_DB_UPDATE', memberId: null, isAdmin: null, changed: false });
  });

  it('maps each refusal to plain copy — the missing RPC says it needs a database update', () => {
    expect(setGroupAdminFailureCopy('NEEDS_DB_UPDATE')).toEqual({
      title: 'This needs a database update',
      subtitle: "Group admins aren't switched on on the server yet. Try again after the update.",
    });
    expect(setGroupAdminFailureCopy('NOT_GROUP_OWNER').title).toBe('Only the group owner can choose admins');
    expect(setGroupAdminFailureCopy('NOT_ELIGIBLE').title).toBe('Only members who have joined on Hisaab can be admins');
    expect(setGroupAdminFailureCopy('TARGET_IS_OWNER').title).toBe('The owner is always an admin');
    expect(setGroupAdminFailureCopy('MEMBER_NOT_FOUND').title).toBe('Could not change the admin');
    expect(setGroupAdminFailureCopy('UNKNOWN').title).toBe('Could not change the admin');
  });
});
