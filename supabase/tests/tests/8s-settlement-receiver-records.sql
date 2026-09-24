-- ════════════════════════════════════════════════════════════════════════════
-- 8s · The receiver records a repayment: both ledgers at once; Apply now;
--      10-minute Undo; "Add to an account"
--      — supabase-migration-settlement-receiver-records.sql
--
-- The founder's incident (2026-09-24): a linked settlement sent with the
-- "Apply to one of my accounts" switch OFF landed record-only — AED 3,000 in
-- Mashreq never reached Mashreq in Hisaab — and waited on a casual payer.
-- Claims:
--   (a) catalog: columns, CHECKs, client RPC grants, helpers closed, accept
--       untouched;
--   (b) record 300 → both loans 700, receiver's account +300, payer's row
--       record-only, EMI #1 paid on both sides, ONE linked_info to the payer,
--       no "to confirm" and no "confirmed" notice;
--   (c) refusals leave nothing written;
--   (d) a raw INSERT cannot forge the new columns; no UPDATE policy;
--   (e) Apply now on the receiver's own pending request;
--   (f) the legacy receiver path (create + accept) still works;
--   (g) Undo: refusals, success (loans, EMIs, balance, tombstones, notice),
--       idempotent, refused when a row was touched;
--   (h) full settle + undo re-opens both loans; interleaved records;
--   (i) "Add to an account": given/taken, idempotent, and every refusal;
--   (j) parity with a normally accepted claim;
--   (k) the invariant monitor sees nothing wrong for either user.
--
-- Fresh users (5d000000-…-01 receiver L, -02 payer B, -03 stranger S).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8s-settlement-receiver-records');

\set uL '5d000000-0000-4000-8000-000000000001'
\set uB '5d000000-0000-4000-8000-000000000002'
\set uS '5d000000-0000-4000-8000-000000000003'

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  (:'uL', 'rr-receiver@hisaab.test'),
  (:'uB', 'rr-payer@hisaab.test'),
  (:'uS', 'rr-stranger@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Founder'            WHERE id = :'uL';
UPDATE profiles SET name = 'Ghulam', lang = 'en' WHERE id = :'uB';
UPDATE profiles SET name = 'Stranger'           WHERE id = :'uS';

-- The receiver's contact, already linked (a client can only link through the
-- consent RPCs, covered in 20-*; the fixture writes it as the owner role).
INSERT INTO public.persons (id, user_id, name, linked_profile_id)
VALUES ('RR-P', :'uL', 'Ghulam', :'uB')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'linked_settlement_requests'
      AND column_name IN ('recorded_by_receiver', 'undone_at')) = 2,
  'linked_settlement_requests has recorded_by_receiver and undone_at');

SELECT test.assert(
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.linked_settlement_requests'::regclass
      AND conname IN ('lsr_recorded_status_chk', 'lsr_undone_chk') AND convalidated) = 2,
  'both new CHECK constraints exist and are validated');

SELECT test.assert(
  has_function_privilege('authenticated', 'public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.apply_own_settlement_request(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.undo_received_repayment(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.set_settlement_repayment_account(text, text)', 'EXECUTE'),
  'the four new RPCs are executable by authenticated');

SELECT test.assert(
  NOT has_function_privilege('anon', 'public.record_received_repayment(text, text, text, text, uuid, numeric, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.apply_own_settlement_request(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.undo_received_repayment(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.set_settlement_repayment_account(text, text)', 'EXECUTE'),
  'the four new RPCs are closed to anon');

SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '\_lsr\_%'
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
  'no _lsr_* helper is executable by authenticated or anon');

SELECT test.assert(
  (SELECT (length(p.prosrc) - length(replace(lower(p.prosrc), 'for update;', ''))) / 11 = 7
          AND p.prosrc ILIKE '%lsr: amount exceeds remaining on one side%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'accept_settlement_request'),
  'accept_settlement_request is untouched (7 locking statements, overpay guard)');

-- ════════════════════════════════════════════════════════════════════════════
-- FIXTURES — three linked pairs of 1,000 with a 4 × 250 schedule on each side
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uL');

INSERT INTO accounts (id, user_id, name, type, currency, balance) VALUES
  ('RR-A1', auth.uid(), 'Mashreq Bank', 'bank', 'AED', 0),
  ('RR-A2', auth.uid(), 'Meezan',       'bank', 'PKR', 0),
  ('RR-AX', auth.uid(), 'Closed',       'cash', 'AED', 0);
UPDATE accounts SET deleted_at = now() WHERE id = 'RR-AX';

INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note)
VALUES
  ('RR-T1', auth.uid(), :'uB', 'RR-P', 'lent', 1000, 'AED', 'pair one'),
  ('RR-T2', auth.uid(), :'uB', 'RR-P', 'lent', 1000, 'AED', 'pair two'),
  ('RR-T3', auth.uid(), :'uB', 'RR-P', 'lent', 1000, 'AED', 'pair three');

SELECT test.as_user(:'uB');
INSERT INTO accounts (id, user_id, name, type, currency, balance) VALUES
  ('RR-B1', auth.uid(), 'Ghulam Bank', 'bank', 'AED', 0),
  ('RR-B2', auth.uid(), 'Ghulam Cash', 'cash', 'AED', 0);

SELECT test.assert_ok($$ SELECT accept_linked_request('RR-T1') $$, 'payer accepts pair one');
SELECT test.assert_ok($$ SELECT accept_linked_request('RR-T2') $$, 'payer accepts pair two');
SELECT test.assert_ok($$ SELECT accept_linked_request('RR-T3') $$, 'payer accepts pair three');

SELECT requester_loan_id AS l1, responder_loan_id AS b1 FROM linked_transaction_requests WHERE id = 'RR-T1' \gset
SELECT requester_loan_id AS l2, responder_loan_id AS b2 FROM linked_transaction_requests WHERE id = 'RR-T2' \gset
SELECT requester_loan_id AS l3, responder_loan_id AS b3 FROM linked_transaction_requests WHERE id = 'RR-T3' \gset

INSERT INTO emi_schedules (id, user_id, loan_id, installment_number, due_date, amount, status)
SELECT 'RR-EB-' || l.k || '-' || n, auth.uid(), l.id, n,
       to_char(date '2026-10-05' + (n - 1) * interval '1 month', 'YYYY-MM-DD'), 250, 'upcoming'
  FROM (VALUES ('1', :'b1'), ('2', :'b2'), ('3', :'b3')) AS l(k, id),
       generate_series(1, 4) AS n;

SELECT test.as_user(:'uL');
INSERT INTO emi_schedules (id, user_id, loan_id, installment_number, due_date, amount, status)
SELECT 'RR-EL-' || l.k || '-' || n, auth.uid(), l.id, n,
       to_char(date '2026-10-05' + (n - 1) * interval '1 month', 'YYYY-MM-DD'), 250, 'upcoming'
  FROM (VALUES ('1', :'l1'), ('2', :'l2'), ('3', :'l3')) AS l(k, id),
       generate_series(1, 4) AS n;

SELECT test.assert(
  (SELECT type = 'given' AND remaining_amount = 1000 FROM loans WHERE id = :'l1'),
  'fixture: the receiver holds the GIVEN side of pair one');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) THE RECEIVER RECORDS 300 INTO MASHREQ
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S1', 'RR-T1', %L, %L, %L, 300, 'AED', 'cash from ATM', 'RR-A1') $q$,
  :'l1', :'b1', :'uB'),
  'the receiver records 300 into Mashreq');

SELECT requester_txn_id AS s1_ltxn, responder_txn_id AS s1_btxn
  FROM linked_settlement_requests WHERE id = 'RR-S1' \gset

SELECT test.assert(
  (SELECT status = 'accepted' AND recorded_by_receiver AND responded_at IS NOT NULL
          AND undone_at IS NULL AND requester_account_id = 'RR-A1'
          AND responder_account_id IS NULL
          AND requester_txn_id IS NOT NULL AND responder_txn_id IS NOT NULL
     FROM linked_settlement_requests WHERE id = 'RR-S1'),
  'the row is accepted, receiver-recorded, with both transaction ids');

SELECT test.assert(
  (SELECT remaining_amount = 700 AND status = 'active' FROM loans WHERE id = :'l1'),
  'the receiver''s loan dropped to 700');

SELECT test.assert(
  (SELECT balance = 300 FROM accounts WHERE id = 'RR-A1'),
  'Mashreq is +300 at once — no waiting on the payer');

SELECT test.assert(
  (SELECT type = 'repayment' AND amount = 300 AND source_account_id IS NULL
          AND destination_account_id = 'RR-A1' AND related_loan_id = :'l1'
          AND notes = 'cash from ATM' AND person_id = 'RR-P' AND related_person = 'Ghulam'
     FROM transactions WHERE id = :'s1_ltxn'),
  'the receiver''s repayment row lands IN Mashreq (destination), with the note');

SELECT test.assert(
  (SELECT string_agg(status, ',' ORDER BY installment_number) = 'paid,upcoming,upcoming,upcoming'
     FROM emi_schedules WHERE loan_id = :'l1'),
  'the receiver''s EMI #1 is paid, the rest are not');

SELECT test.assert(
  (SELECT count(*) FROM notifications
    WHERE user_id = auth.uid() AND type IN ('linked_settlement', 'linked_info')) = 0,
  'the receiver gets no "confirmed" notice (nobody confirmed anything)');

SELECT test.as_user(:'uB');

SELECT test.assert(
  (SELECT remaining_amount = 700 AND status = 'active' FROM loans WHERE id = :'b1'),
  'the payer''s mirrored loan dropped to 700 in the same statement');

SELECT test.assert(
  (SELECT amount = 300 AND source_account_id IS NULL AND destination_account_id IS NULL
          AND related_loan_id = :'b1' AND related_person = 'Founder'
     FROM transactions WHERE id = :'s1_btxn'),
  'the payer''s repayment row is record-only (their accounts are their business)');

SELECT test.assert(
  (SELECT string_agg(status, ',' ORDER BY installment_number) = 'paid,upcoming,upcoming,upcoming'
     FROM emi_schedules WHERE loan_id = :'b1'),
  'the payer''s EMI #1 is paid too');

SELECT test.assert(
  (SELECT count(*) = 1 AND bool_and(template = 'lsr_recorded' AND channel_id = 'money'
                                    AND href = '/inbox' AND title = 'Repayment recorded'
                                    AND actor_id = :'uL'::uuid)
     FROM notifications
    WHERE user_id = auth.uid() AND type = 'linked_info' AND params->>'requestId' = 'RR-S1'),
  'the payer gets exactly one linked_info notice, in their language (en)');

SELECT test.assert(
  (SELECT count(*) FROM notifications WHERE user_id = auth.uid() AND type = 'linked_settlement') = 0,
  'the payer gets no false "Repayment to confirm"');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) REFUSALS — nothing is written
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X1', 'RR-T1', %L, %L, %L, 300, 'AED', '', NULL) $q$,
  :'b1', :'l1', :'uL'),
  'lsr: only the person receiving the money can record it',
  'the PAYER cannot use the receiver path (their claim must be confirmed)');

SELECT test.as_user(:'uS');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X2', 'RR-T1', %L, %L, %L, 300, 'AED', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'lsr: requester loan does not belong to sender',
  'a stranger cannot record on someone else''s loan');

SELECT test.as_user(:'uL');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X3', 'RR-T1', %L, %L, %L, 5000, 'AED', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'lsr: amount exceeds remaining', 'more than the remaining is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X4', 'RR-T1', %L, %L, %L, 0, 'AED', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'lsr: amount must be positive', 'a zero amount is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X5', 'RR-T1', %L, %L, %L, 50, 'AED', '', 'RR-B1') $q$,
  :'l1', :'b1', :'uB'),
  'lsr: requester account not owned', 'someone else''s account is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X6', 'RR-T1', %L, %L, %L, 50, 'AED', '', 'RR-AX') $q$,
  :'l1', :'b1', :'uB'),
  'lsr: requester account was deleted', 'a deleted account is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X7', 'RR-T1', %L, %L, %L, 50, 'AED', '', 'RR-A2') $q$,
  :'l1', :'b1', :'uB'),
  'lsr: requester account currency mismatch', 'a PKR account on an AED loan is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X8', 'RR-T1', %L, %L, %L, 50, 'PKR', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'lsr: currency mismatch', 'a currency that is not the loan''s is refused');
SELECT test.assert_raises(format(
  $q$ SELECT record_received_repayment('RR-X9', 'RR-T1', %L, %L, %L, 50, 'AED', '', NULL) $q$,
  :'l1', :'b2', :'uB'),
  'lsr: loans do not share the same linked pair', 'loans from two different pairs are refused');

SELECT test.assert(
  (SELECT count(*) FROM linked_settlement_requests WHERE id LIKE 'RR-X%') = 0
  AND (SELECT remaining_amount FROM loans WHERE id = :'l1') = 700
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 300,
  'every refusal left nothing behind');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) FORGERY — a raw INSERT is always a plain pending request
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO linked_settlement_requests
  (id, loan_pair_id, requester_loan_id, responder_loan_id, from_user_id, to_user_id,
   amount, currency, note, status, recorded_by_receiver, undone_at, responder_account_id,
   requester_txn_id, responder_txn_id, responded_at)
VALUES
  ('RR-F1', 'RR-T1', :'l1', :'b1', auth.uid(), :'uB',
   10, 'AED', 'forged', 'accepted', true, now(), 'RR-B1',
   'forged-a', 'forged-b', now());

SELECT test.assert(
  (SELECT status = 'pending' AND NOT recorded_by_receiver AND undone_at IS NULL
          AND responder_account_id IS NULL AND requester_txn_id IS NULL
          AND responder_txn_id IS NULL AND responded_at IS NULL
     FROM linked_settlement_requests WHERE id = 'RR-F1'),
  'a raw INSERT cannot forge status, the flag, undone_at, an account or txn ids');

SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'l1') = 700,
  'the forged row moved no money');

SELECT test.assert_zero_rows(
  $$ UPDATE linked_settlement_requests SET status = 'accepted', recorded_by_receiver = true WHERE id = 'RR-F1' $$,
  'the requester still cannot UPDATE a settlement row directly');

-- ════════════════════════════════════════════════════════════════════════════
-- (e) APPLY NOW — the receiver applies their own pending request
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT count(*) FROM notifications WHERE user_id = auth.uid() AND type = 'linked_settlement') = 1,
  'the plain pending request did notify the payer "to confirm" (unchanged path)');
SELECT test.assert_raises($$ SELECT apply_own_settlement_request('RR-F1') $$,
  'lsr: only the sender can apply it now', 'the payer cannot "apply now" the receiver''s request');

SELECT test.as_user(:'uS');
SELECT test.assert_raises($$ SELECT apply_own_settlement_request('RR-F1') $$,
  'lsr: only the sender can apply it now', 'a stranger cannot apply it');

SELECT test.as_user(:'uL');
SELECT test.assert_ok($$ SELECT apply_own_settlement_request('RR-F1') $$,
  'the receiver applies their own pending 10 now');

SELECT test.assert(
  (SELECT status = 'accepted' AND recorded_by_receiver AND responded_at IS NOT NULL
          AND requester_txn_id IS NOT NULL AND responder_txn_id IS NOT NULL
     FROM linked_settlement_requests WHERE id = 'RR-F1')
  AND (SELECT remaining_amount FROM loans WHERE id = :'l1') = 690
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 300,
  'Apply now applied the 10 (record-only: no account on the request)');

SELECT test.assert(
  (SELECT count(*) FROM notifications WHERE user_id = auth.uid() AND title = 'Repayment confirmed') = 0,
  'Apply now sends the receiver no "confirmed" notice');

SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT count(*) FROM notifications
    WHERE user_id = auth.uid() AND type = 'linked_info' AND template = 'lsr_recorded') = 2,
  'the payer is told about the applied request too');
SELECT test.assert_ok($$ SELECT accept_settlement_request('RR-F1') $$,
  'a late accept by the payer is a no-op (the row is no longer pending)');
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'b1') = 690,
  'the late accept moved nothing (no double apply)');

-- A payer's own claim cannot be "applied now" by the payer.
SELECT test.assert_ok(format(
  $q$ SELECT create_settlement_request('RR-C1', 'RR-T1', %L, %L, %L, 50, 'AED', 'claim', NULL) $q$,
  :'b1', :'l1', :'uL'),
  'the payer sends an ordinary claim');
SELECT test.assert_raises($$ SELECT apply_own_settlement_request('RR-C1') $$,
  'lsr: only the person receiving the money can record it',
  'a claim from the paying side still needs the receiver''s OK');
SELECT test.assert_ok($$ SELECT cancel_settlement_request('RR-C1') $$, 'the payer withdraws the claim');

-- ════════════════════════════════════════════════════════════════════════════
-- (f) THE LEGACY RECEIVER PATH (old clients: create + accept) STILL WORKS
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uL');
SELECT test.assert_ok(format(
  $q$ SELECT create_settlement_request('RR-N1', 'RR-T1', %L, %L, %L, 20, 'AED', 'old client', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'an old client still sends a pending request');
SELECT test.as_user(:'uB');
SELECT test.assert_ok($$ SELECT accept_settlement_request('RR-N1') $$, 'and the payer accepts it');
SELECT test.assert(
  (SELECT status = 'accepted' AND NOT recorded_by_receiver FROM linked_settlement_requests WHERE id = 'RR-N1')
  AND (SELECT remaining_amount FROM loans WHERE id = :'b1') = 670,
  'a normal accept is not marked receiver-recorded');

-- ════════════════════════════════════════════════════════════════════════════
-- (g) UNDO
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-S1') $$,
  'lsr: only the person who recorded it can undo it', 'the payer cannot undo');
SELECT test.as_user(:'uS');
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-S1') $$,
  'lsr: only the person who recorded it can undo it', 'a stranger cannot undo');
SELECT test.as_user(:'uL');
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-N1') $$,
  'lsr: only a payment you recorded can be undone', 'a normally accepted settlement cannot be undone');

RESET ROLE;
UPDATE linked_settlement_requests SET responded_at = responded_at - interval '11 minutes' WHERE id = 'RR-F1';
SET ROLE authenticated;
SELECT test.as_user(:'uL');
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-F1') $$,
  'lsr: the undo window has passed', 'undo after 10 minutes is refused');

-- The payer adds S1 to their bank → the receiver can no longer undo it.
SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT set_settlement_repayment_account(:'s1_btxn', 'RR-B1')) = -300,
  'the payer adds their side of S1 to their bank: returns the new balance, -300');
SELECT test.assert(
  (SELECT source_account_id = 'RR-B1' AND destination_account_id IS NULL
     FROM transactions WHERE id = :'s1_btxn')
  AND (SELECT responder_account_id = 'RR-B1' FROM linked_settlement_requests WHERE id = 'RR-S1'),
  'the payer''s row is paid FROM their bank (source) and the request is stamped');
SELECT test.as_user(:'uL');
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-S1') $$,
  'lsr: they already added it to an account', 'undo is refused once the payer used the money');

-- Success.
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S2', 'RR-T1', %L, %L, %L, 250, 'AED', 'oops', 'RR-A1') $q$,
  :'l1', :'b1', :'uB'),
  'the receiver records 250 more');
SELECT requester_txn_id AS s2_ltxn, responder_txn_id AS s2_btxn
  FROM linked_settlement_requests WHERE id = 'RR-S2' \gset
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'l1') = 420
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 550
  AND (SELECT string_agg(status, ',' ORDER BY installment_number) FROM emi_schedules WHERE loan_id = :'l1')
      = 'paid,paid,upcoming,upcoming',
  'after S2: 420 left, Mashreq 550, EMIs #1-#2 paid');

SELECT test.assert_ok($$ SELECT undo_received_repayment('RR-S2') $$, 'the receiver undoes S2 inside the window');

SELECT test.assert(
  (SELECT status = 'cancelled' AND undone_at IS NOT NULL AND recorded_by_receiver
     FROM linked_settlement_requests WHERE id = 'RR-S2'),
  'S2 is cancelled with undone_at');
SELECT test.assert(
  (SELECT remaining_amount = 670 AND status = 'active' FROM loans WHERE id = :'l1')
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 300
  AND (SELECT deleted_at IS NOT NULL FROM transactions WHERE id = :'s2_ltxn'),
  'undo restored the receiver''s loan (670), Mashreq (300) and tombstoned the row');
SELECT test.assert(
  (SELECT string_agg(status, ',' ORDER BY installment_number) FROM emi_schedules WHERE loan_id = :'l1')
    = 'paid,upcoming,upcoming,upcoming',
  'undo recomputed the receiver''s EMIs (#2 back to upcoming)');

SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT remaining_amount = 670 AND status = 'active' FROM loans WHERE id = :'b1')
  AND (SELECT deleted_at IS NOT NULL FROM transactions WHERE id = :'s2_btxn')
  AND (SELECT string_agg(status, ',' ORDER BY installment_number) FROM emi_schedules WHERE loan_id = :'b1')
      = 'paid,upcoming,upcoming,upcoming',
  'undo restored the payer''s side too');
SELECT test.assert(
  (SELECT count(*) FROM notifications
    WHERE user_id = auth.uid() AND type = 'linked_info' AND template = 'lsr_undone'
      AND params->>'requestId' = 'RR-S2' AND title = 'Repayment removed') = 1,
  'the payer is told the record was removed');

SELECT test.as_user(:'uL');
SELECT test.assert_ok($$ SELECT undo_received_repayment('RR-S2') $$, 'a second undo is a no-op');
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'l1') = 670
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 300,
  'the no-op undo changed nothing');

-- Touched since recording → refused.
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S3', 'RR-T1', %L, %L, %L, 100, 'AED', '', 'RR-A1') $q$,
  :'l1', :'b1', :'uB'),
  'the receiver records 100');
SELECT requester_txn_id AS s3_ltxn FROM linked_settlement_requests WHERE id = 'RR-S3' \gset
UPDATE transactions SET deleted_at = now() WHERE id = :'s3_ltxn';
SELECT test.assert_raises($$ SELECT undo_received_repayment('RR-S3') $$,
  'lsr: this payment was changed since it was recorded', 'undo is refused when a row was touched');
UPDATE transactions SET deleted_at = NULL WHERE id = :'s3_ltxn';
SELECT test.assert_ok($$ SELECT undo_received_repayment('RR-S3') $$, 'restored, the undo goes through');
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'l1') = 670
  AND (SELECT balance FROM accounts WHERE id = 'RR-A1') = 300,
  'S3 fully undone');

-- ════════════════════════════════════════════════════════════════════════════
-- (h) FULL SETTLE + UNDO, and INTERLEAVED RECORDS
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S4', 'RR-T1', %L, %L, %L, 670, 'AED', 'all of it', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'the receiver records the full 670');
SELECT test.assert(
  (SELECT remaining_amount = 0 AND status = 'settled' FROM loans WHERE id = :'l1')
  AND (SELECT bool_and(status = 'paid') FROM emi_schedules WHERE loan_id = :'l1'),
  'both the loan and every EMI are settled');
SELECT test.assert_ok($$ SELECT undo_received_repayment('RR-S4') $$, 'and undoes it');
SELECT test.assert(
  (SELECT remaining_amount = 670 AND status = 'active' FROM loans WHERE id = :'l1')
  AND (SELECT string_agg(status, ',' ORDER BY installment_number) FROM emi_schedules WHERE loan_id = :'l1')
      = 'paid,upcoming,upcoming,upcoming',
  'the undo re-opened the loan with recomputed EMIs');
SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT remaining_amount = 670 AND status = 'active' FROM loans WHERE id = :'b1'),
  'the payer''s loan re-opened too');

SELECT test.as_user(:'uL');
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S5', 'RR-T1', %L, %L, %L, 300, 'AED', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'record 300');
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-S6', 'RR-T1', %L, %L, %L, 250, 'AED', '', NULL) $q$,
  :'l1', :'b1', :'uB'),
  'then record 250');
SELECT test.assert_ok($$ SELECT undo_received_repayment('RR-S5') $$, 'then undo the FIRST one');
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'l1') = 420
  AND (SELECT string_agg(status, ',' ORDER BY installment_number) FROM emi_schedules WHERE loan_id = :'l1')
      = 'paid,paid,upcoming,upcoming',
  'interleaved: 420 left and EMIs follow the money that is still there');

-- ════════════════════════════════════════════════════════════════════════════
-- (i) "ADD TO AN ACCOUNT"
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uB');
SELECT test.assert(
  (SELECT set_settlement_repayment_account(:'s1_btxn', 'RR-B1')) = -300
  AND (SELECT balance FROM accounts WHERE id = 'RR-B1') = -300,
  'repeating the same attach is a safe no-op that returns the balance');
SELECT test.assert_raises(format($q$ SELECT set_settlement_repayment_account(%L, 'RR-B2') $q$, :'s1_btxn'),
  'lsr: this repayment is already in an account', 'moving it to another account is refused');

-- Legitimately account-less rows never qualify: a local ledger repayment…
INSERT INTO loans (id, user_id, person_name, type, total_amount, remaining_amount, currency, status)
VALUES ('RR-LB', auth.uid(), 'Shop', 'taken', 100, 50, 'AED', 'active');
INSERT INTO transactions (id, user_id, type, amount, currency, related_loan_id, notes)
VALUES ('RR-TXL', auth.uid(), 'repayment', 50, 'AED', 'RR-LB', 'ledger repayment');
SELECT test.assert_raises($$ SELECT set_settlement_repayment_account('RR-TXL', 'RR-B1') $$,
  'lsr: only a confirmed settlement repayment can be added to an account',
  'a ledger-mode repayment cannot be attached');

SELECT test.as_user(:'uL');
-- …a card-bill-covered row…
INSERT INTO loans (id, user_id, person_name, type, total_amount, remaining_amount, currency, status)
VALUES ('RR-LL', auth.uid(), 'Card advance', 'given', 100, 60, 'AED', 'active');
INSERT INTO transactions (id, user_id, type, amount, currency, related_loan_id, notes)
VALUES ('RR-TXC', auth.uid(), 'repayment', 40, 'AED', 'RR-LL', 'Covered by card bill payment');
SELECT test.assert_raises($$ SELECT set_settlement_repayment_account('RR-TXC', 'RR-A1') $$,
  'lsr: only a confirmed settlement repayment can be added to an account',
  'a card-bill-covered repayment cannot be attached');
-- …an undone settlement's (tombstoned) row…
SELECT test.assert_raises(format($q$ SELECT set_settlement_repayment_account(%L, 'RR-A1') $q$, :'s2_ltxn'),
  'lsr: only a confirmed settlement repayment can be added to an account',
  'an undone settlement''s row cannot be attached');

SELECT requester_txn_id AS n1_ltxn FROM linked_settlement_requests WHERE id = 'RR-N1' \gset
SELECT requester_txn_id AS f1_ltxn FROM linked_settlement_requests WHERE id = 'RR-F1' \gset

SELECT test.as_user(:'uS');
SELECT test.assert_raises(format($q$ SELECT set_settlement_repayment_account(%L, 'RR-A1') $q$, :'n1_ltxn'),
  'lsr: repayment not found', 'nobody can attach to someone else''s repayment');

SELECT test.as_user(:'uL');
SELECT test.assert_raises(format($q$ SELECT set_settlement_repayment_account(%L, 'RR-A2') $q$, :'n1_ltxn'),
  'lsr: account currency mismatch', 'a PKR account on an AED repayment is refused');
SELECT test.assert_raises(format($q$ SELECT set_settlement_repayment_account(%L, 'RR-AX') $q$, :'f1_ltxn'),
  'lsr: account was deleted', 'a deleted account is refused');

-- THE FIX for the founder's 24 Sep settlements: the old record-only row lands.
SELECT test.assert(
  (SELECT set_settlement_repayment_account(:'n1_ltxn', 'RR-A1')) = 320,
  'the receiver adds an old record-only repayment to Mashreq: 300 + 20 = 320');
SELECT test.assert(
  (SELECT destination_account_id = 'RR-A1' AND source_account_id IS NULL
     FROM transactions WHERE id = :'n1_ltxn')
  AND (SELECT requester_account_id = 'RR-A1' FROM linked_settlement_requests WHERE id = 'RR-N1'),
  'the receiver''s row now lands IN Mashreq (destination) and the Inbox line will say so');

-- ════════════════════════════════════════════════════════════════════════════
-- (j) PARITY — a receiver record equals a normally accepted claim
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uB');
SELECT test.assert_ok(format(
  $q$ SELECT create_settlement_request('RR-P1', 'RR-T2', %L, %L, %L, 300, 'AED', 'same money', NULL) $q$,
  :'b2', :'l2', :'uL'),
  'pair two: the payer claims 300');
SELECT test.as_user(:'uL');
SELECT test.assert_ok($$ SELECT accept_settlement_request('RR-P1', 'RR-A1') $$,
  'pair two: the receiver accepts it into Mashreq');
SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('RR-Q1', 'RR-T3', %L, %L, %L, 300, 'AED', 'same money', 'RR-A1') $q$,
  :'l3', :'b3', :'uB'),
  'pair three: the receiver records 300 into Mashreq');

RESET ROLE;
SELECT test.assert(
  (SELECT l2.remaining_amount = l3.remaining_amount AND b2.remaining_amount = b3.remaining_amount
          AND l2.remaining_amount = 700 AND b2.remaining_amount = 700
          AND l2.status = l3.status AND b2.status = b3.status
     FROM loans l2, loans l3, loans b2, loans b3
    WHERE l2.id = :'l2' AND l3.id = :'l3' AND b2.id = :'b2' AND b3.id = :'b3'),
  'parity: all four loans at 700, same statuses');
SELECT test.assert(
  (SELECT count(*) FILTER (WHERE status = 'paid' AND loan_id = :'l2')
        = count(*) FILTER (WHERE status = 'paid' AND loan_id = :'l3')
      AND count(*) FILTER (WHERE status = 'paid' AND loan_id = :'b2')
        = count(*) FILTER (WHERE status = 'paid' AND loan_id = :'b3')
      AND count(*) FILTER (WHERE status = 'paid' AND loan_id = :'l3') = 1
     FROM emi_schedules),
  'parity: the same EMIs are paid on both paths');
SELECT test.assert(
  (SELECT a.type = b.type AND a.amount = b.amount
          AND a.source_account_id IS NOT DISTINCT FROM b.source_account_id
          AND a.destination_account_id IS NOT DISTINCT FROM b.destination_account_id
          AND a.related_person = b.related_person AND a.person_id IS NOT DISTINCT FROM b.person_id
          AND a.notes = b.notes AND a.destination_account_id = 'RR-A1'
     FROM transactions a, transactions b
    WHERE a.id = (SELECT responder_txn_id FROM linked_settlement_requests WHERE id = 'RR-P1')
      AND b.id = (SELECT requester_txn_id FROM linked_settlement_requests WHERE id = 'RR-Q1')),
  'parity: the receiver''s repayment row has the same shape on both paths');
SELECT test.assert(
  (SELECT a.amount = b.amount AND a.source_account_id IS NULL AND b.source_account_id IS NULL
          AND a.destination_account_id IS NULL AND b.destination_account_id IS NULL
          AND a.related_person = b.related_person AND a.person_id IS NOT DISTINCT FROM b.person_id
     FROM transactions a, transactions b
    WHERE a.id = (SELECT requester_txn_id FROM linked_settlement_requests WHERE id = 'RR-P1')
      AND b.id = (SELECT responder_txn_id FROM linked_settlement_requests WHERE id = 'RR-Q1')),
  'parity: the payer''s repayment row has the same shape on both paths');
SELECT test.assert(
  (SELECT balance FROM accounts WHERE id = 'RR-A1') = 920,
  'Mashreq = 300 (S1) + 20 (N1 attached) + 300 (P1) + 300 (Q1)');

-- ════════════════════════════════════════════════════════════════════════════
-- (k) THE INVARIANT MONITOR SEES NOTHING WRONG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM public._recon_check_loans(ARRAY[:'uL', :'uB']::uuid[])) = 0,
  'no loan_remaining_drift for either user',
  (SELECT string_agg(entity_id || ' ' || expected || '≠' || actual, '; ')
     FROM public._recon_check_loans(ARRAY[:'uL', :'uB']::uuid[])));
SELECT test.assert(
  (SELECT count(*) FROM public._recon_check_accounts(ARRAY[:'uL', :'uB']::uuid[])) = 0,
  'no account_balance_drift for either user',
  (SELECT string_agg(entity_id || ' ' || expected || '≠' || actual, '; ')
     FROM public._recon_check_accounts(ARRAY[:'uL', :'uB']::uuid[])));
SELECT test.assert(
  (SELECT count(*) FROM public._recon_check_emi(ARRAY[:'uL', :'uB']::uuid[])) = 0,
  'no EMI coverage finding for either user',
  (SELECT string_agg(kind || ' ' || entity_id, '; ')
     FROM public._recon_check_emi(ARRAY[:'uL', :'uB']::uuid[])));
SELECT test.assert(
  (SELECT count(*) FROM public._recon_check_linked_pairs(ARRAY[:'uL', :'uB']::uuid[])) = 0,
  'every linked pair is still in sync',
  (SELECT string_agg(kind || ' ' || entity_id, '; ')
     FROM public._recon_check_linked_pairs(ARRAY[:'uL', :'uB']::uuid[])));

SET ROLE authenticated;
SELECT test.as_user(NULL::uuid);
