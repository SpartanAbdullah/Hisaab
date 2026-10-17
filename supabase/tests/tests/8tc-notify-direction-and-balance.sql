-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ LOCAL TEST HARNESS ONLY (./supabase/tests/run.sh, psql). NOT a migration —
--   never paste into Supabase Studio: it creates throwaway auth users.
--   The migration it covers is supabase-migration-notify-direction-and-balance.sql.
-- ════════════════════════════════════════════════════════════════════════════
-- 8tc · Every money notice says which way the balance moved, and where it
--       stands — supabase-migration-notify-direction-and-balance.sql
--
-- Founder 2026-10-17: "each transaction notification doesn't inform whether
-- the amount is going to be increased or decreased". Claims, walked through
-- one three-member group (Ayla pays, Bashir and Cem share; Bashir reads roman
-- Urdu, the others English), one linked loan pair, and one kameti:
--   (a) catalog: helpers closed to clients; the pair math matches
--       computePairwiseDebts on the fixture numbers;
--   (b) an expense tells each reader THEIR share and THEIR balance with the
--       payer, in THEIR language; a reader with no share hears "unchanged";
--   (c) an edit and a delete stamp the signed move and the net after;
--   (d) a settlement tells the two parties, and a bystander reads flat with
--       the group-scope line;
--   (e) the group_events feed, the rate limit and the mute filter still work;
--   (f) linked notices carry `delta` and the ▲/▼ glyph; a lump repayment
--       fanned across loans collapses per intent in the tray;
--   (g) a kameti member hears their contribution (▼) and payout (▲) with
--       their rounds-paid position; the organiser hears nothing;
--   (h) actor_id stays NULL on linked rows and present on group rows.
--
-- Fresh users 5f000000-…-01 Ayla (en), -02 Bashir (ur), -03 Cem (en).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8tc-notify-direction-and-balance');

\set uA '5f000000-0000-4000-8000-000000000001'
\set uB '5f000000-0000-4000-8000-000000000002'
\set uC '5f000000-0000-4000-8000-000000000003'
\set uD '5f000000-0000-4000-8000-000000000004'

RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  (:'uA', 'nd-ayla@hisaab.test'),
  (:'uB', 'nd-bashir@hisaab.test'),
  (:'uC', 'nd-cem@hisaab.test'),
  (:'uD', 'nd-dua@hisaab.test')
ON CONFLICT (id) DO NOTHING;

UPDATE profiles SET name = 'Ayla',   lang = 'en' WHERE id = :'uA';
UPDATE profiles SET name = 'Bashir', lang = 'ur' WHERE id = :'uB';
UPDATE profiles SET name = 'Cem',    lang = 'en' WHERE id = :'uC';
-- Dua stays OUTSIDE the group: group debts are mirrored into `loans` by the
-- khata link, so the linked-loan and kameti claims use a pair with no group
-- history (the pair total must start at 0).
UPDATE profiles SET name = 'Dua',    lang = 'ur' WHERE id = :'uD';

-- ════════════════════════════════════════════════════════════════════════════
-- (a) CATALOG + MATH
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_group_reader_balance', '_group_net', '_group_notice_text', '_notify_now_phrase',
                         '_kameti_member_notice', '_lsr_collapse_key', 'fan_out_group_notification')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
  'the balance helpers and the fan-out are not client-executable');

SELECT test.assert(
  public._group_expense_effect('A', '[{"memberId":"A","amount":30},{"memberId":"B","amount":30}]'::jsonb, array['B'], array['A']) = -30
  AND public._group_expense_effect('A', '[{"memberId":"A","amount":30},{"memberId":"B","amount":30}]'::jsonb, array['A'], array['B']) = 30
  AND public._group_settlement_effect('B', 'A', 30, array['B'], array['A']) = 30,
  'the SQL pair effect agrees with computePairwiseDebts (B owes A 30; a 30 settlement clears it)');

-- ════════════════════════════════════════════════════════════════════════════
-- Fixture: group ND with Ayla (owner), Bashir, Cem.
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO split_groups (id, user_id, name, emoji, currency, join_code, join_code_normalized, created_by)
VALUES ('ND-G', auth.uid(), 'Flat 12', '🏠', 'AED', 'GRP-NDB123', 'NDB123', auth.uid());
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status, invited_by, joined_at)
VALUES ('ND-MA', 'ND-G', auth.uid(), 'Ayla', 'owner', 'connected', auth.uid(), now());

SELECT test.as_user(:'uB');
SELECT test.assert((join_group_by_code('NDB123', 'Bashir') ->> 'status') = 'ok', 'Bashir joins Flat 12');
SELECT test.as_user(:'uC');
SELECT test.assert((join_group_by_code('NDB123', 'Cem') ->> 'status') = 'ok', 'Cem joins Flat 12');

RESET ROLE;
SELECT id AS mb FROM group_members WHERE group_id = 'ND-G' AND profile_id = :'uB' \gset
SELECT id AS mc FROM group_members WHERE group_id = 'ND-G' AND profile_id = :'uC' \gset
-- The join notices are not under test here; clear them so counts below are clean.
DELETE FROM notifications WHERE group_id = 'ND-G';

-- ════════════════════════════════════════════════════════════════════════════
-- (b) AN EXPENSE — Ayla pays 150, split Ayla 50 / Bashir 50 / Cem 50
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO group_expenses (id, user_id, group_id, description, amount, paid_by, split_type, splits, created_by)
VALUES ('ND-E1', auth.uid(), 'ND-G', 'Dinner', 150.00, 'ND-MA', 'equal',
        jsonb_build_array(
          jsonb_build_object('memberId', 'ND-MA', 'amount', 50.00),
          jsonb_build_object('memberId', :'mb', 'amount', 50.00),
          jsonb_build_object('memberId', :'mc', 'amount', 50.00)),
        auth.uid());

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) = 1
          AND bool_and(type = 'group_update' AND template = 'expense_added'
                       AND title = 'Ayla ne kharcha add kiya'
                       AND body = 'Flat 12 mein Dinner — AED 150.00 add hua. Aap ka hissa: AED 50.00 ▼. Ab Flat 12 mein: Aap ne Ayla ko AED 50.00 dene hain.'
                       AND (params->>'delta')::numeric = -50
                       AND (params->>'balanceAfter')::numeric = -50
                       AND params->>'balanceScope' = 'pair'
                       AND params->>'counterpartyName' = 'Ayla'
                       AND params ? 'splits' = false
                       AND actor_id = :'uA'
                       AND channel_id = 'groups' AND href = '/group/ND-G')
     FROM notifications WHERE user_id = :'uB' AND params->>'expenseId' = 'ND-E1'),
  'Bashir (ur) hears his AED 50 share ▼ and that he now owes Ayla AED 50 in Flat 12',
  (SELECT body FROM notifications WHERE user_id = :'uB' AND params->>'expenseId' = 'ND-E1'));

SELECT test.assert(
  (SELECT body = 'Dinner for AED 150.00 was added in Flat 12. Your share: AED 50.00 ▼. Now in Flat 12: You owe Ayla AED 50.00.'
          AND title = 'Ayla added an expense'
     FROM notifications WHERE user_id = :'uC' AND params->>'expenseId' = 'ND-E1'),
  'Cem (en) hears the same facts in English, the catalog sentence first',
  (SELECT body FROM notifications WHERE user_id = :'uC' AND params->>'expenseId' = 'ND-E1'));

SELECT test.assert(
  (SELECT count(*) = 0 FROM notifications WHERE user_id = :'uA' AND params->>'expenseId' = 'ND-E1'),
  'the actor is never told about their own expense');

SELECT test.assert(
  (SELECT count(*) = 1 AND bool_and(payload ? 'splits' = false AND summary = 'Dinner for AED 150.00 was added in Flat 12.')
     FROM group_events WHERE group_id = 'ND-G' AND entity_id = 'ND-E1'),
  'the shared feed keeps the plain English sentence and no split payload');

-- Bashir pays 40 split Bashir 20 / Cem 20 — Ayla has no share: "unchanged",
-- and her pair with Bashir is read from HER side (+50 → she is owed 50).
SET ROLE authenticated;
SELECT test.as_user(:'uB');
INSERT INTO group_expenses (id, user_id, group_id, description, amount, paid_by, split_type, splits, created_by)
VALUES ('ND-E2', auth.uid(), 'ND-G', 'Taxi', 40.00, :'mb', 'equal',
        jsonb_build_array(
          jsonb_build_object('memberId', :'mb', 'amount', 20.00),
          jsonb_build_object('memberId', :'mc', 'amount', 20.00)),
        auth.uid());

RESET ROLE;
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = 0 AND (params->>'balanceAfter')::numeric = 50
          AND body LIKE '%Not your share — nothing changes for you. Now in Flat 12: Bashir owes you AED 50.00.'
     FROM notifications WHERE user_id = :'uA' AND params->>'expenseId' = 'ND-E2'),
  'a reader with no share reads "unchanged" and still sees the pair balance (Bashir owes Ayla 50)',
  (SELECT body FROM notifications WHERE user_id = :'uA' AND params->>'expenseId' = 'ND-E2'));
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = -20 AND (params->>'balanceAfter')::numeric = -20
          AND params->>'counterpartyName' = 'Bashir'
     FROM notifications WHERE user_id = :'uC' AND params->>'expenseId' = 'ND-E2'),
  'Cem owes Bashir 20 for the taxi — his pair with Bashir, not with Ayla');

-- ════════════════════════════════════════════════════════════════════════════
-- (c) EDIT and DELETE
-- ════════════════════════════════════════════════════════════════════════════
-- Ayla reprices the dinner to 180, split 60/60/60 ⇒ Bashir's share +10.
SET ROLE authenticated;
SELECT test.as_user(:'uA');
UPDATE group_expenses
   SET amount = 180.00,
       splits = jsonb_build_array(
         jsonb_build_object('memberId', 'ND-MA', 'amount', 60.00),
         jsonb_build_object('memberId', :'mb', 'amount', 60.00),
         jsonb_build_object('memberId', :'mc', 'amount', 60.00)),
       updated_by = auth.uid(),
       version = version + 1   -- the edit-history optimistic lock
 WHERE id = 'ND-E1';

RESET ROLE;
SELECT test.assert(
  (SELECT template = 'expense_updated' AND (params->>'delta')::numeric = -10 AND (params->>'balanceAfter')::numeric = -60
          AND body = 'Flat 12 mein Dinner badla gaya. ▼ AED 10.00 aap ke zimme. Ab Flat 12 mein: Aap ne Ayla ko AED 60.00 dene hain.'
     FROM notifications WHERE user_id = :'uB' AND template = 'expense_updated' AND params->>'expenseId' = 'ND-E1'),
  'an edit stamps the signed move (−10) and the net after (−60), in roman Urdu',
  (SELECT body FROM notifications WHERE user_id = :'uB' AND template = 'expense_updated' AND params->>'expenseId' = 'ND-E1'));

-- Bashir deletes the taxi ⇒ Cem's 20 debt to him is gone (+20 for Cem).
SET ROLE authenticated;
SELECT test.as_user(:'uB');
UPDATE group_expenses SET deleted_at = now(), deleted_by = auth.uid() WHERE id = 'ND-E2';

RESET ROLE;
SELECT test.assert(
  (SELECT template = 'expense_deleted' AND (params->>'delta')::numeric = 20 AND (params->>'balanceAfter')::numeric = 0
          AND body = 'Taxi was removed from Flat 12. ▲ AED 20.00 in your favour. Now in Flat 12: Settled up with Bashir.'
     FROM notifications WHERE user_id = :'uC' AND template = 'expense_deleted' AND params->>'expenseId' = 'ND-E2'),
  'a delete reverses the share (+20 for Cem) and reads settled with Bashir',
  (SELECT body FROM notifications WHERE user_id = :'uC' AND template = 'expense_deleted' AND params->>'expenseId' = 'ND-E2'));

-- ════════════════════════════════════════════════════════════════════════════
-- (d) SETTLEMENT — Cem pays Ayla 60 (recorded by Ayla)
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO group_settlements (id, user_id, group_id, from_member, to_member, amount, created_by)
VALUES ('ND-S1', auth.uid(), 'ND-G', :'mc', 'ND-MA', 60.00, auth.uid());

RESET ROLE;
SELECT test.assert(
  (SELECT template = 'settlement_added' AND (params->>'delta')::numeric = 60 AND (params->>'balanceAfter')::numeric = 0
          AND params->>'balanceScope' = 'pair' AND params->>'counterpartyName' = 'Ayla'
          AND body = 'Cem settled AED 60.00 with Ayla in Flat 12. ▲ AED 60.00 in your favour. Now in Flat 12: Settled up with Ayla.'
     FROM notifications WHERE user_id = :'uC' AND params->>'settlementId' = 'ND-S1'),
  'the payer of a settlement reads +60 and settled with the receiver',
  (SELECT body FROM notifications WHERE user_id = :'uC' AND params->>'settlementId' = 'ND-S1'));
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = 0 AND params->>'balanceScope' = 'group' AND (params->>'balanceAfter')::numeric = -60
          AND body LIKE '%Aap ke liye kuch nahi badla. Ab Flat 12 mein: kul AED 60.00 aap ne dene hain.'
     FROM notifications WHERE user_id = :'uB' AND params->>'settlementId' = 'ND-S1'),
  'a bystander reads flat, with his overall net in the group (owes 60)',
  (SELECT body FROM notifications WHERE user_id = :'uB' AND params->>'settlementId' = 'ND-S1'));

-- ════════════════════════════════════════════════════════════════════════════
-- (e) FILTERS SURVIVED THE REWRITE — mute
-- ════════════════════════════════════════════════════════════════════════════
-- Fresh user, fresh group: no prior prefs row (the unique index is an
-- expression index, so ON CONFLICT cannot name it).
INSERT INTO public.notification_prefs (user_id, group_id, muted)
VALUES (:'uC', 'ND-G', true);

SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO group_expenses (id, user_id, group_id, description, amount, paid_by, split_type, splits, created_by)
VALUES ('ND-E3', auth.uid(), 'ND-G', 'Muted', 30.00, 'ND-MA', 'equal',
        jsonb_build_array(
          jsonb_build_object('memberId', 'ND-MA', 'amount', 15.00),
          jsonb_build_object('memberId', :'mc', 'amount', 15.00)),
        auth.uid());
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) = 0 FROM notifications WHERE user_id = :'uC' AND params->>'expenseId' = 'ND-E3')
  AND (SELECT count(*) = 1 FROM notifications WHERE user_id = :'uB' AND params->>'expenseId' = 'ND-E3')
  AND (SELECT count(*) = 1 FROM group_events WHERE entity_id = 'ND-E3'),
  'a muter gets no row, the other member does, and the feed row is still written');
DELETE FROM public.notification_prefs WHERE user_id = :'uC' AND group_id = 'ND-G';

-- ════════════════════════════════════════════════════════════════════════════
-- (f) LINKED — delta + glyph, and the lump-repayment batch
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.persons (id, user_id, name, linked_profile_id)
VALUES ('ND-P', :'uA', 'Dua', :'uD')
ON CONFLICT (id) DO NOTHING;

SET ROLE authenticated;
SELECT test.as_user(:'uA');
INSERT INTO linked_transaction_requests (id, from_user_id, to_user_id, person_id, kind, amount, currency, note)
VALUES ('ND-T1', auth.uid(), :'uD', 'ND-P', 'lent', 1000, 'AED', 'first');

SELECT test.as_user(:'uD');
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = -1000
          AND body LIKE '%Accept karne par: ▼ Aap ne Ayla ko AED 1,000.00 dene hain.%'
          AND actor_id IS NULL
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'ND-T1'),
  'a lend request carries delta −1000 and the ▼ glyph before the if-accepted phrase',
  (SELECT body FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'ND-T1'));
SELECT test.assert_ok($$ SELECT accept_linked_request('ND-T1') $$, 'Dua accepts');

SELECT test.as_user(:'uA');
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = 1000 AND actor_id IS NULL
          AND body = 'Dua confirmed the shared loan of AED 1,000.00. Now: ▲ Dua owes you AED 1,000.00.'
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'ND-T1'),
  'the lender reads +1000 ▲ on the acceptance');

SELECT requester_loan_id AS la, responder_loan_id AS lb FROM linked_transaction_requests WHERE id = 'ND-T1' \gset

-- A lump repayment fanned across loans: ids `${intentId}:${loanId}`.
SELECT test.as_user(:'uD');
SELECT test.assert_ok(format(
  $q$ SELECT create_settlement_request('ND-I1:%s', 'ND-T1', %L, %L, %L, 300, 'AED', '') $q$,
  :'lb', :'lb', :'la', :'uA'),
  'the borrower claims 300 as part of a lump repayment');

SELECT test.as_user(:'uA');
SELECT test.assert(
  (SELECT template = 'lsr_request'
          AND (params->>'delta')::numeric = -300 AND (params->>'balanceAfter')::numeric = 700
          AND params->>'batchId' = 'ND-I1'
          AND collapse_key = 'linked_settlement:batch:ND-I1'
          AND body LIKE '%If you confirm: ▼ Dua owes you AED 700.00. Open Inbox to confirm. Part of one repayment across your loans.'
          AND actor_id IS NULL
     FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'ND-I1:' || :'lb'),
  'a batch row collapses per intent, says it is one of several, and is not counted yet',
  (SELECT body || ' | ' || collapse_key FROM notifications WHERE user_id = auth.uid() AND params->>'requestId' = 'ND-I1:' || :'lb'));
SELECT test.assert((SELECT remaining_amount FROM loans WHERE id = :'la') = 1000, 'a pending claim moved no money');

-- ════════════════════════════════════════════════════════════════════════════
-- (g) KAMETI — the linked member hears contribution ▼ and payout ▲
-- ════════════════════════════════════════════════════════════════════════════
SELECT test.as_user(:'uA');
INSERT INTO committees (id, user_id, name, currency, contribution_amount, member_count, cadence, total_rounds, start_date)
VALUES ('ND-K', auth.uid(), 'Office kameti', 'AED', 500, 4, 'monthly', 4, current_date);
INSERT INTO committee_members (id, committee_id, user_id, name, person_id, slot, is_organizer)
VALUES ('ND-KM-A', 'ND-K', auth.uid(), 'Ayla', NULL, 1, true),
       ('ND-KM-D', 'ND-K', auth.uid(), 'Dua', 'ND-P', 2, false);

INSERT INTO committee_payments (id, committee_id, user_id, member_id, round)
VALUES ('ND-KP-1', 'ND-K', auth.uid(), 'ND-KM-D', 1);
INSERT INTO committee_payments (id, committee_id, user_id, member_id, round)
VALUES ('ND-KP-2', 'ND-K', auth.uid(), 'ND-KM-D', 2);

SELECT test.as_user(:'uD');
SELECT test.assert(
  (SELECT count(*) = 2
          AND bool_and(type = 'kameti' AND channel_id = 'kameti' AND href = '/kameti/ND-K'
                       AND (params->>'delta')::numeric = -500 AND params->>'balanceScope' = 'kameti')
     FROM notifications WHERE user_id = auth.uid() AND template = 'kameti_contribution_recorded'),
  'two contributions ⇒ two kameti rows for the linked member, each ▼ 500');
SELECT test.assert(
  (SELECT (params->>'paidRounds')::int = 2 AND (params->>'paidTotal')::numeric = 1000
          AND title = 'Qisht record ho gayi — Office kameti'
          AND body = 'Round 2: AED 500.00 ▼ organiser ne paid likha. 4 mein se 2 round ada · ab tak AED 1,000.00 jama.'
     FROM notifications WHERE user_id = auth.uid() AND template = 'kameti_contribution_recorded'
                          AND (params->>'round')::int = 2),
  'the second contribution reads "2 of 4 rounds · AED 1,000.00 in", in roman Urdu',
  (SELECT body FROM notifications WHERE user_id = auth.uid() AND template = 'kameti_contribution_recorded' AND (params->>'round')::int = 2));

SELECT test.as_user(:'uA');
UPDATE committee_members SET payout_received_at = now() WHERE id = 'ND-KM-D';
DELETE FROM committee_payments WHERE id = 'ND-KP-2';

SELECT test.as_user(:'uD');
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = 2000 AND (params->>'amount')::numeric = 2000
          AND body LIKE 'Round 2: AED 2,000.00 ▲ aap ko mil gaya%'
     FROM notifications WHERE user_id = auth.uid() AND template = 'kameti_payout_recorded'),
  'the payout (4 × 500) reads ▲ AED 2,000.00 to the member');
SELECT test.assert(
  (SELECT (params->>'delta')::numeric = 500 AND (params->>'paidRounds')::int = 1
     FROM notifications WHERE user_id = auth.uid() AND template = 'kameti_contribution_removed'),
  'un-marking a round reads ▲ 500 and the position drops to 1 of 4');
SELECT test.assert(
  (SELECT count(*) = 0 FROM notifications WHERE user_id = :'uA' AND template LIKE 'kameti_%' AND params->>'committeeId' = 'ND-K'),
  'the organiser hears nothing about their own kameti bookkeeping');

-- ════════════════════════════════════════════════════════════════════════════
-- (h) The money itself is untouched by any of this
-- ════════════════════════════════════════════════════════════════════════════
RESET ROLE;
SELECT test.assert(
  (SELECT amount FROM group_expenses WHERE id = 'ND-E1') = 180
  AND (SELECT count(*) FROM committee_payments WHERE committee_id = 'ND-K') = 1
  AND (SELECT remaining_amount FROM loans WHERE id = :'lb') = 1000,
  'notices only describe money — nothing moved that the writes themselves did not move');

RESET ROLE;
