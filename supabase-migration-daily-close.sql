-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Daily close: "I closed today" / "nothing spent today" markers
-- (founder request, 2026-09-22)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor. No prerequisites beyond the base schema
-- (auth.users); in production run this file on its own. It creates no
-- functions, so supabase-migration-p3-rpc-execute-grants.sql does NOT need a
-- re-run.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS before every
-- policy. One transaction, self-verifying (§3): if a check fails, nothing is
-- applied.
--
-- WHY
-- The 2026-09 balance reconciliation was drift the founder never saw coming:
-- bill payments never entered, spends never logged, accounts untouched for
-- two months. The fix is a two-minute evening habit — and a day with nothing
-- to log is real information, not a gap. Without a marker, "nothing spent"
-- and "forgot to log" look identical, the streak breaks on honest days, and
-- the evening nudge keeps ringing on a day the user already answered.
--
-- THE MODEL
--   One row per (user, local calendar day) the user explicitly closed:
--     kind 'no_spend' — "Nothing spent today" (from the sheet or the
--                        notification's action button)
--     kind 'closed'   — "Close the day" after logging entries
--   A day with logged transactions counts for the streak on its own; the row
--   only records the explicit close. Deleting the row reopens the day.
--   `day` is the device's LOCAL date (the app's markets are UTC+4/+5; a UTC
--   date would file a 23:30 close under tomorrow).
--
-- Self-only RLS, all verbs the client needs (select / insert / update for the
-- upsert / delete for Reopen). Nobody else can learn whether you logged.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- §1 Table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_closes (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('no_spend', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

COMMENT ON TABLE public.daily_closes IS
  'Daily close markers (2026-09-22): one row per local day the user explicitly closed. Self-only RLS.';

ALTER TABLE public.daily_closes ENABLE ROW LEVEL SECURITY;

-- §2 Policies (auth.uid() hoisted into an initplan, per p3-rls-initplan) ─────
DROP POLICY IF EXISTS daily_closes_select_own ON public.daily_closes;
CREATE POLICY daily_closes_select_own ON public.daily_closes
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS daily_closes_insert_own ON public.daily_closes;
CREATE POLICY daily_closes_insert_own ON public.daily_closes
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS daily_closes_update_own ON public.daily_closes;
CREATE POLICY daily_closes_update_own ON public.daily_closes
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS daily_closes_delete_own ON public.daily_closes;
CREATE POLICY daily_closes_delete_own ON public.daily_closes
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.daily_closes FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_closes TO authenticated;

-- §3 Self-verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'daily_closes' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'daily-close: RLS is not enabled on daily_closes';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'daily_closes') <> 4 THEN
    RAISE EXCEPTION 'daily-close: expected exactly 4 policies on daily_closes';
  END IF;
  RAISE NOTICE 'daily-close: OK';
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual)
-- ════════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS public.daily_closes;
-- The client tolerates a missing table: closes read as none, and the
-- "Nothing spent today" action shows the save-failed message.
