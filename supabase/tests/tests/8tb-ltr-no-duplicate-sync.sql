-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ LOCAL TEST HARNESS ONLY (./supabase/tests/run.sh, psql). NOT a migration —
--   never paste into Supabase Studio: it creates throwaway auth users.
--   The migration it covers is supabase-migration-ltr-no-duplicate-sync.sql.
-- ════════════════════════════════════════════════════════════════════════════
-- 8tb · A loan can be shared with the other person only once
--
-- The Ghulam duplicate (2026-05-26): a loan already mirrored by a normal
-- shared loan was mirrored AGAIN by "Sync past records". Claims:
--   (a) catalog: both triggers exist, the helper is closed to clients;
--   (b) the sender cannot sync a loan that is already half of an accepted pair;
--   (c) the receiver cannot sync their MIRROR copy back (the ping-pong);
--   (d) a synced loan cannot be synced a second time;
--   (e) a rejected sync frees the loan — re-syncing it is allowed;
--   (f) a duplicate that slipped in before the guard cannot be ACCEPTED, and
--       nothing is written; it can still be rejected.
--
-- Fresh users (5f000000-…-01 sender X, -02 receiver Y).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8tb-ltr-no-duplicate-sync');

\set uX '5f000000-0000-4000-8000-000000000001'
\set uY '5f000000-0000-4000-8000-000000000002'

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  (:'uX', 'dup-sender@hisaab.test'),
  (:'uY', 'dup-receiver@hisaab.test')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET name = 'Sender'   WHERE id = :'uX';
UPDATE profiles SET name = 'Receiver' WHERE id = :'uY';

INSERT INTO public.persons (id, user_id, name, linked_profile_id)
VALUES ('DS-P', :'uX', 'Receiver', :'uY')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'public.linked_transaction_requests'::regclass
      AND tgname IN ('ltr_refuse_duplicate_sync', 'ltr_refuse_duplicate_accept')
      AND NOT tgisinternal) = 2,
  'both one-share-per-loan triggers exist');

SELECT test.assert(
  NOT has_function_privilege('authenticated', 'public._ltr_loan_shared_elsewhere(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public._ltr_loan_shared_elsewhere(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.tg_ltr_refuse_duplicate_sync()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.tg_ltr_refuse_duplicate_accept()', 'EXECUTE'),
  'the helper and trigger functions are not client-executable');

-- ════════════════════════════════════════════════════════════════════════════
-- FIXTURE — one normal shared loan (X lends 100, Y accepts)
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uX');
INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note)
VALUES ('DS-F1', auth.uid(), :'uY', 'DS-P', 'lent', 100, 'AED', 'day loan');

SELECT test.as_user(:'uY');
SELECT test.assert_ok($$ SELECT accept_linked_request('DS-F1') $$, 'the receiver accepts the shared loan');

SELECT requester_loan_id AS lx1, responder_loan_id AS ly1 FROM linked_transaction_requests WHERE id = 'DS-F1' \gset
SELECT id AS py FROM persons WHERE user_id = auth.uid() AND linked_profile_id = :'uX' \gset

-- ════════════════════════════════════════════════════════════════════════════
-- (b) THE SENDER CANNOT SYNC AN ALREADY-SHARED LOAN
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uX');
SELECT test.assert_raises(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S1', auth.uid(), %L, 'DS-P', 'lent', 100, 'AED', 'day loan', %L) $q$,
  :'uY', :'lx1'),
  'ltr: loan is already shared',
  'syncing a loan that is already half of an accepted pair is refused (the Ghulam duplicate)');
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM linked_transaction_requests WHERE id = 'DS-S1'),
  'nothing was written');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) THE RECEIVER CANNOT SYNC THEIR MIRROR BACK
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uY');
SELECT test.assert_raises(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S2', auth.uid(), %L, %L, 'borrowed', 100, 'AED', 'mirror', %L) $q$,
  :'uX', :'py', :'ly1'),
  'ltr: loan is already shared',
  'the receiver cannot sync their mirrored copy back (ping-pong)');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) A SYNCED LOAN CANNOT BE SYNCED AGAIN
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uX');
INSERT INTO loans (id, user_id, person_name, person_id, type, total_amount, remaining_amount, currency, status, notes)
VALUES ('DS-L2', auth.uid(), 'Receiver', 'DS-P', 'given', 250, 250, 'AED', 'active', 'old record'),
       ('DS-L3', auth.uid(), 'Receiver', 'DS-P', 'given',  40,  40, 'AED', 'active', 'rejected once');

SELECT test.assert_ok(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S3', auth.uid(), %L, 'DS-P', 'lent', 250, 'AED', 'old record', 'DS-L2') $q$, :'uY'),
  'an unshared past record can be synced');

SELECT test.as_user(:'uY');
SELECT test.assert_ok($$ SELECT accept_linked_request('DS-S3') $$, 'the receiver accepts the sync');

SELECT test.as_user(:'uX');
SELECT test.assert_raises(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S4', auth.uid(), %L, 'DS-P', 'lent', 250, 'AED', 'old record', 'DS-L2') $q$, :'uY'),
  'ltr: loan is already shared',
  'a loan that was already synced cannot be synced a second time');

-- ════════════════════════════════════════════════════════════════════════════
-- (e) A REJECTED SYNC FREES THE LOAN
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_ok(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S5', auth.uid(), %L, 'DS-P', 'lent', 40, 'AED', 'rejected once', 'DS-L3') $q$, :'uY'),
  'sync of DS-L3 sent');
SELECT test.as_user(:'uY');
SELECT test.assert_ok($$ SELECT reject_linked_request('DS-S5') $$, 'the receiver rejects it');
SELECT test.as_user(:'uX');
SELECT test.assert_ok(format(
  $q$ INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
      VALUES ('DS-S6', auth.uid(), %L, 'DS-P', 'lent', 40, 'AED', 'rejected once', 'DS-L3') $q$, :'uY'),
  'after a rejection the same loan may be synced again');

-- ════════════════════════════════════════════════════════════════════════════
-- (f) A LEGACY DUPLICATE CANNOT BE ACCEPTED — and can still be rejected
-- ════════════════════════════════════════════════════════════════════════════
-- Simulate a pending sync created BEFORE the guard existed: bypass the
-- insert trigger as the table owner, for this one row only.
RESET ROLE;
ALTER TABLE public.linked_transaction_requests DISABLE TRIGGER ltr_refuse_duplicate_sync;
INSERT INTO public.linked_transaction_requests
  (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
VALUES ('DS-S7', :'uX', :'uY', 'DS-P', 'lent', 100, 'AED', 'legacy duplicate', :'lx1');
ALTER TABLE public.linked_transaction_requests ENABLE TRIGGER ltr_refuse_duplicate_sync;
SET ROLE authenticated;

SELECT test.as_user(:'uY');
SELECT count(*) AS y_loans_before FROM loans WHERE user_id = auth.uid() \gset
SELECT test.assert_raises($$ SELECT accept_linked_request('DS-S7') $$,
  'ltr: loan is already shared',
  'a duplicate sync that slipped in earlier cannot be accepted into a second mirror');
SELECT test.assert(
  (SELECT count(*) FROM loans WHERE user_id = auth.uid()) = :y_loans_before
  AND (SELECT status FROM linked_transaction_requests WHERE id = 'DS-S7') = 'pending',
  'the refused accept wrote nothing — no mirror loan, request still pending');
SELECT test.assert_ok($$ SELECT reject_linked_request('DS-S7') $$,
  'the receiver can still clear it out by rejecting');

RESET ROLE;
