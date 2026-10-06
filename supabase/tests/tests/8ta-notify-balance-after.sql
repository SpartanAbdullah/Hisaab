-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ LOCAL TEST HARNESS ONLY (./supabase/tests/run.sh, psql). NOT a migration —
--   never paste into Supabase Studio: it creates throwaway auth users.
--   The migration it covers is supabase-migration-notify-balance-after.sql.
-- ════════════════════════════════════════════════════════════════════════════
-- 8ta · Linked money notices say where the total stands
--       — supabase-migration-notify-balance-after.sql
--
-- The Ghulam exercise (2026-10-06): notices were English-only and never said
-- what the total became. Claims, walked through one relationship
-- (Abdullah lends, Ghulam borrows; Ghulam reads roman Urdu, Abdullah English):
--   (a) catalog: helpers closed to clients, the three triggers re-created;
--   (b) a lend request tells the borrower — in THEIR language — the total if
--       they accept, and never counts it before they do;
--   (c) accept / reject tell the lender the total now;
--   (d) a receiver-recorded repayment tells the payer what is left;
--   (e) a payer's claim tells the receiver the total if they confirm, and the
--       accept tells the payer the total now;
--   (f) titles the rest of the app keys on are unchanged in English, and
--       linked_request / linked_settlement rows carry no actor_id (the group
--       fan-out rate limit counts a sender's rows by actor_id).
--
-- Fresh users (5e000000-…-01 lender A, -02 borrower G).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8ta-notify-balance-after');

\set uA '5e000000-0000-4000-8000-000000000001'
\set uG '5e000000-0000-4000-8000-000000000002'

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  (:'uA', 'nb-lender@hisaab.test'),
  (:'uG', 'nb-borrower@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Abdullah', lang = 'en' WHERE id = :'uA';
UPDATE profiles SET name = 'Ghulam',   lang = 'ur' WHERE id = :'uG';

INSERT INTO public.persons (id, user_id, name, linked_profile_id)
VALUES ('NB-P', :'uA', 'Ghulam', :'uG')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_pair_net_balance', '_notify_money_text', '_notify_balance_phrase', '_lsr_notify_info')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
  'the balance / phrase helpers are not client-executable');

SELECT test.assert(
  (SELECT prosrc LIKE '%ltr_request%' AND prosrc LIKE '%_pair_net_balance%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tg_ltr_notify'),
  'tg_ltr_notify writes templated, balance-aware notices');

SELECT test.assert(
  (SELECT prosrc LIKE '%lsr_quiet_insert%' AND prosrc LIKE '%lsr_recorded%' AND prosrc LIKE '%lsr_undone%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tg_lsr_notify'),
  'tg_lsr_notify keeps its quiet-insert, recorded and undone branches');

-- ════════════════════════════════════════════════════════════════════════════
-- (b) A LEND REQUEST — the borrower learns the total if they accept
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note)
VALUES ('NB-T1', auth.uid(), :'uG', 'NB-P', 'lent', 1000, 'AED', 'first');

SELECT test.as_user(:'uG');
SELECT test.assert(
  (SELECT count(*) = 1
          AND bool_and(type = 'linked_request' AND template = 'ltr_request'
                       AND title = 'Naya qarz — tasdeeq karein'
                       AND body LIKE '%Aap ne Abdullah ko AED 1,000.00 dene hain%'
                       AND (params->>'kind') = 'borrowed'
                       AND (params->>'balanceNow')::numeric = 0
                       AND (params->>'balanceAfter')::numeric = -1000
                       AND actor_id IS NULL AND channel_id = 'money' AND href = '/inbox')
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-T1'),
  'the borrower is told, in roman Urdu, that accepting makes it AED 1,000 owed');

SELECT test.assert_ok($$ SELECT accept_linked_request('NB-T1') $$, 'the borrower accepts');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) ACCEPT / REJECT — the lender learns the total now
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uA');
SELECT test.assert(
  (SELECT count(*) = 1
          AND bool_and(template = 'ltr_accepted' AND title = 'Shared loan confirmed'
                       AND body = 'Ghulam confirmed the shared loan of AED 1,000.00. Now: Ghulam owes you AED 1,000.00.'
                       AND (params->>'balanceAfter')::numeric = 1000)
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-T1'),
  'the lender hears the confirmation and the total now (English)');

INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note)
VALUES ('NB-T2', auth.uid(), :'uG', 'NB-P', 'lent', 87.6, 'AED', 'second');

SELECT test.as_user(:'uG');
SELECT test.assert(
  (SELECT (params->>'balanceNow')::numeric = -1000 AND (params->>'balanceAfter')::numeric = -1087.6
          AND body LIKE '%AED 1,087.60 dene hain%'
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-T2'),
  'a second request starts from the accepted total — the pending one is not counted yet');
SELECT test.assert_ok($$ SELECT reject_linked_request('NB-T2') $$, 'the borrower rejects the second');

SELECT test.as_user(:'uA');
SELECT test.assert(
  (SELECT template = 'ltr_rejected' AND title = 'Shared loan declined'
          AND (params->>'balanceAfter')::numeric = 1000
          AND body LIKE '%Still: Ghulam owes you AED 1,000.00.'
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-T2'),
  'a rejection says the total did not move');

-- ════════════════════════════════════════════════════════════════════════════
-- (d) THE RECEIVER RECORDS A REPAYMENT — the payer learns what is left
-- ════════════════════════════════════════════════════════════════════════════
SELECT requester_loan_id AS la, responder_loan_id AS lg FROM linked_transaction_requests WHERE id = 'NB-T1' \gset

SELECT test.assert_ok(format(
  $q$ SELECT record_received_repayment('NB-S1', 'NB-T1', %L, %L, %L, 300, 'AED', '', NULL) $q$,
  :'la', :'lg', :'uG'),
  'the lender records 300 received');

SELECT test.as_user(:'uG');
SELECT test.assert(
  (SELECT count(*) = 1
          AND bool_and(type = 'linked_info' AND template = 'lsr_recorded'
                       AND (params->>'balanceAfter')::numeric = -700
                       AND body LIKE '%Ab: Aap ne Abdullah ko AED 700.00 dene hain.')
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-S1'),
  'the payer is told what is left after the recorded repayment (roman Urdu)');

-- ════════════════════════════════════════════════════════════════════════════
-- (e) A PAYER'S CLAIM — the receiver learns the total if they confirm
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert_ok(format(
  $q$ SELECT create_settlement_request('NB-S2', 'NB-T1', %L, %L, %L, 200, 'AED', '') $q$,
  :'lg', :'la', :'uA'),
  'the payer claims a 200 repayment');

SELECT test.as_user(:'uA');
SELECT test.assert(
  (SELECT type = 'linked_settlement' AND template = 'lsr_request' AND title = 'Repayment to confirm'
          AND (params->>'balanceNow')::numeric = 700 AND (params->>'balanceAfter')::numeric = 500
          AND body = 'Ghulam recorded a repayment of AED 200.00. If you confirm: Ghulam owes you AED 500.00. Open Inbox to confirm.'
          AND actor_id IS NULL
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-S2'),
  'the receiver sees the claim and the total if confirmed — the claim is not counted yet');
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'la') = 700,
  'a pending claim moved no money');
SELECT test.assert_ok($$ SELECT accept_settlement_request('NB-S2') $$, 'the receiver confirms');

SELECT test.as_user(:'uG');
SELECT test.assert(
  (SELECT template = 'lsr_accepted' AND title = 'Wapsi tasdeeq ho gayi'
          AND (params->>'balanceAfter')::numeric = -500
          AND body LIKE '%Ab: Aap ne Abdullah ko AED 500.00 dene hain.'
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'NB-S2'),
  'the payer hears the confirmation and the total now');

-- ════════════════════════════════════════════════════════════════════════════
-- (f) The money itself is untouched by any of this
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT remaining_amount FROM loans WHERE id = :'lg') = 500,
  'the borrower''s loan is at 500 — notices only describe, never move, money');

RESET ROLE;
