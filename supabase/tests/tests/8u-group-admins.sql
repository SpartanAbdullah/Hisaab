-- ════════════════════════════════════════════════════════════════════════════
-- 8u · Group co-admins — supabase-migration-group-admins.sql
--
-- The founder's report (2026-09-19): "I assigned someone else as a group admin
-- and this action removed me from group admin." The old "Assign another admin"
-- button called transfer_group_ownership. The claims under test:
--   (a) the catalog: column, helper, RPC, trigger functions and their grants;
--   (b) THE FIX — making someone an admin leaves the owner the owner, and both
--       of them now manage the group;
--   (c) only the owner chooses admins, never on the owner seat, never a guest;
--   (d) the flag cannot be PATCHed by anyone — set_group_admin is the door;
--   (e) an admin can do the management work: join code, rename, invite links,
--       guest rename / removal, archive and reopen;
--   (f) an admin still cannot take the group, delete it, mint in someone
--       else's name, or conscript a Hisaab user straight into it;
--   (g) a plain member is exactly as limited as before;
--   (h) removing an admin takes effect at once;
--   (i) the flag never outlives the membership (leave, rejoin), and admins can
--       be chosen on an archived group so a co-admin can reopen it;
--   (j) transferring ownership keeps the previous owner an admin.
--
-- Fresh users (ad000000-…-01 … -04) and a fresh group GA1, so nothing above
-- (G1, GG1, users A–L) shifts. Member ids are deterministic: the owner invites
-- P and Q (the consent trigger forces 'invited') and each accepts.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8u-group-admins');

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  ('ad000000-0000-4000-8000-000000000001', 'admins-owner@hisaab.test'),
  ('ad000000-0000-4000-8000-000000000002', 'admins-p@hisaab.test'),
  ('ad000000-0000-4000-8000-000000000003', 'admins-q@hisaab.test'),
  ('ad000000-0000-4000-8000-000000000004', 'admins-outsider@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Omar'    WHERE id = 'ad000000-0000-4000-8000-000000000001';
UPDATE profiles SET name = 'Parveen' WHERE id = 'ad000000-0000-4000-8000-000000000002';
UPDATE profiles SET name = 'Qasim'   WHERE id = 'ad000000-0000-4000-8000-000000000003';
UPDATE profiles SET name = 'Rida'    WHERE id = 'ad000000-0000-4000-8000-000000000004';

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false'
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_members'
      AND column_name = 'is_admin'),
  'group_members.is_admin is BOOLEAN NOT NULL DEFAULT false');

-- The R1 rule from p3-rpc-execute-grants: a policy expression is checked
-- against the QUERYING role, so the helper four policies call must stay
-- executable by authenticated — and never by anon.
SELECT test.assert(
  has_function_privilege('authenticated', 'public.is_group_admin(text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_group_admin(text, uuid)', 'EXECUTE'),
  'is_group_admin: authenticated YES (RLS policy dependency), anon NO');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.set_group_admin(text, text, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.set_group_admin(text, text, boolean)', 'EXECUTE'),
  'set_group_admin: authenticated YES, anon NO');

SELECT test.assert(
  NOT has_function_privilege('authenticated', 'public.tg_group_members_admin_flag()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.tg_split_groups_protect_ownership()', 'EXECUTE'),
  'the two new trigger functions are not callable as bare RPCs');

-- ── Fixture: O owns GA1; P and Q are invited and accept; O adds two guests. ─
SET ROLE authenticated;
SELECT test.as_user('ad000000-0000-4000-8000-000000000001');

INSERT INTO split_groups (id, user_id, name, emoji, currency,
                          join_code, join_code_normalized, created_by)
VALUES ('GA1', auth.uid(), 'Office Lunch', '🍛', 'AED',
        'GRP-ADM111', 'ADM111', auth.uid());

-- Every seat is sent WITH is_admin = true on purpose: a client INSERT is
-- forced to false, so nobody is ever born an admin.
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, joined_at, is_admin)
VALUES ('MA-O', 'GA1', auth.uid(), 'Omar', 'owner', 'connected', auth.uid(), now(), true);

INSERT INTO group_members (id, group_id, profile_id, display_name, role, status,
                           invited_by, is_admin)
VALUES ('MA-P', 'GA1', 'ad000000-0000-4000-8000-000000000002', 'Parveen', 'member', 'connected', auth.uid(), true),
       ('MA-Q', 'GA1', 'ad000000-0000-4000-8000-000000000003', 'Qasim',   'member', 'connected', auth.uid(), true);

SELECT test.assert(
  (SELECT count(*) = 3 AND bool_and(NOT is_admin) FROM group_members WHERE group_id = 'GA1'),
  'a client INSERT carrying is_admin = true is forced to false — the owner seat and invitees alike');

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');
SELECT test.assert((accept_group_membership('GA1') ->> 'success')::boolean,
  'fixture: P accepts the invitation');

SELECT test.as_user('ad000000-0000-4000-8000-000000000003');
SELECT test.assert((accept_group_membership('GA1') ->> 'success')::boolean,
  'fixture: Q accepts the invitation');

SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
SELECT test.assert(
  (add_group_guest('GA1', 'Gul', NULL, 'MA-G1') ->> 'status') = 'ok'
  AND (add_group_guest('GA1', 'Hina', NULL, 'MA-G2') ->> 'status') = 'ok',
  'fixture: the owner adds two guest seats');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) THE FOUNDER'S BUG — granting admin keeps the owner the owner
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000001')
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000002')
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000003')
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000004'),
  'before any grant, only the owner manages GA1');

CREATE TEMP TABLE _grant AS SELECT set_group_admin('GA1', 'MA-P', true) AS r;
SELECT test.assert(
  (SELECT r ->> 'status' = 'ok' AND (r ->> 'changed')::boolean AND (r ->> 'is_admin')::boolean
     FROM _grant),
  'the owner makes P an admin',
  (SELECT r::text FROM _grant));

SELECT test.assert(
  (SELECT user_id FROM split_groups WHERE id = 'GA1') = 'ad000000-0000-4000-8000-000000000001'::uuid
  AND (SELECT role FROM group_members WHERE id = 'MA-O') = 'owner'
  AND is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000001')
  AND is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000002'),
  'THE FIX: after making P an admin the owner is still the owner AND still an admin — both manage GA1');

SELECT test.assert(
  (SELECT count(*) FROM group_events
    WHERE group_id = 'GA1' AND event_type = 'member_admin_granted' AND entity_id = 'MA-P') = 1,
  'the grant is written to the group activity feed');

SELECT test.assert(
  (set_group_admin('GA1', 'MA-P', true) ->> 'changed') = 'false'
  AND (SELECT count(*) FROM group_events
        WHERE group_id = 'GA1' AND event_type = 'member_admin_granted' AND entity_id = 'MA-P') = 1,
  'granting again is an idempotent ok (changed = false) with no second feed row');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) WHO MAY CHOOSE ADMINS, AND WHOM
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (set_group_admin('GA1', 'MA-O', false) ->> 'status') = 'TARGET_IS_OWNER'
  AND (set_group_admin('GA1', 'MA-O', true) ->> 'status') = 'TARGET_IS_OWNER',
  'the owner is always an admin: the owner seat can be neither granted nor demoted');

SELECT test.assert(
  (set_group_admin('GA1', 'MA-G1', true) ->> 'status') = 'NOT_ELIGIBLE',
  'a guest seat (no Hisaab account) cannot be made an admin');

SELECT test.assert(
  (set_group_admin('GA1', 'MA-NOPE', true) ->> 'status') = 'MEMBER_NOT_FOUND'
  AND (set_group_admin('GA1', 'MA-Q', NULL) ->> 'status') = 'INVALID_REQUEST',
  'an unknown seat and a NULL flag come back as data, not exceptions');

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');   -- P, an admin
SELECT test.assert(
  (set_group_admin('GA1', 'MA-Q', true) ->> 'status') = 'NOT_GROUP_OWNER'
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000003'),
  'an admin cannot make admins — choosing admins is owner-only');

SELECT test.assert(
  (transfer_group_ownership('GA1', 'MA-Q') ->> 'reason_code') = 'NOT_GROUP_OWNER',
  'an admin cannot transfer ownership — owner-only');

SELECT test.as_user('ad000000-0000-4000-8000-000000000003');   -- Q, a member
SELECT test.assert(
  (set_group_admin('GA1', 'MA-Q', true) ->> 'status') = 'NOT_GROUP_OWNER',
  'a plain member cannot make themselves an admin');

SELECT test.as_user('ad000000-0000-4000-8000-000000000004');   -- R, outsider
SELECT test.assert(
  (set_group_admin('GA1', 'MA-Q', true) ->> 'status') = 'NOT_GROUP_OWNER'
  AND (set_group_admin('G-NOPE', 'MA-Q', true) ->> 'status') = 'NOT_GROUP_OWNER',
  'an outsider gets the same answer for a real and a made-up group (no existence oracle)');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) THE FLAG CANNOT BE PATCHED
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
SELECT test.assert_raises(
  $$ UPDATE group_members SET is_admin = true WHERE id = 'MA-Q' $$,
  'GROUP_ADMIN_RPC_ONLY',
  'even the owner cannot PATCH is_admin — set_group_admin is the only door');

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');
SELECT test.assert_raises(
  $$ UPDATE group_members SET is_admin = true WHERE id = 'MA-Q' $$,
  'GROUP_ADMIN_RPC_ONLY',
  'an admin cannot PATCH another member into an admin');

SELECT test.as_user('ad000000-0000-4000-8000-000000000003');
SELECT test.assert_zero_rows(
  $$ UPDATE group_members SET is_admin = true WHERE id = 'MA-Q' $$,
  'a plain member cannot PATCH themselves into an admin (RLS: zero rows)');

SELECT test.assert(
  NOT (SELECT is_admin FROM group_members WHERE id = 'MA-Q'),
  'after all three attempts Q is still not an admin');

-- ════════════════════════════════════════════════════════════════════════════
-- (e) WHAT AN ADMIN CAN DO
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('ad000000-0000-4000-8000-000000000002');   -- P, an admin

SELECT test.assert_ok(
  $$ UPDATE split_groups SET join_code = 'GRP-ADM222', join_code_normalized = 'ADM222'
      WHERE id = 'GA1' $$,
  'an admin can refresh the join code');
SELECT test.assert(
  (SELECT join_code_normalized FROM split_groups WHERE id = 'GA1') = 'ADM222',
  '…and the new code landed');

SELECT test.assert_ok(
  $$ UPDATE split_groups SET name = 'Office Lunch Club' WHERE id = 'GA1' $$,
  'an admin can rename the group');

SELECT test.assert_ok(
  $$ INSERT INTO group_invites (id, group_id, token_hash, created_by)
     VALUES ('IA-1', 'GA1', md5('group-admins-token-1'), auth.uid()) $$,
  'an admin can create an invite link');

SELECT test.assert_ok(
  $$ UPDATE group_members SET display_name = 'Gul Bano' WHERE id = 'MA-G1' $$,
  'an admin can rename a guest seat');
SELECT test.assert(
  (SELECT display_name FROM group_members WHERE id = 'MA-G1') = 'Gul Bano',
  '…and the rename landed');

SELECT test.assert(
  (remove_group_guest('GA1', 'MA-G1') ->> 'status') = 'ok',
  'an admin can remove an unused guest seat somebody else added');

CREATE TEMP TABLE _arch_admin AS SELECT archive_group('GA1') AS r;
SELECT test.assert(
  (SELECT (r ->> 'success')::boolean FROM _arch_admin),
  'an admin can archive the group',
  (SELECT r::text FROM _arch_admin));
SELECT test.assert(
  (unarchive_group('GA1') ->> 'success')::boolean,
  'an admin can reopen the group');

-- ════════════════════════════════════════════════════════════════════════════
-- (f) WHAT AN ADMIN STILL CANNOT DO
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises(
  $$ UPDATE split_groups SET user_id = auth.uid() WHERE id = 'GA1' $$,
  'GROUP_OWNERSHIP_RPC_ONLY',
  'an admin cannot make themselves the owner by PATCHing split_groups.user_id');

SELECT test.assert_raises(
  $$ UPDATE split_groups SET created_by = auth.uid() WHERE id = 'GA1' $$,
  'GROUP_OWNERSHIP_RPC_ONLY',
  'an admin cannot rewrite split_groups.created_by either');

SELECT test.assert_zero_rows(
  $$ DELETE FROM split_groups WHERE id = 'GA1' $$,
  'an admin cannot delete the group');

SELECT test.assert_raises(
  $$ INSERT INTO group_invites (id, group_id, token_hash, created_by)
     VALUES ('IA-FORGED', 'GA1', md5('group-admins-forged'),
             'ad000000-0000-4000-8000-000000000001') $$,
  'row-level security',
  'an admin cannot mint an invite in the owner''s name (created_by is pinned to the caller)');

SELECT test.assert_raises(
  $$ INSERT INTO group_members (id, group_id, profile_id, display_name, role, status, invited_by)
     VALUES ('MA-R', 'GA1', 'ad000000-0000-4000-8000-000000000004', 'Rida', 'member', 'invited', auth.uid()) $$,
  'row-level security',
  'an admin cannot add a Hisaab user straight into the group (member INSERT stays owner-only)');

SELECT test.assert(
  (SELECT user_id FROM split_groups WHERE id = 'GA1') = 'ad000000-0000-4000-8000-000000000001'::uuid,
  'after every attempt the owner is unchanged');

-- ════════════════════════════════════════════════════════════════════════════
-- (g) A PLAIN MEMBER IS AS LIMITED AS BEFORE
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('ad000000-0000-4000-8000-000000000003');   -- Q

SELECT test.assert_zero_rows(
  $$ UPDATE split_groups SET join_code = 'GRP-ADM333', join_code_normalized = 'ADM333'
      WHERE id = 'GA1' $$,
  'a plain member cannot refresh the join code');

SELECT test.assert_raises(
  $$ INSERT INTO group_invites (id, group_id, token_hash, created_by)
     VALUES ('IA-Q', 'GA1', md5('group-admins-token-q'), auth.uid()) $$,
  'row-level security',
  'a plain member cannot create an invite link');

SELECT test.assert_zero_rows(
  $$ UPDATE group_members SET display_name = 'Renamed' WHERE id = 'MA-G2' $$,
  'a plain member cannot rename a guest seat');

SELECT test.assert(
  (archive_group('GA1') ->> 'reason_code') = 'NOT_GROUP_ADMIN'
  AND (SELECT archived_at IS NULL FROM split_groups WHERE id = 'GA1'),
  'a plain member cannot archive the group (NOT_GROUP_ADMIN)');

SELECT test.assert(
  (remove_group_guest('GA1', 'MA-G2') ->> 'status') = 'NOT_ALLOWED',
  'a plain member cannot remove a guest seat somebody else added');

-- ════════════════════════════════════════════════════════════════════════════
-- (h) REMOVING AN ADMIN
-- ════════════════════════════════════════════════════════════════════════════
-- The RPC runs in its OWN statement: is_group_admin is STABLE, so inside the
-- same statement it would still see the snapshot from before the write.
SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
CREATE TEMP TABLE _revoke AS SELECT set_group_admin('GA1', 'MA-P', false) AS r;
SELECT test.assert(
  (SELECT r ->> 'status' = 'ok' AND (r ->> 'changed')::boolean FROM _revoke)
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000002')
  AND (SELECT count(*) FROM group_events
        WHERE group_id = 'GA1' AND event_type = 'member_admin_revoked' AND entity_id = 'MA-P') = 1,
  'the owner removes P as an admin, and the feed records it',
  (SELECT r::text FROM _revoke));

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');
SELECT test.assert_zero_rows(
  $$ UPDATE split_groups SET join_code = 'GRP-ADM444', join_code_normalized = 'ADM444'
      WHERE id = 'GA1' $$,
  'a removed admin loses the power at once');

-- ════════════════════════════════════════════════════════════════════════════
-- (i) ARCHIVED GROUPS, AND THE FLAG NEVER OUTLIVES THE MEMBERSHIP
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
SELECT test.assert((archive_group('GA1') ->> 'success')::boolean,
  'fixture: the owner archives GA1');
SELECT test.assert(
  (set_group_admin('GA1', 'MA-P', true) ->> 'status') = 'ok',
  'admins can be chosen on an archived group');

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');
SELECT test.assert((unarchive_group('GA1') ->> 'success')::boolean,
  '…which is how an owner lets a co-admin reopen it');

CREATE TEMP TABLE _leave AS SELECT leave_group('GA1') AS r;
SELECT test.assert(
  (SELECT (r ->> 'success')::boolean FROM _leave),
  'an admin who is not the owner can leave the group',
  (SELECT r::text FROM _leave));

RESET ROLE;
SELECT test.assert(
  (SELECT status = 'left' AND NOT is_admin FROM group_members WHERE id = 'MA-P'),
  'leaving clears the admin flag');
SET ROLE authenticated;

SELECT test.as_user('ad000000-0000-4000-8000-000000000002');
SELECT test.assert(
  (join_group_by_code('ADM222', 'Parveen') ->> 'status') = 'ok',
  'fixture: P rejoins GA1 by code');

RESET ROLE;
SELECT test.assert(
  (SELECT status = 'connected' AND NOT is_admin FROM group_members WHERE id = 'MA-P'),
  'a member who leaves and rejoins does not silently come back as an admin');
SET ROLE authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- (j) TRANSFER KEEPS THE PREVIOUS OWNER AN ADMIN
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
CREATE TEMP TABLE _xfer AS SELECT transfer_group_ownership('GA1', 'MA-Q') AS r;
SELECT test.assert(
  (SELECT (r ->> 'success')::boolean FROM _xfer),
  'the owner transfers GA1 to Q',
  (SELECT r::text FROM _xfer));

RESET ROLE;
SELECT test.assert(
  (SELECT user_id FROM split_groups WHERE id = 'GA1') = 'ad000000-0000-4000-8000-000000000003'::uuid
  AND (SELECT role = 'owner' AND NOT is_admin FROM group_members WHERE id = 'MA-Q')
  AND (SELECT role = 'member' AND is_admin FROM group_members WHERE id = 'MA-O'),
  'Q is the owner; the previous owner is a member WITH the admin flag, not demoted to a plain member');
SET ROLE authenticated;

SELECT test.as_user('ad000000-0000-4000-8000-000000000001');
SELECT test.assert(
  is_group_admin('GA1', auth.uid())
  AND (set_group_admin('GA1', 'MA-P', true) ->> 'status') = 'NOT_GROUP_OWNER',
  'the previous owner still manages the group as an admin, but no longer chooses admins');

SELECT test.assert_ok(
  $$ UPDATE split_groups SET join_code = 'GRP-ADM555', join_code_normalized = 'ADM555'
      WHERE id = 'GA1' $$,
  'the previous owner can still refresh the join code');

SELECT test.as_user('ad000000-0000-4000-8000-000000000003');   -- Q, the new owner
CREATE TEMP TABLE _demote_prev AS SELECT set_group_admin('GA1', 'MA-O', false) AS r;
SELECT test.assert(
  (SELECT r ->> 'status' = 'ok' FROM _demote_prev)
  AND NOT is_group_admin('GA1', 'ad000000-0000-4000-8000-000000000001'),
  'the new owner can remove the previous owner''s admin role',
  (SELECT r::text FROM _demote_prev));

-- ── The operator query Q2 invariant, over the whole database ───────────────
RESET ROLE;
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM group_members
               WHERE is_admin AND (status <> 'connected' OR profile_id IS NULL)),
  'invariant: no admin flag on a seat that is not connected and profile-linked');
