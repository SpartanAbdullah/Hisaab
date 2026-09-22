-- ════════════════════════════════════════════════════════════════════════════
-- 8t · A pending "Sync this record" mirrors the loan as it is at accept time
--      — supabase-migration-linked-sync-live-amount.sql
--
-- The founder's incident (2026-09-21): a sync request for AED 1,581.80 sat
-- pending while the sender recorded repayments of 1,440 and 93 (remaining
-- 48.80). The accept created the receiver's loan at 1,581.80. Claims:
--   (a) catalog: trigger present, trigger function closed to client roles,
--       accept_linked_request still a client RPC;
--   (b) a repayment on the loan refreshes the PENDING request's amount — the
--       receiver (who cannot read the sender's loan) sees 48.80 too;
--   (c) THE FIX — accept mirrors 48.80: receiver loan total = remaining =
--       48.80, receiver transaction 48.80, request row 48.80, and the pair
--       starts in sync with the sender's loan;
--   (d) a loan settled while pending: request amount left alone, accept
--       refused, nothing created;
--   (e) a loan soft-deleted while pending: accept refused, nothing created;
--   (f) the requester still cannot PATCH the request row (no RLS loosening).
--
-- Fresh users (5c000000-…-01 sender, -02 receiver) so nothing above shifts.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8t-linked-sync-live-amount');

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-4000-8000-000000000001', 'sync-sender@hisaab.test'),
  ('5c000000-0000-4000-8000-000000000002', 'sync-receiver@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Founder' WHERE id = '5c000000-0000-4000-8000-000000000001';
UPDATE profiles SET name = 'Ghulam'  WHERE id = '5c000000-0000-4000-8000-000000000002';

-- The sender's contact, already linked (the consent RPCs are covered in 20-*).
INSERT INTO public.persons (id, user_id, name, linked_profile_id)
VALUES ('SY-P', '5c000000-0000-4000-8000-000000000001', 'Ghulam',
        '5c000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  EXISTS (SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'public.loans'::regclass
             AND tgname = 'loans_refresh_pending_sync' AND NOT tgisinternal),
  'loans_refresh_pending_sync trigger exists on loans');

SELECT test.assert(
  NOT has_function_privilege('authenticated', 'public.tg_loans_refresh_pending_sync()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.tg_loans_refresh_pending_sync()', 'EXECUTE'),
  'tg_loans_refresh_pending_sync is not executable by authenticated or anon');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.accept_linked_request(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accept_linked_request(text, text)', 'EXECUTE'),
  'accept_linked_request(text, text): authenticated YES, anon NO');

-- ════════════════════════════════════════════════════════════════════════════
-- Sender: three loans, three pending sync requests (ledger-only, as always)
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user('5c000000-0000-4000-8000-000000000001');

INSERT INTO loans (id, user_id, person_name, person_id, type, total_amount,
                   remaining_amount, currency, status, notes)
VALUES
  ('SY-L1', auth.uid(), 'Ghulam', 'SY-P', 'given', 1581.80, 1581.80, 'AED', 'active', 'rent share'),
  ('SY-L2', auth.uid(), 'Ghulam', 'SY-P', 'given', 1000.00, 1000.00, 'AED', 'active', 'settled later'),
  ('SY-L3', auth.uid(), 'Ghulam', 'SY-P', 'given',  250.00,  250.00, 'AED', 'active', 'deleted later');

INSERT INTO linked_transaction_requests
  (id, from_user_id, to_user_id, person_id, kind, amount, currency, note, pre_existing_loan_id)
VALUES
  ('SY-R1', auth.uid(), '5c000000-0000-4000-8000-000000000002', 'SY-P', 'lent', 1581.80, 'AED', 'rent share', 'SY-L1'),
  ('SY-R2', auth.uid(), '5c000000-0000-4000-8000-000000000002', 'SY-P', 'lent', 1000.00, 'AED', 'settled later', 'SY-L2'),
  ('SY-R3', auth.uid(), '5c000000-0000-4000-8000-000000000002', 'SY-P', 'lent',  250.00, 'AED', 'deleted later', 'SY-L3');

SELECT test.assert(
  (SELECT count(*) FROM linked_transaction_requests
    WHERE id IN ('SY-R1','SY-R2','SY-R3') AND status = 'pending') = 3,
  'three pending past-record sync requests were created');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) Repayments while pending refresh the request amount
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_ok($$ SELECT apply_loan_remaining_delta('SY-L1', -1440, 1581.80) $$,
  'sender records a 1,440 repayment on the pending loan');
SELECT test.assert_ok($$ SELECT apply_loan_remaining_delta('SY-L1', -93, 141.80) $$,
  'sender records a 93 repayment on the pending loan');

SELECT test.assert(
  (SELECT amount FROM linked_transaction_requests WHERE id = 'SY-R1') = 48.80,
  'the pending request amount followed the loan to 48.80 (sender view)',
  'amount = ' || (SELECT amount FROM linked_transaction_requests WHERE id = 'SY-R1')::text);

-- (f) no RLS loosening: the requester still cannot PATCH the row.
SELECT test.assert_zero_rows(
  $$ UPDATE linked_transaction_requests SET amount = 1 WHERE id = 'SY-R1' $$,
  'the requester cannot UPDATE its own request row directly');

-- (d) settle SY-L2 fully while pending: the amount stays (it must stay > 0).
SELECT test.assert_ok($$ SELECT apply_loan_remaining_delta('SY-L2', -1000, 1000) $$,
  'sender settles the second loan while its sync is pending');
SELECT test.assert(
  (SELECT amount FROM linked_transaction_requests WHERE id = 'SY-R2') = 1000,
  'a settled loan leaves its request amount alone (amount > 0 constraint)');

-- (e) soft-delete SY-L3 while pending (loansDb.delete stamps deleted_at only).
UPDATE loans SET deleted_at = now() WHERE id = 'SY-L3';

-- ════════════════════════════════════════════════════════════════════════════
-- Receiver
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user('5c000000-0000-4000-8000-000000000002');

SELECT test.assert(
  (SELECT amount FROM linked_transaction_requests WHERE id = 'SY-R1') = 48.80,
  'the receiver sees the refreshed 48.80 on the incoming request');

-- (c) THE FIX
SELECT test.assert_ok($$ SELECT accept_linked_request('SY-R1') $$,
  'receiver accepts the sync request');

SELECT test.assert(
  (SELECT total_amount = 48.80 AND remaining_amount = 48.80 AND type = 'taken'
     FROM loans l
     JOIN linked_transaction_requests r ON r.responder_loan_id = l.id
    WHERE r.id = 'SY-R1'),
  'the receiver''s mirrored loan is total = remaining = 48.80 (not 1,581.80)',
  (SELECT 'total=' || l.total_amount || ' remaining=' || l.remaining_amount
     FROM loans l JOIN linked_transaction_requests r ON r.responder_loan_id = l.id
    WHERE r.id = 'SY-R1'));

SELECT test.assert(
  (SELECT t.amount = 48.80 AND t.source_account_id IS NULL AND t.destination_account_id IS NULL
     FROM transactions t
     JOIN linked_transaction_requests r ON r.responder_txn_id = t.id
    WHERE r.id = 'SY-R1'),
  'the receiver''s mirrored transaction is 48.80 and ledger-only');

SELECT test.assert(
  (SELECT status = 'accepted' AND amount = 48.80 AND requester_loan_id = 'SY-L1'
     FROM linked_transaction_requests WHERE id = 'SY-R1'),
  'the accepted request records the mirrored amount and adopts the sender''s loan');

SELECT test.assert_raises($$ SELECT accept_linked_request('SY-R2') $$,
  'ltr: pre_existing loan has been settled or archived',
  'accepting a sync whose loan was settled meanwhile is refused');

SELECT test.assert_raises($$ SELECT accept_linked_request('SY-R3') $$,
  'ltr: pre_existing loan no longer available',
  'accepting a sync whose loan was deleted meanwhile is refused');

SELECT test.assert(
  (SELECT count(*) FROM loans WHERE user_id = auth.uid()) = 1,
  'the two refused accepts created no loan on the receiver''s side',
  'receiver loans: ' || (SELECT count(*) FROM loans WHERE user_id = auth.uid())::text);

SELECT test.assert(
  (SELECT count(*) FROM linked_transaction_requests
    WHERE id IN ('SY-R2','SY-R3') AND status = 'pending') = 2,
  'the refused requests stay pending (the receiver can decline, the sender withdraw)');

-- Both sides of the new pair agree (the invariant monitor's divergence check).
RESET ROLE;
SELECT test.assert(
  (SELECT rl.remaining_amount = pl.remaining_amount
     FROM linked_transaction_requests r
     JOIN loans rl ON rl.id = r.requester_loan_id
     JOIN loans pl ON pl.id = r.responder_loan_id
    WHERE r.id = 'SY-R1'),
  'the new linked pair starts in sync: both remaining amounts are 48.80');
SET ROLE authenticated;
SELECT test.as_user(NULL::uuid);
