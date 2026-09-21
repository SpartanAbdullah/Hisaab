-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Group co-admins: making someone an admin keeps the owner an admin
-- (founder report, 2026-09-19)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor AFTER every file in
-- supabase/tests/apply-order.txt up to and including
-- supabase-migration-p3-rls-initplan-and-indexes.sql. The hard prerequisites:
--   supabase-migration-p0-launch-blockers.sql         ("Group owners can update
--                                                       members" / "… update
--                                                       invites", replaced in §4)
--   supabase-migration-audit-p0-group-deletion-guard.sql (archive_group /
--                                                       unarchive_group, §5a/§5b)
--   supabase-migration-audit-p0-account-deletion.sql  (transfer_group_ownership, §5d)
--   supabase-migration-p2-guest-members.sql           (remove_group_guest, §5c)
--   supabase-migration-p3-rls-initplan-and-indexes.sql (its §1 DROPs and
--                                                       re-CREATEs the split_groups
--                                                       UPDATE policy BY NAME — this
--                                                       file must come after it or
--                                                       §4a is wiped)
-- In production every one of those is already applied: run this file on its
-- own. It writes its own EXECUTE grants and search_path pins, so
-- supabase-migration-p3-rpc-execute-grants.sql does NOT need a re-run; that
-- file's allowlists now name set_group_admin / is_group_admin, so a future
-- re-run keeps them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE for every function,
-- DROP … IF EXISTS before every trigger and policy. Wrapped in one transaction
-- and self-verifying (§6): if any check fails, nothing is applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- The founder: "if one person is owner and he marks other person as admin, the
-- owner shall also stay as admin … assigning someone else as a group admin
-- removed me from group admin."
--
-- A group had exactly ONE manager: split_groups.user_id (mirrored as
-- group_members.role = 'owner'). The group screen's "Assign another admin"
-- menu item actually called transfer_group_ownership (account-deletion.sql §5),
-- which MOVES split_groups.user_id and demotes the caller to a plain member —
-- so "assign an admin" silently meant "give the group away". There was no way
-- to share the management of a group at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MODEL
-- ─────────────────────────────────────────────────────────────────────────────
--   owner  — split_groups.user_id. Exactly one. Always an admin.
--   admin  — group_members.is_admin = true on a CONNECTED, profile-linked seat.
--            Any number. Granted and removed ONLY by the owner, ONLY through
--            set_group_admin (a client PATCH of the flag is refused, §3).
--   member — everyone else who has joined.
--
-- public.is_group_admin(group, uid) is TRUE for the owner OR an admin, and it
-- is what every management gate below now asks.
--
-- PERMISSION MATRIX (after this file)            owner   admin   member
--   see the group, add expenses / settlements      yes     yes     yes
--   add a guest seat (add_group_guest)             yes     yes     yes
--   create an invite link (group_invites INSERT)   yes     YES*    no
--   update an invite (group_invites UPDATE)        yes     YES*    no
--   re-invite a member who left / rename a guest   yes     YES*    no
--     (group_members UPDATE)
--   remove an unused guest seat                    yes     YES*    only a seat
--                                                                  they added
--   refresh the join code / rename the group       yes     YES*    no
--     (split_groups UPDATE)
--   archive / reopen the group                     yes     YES*    no
--   add a Hisaab user straight into the group      yes     no      no
--     (group_members INSERT — unchanged, see below)
--   delete the group                               yes     no      no
--   transfer ownership                             yes     no      no
--   make / remove admins (set_group_admin)         yes     no      no
--   leave the group                                no**    yes     yes
--   * new in this file.
--   ** unchanged: leave_group's ONLY_OWNER_ADMIN — the owner transfers
--      ownership first. An admin who leaves loses the flag (§3 hygiene).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DECISIONS, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- D1. OWNER-ONLY stays owner-only for the three irreversible or power-moving
--     acts: deleting the group, transferring it, and choosing admins. An admin
--     who could mint admins could lock the owner out socially; an admin who
--     could delete would reopen the cross-user destruction R2 of
--     account-deletion.sql closed.
--
-- D2. group_members INSERT stays owner-only ("Group owners can add members",
--     untouched). No client path inserts a member into an existing group (the
--     app only does it inside createGroup, as the owner), and the M17 block
--     model is deliberately OWNER-scoped (p2-trust-safety [J1]):
--     tg_group_members_block_guard compares the joiner with the group OWNER,
--     and tg_group_members_notify_invited writes the invitee a notification
--     with no block filter. Opening that INSERT to admins would let a person
--     you blocked invite you. Admins invite through links and the join code,
--     which the invitee redeems themselves.
--
-- D3. The admin flag is protected by its OWN trigger (§3) instead of a new
--     line in tg_group_members_protect_membership_fields. That function belongs
--     to consent-guards / safe-leave-group; re-applying either file (the
--     corpus is re-runnable by design) would silently drop an edit made here.
--     A separate trigger cannot be undone that way.
--
-- D4. Widening the split_groups UPDATE policy to admins would let an admin
--     write split_groups.user_id — i.e. make themselves the owner. §2 freezes
--     user_id and created_by against every client role first; ownership moves
--     only through transfer_group_ownership (a definer RPC, exempt). This
--     costs the owner nothing: the old WITH CHECK (auth.uid() = user_id)
--     already refused an owner handing the row to somebody else.
--
-- D5. transfer_group_ownership now keeps the previous owner as an ADMIN
--     (is_admin = true on their seat) instead of demoting them to a plain
--     member. That is the founder's rule applied to the one remaining path
--     that removed him: handing the group over no longer takes away his
--     ability to help run it. The new owner can remove that admin with
--     set_group_admin like any other.
--
-- D6. The policy on split_groups keeps its NAME, "Owners can update own
--     groups", while its expression widens. The name is pinned by
--     supabase/tests/tests/90-performance-hardening.sql ("exactly one
--     permissive policy per command") and by p3-rls-initplan-and-indexes §1's
--     re-run no-op check (it looks for these three names). The three policies
--     that change NAME (group_members UPDATE, group_invites INSERT/UPDATE) are
--     pinned by nothing and now say what they do.
--
-- D7. Every new policy is written pre-hoisted — (SELECT auth.uid()) — so
--     p3-rls-initplan-and-indexes has nothing to rewrite and does not need to
--     run again (90-performance-hardening.sql asserts no bare auth.uid()).
--
-- D8. Admin changes are allowed on an ARCHIVED group. They touch no ledger
--     row, and they are how an owner lets a co-admin reopen it.
--
-- D9. RESIDUAL, accepted: an admin inherits exactly the row powers the owner
--     already had over group_members through the UPDATE policy — every field
--     guard still applies (status / role / profile_id on a connected seat,
--     is_admin), so that is display names, re-inviting a departed member, and
--     the legacy guest-seat self-claim (attaching one's OWN profile to an
--     unclaimed guest seat, splitStore claimPaidByMemberIfMine). Admins are
--     people the owner chose; narrowing the owner's own powers is out of scope.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CLIENT COMPATIBILITY (the client ships independently of this file)
-- ─────────────────────────────────────────────────────────────────────────────
-- BEFORE this file is applied:
--   * group loading is unaffected — the client reads group_members with
--     select('*') and maps a missing is_admin to undefined, so nobody is an
--     admin (src/lib/groupRoles.ts groupSupportsAdmins tells the two apart);
--   * every management control is shown to the owner only (canManageGroup ==
--     isOwner when nobody is an admin), exactly as today;
--   * "Make admin" calls set_group_admin, PostgREST answers PGRST202 (function
--     not in the schema cache) and the app says the feature needs a database
--     update. Nothing is written.
-- AFTER: admins exist, every gate in the matrix above applies, and the same
-- client build lights up without a release.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDATION
-- ─────────────────────────────────────────────────────────────────────────────
-- Applied to a throwaway postgres:15 with the full apply-order.txt corpus
-- (supabase/tests/run.sh: 77 files applied cleanly, 715 assertions, 0 failed)
-- and exercised by supabase/tests/tests/8u-group-admins.sql (59 assertions) as
-- real `authenticated` sessions: owner / admin / member / outsider through
-- every row of the matrix, the flag guard, the ownership freeze,
-- leave-and-rejoin hygiene, and transfer keeping the previous owner an admin.
-- Also applied three times in a row on top of the migrated corpus (the
-- production order: AFTER p3-rpc-execute-grants), then that grants sweep
-- re-run: no errors, §6 green each time, both new functions keep
-- authenticated EXECUTE.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. The admin flag and the one question every gate asks
-- ═══════════════════════════════════════════════════════════════════════════

-- Constant default: metadata-only on Postgres 11+, no table rewrite.
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.group_members.is_admin IS
  'Co-admin of the group (supabase-migration-group-admins.sql). Meaningful only on a connected, profile-linked, non-owner seat; the owner (split_groups.user_id) is always an admin regardless of this flag. Written ONLY by set_group_admin and transfer_group_ownership — a client-role change is refused by group_members_admin_flag, which also clears the flag whenever the seat stops being connected.';

-- SECURITY DEFINER for the same reason as is_group_member (fix-rls-recursion):
-- it reads group_members from inside group_members' own UPDATE policy, and a
-- definer read bypasses RLS instead of recursing into it.
CREATE OR REPLACE FUNCTION public.is_group_admin(p_group_id TEXT, p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.split_groups g
          WHERE g.id = p_group_id
            AND g.user_id = p_uid
       )
       OR EXISTS (
         SELECT 1 FROM public.group_members gm
          WHERE gm.group_id = p_group_id
            AND gm.profile_id = p_uid
            AND gm.status = 'connected'
            AND gm.is_admin
       )
     );
$$;

COMMENT ON FUNCTION public.is_group_admin(TEXT, UUID) IS
  'TRUE when p_uid manages the group: its owner (split_groups.user_id) or a connected co-admin (group_members.is_admin). The single predicate behind every owner-or-admin RLS policy and RPC gate. authenticated only — RLS policies are privilege-checked against the querying role (p3-rpc-execute-grants R1); never anon.';

REVOKE ALL ON FUNCTION public.is_group_admin(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_group_admin(TEXT, UUID) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. Ownership cannot be PATCHed (D4)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tg_split_groups_protect_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Client roles only. transfer_group_ownership (definer) and the FK's own
  -- ON DELETE SET NULL on created_by run as the table owner and pass.
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'GROUP_OWNERSHIP_RPC_ONLY: the group owner changes only through transfer_group_ownership'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_split_groups_protect_ownership() IS
  'Freezes split_groups.user_id (the owner) and created_by against client roles, so the owner-or-admin UPDATE policy cannot be used by an admin to take the group. Ownership moves only through transfer_group_ownership.';

DROP TRIGGER IF EXISTS split_groups_protect_ownership ON public.split_groups;
CREATE TRIGGER split_groups_protect_ownership
  BEFORE UPDATE ON public.split_groups
  FOR EACH ROW EXECUTE FUNCTION public.tg_split_groups_protect_ownership();

REVOKE ALL ON FUNCTION public.tg_split_groups_protect_ownership() FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. The admin flag is granted by the RPC only, and never outlives
-- the membership (D3)
-- ═══════════════════════════════════════════════════════════════════════════
-- Ordering: BEFORE triggers fire alphabetically, so this runs ahead of
-- group_members_require_invite_consent (which may force status='invited' on a
-- client INSERT). That is harmless: a client INSERT is forced to false here
-- regardless of status, and no later BEFORE trigger changes status on UPDATE.
CREATE OR REPLACE FUNCTION public.tg_group_members_admin_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- Nobody is BORN an admin — not the owner's own seat in createGroup,
      -- not an invitee, not a guest. The flag is granted afterwards.
      NEW.is_admin := false;
    ELSIF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      RAISE EXCEPTION 'GROUP_ADMIN_RPC_ONLY: admins are added and removed through set_group_admin'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Every role, definer RPCs included: an admin is a live, profile-linked
  -- member. leave_group, decline_group_membership and delete_current_user all
  -- move a seat off 'connected' (or null its profile) and the flag goes with
  -- it, so a member who leaves and later rejoins by code does not silently
  -- come back as an admin.
  IF NEW.is_admin AND (NEW.status IS DISTINCT FROM 'connected' OR NEW.profile_id IS NULL) THEN
    NEW.is_admin := false;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_group_members_admin_flag() IS
  'group_members.is_admin rules: a client INSERT is always forced to false, a client UPDATE that changes it is refused (GROUP_ADMIN_RPC_ONLY — use set_group_admin), and for every role the flag is cleared on any seat that is not connected and profile-linked.';

DROP TRIGGER IF EXISTS group_members_admin_flag ON public.group_members;
CREATE TRIGGER group_members_admin_flag
  BEFORE INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_admin_flag();

REVOKE ALL ON FUNCTION public.tg_group_members_admin_flag() FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. RLS: owner-only management policies become owner-or-admin
-- ═══════════════════════════════════════════════════════════════════════════

-- 4a. split_groups UPDATE — join-code rotation, name / emoji. Name kept (D6);
--     user_id / created_by are frozen by §2, archived_at / archived_by by
--     split_groups_protect_archive (group-deletion-guard §4).
DROP POLICY IF EXISTS "Owners can update own groups" ON public.split_groups;
CREATE POLICY "Owners can update own groups"
  ON public.split_groups FOR UPDATE TO authenticated
  USING      ((SELECT auth.uid()) = user_id OR public.is_group_admin(id, (SELECT auth.uid())))
  WITH CHECK ((SELECT auth.uid()) = user_id OR public.is_group_admin(id, (SELECT auth.uid())));

COMMENT ON POLICY "Owners can update own groups" ON public.split_groups IS
  'Owner OR co-admin (supabase-migration-group-admins.sql). The name predates co-admins and is pinned by 90-performance-hardening.sql and p3-rls-initplan-and-indexes §1. user_id and created_by cannot change from a client (split_groups_protect_ownership).';

-- 4b. group_members UPDATE — rename a guest seat, re-invite a member who left
--     (createInvite flips a linked, non-connected seat to 'invited').
--     Connected seats stay locked by group_members_protect_membership_fields
--     (status / role / profile_id) and §3 (is_admin), for admins and owner
--     alike.
DROP POLICY IF EXISTS "Group owners can update members" ON public.group_members;
DROP POLICY IF EXISTS "Group admins can update members" ON public.group_members;
CREATE POLICY "Group admins can update members"
  ON public.group_members FOR UPDATE TO authenticated
  USING      (public.is_group_admin(group_id, (SELECT auth.uid())))
  WITH CHECK (public.is_group_admin(group_id, (SELECT auth.uid())));

COMMENT ON POLICY "Group admins can update members" ON public.group_members IS
  'Owner or co-admin (supabase-migration-group-admins.sql; was owner-only "Group owners can update members", p0-launch-blockers). Field-level limits live in group_members_protect_membership_fields and group_members_admin_flag.';

-- 4c. group_invites INSERT — minting an invite link. created_by is now pinned
--     to the caller as well: the DELETE policy trusts created_by, so an admin
--     must not be able to mint an invite in someone else's name.
DROP POLICY IF EXISTS "Group owners can create invites" ON public.group_invites;
DROP POLICY IF EXISTS "Group admins can create invites" ON public.group_invites;
CREATE POLICY "Group admins can create invites"
  ON public.group_invites FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND public.is_group_admin(group_id, (SELECT auth.uid()))
  );

COMMENT ON POLICY "Group admins can create invites" ON public.group_invites IS
  'Owner or co-admin mints invite links, always in their own name (supabase-migration-group-admins.sql; was owner-only "Group owners can create invites", supabase-schema.sql).';

-- 4d. group_invites UPDATE (revoke / relink). The column-level UPDATE grant
--     from consent-guards §3.2 still limits WHICH columns can move.
DROP POLICY IF EXISTS "Group owners can update invites" ON public.group_invites;
DROP POLICY IF EXISTS "Group admins can update invites" ON public.group_invites;
CREATE POLICY "Group admins can update invites"
  ON public.group_invites FOR UPDATE TO authenticated
  USING      (public.is_group_admin(group_id, (SELECT auth.uid())))
  WITH CHECK (public.is_group_admin(group_id, (SELECT auth.uid())));

COMMENT ON POLICY "Group admins can update invites" ON public.group_invites IS
  'Owner or co-admin (supabase-migration-group-admins.sql; was owner-only "Group owners can update invites", p0-launch-blockers).';

-- NOT changed, on purpose:
--   group_members  "Group owners can add members"  (INSERT)  — D2
--   split_groups   "Owners can delete own groups"  (DELETE)  — D1
--   split_groups   "Owners can create own groups"  (INSERT)  — creating a group
--   group_invites  "Owner can revoke invites"      (DELETE)  — keyed on
--                  created_by, so an admin can already delete their own.


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- 5a. archive_group — group-deletion-guard §6b, verbatim except the gate
--     (owner → is_group_admin), its reason code and the actor fallback text.
CREATE OR REPLACE FUNCTION public.archive_group(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      UUID := auth.uid();
  v_group    public.split_groups%ROWTYPE;
  v_now      TIMESTAMPTZ := now();
  v_event_id TEXT := gen_random_uuid()::text;
  v_actor    TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  -- One generic answer for "missing group", "guessed id" and "not an admin",
  -- so the RPC never confirms that an unrelated group exists — leave_group's
  -- rule (safe-leave-group.sql:75-91).
  IF v_group.id IS NULL OR NOT public.is_group_admin(p_group_id, v_uid) THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_ADMIN',
      'user_message', 'Only the group owner or an admin can archive this group.'
    );
  END IF;

  IF v_group.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'reason_code', 'ALREADY_ARCHIVED',
      'user_message', 'This group is already archived.',
      'archived_at', v_group.archived_at
    );
  END IF;

  UPDATE public.split_groups
     SET archived_at = v_now,
         archived_by = v_uid
   WHERE id = p_group_id;

  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), NULLIF(trim(p.name), ''), 'A group admin')
    INTO v_actor
    FROM public.profiles p
    LEFT JOIN public.group_members gm
      ON gm.group_id = p_group_id AND gm.profile_id = v_uid
   WHERE p.id = v_uid
   LIMIT 1;

  v_actor := COALESCE(v_actor, 'A group admin');

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, v_uid, 'group_archived', 'group', p_group_id,
    v_actor || ' archived this group. It stays readable, but nothing new can be added.',
    jsonb_build_object(
      'groupId',    p_group_id,
      'groupName',  v_group.name,
      'currency',   v_group.currency,
      'actorName',  v_actor,
      'archivedAt', v_now
    ),
    v_now
  );

  PERFORM public.notify_group_archive_state(
    p_group_id, v_event_id, v_uid, 'group_archived',
    'Group archived',
    v_actor || ' archived ' || v_group.name || '. It is now read-only.',
    jsonb_build_object('groupId', p_group_id, 'groupName', v_group.name,
                       'currency', v_group.currency, 'actorName', v_actor)
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'GROUP_ARCHIVED',
    'user_message', 'Group archived. Everyone can still see it, but nothing new can be added.',
    'archived_at', v_now
  );
END;
$fn$;

COMMENT ON FUNCTION public.archive_group(TEXT) IS
  'Owner-or-admin, non-destructive alternative to deleting a shared group. Sets split_groups.archived_at (readable by all members, closed to new expenses, settlements and joins) and emits a group_archived event. Returns leave_group''s { success, reason_code, user_message } shape; reason_code is NOT_GROUP_ADMIN, ALREADY_ARCHIVED or GROUP_ARCHIVED.';

REVOKE ALL ON FUNCTION public.archive_group(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_group(TEXT) TO authenticated;

-- 5b. unarchive_group — group-deletion-guard §6c, same three edits as 5a.
CREATE OR REPLACE FUNCTION public.unarchive_group(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      UUID := auth.uid();
  v_group    public.split_groups%ROWTYPE;
  v_now      TIMESTAMPTZ := now();
  v_event_id TEXT := gen_random_uuid()::text;
  v_actor    TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF v_group.id IS NULL OR NOT public.is_group_admin(p_group_id, v_uid) THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_ADMIN',
      'user_message', 'Only the group owner or an admin can reopen this group.'
    );
  END IF;

  IF v_group.archived_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'reason_code', 'NOT_ARCHIVED',
      'user_message', 'This group is already active.'
    );
  END IF;

  UPDATE public.split_groups
     SET archived_at = NULL,
         archived_by = NULL
   WHERE id = p_group_id;

  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), NULLIF(trim(p.name), ''), 'A group admin')
    INTO v_actor
    FROM public.profiles p
    LEFT JOIN public.group_members gm
      ON gm.group_id = p_group_id AND gm.profile_id = v_uid
   WHERE p.id = v_uid
   LIMIT 1;

  v_actor := COALESCE(v_actor, 'A group admin');

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, v_uid, 'group_unarchived', 'group', p_group_id,
    v_actor || ' reopened this group.',
    jsonb_build_object(
      'groupId',      p_group_id,
      'groupName',    v_group.name,
      'currency',     v_group.currency,
      'actorName',    v_actor,
      'unarchivedAt', v_now
    ),
    v_now
  );

  PERFORM public.notify_group_archive_state(
    p_group_id, v_event_id, v_uid, 'group_unarchived',
    'Group reopened',
    v_actor || ' reopened ' || v_group.name || '.',
    jsonb_build_object('groupId', p_group_id, 'groupName', v_group.name,
                       'currency', v_group.currency, 'actorName', v_actor)
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'GROUP_UNARCHIVED',
    'user_message', 'Group reopened. You can add expenses again.',
    'archived_at', NULL
  );
END;
$fn$;

COMMENT ON FUNCTION public.unarchive_group(TEXT) IS
  'Owner-or-admin reopen of an archived group. Same { success, reason_code, user_message } shape as archive_group; reason_code is NOT_GROUP_ADMIN, NOT_ARCHIVED or GROUP_UNARCHIVED.';

REVOKE ALL ON FUNCTION public.unarchive_group(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unarchive_group(TEXT) TO authenticated;

-- 5c. remove_group_guest — p2-guest-members §4b, verbatim except the gate:
--     the owner OR an admin OR whoever added the seat.
CREATE OR REPLACE FUNCTION public.remove_group_guest(
  p_group_id  TEXT,
  p_member_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_group  public.split_groups%ROWTYPE;
  v_member public.group_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups WHERE id = p_group_id FOR NO KEY UPDATE;

  IF v_group.id IS NULL OR NOT public.is_group_member(p_group_id, v_uid) THEN
    RETURN jsonb_build_object('status', 'NOT_ACTIVE_MEMBER');
  END IF;
  IF v_group.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'GROUP_ARCHIVED');
  END IF;

  SELECT * INTO v_member
    FROM public.group_members AS gm
   WHERE gm.id = p_member_id
     AND gm.group_id = p_group_id
   FOR UPDATE;

  IF v_member.id IS NULL OR v_member.profile_id IS NOT NULL OR v_member.status = 'left' THEN
    RETURN jsonb_build_object('status', 'NOT_A_GUEST');
  END IF;

  IF NOT public.is_group_admin(p_group_id, v_uid)
     AND v_member.invited_by IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('status', 'NOT_ALLOWED');
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.group_expenses e
        WHERE e.group_id = p_group_id
          AND (e.paid_by = p_member_id
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS s(value)
                  WHERE COALESCE(s.value->>'memberId', s.value->>'member_id') = p_member_id))
     ) OR EXISTS (
       SELECT 1 FROM public.group_settlements st
        WHERE st.group_id = p_group_id
          AND (st.from_member = p_member_id OR st.to_member = p_member_id)
     ) THEN
    RETURN jsonb_build_object('status', 'GUEST_HAS_LEDGER');
  END IF;

  DELETE FROM public.group_members WHERE id = p_member_id;

  RETURN jsonb_build_object('status', 'ok', 'member_id', p_member_id);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_group_guest(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_group_guest(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.remove_group_guest(TEXT, TEXT) IS
  'G6/O4: deletes an unused guest seat (the owner, a co-admin, or the member who added it). Refuses GUEST_HAS_LEDGER the moment any expense, split share or settlement — including soft-deleted ones — references the member id, so the ledger can never dangle.';

-- 5d. transfer_group_ownership — account-deletion §5, still OWNER-ONLY (D1).
--     Two edits: the previous owner's seat keeps is_admin = true (D5), and the
--     new owner's seat drops the now-meaningless flag, so "is_admin = true"
--     only ever marks a non-owner co-admin.
CREATE OR REPLACE FUNCTION public.transfer_group_ownership(
  p_group_id       TEXT,
  p_new_owner_member_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_group        public.split_groups%ROWTYPE;
  v_new_owner    public.group_members%ROWTYPE;
  v_old_member   public.group_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF v_group.id IS NULL OR v_group.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_OWNER',
      'user_message', 'Only the group owner can transfer ownership.'
    );
  END IF;

  SELECT * INTO v_new_owner
    FROM public.group_members
   WHERE id = p_new_owner_member_id
     AND group_id = p_group_id
     AND status = 'connected'
     AND profile_id IS NOT NULL
     AND profile_id <> v_uid
   FOR UPDATE;

  IF v_new_owner.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'INVALID_NEW_OWNER',
      'user_message', 'Pick a member who has joined this group on Hisaab.'
    );
  END IF;

  UPDATE public.split_groups
     SET user_id = v_new_owner.profile_id
   WHERE id = p_group_id;

  UPDATE public.group_members
     SET role = 'owner',
         is_admin = false
   WHERE id = v_new_owner.id;

  SELECT * INTO v_old_member
    FROM public.group_members
   WHERE group_id = p_group_id
     AND profile_id = v_uid
   LIMIT 1;

  IF v_old_member.id IS NOT NULL THEN
    -- The previous owner stays an admin (D5). group_members_admin_flag clears
    -- it again if this seat is somehow not a connected one.
    UPDATE public.group_members
       SET role = 'member',
           is_admin = true
     WHERE id = v_old_member.id;
  END IF;

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload
  ) VALUES (
    gen_random_uuid()::text,
    p_group_id,
    v_uid,
    'group_ownership_transferred',
    'group',
    p_group_id,
    'Group ownership moved to ' || COALESCE(NULLIF(trim(v_new_owner.display_name), ''), 'another member') || '.',
    jsonb_build_object(
      'newOwnerMemberId',  v_new_owner.id,
      'newOwnerProfileId', v_new_owner.profile_id,
      'previousOwnerMemberId', v_old_member.id,
      'previousOwnerStaysAdmin', v_old_member.id IS NOT NULL
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'OWNERSHIP_TRANSFERRED',
    'user_message', 'Ownership transferred. You are still an admin of this group.',
    'new_owner_member_id', v_new_owner.id
  );
END;
$$;

COMMENT ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) IS
  'Owner-only ownership transfer. The target must be a connected, profile-linked member of the same group. Moves split_groups.user_id, swaps the owner/member roles, keeps the previous owner as a co-admin (group_members.is_admin), and logs a group_ownership_transferred event. Exists so delete_current_user''s OWNED_GROUPS_WITH_MEMBERS and leave_group''s ONLY_OWNER_ADMIN refusals have a resolution path.';

REVOKE ALL ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) TO authenticated;

-- 5e. set_group_admin — NEW. Owner-only (D1). Failures are data, never
--     exceptions (the audit-H1 rule every recent group RPC follows):
--
--   set_group_admin(p_group_id TEXT, p_member_id TEXT, p_is_admin BOOLEAN) -> JSONB
--     {"status":"ok","member_id":…,"is_admin":bool,"changed":bool}
--     {"status":"NOT_AUTHENTICATED"}
--     {"status":"INVALID_REQUEST"}    -- p_is_admin NULL
--     {"status":"NOT_GROUP_OWNER"}    -- also: no such group (no oracle)
--     {"status":"MEMBER_NOT_FOUND"}   -- no such seat in THIS group
--     {"status":"TARGET_IS_OWNER"}    -- the owner is always an admin
--     {"status":"NOT_ELIGIBLE"}       -- a guest, invited or departed seat
--
-- Demoting a seat that is no longer connected answers ok/changed=false: the
-- flag was already cleared by group_members_admin_flag when it left.
CREATE OR REPLACE FUNCTION public.set_group_admin(
  p_group_id  TEXT,
  p_member_id TEXT,
  p_is_admin  BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_now    TIMESTAMPTZ := now();
  v_group  public.split_groups%ROWTYPE;
  v_member public.group_members%ROWTYPE;
  v_actor  TEXT;
  v_name   TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  IF p_is_admin IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_REQUEST');
  END IF;

  -- FOR UPDATE on the group row serializes this with transfer_group_ownership
  -- (which takes the same lock), so the owner check cannot race a handover.
  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF v_group.id IS NULL OR v_group.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('status', 'NOT_GROUP_OWNER');
  END IF;

  SELECT * INTO v_member
    FROM public.group_members AS gm
   WHERE gm.id = p_member_id
     AND gm.group_id = p_group_id
   FOR UPDATE;

  IF v_member.id IS NULL THEN
    RETURN jsonb_build_object('status', 'MEMBER_NOT_FOUND');
  END IF;

  IF v_member.role = 'owner' OR v_member.profile_id IS NOT DISTINCT FROM v_group.user_id THEN
    RETURN jsonb_build_object('status', 'TARGET_IS_OWNER');
  END IF;

  IF p_is_admin AND (v_member.status IS DISTINCT FROM 'connected' OR v_member.profile_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'NOT_ELIGIBLE');
  END IF;

  IF v_member.is_admin IS NOT DISTINCT FROM p_is_admin THEN
    RETURN jsonb_build_object(
      'status', 'ok', 'member_id', v_member.id,
      'is_admin', p_is_admin, 'changed', false
    );
  END IF;

  UPDATE public.group_members
     SET is_admin = p_is_admin
   WHERE id = v_member.id;

  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), NULLIF(trim(p.name), ''), 'The group owner')
    INTO v_actor
    FROM public.profiles p
    LEFT JOIN public.group_members gm
      ON gm.group_id = p_group_id AND gm.profile_id = v_uid
   WHERE p.id = v_uid
   LIMIT 1;
  v_actor := COALESCE(v_actor, 'The group owner');
  v_name  := COALESCE(NULLIF(trim(v_member.display_name), ''), 'A member');

  -- Durable, member-visible history — the same shape transfer_group_ownership
  -- writes. No push: a role change is a fact for the activity feed, not an
  -- alert.
  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    gen_random_uuid()::text,
    p_group_id,
    v_uid,
    CASE WHEN p_is_admin THEN 'member_admin_granted' ELSE 'member_admin_revoked' END,
    'member',
    v_member.id,
    CASE WHEN p_is_admin
         THEN v_actor || ' made ' || v_name || ' an admin.'
         ELSE v_actor || ' removed ' || v_name || ' as an admin.'
    END,
    jsonb_build_object(
      'memberId',        v_member.id,
      'memberProfileId', v_member.profile_id,
      'memberName',      v_name,
      'isAdmin',         p_is_admin,
      'actorName',       v_actor
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'status', 'ok', 'member_id', v_member.id,
    'is_admin', p_is_admin, 'changed', true
  );
END;
$$;

COMMENT ON FUNCTION public.set_group_admin(TEXT, TEXT, BOOLEAN) IS
  'Owner-only: make a connected, profile-linked member a co-admin of the group, or remove them. The owner stays the owner (and an admin) either way. Writes a member_admin_granted / member_admin_revoked group event. Failures are data: NOT_AUTHENTICATED, INVALID_REQUEST, NOT_GROUP_OWNER, MEMBER_NOT_FOUND, TARGET_IS_OWNER, NOT_ELIGIBLE.';

REVOKE ALL ON FUNCTION public.set_group_admin(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_group_admin(TEXT, TEXT, BOOLEAN) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. Self-verification — inside the transaction, so drift aborts the
-- whole apply instead of leaving a half-migrated database.
-- ═══════════════════════════════════════════════════════════════════════════
DO $verify$
DECLARE
  v_missing TEXT;
BEGIN
  -- V1. The column, with the shape every gate assumes.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'group_members'
       AND column_name = 'is_admin' AND data_type = 'boolean'
       AND is_nullable = 'NO' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'group-admins V1 FAILED: group_members.is_admin is missing or not BOOLEAN NOT NULL DEFAULT false';
  END IF;

  -- V2. Helper + RPC: SECURITY DEFINER, search_path pinned, authenticated
  --     only (p3-rpc-execute-grants R1 / advisor (a)).
  -- CASE, not OR: has_function_privilege() RAISES on a missing signature, and
  -- SQL does not promise to short-circuit OR.
  SELECT string_agg(x.sig, ', ') INTO v_missing
    FROM unnest(ARRAY['public.is_group_admin(text, uuid)',
                      'public.set_group_admin(text, text, boolean)']) AS x(sig)
   WHERE CASE
           WHEN to_regprocedure(x.sig) IS NULL THEN true
           ELSE NOT (SELECT p.prosecdef
                            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%')
                       FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig))
                OR NOT has_function_privilege('authenticated', x.sig, 'EXECUTE')
                OR has_function_privilege('anon', x.sig, 'EXECUTE')
         END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'group-admins V2 FAILED: wrong shape or grants on %', v_missing;
  END IF;

  -- V3. The two trigger functions exist, are attached, and no client role can
  --     call them as bare RPCs (advisor (b)).
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND ((t.tgname = 'group_members_admin_flag'
               AND t.tgrelid = 'public.group_members'::regclass)
           OR (t.tgname = 'split_groups_protect_ownership'
               AND t.tgrelid = 'public.split_groups'::regclass))) <> 2 THEN
    RAISE EXCEPTION 'group-admins V3 FAILED: a trigger is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_group_members_admin_flag()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_group_members_admin_flag()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_split_groups_protect_ownership()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_split_groups_protect_ownership()', 'EXECUTE') THEN
    RAISE EXCEPTION 'group-admins V3 FAILED: a trigger function is client-executable';
  END IF;

  -- V4. The four widened policies are in place and ask is_group_admin; the
  --     three owner-only names they replace are gone.
  SELECT string_agg(x.tbl || '.' || x.pol, ', ') INTO v_missing
    FROM (VALUES ('split_groups',  'Owners can update own groups',    'UPDATE'),
                 ('group_members', 'Group admins can update members', 'UPDATE'),
                 ('group_invites', 'Group admins can create invites', 'INSERT'),
                 ('group_invites', 'Group admins can update invites', 'UPDATE')) AS x(tbl, pol, cmd)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = x.tbl
        AND p.policyname = x.pol AND p.cmd = x.cmd
        AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) LIKE '%is_group_admin%'
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'group-admins V4 FAILED: policy missing or not owner-or-admin: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND ((tablename = 'group_members' AND policyname = 'Group owners can update members')
                  OR (tablename = 'group_invites' AND policyname IN ('Group owners can create invites',
                                                                      'Group owners can update invites')))) THEN
    RAISE EXCEPTION 'group-admins V4 FAILED: an owner-only policy this file replaces is still present';
  END IF;

  -- V5. What must stay OWNER-ONLY stayed owner-only (D1 / D2).
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND ((tablename = 'split_groups' AND cmd = 'DELETE')
                  OR (tablename = 'group_members' AND cmd = 'INSERT'))
                AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) LIKE '%is_group_admin%') THEN
    RAISE EXCEPTION 'group-admins V5 FAILED: group deletion or direct member insertion was widened to admins';
  END IF;
  IF position('is_group_admin' IN (SELECT prosrc FROM pg_proc
                                     WHERE oid = 'public.transfer_group_ownership(text, text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'group-admins V5 FAILED: transfer_group_ownership must stay owner-only';
  END IF;

  -- V6. The management RPCs ask the new question.
  SELECT string_agg(x.sig, ', ') INTO v_missing
    FROM unnest(ARRAY['public.archive_group(text)',
                      'public.unarchive_group(text)',
                      'public.remove_group_guest(text, text)']) AS x(sig)
   WHERE position('is_group_admin' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(x.sig))) = 0;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'group-admins V6 FAILED: still owner-only: %', v_missing;
  END IF;

  RAISE NOTICE 'group-admins: OK';
END;
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR QUERIES — read-only, run by hand after applying.
-- ════════════════════════════════════════════════════════════════════════════
-- Q1. Who manages each of my groups (owner first, then admins):
--
--   SELECT g.name, gm.display_name,
--          CASE WHEN gm.profile_id = g.user_id THEN 'owner' ELSE 'admin' END AS role
--     FROM public.split_groups g
--     JOIN public.group_members gm ON gm.group_id = g.id
--    WHERE gm.status = 'connected'
--      AND (gm.profile_id = g.user_id OR gm.is_admin)
--    ORDER BY g.name, role DESC, gm.display_name;
--
-- Q2. Invariant: no admin flag on a seat that is not connected + linked
--     (EXPECT 0):
--
--   SELECT count(*) FROM public.group_members
--    WHERE is_admin AND (status <> 'connected' OR profile_id IS NULL);

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual; only if co-admins must be withdrawn)
-- ════════════════════════════════════════════════════════════════════════════
-- 1. Re-run, from their own files, the definitions this file replaced:
--      archive_group / unarchive_group  — audit-p0-group-deletion-guard.sql §6b/§6c
--      transfer_group_ownership         — audit-p0-account-deletion.sql §5
--      remove_group_guest               — p2-guest-members.sql §4b
--      "Group owners can update members" / "Group owners can update invites"
--                                       — p0-launch-blockers.sql:163-195
--      "Group owners can create invites" — supabase-schema.sql:415-423
--      "Owners can update own groups"   — p3-rls-initplan-and-indexes.sql:222-225
--    (for the last one: DROP it first, then CREATE it with that file's body).
-- 2. Then:
--      DROP POLICY IF EXISTS "Group admins can update members" ON public.group_members;
--      DROP POLICY IF EXISTS "Group admins can create invites" ON public.group_invites;
--      DROP POLICY IF EXISTS "Group admins can update invites" ON public.group_invites;
--      DROP FUNCTION IF EXISTS public.set_group_admin(TEXT, TEXT, BOOLEAN);
--      DROP TRIGGER IF EXISTS group_members_admin_flag ON public.group_members;
--      DROP FUNCTION IF EXISTS public.tg_group_members_admin_flag();
--      DROP TRIGGER IF EXISTS split_groups_protect_ownership ON public.split_groups;
--      DROP FUNCTION IF EXISTS public.tg_split_groups_protect_ownership();
--      DROP FUNCTION IF EXISTS public.is_group_admin(TEXT, UUID);
--      ALTER TABLE public.group_members DROP COLUMN IF EXISTS is_admin;
--    The client tolerates every step: a missing is_admin reads as "nobody is
--    an admin", and a missing set_group_admin reads as "needs a database
--    update".
