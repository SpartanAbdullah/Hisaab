// Group roles — owner, admin, member (supabase-migration-group-admins.sql).
//
// The founder (2026-09-19): "if one person is owner and he marks other person
// as admin, the owner shall also stay as admin". Until then a group had ONE
// manager, and the button labelled "Assign another admin" called
// transfer_group_ownership — the owner was demoted to a plain member. Now:
//
//   owner  — split_groups.user_id, mirrored as group_members.role = 'owner'.
//            Exactly one. Always an admin.
//   admin  — group_members.is_admin on a connected, profile-linked seat. Any
//            number, chosen by the owner through set_group_admin.
//   member — everyone else.
//
// `isGroupAdmin` below is public.is_group_admin(), transliterated; the two
// must agree, because every management control the UI shows is one the server
// will accept. Owner-only stays owner-only for: deleting the group,
// transferring it, and choosing admins (`isGroupOwner`).
//
// BACKWARD COMPATIBILITY: on a database that has not had the migration applied
// the column does not exist, the mapper leaves `isAdmin` undefined, nobody is
// an admin, and `canManageGroup` collapses to "is the owner" — exactly the old
// behaviour. `groupSupportsAdmins` tells the two databases apart.
//
// Pure: no store, no supabase, no React. i18n only maps server status codes to
// the copy the UI shows (the groupGuests.ts convention).

import { tStatic } from './i18n';
import type { GroupMember } from '../db';

type OwnerFields = Pick<GroupMember, 'isOwner' | 'role'>;
type RoleFields = Pick<GroupMember, 'isOwner' | 'role' | 'isAdmin' | 'status' | 'profileId'>;

export type GroupRole = 'owner' | 'admin' | 'member';

/** The canonical owner seat (role = 'owner', kept in step with
 *  split_groups.user_id by transfer_group_ownership). */
export function isGroupOwner(member: OwnerFields | null | undefined): boolean {
  return Boolean(member && (member.isOwner || member.role === 'owner'));
}

/**
 * public.is_group_admin(), client-side: the owner, or a connected,
 * profile-linked seat carrying the admin flag. A flag on a seat that has left
 * (or a guest) is not an admin — the server clears it, and this refuses to
 * trust a stale copy.
 */
export function isGroupAdmin(member: RoleFields | null | undefined): boolean {
  if (!member) return false;
  if (isGroupOwner(member)) return true;
  return member.isAdmin === true && member.status === 'connected' && Boolean(member.profileId);
}

/**
 * May this member do the management work — invite links, the join code, guest
 * renames and removals, archive / reopen? The owner and every admin.
 */
export function canManageGroup(member: RoleFields | null | undefined): boolean {
  return isGroupAdmin(member);
}

export function groupRoleOf(member: RoleFields): GroupRole {
  if (isGroupOwner(member)) return 'owner';
  return isGroupAdmin(member) ? 'admin' : 'member';
}

/** True once the database has the co-admin column (every member row then
 *  carries a boolean). Before the migration every `isAdmin` is undefined. */
export function groupSupportsAdmins(members: ReadonlyArray<Pick<GroupMember, 'isAdmin'>>): boolean {
  return members.some((member) => typeof member.isAdmin === 'boolean');
}

/** A seat set_group_admin accepts: connected, has a Hisaab account, and is not
 *  the owner (who is always an admin). Guests, invitees and departed members
 *  are refused server-side with NOT_ELIGIBLE / TARGET_IS_OWNER. */
export function isAdminCandidate(member: RoleFields): boolean {
  return !isGroupOwner(member) && member.status === 'connected' && Boolean(member.profileId);
}

/** The "Group admins" sheet's list: every eligible seat, current admins first,
 *  then by name. */
export function adminCandidates<T extends RoleFields & Pick<GroupMember, 'name'>>(members: ReadonlyArray<T>): T[] {
  return members
    .filter(isAdminCandidate)
    .sort((a, b) => Number(isGroupAdmin(b)) - Number(isGroupAdmin(a)) || a.name.localeCompare(b.name));
}

/** transfer_group_ownership's own filter (INVALID_NEW_OWNER otherwise):
 *  connected, profile-linked, and not the caller. */
export function transferCandidates<T extends Pick<GroupMember, 'status' | 'profileId'>>(
  members: ReadonlyArray<T>,
  currentUserId: string | null | undefined,
): T[] {
  return members.filter(
    (member) => member.status === 'connected' && Boolean(member.profileId) && member.profileId !== currentUserId,
  );
}

// ── set_group_admin's answer ────────────────────────────────────────────────

export type SetGroupAdminStatus =
  | 'ok'
  | 'NOT_AUTHENTICATED'
  | 'INVALID_REQUEST'
  | 'NOT_GROUP_OWNER'
  | 'MEMBER_NOT_FOUND'
  | 'TARGET_IS_OWNER'
  | 'NOT_ELIGIBLE'
  /** Client-side: the RPC is not on this server yet (PostgREST PGRST202) —
   *  supabase-migration-group-admins.sql has not been applied. */
  | 'NEEDS_DB_UPDATE'
  | 'UNKNOWN';

export interface SetGroupAdminResult {
  status: SetGroupAdminStatus;
  memberId: string | null;
  isAdmin: boolean | null;
  /** false for an idempotent replay (the seat was already in that state). */
  changed: boolean;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<SetGroupAdminStatus>([
  'ok', 'NOT_AUTHENTICATED', 'INVALID_REQUEST', 'NOT_GROUP_OWNER',
  'MEMBER_NOT_FOUND', 'TARGET_IS_OWNER', 'NOT_ELIGIBLE',
]);

export function parseSetGroupAdminResult(data: unknown): SetGroupAdminResult {
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const raw = typeof row.status === 'string' ? row.status : '';
  return {
    status: (KNOWN_STATUSES.has(raw) ? raw : 'UNKNOWN') as SetGroupAdminStatus,
    memberId: typeof row.member_id === 'string' && row.member_id ? row.member_id : null,
    isAdmin: typeof row.is_admin === 'boolean' ? row.is_admin : null,
    changed: row.changed === true,
  };
}

export function missingAdminRpcResult(): SetGroupAdminResult {
  return { status: 'NEEDS_DB_UPDATE', memberId: null, isAdmin: null, changed: false };
}

/** Copy for a refused set_group_admin, as { title, subtitle? }. */
export function setGroupAdminFailureCopy(status: SetGroupAdminStatus): { title: string; subtitle?: string } {
  switch (status) {
    case 'NEEDS_DB_UPDATE':
      return { title: tStatic('grp_admin_err_needs_update'), subtitle: tStatic('grp_admin_err_needs_update_sub') };
    case 'NOT_GROUP_OWNER':
      return { title: tStatic('grp_admin_err_not_owner') };
    case 'NOT_ELIGIBLE':
      return { title: tStatic('grp_admin_err_not_eligible') };
    case 'TARGET_IS_OWNER':
      return { title: tStatic('grp_admin_err_is_owner') };
    default:
      return { title: tStatic('grp_admin_err_generic') };
  }
}
