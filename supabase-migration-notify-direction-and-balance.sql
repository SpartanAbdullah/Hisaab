-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — every money notice says which way the balance moved, and where it
-- stands now (2026-10-17)
-- ----------------------------------------------------------------------------
-- Founder, 2026-10-17: "each transaction notification doesn't inform whether
-- the amount is going to be increased or decreased". The Splitwise pattern is
-- the target — one line for the event, one line for the reader's position
-- after it, with an up/down mark:
--
--     Ali added an expense
--     Dinner — AED 150.00 in Flat 12. Your share: AED 50.00 ▼.
--     Now in Flat 12: You owe Ali AED 120.00.
--
-- What this file changes, per notice family (the gap table is in the PR):
--
--   GROUP (expense_added / _updated / _deleted, settlement_added / _deleted)
--     Before: one English body for every recipient, no share, no direction,
--     no total. After: fan_out_group_notification composes PER READER, in the
--     reader's language, and stamps `delta` (the reader's signed move in this
--     group), `balanceAfter` (the reader's net after the change), `balanceScope`
--     ('pair' = with the payer / the other side of the settlement; 'group' =
--     the reader's overall net in the group, used when the reader IS the
--     payer or is not a party to a settlement) and `counterpartyName`.
--     The math is the client's computePairwiseDebts (groupDebts.ts) moved
--     into SQL: direct obligations only, never rerouted, one group currency.
--
--   LINKED (ltr_* / lsr_*, already balance-aware since notify-balance-after)
--     Gain a signed `delta` param and a ▲/▼ mark in the "Now:" / "If you
--     accept:" sentence. A lump repayment fanned across loans (ids
--     `${intentId}:${loanId}`, settlementBatchKeys) collapses in the tray
--     under one key per intent and says so in the body — the per-loan rows
--     stay separate decisions in the Inbox.
--
--   KAMETI (new: kameti_contribution_recorded / _removed, kameti_payout_recorded)
--     Before: nothing — a member whose round the organiser marked paid heard
--     nothing. After: the linked member is told, with the direction (▼ paid
--     in, ▲ received) and their position: rounds paid of total, amount in.
--
-- Invariants kept:
--   • notification TYPES are unchanged (bell counting, channel/href/collapse
--     stamping key on them); every English TITLE the old triggers wrote is
--     unchanged, and the English event sentence of the group bodies is the
--     same text as before with the move + balance appended.
--   • actor_id stays NULL on linked_request / linked_settlement rows
--     (fan_out's per-sender rate limit counts actor_id rows). linked_info,
--     group and kameti rows carry the actor as before.
--   • RULE 4 (p2-notification-maturity): a notice is never worth rolling back
--     money. Every per-reader computation is wrapped; a failure degrades to
--     the plain sentence, never to a failed expense / settlement / payment.
--   • A pending request is never counted in a total: `balanceAfter` on a
--     request row is "if accepted", computed from the reader's OWN rows.
--   • One currency per notice (a group has one; a loan pair has one).
--
-- Replaces (latest definitions):
--   fan_out_group_notification  — supabase-migration-p2-notification-maturity.sql §5
--   tg_group_expenses_notify    — supabase-migration-audit-p0-notifications.sql §5
--   tg_group_settlements_notify — supabase-migration-audit-p0-notifications.sql §5
--   tg_ltr_notify / tg_lsr_notify / _lsr_notify_info
--                               — supabase-migration-notify-balance-after.sql
-- Adds internal helpers (all revoked from clients) and two kameti triggers.
--
-- Safe to re-run (create or replace). Apply in Supabase Studio, then re-run
-- supabase-migration-p3-rpc-execute-grants.sql (the least-privilege sweep).
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- ▲ when the reader's net goes up (owed more / owes less), ▼ when it goes
-- down, nothing when it did not move. The push tray cannot show colour; this
-- is the one glyph it gets.
create or replace function public._notify_move_glyph(p_delta numeric)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_delta, 0) > 0.005 then '▲'
    when coalesce(p_delta, 0) < -0.005 then '▼'
    else ''
  end;
$$;

-- The reader's language: profiles.lang, default 'ur' (the i18n fallback).
create or replace function public._notify_lang(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.lang from public.profiles p where p.id = p_user), 'ur');
$$;

-- Sum of the split amounts that belong to `p_members` (NULL = every split).
-- Splits are `[{memberId, amount}]` (splitStore); `member_id` is tolerated
-- because the ledger-integrity trigger tolerates it.
create or replace function public._group_split_sum(p_splits jsonb, p_members text[])
returns numeric
language sql
immutable
set search_path = public
as $$
  select coalesce(sum((s->>'amount')::numeric), 0)
    from jsonb_array_elements(
           case when jsonb_typeof(coalesce(p_splits, '[]'::jsonb)) = 'array'
                then coalesce(p_splits, '[]'::jsonb) else '[]'::jsonb end) s
   where p_members is null
      or coalesce(s->>'memberId', s->>'member_id') = any (p_members);
$$;

-- One expense's effect on the reader's net with `p_other` (NULL = everyone
-- else in the group). Positive ⇒ the others owe the reader more. Mirrors
-- computePairwiseDebts: a split owed to the payer, a payer never owing
-- themselves their own share.
create or replace function public._group_expense_effect(
  p_paid_by text,
  p_splits  jsonb,
  p_reader  text[],
  p_other   text[]
)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_paid_by is null or p_reader is null then 0
    when p_paid_by = any (p_reader) then
      case when p_other is null
           then public._group_split_sum(p_splits, null) - public._group_split_sum(p_splits, p_reader)
           else public._group_split_sum(p_splits, p_other) end
    when p_other is null or p_paid_by = any (p_other) then
      - public._group_split_sum(p_splits, p_reader)
    else 0
  end;
$$;

-- One settlement's effect: from → to pays down from's debt to to.
create or replace function public._group_settlement_effect(
  p_from   text,
  p_to     text,
  p_amount numeric,
  p_reader text[],
  p_other  text[]
)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_reader is null then 0
    when p_from = any (p_reader) and (p_other is null or p_to = any (p_other)) then coalesce(p_amount, 0)
    when p_to = any (p_reader) and (p_other is null or p_from = any (p_other)) then -coalesce(p_amount, 0)
    else 0
  end;
$$;

-- Every member row a profile holds in a group (a claimed guest slot plus the
-- joined row is one person for balance purposes).
create or replace function public._group_member_ids(p_group_id text, p_profile uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_agg(gm.id)
    from public.group_members gm
   where gm.group_id = p_group_id
     and gm.profile_id = p_profile;
$$;

-- The member set behind one member id: all rows of that member's profile, or
-- just the id itself for a guest (no profile).
create or replace function public._group_member_set(p_group_id text, p_member_id text)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile uuid;
  v_ids     text[];
begin
  if p_member_id is null then
    return null;
  end if;
  select gm.profile_id into v_profile from public.group_members gm where gm.id = p_member_id;
  if v_profile is null then
    return array[p_member_id];
  end if;
  v_ids := public._group_member_ids(p_group_id, v_profile);
  return coalesce(v_ids, array[p_member_id]);
end $$;

-- The reader's net in a group — with `p_other`, or overall when NULL — from
-- every live expense and settlement. Same sign rule as _pair_net_balance:
-- positive ⇒ the other side owes the reader.
create or replace function public._group_net(p_group_id text, p_reader text[], p_other text[])
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(coalesce(sum(q.x), 0), 2)
    from (
      select public._group_expense_effect(e.paid_by, e.splits, p_reader, p_other) as x
        from public.group_expenses e
       where e.group_id = p_group_id
         and e.deleted_at is null
      union all
      select public._group_settlement_effect(s.from_member, s.to_member, s.amount, p_reader, p_other)
        from public.group_settlements s
       where s.group_id = p_group_id
         and s.deleted_at is null
    ) q;
$$;

-- Per-reader balance facts for one group notice. `p_calc` is the trigger's
-- raw params: paidBy / splits / prevPaidBy / prevSplits for expenses,
-- fromMember / toMember / amount for settlements. Returns '{}' when the
-- reader has no member row, the template carries no money, or anything at
-- all goes wrong — the notice then falls back to the plain sentence.
create or replace function public._group_reader_balance(
  p_group_id text,
  p_reader   uuid,
  p_template text,
  p_calc     jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reader   text[];
  v_other    text[];
  v_cp       text;      -- counterparty member id ('pair' scope)
  v_cp_name  text;
  v_scope    text;
  v_delta    numeric;
  v_after    numeric;
  v_new_paid text;
  v_prev_paid text;
  v_from     text;
  v_to       text;
  v_amount   numeric;
begin
  v_reader := public._group_member_ids(p_group_id, p_reader);
  if v_reader is null or cardinality(v_reader) = 0 then
    return '{}'::jsonb;
  end if;

  if p_template in ('expense_added', 'expense_updated', 'expense_deleted') then
    v_new_paid  := p_calc->>'paidBy';
    v_prev_paid := coalesce(p_calc->>'prevPaidBy', v_new_paid);
    v_cp := case when p_template = 'expense_deleted' then v_prev_paid else v_new_paid end;
    if v_cp is null then
      return '{}'::jsonb;
    end if;
    if v_cp = any (v_reader) then
      v_other := null; v_scope := 'group';
    else
      v_other := public._group_member_set(p_group_id, v_cp); v_scope := 'pair';
    end if;
    -- added: no previous row; deleted: no current row (splits NULL ⇒ 0).
    v_delta := public._group_expense_effect(v_new_paid,
                 case when p_template = 'expense_deleted' then null else p_calc->'splits' end,
                 v_reader, v_other)
             - public._group_expense_effect(v_prev_paid,
                 case when p_template = 'expense_added' then null else p_calc->'prevSplits' end,
                 v_reader, v_other);

  elsif p_template in ('settlement_added', 'settlement_deleted') then
    v_from   := p_calc->>'fromMember';
    v_to     := p_calc->>'toMember';
    v_amount := (p_calc->>'amount')::numeric;
    if v_from = any (v_reader) then
      v_cp := v_to;   v_other := public._group_member_set(p_group_id, v_to);   v_scope := 'pair';
    elsif v_to = any (v_reader) then
      v_cp := v_from; v_other := public._group_member_set(p_group_id, v_from); v_scope := 'pair';
    else
      v_cp := null;   v_other := null; v_scope := 'group';
    end if;
    v_delta := public._group_settlement_effect(v_from, v_to, v_amount, v_reader, v_other)
             * case when p_template = 'settlement_deleted' then -1 else 1 end;
  else
    return '{}'::jsonb;
  end if;

  -- AFTER triggers: the table already holds the state after the change.
  v_after := public._group_net(p_group_id, v_reader, v_other);

  if v_scope = 'pair' then
    select coalesce(nullif(trim(gm.display_name), ''), 'A member') into v_cp_name
      from public.group_members gm where gm.id = v_cp;
  end if;

  return jsonb_build_object(
           'delta',        round(coalesce(v_delta, 0), 2),
           'balanceAfter', round(coalesce(v_after, 0), 2),
           'balanceScope', v_scope)
         || case when v_cp_name is not null
                 then jsonb_build_object('counterpartyName', v_cp_name)
                 else '{}'::jsonb end;
exception when others then
  return '{}'::jsonb;
end $$;

-- The reader's move, in their language. Expense_added speaks of a share; the
-- rest of the family uses the generic in-your-favour / against-you wording
-- (i18n ntf_move_*).
create or replace function public._group_move_phrase(
  p_lang     text,
  p_template text,
  p_delta    numeric,
  p_currency text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_template = 'expense_added' then
      case
        when coalesce(p_delta, 0) < -0.005 then
          case when p_lang = 'en' then 'Your share: ' || public._notify_money_text(p_currency, p_delta) || ' ▼.'
               else 'Aap ka hissa: ' || public._notify_money_text(p_currency, p_delta) || ' ▼.' end
        when coalesce(p_delta, 0) > 0.005 then
          case when p_lang = 'en' then 'You paid — ' || public._notify_money_text(p_currency, p_delta) || ' ▲ is owed to you.'
               else 'Aap ne diye — ' || public._notify_money_text(p_currency, p_delta) || ' ▲ aap ko milne hain.' end
        else
          case when p_lang = 'en' then 'Not your share — nothing changes for you.'
               else 'Aap ka hissa nahi — aap ke liye kuch nahi badla.' end
      end
    else
      case
        when coalesce(p_delta, 0) > 0.005 then
          case when p_lang = 'en' then '▲ ' || public._notify_money_text(p_currency, p_delta) || ' in your favour.'
               else '▲ ' || public._notify_money_text(p_currency, p_delta) || ' aap ke haq mein.' end
        when coalesce(p_delta, 0) < -0.005 then
          case when p_lang = 'en' then '▼ ' || public._notify_money_text(p_currency, p_delta) || ' against you.'
               else '▼ ' || public._notify_money_text(p_currency, p_delta) || ' aap ke zimme.' end
        else
          case when p_lang = 'en' then 'Nothing changes for you.'
               else 'Aap ke liye kuch nahi badla.' end
      end
  end;
$$;

-- "Now in Flat 12: You owe Ali AED 120.00." (pair) /
-- "Now in Flat 12: you are owed AED 300.00 overall." (group).
create or replace function public._group_balance_phrase(
  p_lang      text,
  p_scope     text,
  p_net       numeric,
  p_currency  text,
  p_other     text,
  p_group     text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_lang = 'en' then 'Now in ' || p_group || ': ' else 'Ab ' || p_group || ' mein: ' end
      || case
           when p_scope = 'pair' and p_other is not null then
             public._notify_balance_phrase(p_lang, p_net, p_currency, p_other)
           when abs(coalesce(p_net, 0)) < 0.005 then
             case when p_lang = 'en' then 'all settled up' else 'sab hisaab barabar' end
           when p_net > 0 then
             case when p_lang = 'en' then 'you are owed ' || public._notify_money_text(p_currency, p_net) || ' overall'
                  else 'kul ' || public._notify_money_text(p_currency, p_net) || ' aap ko milne hain' end
           else
             case when p_lang = 'en' then 'you owe ' || public._notify_money_text(p_currency, p_net) || ' overall'
                  else 'kul ' || public._notify_money_text(p_currency, p_net) || ' aap ne dene hain' end
         end
      || '.';
$$;

-- Title + body for one reader. Money templates are composed here in both
-- languages (the English event sentence is the audit-p0 catalog's, verbatim,
-- so legacy assertions and the activity feed keep their wording); anything
-- else falls through to group_notification_text unchanged.
create or replace function public._group_notice_text(
  p_template text,
  p_params   jsonb,
  p_lang     text
)
returns table (title text, body text)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_actor  text := coalesce(nullif(trim(p_params->>'actorName'), ''), case when p_lang = 'en' then 'A member' else 'Koi member' end);
  v_group  text := coalesce(nullif(trim(p_params->>'groupName'), ''), case when p_lang = 'en' then 'the group' else 'group' end);
  v_desc   text := coalesce(nullif(trim(p_params->>'description'), ''), case when p_lang = 'en' then 'An expense' else 'Aik kharcha' end);
  v_from   text := coalesce(nullif(trim(p_params->>'fromName'), ''), case when p_lang = 'en' then 'Someone' else 'Koi member' end);
  v_to     text := coalesce(nullif(trim(p_params->>'toName'), ''), case when p_lang = 'en' then 'someone' else 'koi member' end);
  v_cur    text := coalesce(nullif(trim(p_params->>'currency'), ''), '');
  v_money  text;
  v_delta  numeric;
  v_after  numeric;
  v_scope  text := p_params->>'balanceScope';
  v_cp     text := nullif(trim(coalesce(p_params->>'counterpartyName', '')), '');
  v_tail   text := '';
begin
  if p_template not in ('expense_added', 'expense_updated', 'expense_deleted',
                        'settlement_added', 'settlement_deleted') then
    return query select t.title, t.body from public.group_notification_text(p_template, p_params) t;
    return;
  end if;

  if (p_params->>'amount') is not null then
    v_money := public._notify_money_text(v_cur, (p_params->>'amount')::numeric);
  end if;
  if (p_params->>'delta') is not null and (p_params->>'balanceAfter') is not null then
    v_delta := (p_params->>'delta')::numeric;
    v_after := (p_params->>'balanceAfter')::numeric;
    v_tail := ' ' || public._group_move_phrase(p_lang, p_template, v_delta, v_cur)
           || ' ' || public._group_balance_phrase(p_lang, coalesce(v_scope, 'group'), v_after, v_cur, v_cp, v_group);
  end if;

  if p_lang = 'en' then
    if p_template = 'expense_added' then
      title := v_actor || ' added an expense';
      body  := v_desc || coalesce(' for ' || v_money, '') || ' was added in ' || v_group || '.';
    elsif p_template = 'expense_updated' then
      title := v_actor || ' updated an expense';
      body  := v_desc || ' was changed in ' || v_group || '.';
    elsif p_template = 'expense_deleted' then
      title := v_actor || ' deleted an expense';
      body  := v_desc || ' was removed from ' || v_group || '.';
    elsif p_template = 'settlement_added' then
      title := v_from || ' settled up';
      body  := v_from || ' settled ' || coalesce(v_money, 'up') || ' with ' || v_to || ' in ' || v_group || '.';
    else
      title := v_actor || ' removed a settlement';
      body  := 'The ' || v_from || ' → ' || v_to || ' settlement in ' || v_group || ' was undone.';
    end if;
  else
    -- Roman Urdu — the same copy as i18n.ts ntf_* so the tray and the card agree.
    if p_template = 'expense_added' then
      title := v_actor || ' ne kharcha add kiya';
      body  := v_group || ' mein ' || v_desc || coalesce(' — ' || v_money, '') || ' add hua.';
    elsif p_template = 'expense_updated' then
      title := v_actor || ' ne kharcha update kiya';
      body  := v_group || ' mein ' || v_desc || ' badla gaya.';
    elsif p_template = 'expense_deleted' then
      title := v_actor || ' ne kharcha delete kiya';
      body  := v_group || ' se ' || v_desc || ' hata diya gaya.';
    elsif p_template = 'settlement_added' then
      title := v_from || ' ne hisaab barabar kiya';
      body  := v_group || ' mein ' || v_from || ' ne ' || v_to || ' ko ' || coalesce(v_money, 'hisaab') || ' diye.';
    else
      title := v_actor || ' ne settlement hataya';
      body  := v_group || ' ka ' || v_from || ' → ' || v_to || ' settlement undo ho gaya.';
    end if;
  end if;

  body := body || v_tail;
  return next;
end $$;

revoke all on function public._notify_move_glyph(numeric) from public, anon, authenticated;
revoke all on function public._notify_lang(uuid) from public, anon, authenticated;
revoke all on function public._group_split_sum(jsonb, text[]) from public, anon, authenticated;
revoke all on function public._group_expense_effect(text, jsonb, text[], text[]) from public, anon, authenticated;
revoke all on function public._group_settlement_effect(text, text, numeric, text[], text[]) from public, anon, authenticated;
revoke all on function public._group_member_ids(text, uuid) from public, anon, authenticated;
revoke all on function public._group_member_set(text, text) from public, anon, authenticated;
revoke all on function public._group_net(text, text[], text[]) from public, anon, authenticated;
revoke all on function public._group_reader_balance(text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public._group_move_phrase(text, text, numeric, text) from public, anon, authenticated;
revoke all on function public._group_balance_phrase(text, text, numeric, text, text, text) from public, anon, authenticated;
revoke all on function public._group_notice_text(text, jsonb, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. fan_out_group_notification — per-reader composition
--
-- CREATE OR REPLACE on the p2-notification-maturity §5 body. Unchanged: the
-- group_events row (written for everyone, before any filter), the per-actor
-- rate limit, the block [F1] and mute [M5-b] recipient filters, the caps.
-- Changed: the recipient SELECT became a loop so each row can carry the
-- reader's own delta / balanceAfter and be composed in the reader's language.
-- The transient keys the triggers pass for the math (splits, prevSplits,
-- prevPaidBy) are stripped from what is stored.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fan_out_group_notification(
  p_group_id    text,
  p_actor       uuid,
  p_event_type  text,
  p_entity_type text,
  p_entity_id   text,
  p_template    text,
  p_params      jsonb,
  p_recipients  uuid[] default null,
  p_event_summary text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c_max_per_minute constant integer := 120;
  c_max_recipients constant integer := 100;

  v_group      public.split_groups%rowtype;
  v_actor_name text;
  v_calc       jsonb;   -- raw params incl. the transient math keys
  v_params     jsonb;   -- what is stored / fed to the feed
  v_title      text;
  v_body       text;
  v_event_id   text := gen_random_uuid()::text;
  v_recent     integer := 0;
  v_sent       integer := 0;
  r            record;
  v_rparams    jsonb;
  v_lang       text;
  v_rtitle     text;
  v_rbody      text;
begin
  select * into v_group from public.split_groups where id = p_group_id;
  if v_group.id is null then
    return;
  end if;

  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user')
    into v_actor_name
    from public.profiles p
   where p.id = p_actor;

  select coalesce(nullif(trim(gm.display_name), ''), v_actor_name)
    into v_actor_name
    from public.group_members gm
   where gm.group_id = p_group_id
     and gm.profile_id = p_actor
   order by gm.created_at
   limit 1;

  v_calc := coalesce(p_params, '{}'::jsonb)
    || jsonb_build_object(
         'groupId',   p_group_id,
         'groupName', v_group.name,
         'currency',  v_group.currency,
         'actorName', coalesce(v_actor_name, 'A member')
       );
  v_params := v_calc - 'splits' - 'prevSplits' - 'prevPaidBy';

  -- The shared feed reads the English catalog sentence, as before.
  select t.title, t.body into v_title, v_body
    from public.group_notification_text(p_template, v_params) as t;

  insert into public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) values (
    v_event_id, p_group_id, p_actor, p_event_type, p_entity_type, p_entity_id,
    left(
      coalesce(
        replace(p_event_summary, '{actor}', coalesce(v_actor_name, 'A member')),
        v_body
      ),
      500
    ),
    v_params, now()
  );

  if p_actor is not null then
    select count(*) into v_recent
      from public.notifications n
     where n.actor_id = p_actor
       and n.created_at > now() - interval '1 minute';
    if v_recent >= c_max_per_minute then
      return;
    end if;
  end if;

  for r in
    select distinct gm.profile_id
      from public.group_members gm
     where gm.group_id = p_group_id
       and gm.status = 'connected'
       and gm.profile_id is not null
       and gm.profile_id is distinct from p_actor
       and (p_recipients is null or gm.profile_id = any (p_recipients))
       and not public.is_blocked_either_way(p_actor, gm.profile_id)
       and not public.notification_muted(gm.profile_id, p_group_id)
  loop
    exit when v_sent >= c_max_recipients;
    v_sent := v_sent + 1;

    -- Per-reader facts + language. Each guarded: a reader we cannot compute
    -- for still gets the plain sentence (and never blocks the money write).
    begin
      v_rparams := v_params || public._group_reader_balance(p_group_id, r.profile_id, p_template, v_calc);
      v_lang    := public._notify_lang(r.profile_id);
      select t.title, t.body into v_rtitle, v_rbody
        from public._group_notice_text(p_template, v_rparams, v_lang) as t;
    exception when others then
      v_rparams := v_params;
      v_rtitle  := v_title;
      v_rbody   := v_body;
    end;

    insert into public.notifications (
      id, user_id, group_id, event_id, type, title, body,
      template, params, actor_id, read_at, created_at
    ) values (
      gen_random_uuid()::text, r.profile_id, p_group_id, v_event_id,
      'group_update', left(coalesce(v_rtitle, v_title), 200), left(coalesce(v_rbody, v_body), 1000),
      p_template, v_rparams, p_actor, null, now()
    );
  end loop;
end;
$$;

comment on function public.fan_out_group_notification(text, uuid, text, text, text, text, jsonb, uuid[], text) is
  'Writes the durable group_events activity row plus one notification per other connected member, composed in the reader''s language with the reader''s own delta / balanceAfter (2026-10-17). Rate-limited per actor; blocked pairs and muters skipped; group_events filtered by neither.';

revoke all on function public.fan_out_group_notification(text, uuid, text, text, text, text, jsonb, uuid[], text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Group triggers — pass what the math needs
--   Same branches and change-detection as audit-p0-notifications §5; the
--   params gain splits / prevSplits / prevPaidBy (expenses) and fromMember /
--   toMember (settlements), and each function now swallows its own errors
--   (RULE 4 — the old bodies did not).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_group_expenses_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := coalesce(auth.uid(), new.user_id);
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null then
      return null;
    end if;
    perform public.fan_out_group_notification(
      new.group_id, v_actor, 'expense_added', 'group_expense', new.id,
      'expense_added',
      jsonb_build_object(
        'expenseId', new.id,
        'description', new.description,
        'amount', new.amount,
        'paidBy', new.paid_by,
        'splits', new.splits
      ),
      null::uuid[]
    );
    return null;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    perform public.fan_out_group_notification(
      new.group_id, coalesce(auth.uid(), new.deleted_by, new.user_id),
      'expense_deleted', 'group_expense', new.id,
      'expense_deleted',
      jsonb_build_object(
        'expenseId', new.id,
        'description', old.description,
        'amount', old.amount,
        'paidBy', old.paid_by,
        'prevPaidBy', old.paid_by,
        'prevSplits', old.splits
      ),
      null::uuid[]
    );
    return null;
  end if;

  if new.deleted_at is not null then
    return null;
  end if;

  if new.description is distinct from old.description
     or new.amount     is distinct from old.amount
     or new.paid_by    is distinct from old.paid_by
     or new.splits     is distinct from old.splits
     or new.split_type is distinct from old.split_type
     or new.category   is distinct from old.category then
    perform public.fan_out_group_notification(
      new.group_id, coalesce(auth.uid(), new.updated_by, new.user_id),
      'expense_updated', 'group_expense', new.id,
      'expense_updated',
      jsonb_build_object(
        'expenseId', new.id,
        'description', old.description,
        'amount', new.amount,
        'paidBy', new.paid_by,
        'splits', new.splits,
        'prevPaidBy', old.paid_by,
        'prevSplits', old.splits
      ),
      null::uuid[]
    );
  end if;

  return null;
exception when others then
  raise warning 'group expense notify skipped: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists group_expenses_notify on public.group_expenses;
create trigger group_expenses_notify
  after insert or update on public.group_expenses
  for each row execute function public.tg_group_expenses_notify();

create or replace function public.tg_group_settlements_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_from  text;
  v_to    text;
begin
  select coalesce(nullif(trim(gm.display_name), ''), 'Someone') into v_from
    from public.group_members gm where gm.id = new.from_member;
  select coalesce(nullif(trim(gm.display_name), ''), 'someone') into v_to
    from public.group_members gm where gm.id = new.to_member;

  if tg_op = 'INSERT' then
    if new.deleted_at is not null then
      return null;
    end if;
    v_actor := coalesce(auth.uid(), new.created_by, new.user_id);
    perform public.fan_out_group_notification(
      new.group_id, v_actor, 'settlement_added', 'group_settlement', new.id,
      'settlement_added',
      jsonb_build_object(
        'settlementId', new.id,
        'fromName', coalesce(v_from, 'Someone'),
        'toName', coalesce(v_to, 'someone'),
        'fromMember', new.from_member,
        'toMember', new.to_member,
        'amount', new.amount
      ),
      null::uuid[]
    );
    return null;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    v_actor := coalesce(auth.uid(), new.deleted_by, new.user_id);
    perform public.fan_out_group_notification(
      new.group_id, v_actor, 'settlement_deleted', 'group_settlement', new.id,
      'settlement_deleted',
      jsonb_build_object(
        'settlementId', new.id,
        'fromName', coalesce(v_from, 'Someone'),
        'toName', coalesce(v_to, 'someone'),
        'fromMember', old.from_member,
        'toMember', old.to_member,
        'amount', old.amount
      ),
      null::uuid[]
    );
  end if;

  return null;
exception when others then
  raise warning 'group settlement notify skipped: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists group_settlements_notify on public.group_settlements;
create trigger group_settlements_notify
  after insert or update on public.group_settlements
  for each row execute function public.tg_group_settlements_notify();

revoke all on function public.tg_group_expenses_notify() from public, anon, authenticated;
revoke all on function public.tg_group_settlements_notify() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Linked notices — signed delta, ▲/▼ mark, batch collapse
--   Bodies are the notify-balance-after bodies with the glyph after the
--   "Now:" / "If you accept:" label. `delta` is the reader's signed move
--   (for a request: the move IF they accept). A `${intentId}:${loanId}` id
--   (a lump repayment fanned across loans) collapses the tray per intent.
-- ═══════════════════════════════════════════════════════════════════════════

-- "Now: ▼ You owe Abdullah AED 700.00" — label + glyph + phrase.
create or replace function public._notify_now_phrase(
  p_lang     text,
  p_label    text,     -- 'now' | 'if_accepted' | 'if_confirmed' | 'still'
  p_delta    numeric,
  p_net      numeric,
  p_currency text,
  p_other    text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_label
           when 'now'          then case when p_lang = 'en' then 'Now: '            else 'Ab: ' end
           when 'if_accepted'  then case when p_lang = 'en' then 'If you accept: '  else 'Accept karne par: ' end
           when 'if_confirmed' then case when p_lang = 'en' then 'If you confirm: ' else 'Tasdeeq karne par: ' end
           else                     case when p_lang = 'en' then 'Still: '          else 'Ab bhi: ' end
         end
      || case when public._notify_move_glyph(p_delta) = '' then '' else public._notify_move_glyph(p_delta) || ' ' end
      || public._notify_balance_phrase(p_lang, p_net, p_currency, p_other);
$$;

-- Tray collapse key for a linked settlement row: one per lump repayment.
create or replace function public._lsr_collapse_key(p_request_id text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when position(':' in coalesce(p_request_id, '')) > 1
              then 'linked_settlement:batch:' || split_part(p_request_id, ':', 1)
              else null end;
$$;

revoke all on function public._notify_now_phrase(text, text, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function public._lsr_collapse_key(text) from public, anon, authenticated;

create or replace function public.tg_ltr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name      text;
  v_lang      text;
  v_amount    text;
  v_now       numeric;
  v_after     numeric;
  v_delta     numeric;
  v_kind      text;
  v_title     text;
  v_body      text;
  v_template  text;
begin
  v_amount := public._notify_money_text(new.currency, new.amount);

  if tg_op = 'INSERT' then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    v_lang := public._notify_lang(new.to_user_id);
    v_kind  := case when new.kind = 'lent' then 'borrowed' else 'lent' end;
    v_now   := public._pair_net_balance(new.to_user_id, new.from_user_id, new.currency);
    v_delta := case when v_kind = 'borrowed' then -new.amount else new.amount end;
    v_after := v_now + v_delta;

    if v_lang = 'en' then
      v_title := 'New shared loan to review';
      v_body  := v_name || ' recorded ' || v_amount
              || case when v_kind = 'borrowed' then ' that you borrowed' else ' that you lent' end
              || '. ' || public._notify_now_phrase('en', 'if_accepted', v_delta, v_after, new.currency, v_name)
              || '. Open Inbox to confirm.';
    else
      v_title := 'Naya qarz — tasdeeq karein';
      v_body  := v_name || ' ne ' || v_amount
              || case when v_kind = 'borrowed' then ' likha jo aap ne udhaar liya' else ' likha jo aap ne udhaar diya' end
              || '. ' || public._notify_now_phrase('ur', 'if_accepted', v_delta, v_after, new.currency, v_name)
              || '. Inbox mein tasdeeq karein.';
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_request',
      left(v_title, 200), left(v_body, 1000), 'ltr_request',
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'kind', v_kind, 'requestId', new.id,
                         'balanceNow', v_now, 'balanceAfter', v_after, 'delta', v_delta),
      now()
    );

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    v_lang := public._notify_lang(new.from_user_id);
    v_after    := public._pair_net_balance(new.from_user_id, new.to_user_id, new.currency);
    -- The sender's own side: they lent ⇒ owed more (+); they borrowed ⇒ owe more (−).
    v_delta    := case when new.status = 'accepted'
                       then case when new.kind = 'lent' then new.amount else -new.amount end
                       else 0 end;
    v_template := case when new.status = 'accepted' then 'ltr_accepted' else 'ltr_rejected' end;

    if v_lang = 'en' then
      if new.status = 'accepted' then
        v_title := 'Shared loan confirmed';
        v_body  := v_name || ' confirmed the shared loan of ' || v_amount || '. '
                || public._notify_now_phrase('en', 'now', v_delta, v_after, new.currency, v_name) || '.';
      else
        v_title := 'Shared loan declined';
        v_body  := v_name || ' declined the shared loan of ' || v_amount || ' — it was not added. '
                || public._notify_now_phrase('en', 'still', 0, v_after, new.currency, v_name) || '.';
      end if;
    else
      if new.status = 'accepted' then
        v_title := 'Qarz tasdeeq ho gaya';
        v_body  := v_name || ' ne ' || v_amount || ' ka qarz tasdeeq kar diya. '
                || public._notify_now_phrase('ur', 'now', v_delta, v_after, new.currency, v_name) || '.';
      else
        v_title := 'Qarz radd ho gaya';
        v_body  := v_name || ' ne ' || v_amount || ' ka qarz radd kar diya — total mein shamil nahi hua. '
                || public._notify_now_phrase('ur', 'still', 0, v_after, new.currency, v_name) || '.';
      end if;
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_request',
      left(v_title, 200), left(v_body, 1000), v_template,
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceAfter', v_after, 'delta', v_delta),
      now()
    );
  end if;
  return null;
exception when others then
  raise warning 'ltr notify skipped: %', sqlerrm;
  return null;
end $$;

drop trigger if exists ltr_notify on public.linked_transaction_requests;
create trigger ltr_notify
  after insert or update on public.linked_transaction_requests
  for each row execute function public.tg_ltr_notify();

create or replace function public._lsr_notify_info(
  p_req public.linked_settlement_requests,
  p_template text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor  text;
  v_lang   text;
  v_amount text := public._notify_money_text(p_req.currency, p_req.amount);
  v_after  numeric;
  v_delta  numeric;
  v_type   text;
  v_phrase text;
  v_title  text;
  v_body   text;
  v_batch  text := public._lsr_collapse_key(p_req.id);
begin
  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_actor
    from public.profiles p where p.id = p_req.from_user_id;
  v_actor := coalesce(v_actor, 'A Hisaab user');
  v_lang  := public._notify_lang(p_req.to_user_id);
  v_after := public._pair_net_balance(p_req.to_user_id, p_req.from_user_id, p_req.currency);
  -- The payer's (reader's) loan: a repayment on a 'taken' loan lifts what
  -- they owe (+); on a 'given' loan it lowers what they are owed (−).
  select l.type into v_type from public.loans l where l.id = p_req.responder_loan_id;
  v_delta := case when v_type = 'given' then -p_req.amount else p_req.amount end
           * case when p_template = 'lsr_undone' then -1 else 1 end;
  v_phrase := public._notify_now_phrase(v_lang, 'now', v_delta, v_after, p_req.currency, v_actor);

  if p_template = 'lsr_recorded' then
    if v_lang = 'en' then
      v_title := 'Repayment recorded';
      v_body  := v_actor || ' recorded your repayment of ' || v_amount || '. Nothing to confirm. ' || v_phrase || '.';
    else
      v_title := 'Repayment record ho gayi';
      v_body  := v_actor || ' ne aap ki ' || v_amount || ' ki repayment record kar di. Kuch confirm nahi karna. ' || v_phrase || '.';
    end if;
  else
    if v_lang = 'en' then
      v_title := 'Repayment removed';
      v_body  := v_actor || ' removed the repayment of ' || v_amount || ' they had recorded. ' || v_phrase || '.';
    else
      v_title := 'Repayment hata di gayi';
      v_body  := v_actor || ' ne ' || v_amount || ' ki record ki hui repayment hata di. ' || v_phrase || '.';
    end if;
  end if;
  if v_batch is not null then
    v_body := v_body || case when v_lang = 'en' then ' Part of one repayment across your loans.'
                             else ' Aik hi wapsi, aap ke kai qarzon par.' end;
  end if;

  insert into public.notifications(
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, channel_id, href, collapse_key, created_at
  ) values (
    gen_random_uuid()::text, p_req.to_user_id, null, null, 'linked_info',
    left(v_title, 200), left(v_body, 1000),
    p_template,
    jsonb_build_object('actorName', v_actor, 'amount', p_req.amount,
                       'currency', p_req.currency, 'requestId', p_req.id,
                       'balanceAfter', v_after, 'delta', v_delta)
      || case when v_batch is null then '{}'::jsonb
              else jsonb_build_object('batchId', split_part(p_req.id, ':', 1)) end,
    -- linked_info rows DO carry the actor (settlement-receiver-records §3,
    -- pinned by the 8s DB test); only linked_request / linked_settlement stay NULL.
    p_req.from_user_id, 'money', '/inbox', v_batch, now()
  );
exception when others then
  raise warning 'lsr notify (%) skipped: %', p_template, sqlerrm;
end $$;

revoke all on function public._lsr_notify_info(public.linked_settlement_requests, text) from public, anon, authenticated;

create or replace function public.tg_lsr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name     text;
  v_lang     text;
  v_amount   text;
  v_now      numeric;
  v_after    numeric;
  v_delta    numeric;
  v_type     text;
  v_title    text;
  v_body     text;
  v_template text;
  v_batch    text := public._lsr_collapse_key(new.id);
begin
  v_amount := public._notify_money_text(new.currency, new.amount);

  if tg_op = 'INSERT' then
    if coalesce(current_setting('hisaab.lsr_quiet_insert', true), '') = new.id then
      return null;
    end if;
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    v_lang := public._notify_lang(new.to_user_id);
    select l.type into v_type from public.loans l where l.id = new.responder_loan_id;
    v_now   := public._pair_net_balance(new.to_user_id, new.from_user_id, new.currency);
    v_delta := case when v_type = 'taken' then new.amount else -new.amount end;
    v_after := v_now + v_delta;

    if v_lang = 'en' then
      v_title := 'Repayment to confirm';
      v_body  := v_name || ' recorded a repayment of ' || v_amount || '. '
              || public._notify_now_phrase('en', 'if_confirmed', v_delta, v_after, new.currency, v_name)
              || '. Open Inbox to confirm.';
    else
      v_title := 'Wapsi — tasdeeq karein';
      v_body  := v_name || ' ne ' || v_amount || ' wapas dene ki entry ki. '
              || public._notify_now_phrase('ur', 'if_confirmed', v_delta, v_after, new.currency, v_name)
              || '. Inbox mein dekhein.';
    end if;
    if v_batch is not null then
      v_body := v_body || case when v_lang = 'en' then ' Part of one repayment across your loans.'
                               else ' Aik hi wapsi, aap ke kai qarzon par.' end;
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, collapse_key, created_at
    ) values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_settlement',
      left(v_title, 200), left(v_body, 1000), 'lsr_request',
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceNow', v_now, 'balanceAfter', v_after, 'delta', v_delta)
        || case when v_batch is null then '{}'::jsonb
                else jsonb_build_object('batchId', split_part(new.id, ':', 1)) end,
      v_batch, now()
    );

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status = 'accepted'
        and new.recorded_by_receiver then
    perform public._lsr_notify_info(new, 'lsr_recorded');

  elsif tg_op = 'UPDATE'
        and old.status = 'accepted'
        and new.status = 'cancelled'
        and new.undone_at is not null then
    perform public._lsr_notify_info(new, 'lsr_undone');

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    v_lang := public._notify_lang(new.from_user_id);
    v_after    := public._pair_net_balance(new.from_user_id, new.to_user_id, new.currency);
    -- The requester's (reader's) own loan moved toward zero.
    select l.type into v_type from public.loans l where l.id = new.requester_loan_id;
    v_delta    := case when new.status = 'accepted'
                       then case when v_type = 'taken' then new.amount else -new.amount end
                       else 0 end;
    v_template := case when new.status = 'accepted' then 'lsr_accepted' else 'lsr_rejected' end;

    if v_lang = 'en' then
      if new.status = 'accepted' then
        v_title := 'Repayment confirmed';
        v_body  := v_name || ' confirmed the repayment of ' || v_amount || '. '
                || public._notify_now_phrase('en', 'now', v_delta, v_after, new.currency, v_name) || '.';
      else
        v_title := 'Repayment declined';
        v_body  := v_name || ' declined the repayment of ' || v_amount || '. '
                || public._notify_now_phrase('en', 'still', 0, v_after, new.currency, v_name) || '.';
      end if;
    else
      if new.status = 'accepted' then
        v_title := 'Wapsi tasdeeq ho gayi';
        v_body  := v_name || ' ne ' || v_amount || ' ki wapsi tasdeeq kar di. '
                || public._notify_now_phrase('ur', 'now', v_delta, v_after, new.currency, v_name) || '.';
      else
        v_title := 'Wapsi radd ho gayi';
        v_body  := v_name || ' ne ' || v_amount || ' ki wapsi radd kar di. '
                || public._notify_now_phrase('ur', 'still', 0, v_after, new.currency, v_name) || '.';
      end if;
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, collapse_key, created_at
    ) values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_settlement',
      left(v_title, 200), left(v_body, 1000), v_template,
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceAfter', v_after, 'delta', v_delta)
        || case when v_batch is null then '{}'::jsonb
                else jsonb_build_object('batchId', split_part(new.id, ':', 1)) end,
      v_batch, now()
    );
  end if;
  return null;
exception when others then
  raise warning 'lsr notify skipped: %', sqlerrm;
  return null;
end $$;

drop trigger if exists lsr_notify on public.linked_settlement_requests;
create trigger lsr_notify
  after insert or update on public.linked_settlement_requests
  for each row execute function public.tg_lsr_notify();

revoke all on function public.tg_ltr_notify() from public, anon, authenticated;
revoke all on function public.tg_lsr_notify() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Kameti — the member hears their contribution / payout
--
-- committee_payments is organiser-only (RLS), so the organiser writes the
-- row and the LINKED member (committee_members.person_id → persons →
-- linked_profile_id, the organiser's own contact list) is told. Same reach
-- rule, block and mute checks as notify_committee_members. type 'kameti' so
-- the existing channel / href / collapse stamping applies.
--   kameti_contribution_recorded  INSERT on committee_payments   (▼ paid in)
--   kameti_contribution_removed   DELETE on committee_payments   (▲ given back)
--   kameti_payout_recorded        payout_received_at NULL → set   (▲ received)
-- The position line is the member's own: rounds paid of total, amount in.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._kameti_member_notice(
  p_committee_id text,
  p_member_id    text,
  p_template     text,
  p_round        integer,
  p_amount       numeric,   -- the event's amount (contribution or pool)
  p_delta        numeric    -- signed, from the member's side
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c          public.committees%rowtype;
  v_m          public.committee_members%rowtype;
  v_profile    uuid;
  v_lang       text;
  v_paid       integer;
  v_paid_total numeric;
  v_money      text;
  v_pos        text;
  v_title      text;
  v_body       text;
begin
  select * into v_c from public.committees where id = p_committee_id;
  select * into v_m from public.committee_members where id = p_member_id;
  if v_c.id is null or v_m.id is null or v_m.person_id is null then
    return;
  end if;
  select pr.linked_profile_id into v_profile
    from public.persons pr
   where pr.id = v_m.person_id and pr.user_id = v_c.user_id;
  if v_profile is null or v_profile = v_c.user_id then
    return;
  end if;
  if public.is_blocked_either_way(v_c.user_id, v_profile)
     or public.notification_muted(v_profile, null) then
    return;
  end if;

  select count(*) into v_paid from public.committee_payments p where p.member_id = v_m.id;
  v_paid_total := round(v_paid * v_c.contribution_amount, 2);
  v_lang  := public._notify_lang(v_profile);
  v_money := public._notify_money_text(v_c.currency, p_amount);

  if v_lang = 'en' then
    v_pos := 'Paid ' || v_paid || ' of ' || v_c.total_rounds || ' rounds · '
          || public._notify_money_text(v_c.currency, v_paid_total) || ' in so far.';
    if p_template = 'kameti_contribution_recorded' then
      v_title := 'Contribution recorded — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▼ marked paid by the organiser. ' || v_pos;
    elsif p_template = 'kameti_contribution_removed' then
      v_title := 'Contribution removed — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▲ was un-marked by the organiser. ' || v_pos;
    else
      v_title := 'Payout recorded — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▲ marked as received by you. ' || v_pos;
    end if;
  else
    v_pos := v_c.total_rounds || ' mein se ' || v_paid || ' round ada · ab tak '
          || public._notify_money_text(v_c.currency, v_paid_total) || ' jama.';
    if p_template = 'kameti_contribution_recorded' then
      v_title := 'Qisht record ho gayi — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▼ organiser ne paid likha. ' || v_pos;
    elsif p_template = 'kameti_contribution_removed' then
      v_title := 'Qisht hata di gayi — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▲ organiser ne hata di. ' || v_pos;
    else
      v_title := 'Payout record ho gaya — ' || v_c.name;
      v_body  := 'Round ' || coalesce(p_round, 0) || ': ' || v_money || ' ▲ aap ko mil gaya, organiser ne likha. ' || v_pos;
    end if;
  end if;

  insert into public.notifications (
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, read_at, created_at
  ) values (
    gen_random_uuid()::text, v_profile, null, null,
    'kameti', left(v_title, 200), left(v_body, 1000),
    p_template,
    jsonb_build_object(
      'committeeId',   v_c.id,
      'committeeName', v_c.name,
      'currency',      v_c.currency,
      'amount',        p_amount,
      'round',         p_round,
      'slot',          v_m.slot,
      'memberName',    v_m.name,
      'paidRounds',    v_paid,
      'totalRounds',   v_c.total_rounds,
      'paidTotal',     v_paid_total,
      'delta',         p_delta,
      'balanceScope',  'kameti'
    ),
    v_c.user_id, null, now()
  );
exception when others then
  -- The payment / payout row is the record; never block it.
  raise warning 'kameti notice (%) skipped: %', p_template, sqlerrm;
end $$;

create or replace function public.tg_committee_payments_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric;
begin
  if tg_op = 'INSERT' then
    select c.contribution_amount into v_amount from public.committees c where c.id = new.committee_id;
    perform public._kameti_member_notice(new.committee_id, new.member_id,
      'kameti_contribution_recorded', new.round, v_amount, -coalesce(v_amount, 0));
  elsif tg_op = 'DELETE' then
    select c.contribution_amount into v_amount from public.committees c where c.id = old.committee_id;
    perform public._kameti_member_notice(old.committee_id, old.member_id,
      'kameti_contribution_removed', old.round, v_amount, coalesce(v_amount, 0));
  end if;
  return null;
exception when others then
  return null;
end $$;

drop trigger if exists committee_payments_notify on public.committee_payments;
create trigger committee_payments_notify
  after insert or delete on public.committee_payments
  for each row execute function public.tg_committee_payments_notify();

create or replace function public.tg_committee_members_payout_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pool numeric;
begin
  if old.payout_received_at is null and new.payout_received_at is not null then
    select round(c.contribution_amount * c.member_count, 2) into v_pool
      from public.committees c where c.id = new.committee_id;
    perform public._kameti_member_notice(new.committee_id, new.id,
      'kameti_payout_recorded', new.slot, v_pool, coalesce(v_pool, 0));
  end if;
  return null;
exception when others then
  return null;
end $$;

drop trigger if exists committee_members_payout_notify on public.committee_members;
create trigger committee_members_payout_notify
  after update on public.committee_members
  for each row execute function public.tg_committee_members_payout_notify();

revoke all on function public._kameti_member_notice(text, text, text, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.tg_committee_payments_notify() from public, anon, authenticated;
revoke all on function public.tg_committee_members_payout_notify() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. Self-check — any failure rolls the whole file back
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_src   text;
  v_title text;
  v_body  text;
  v_fn    text;
begin
  -- 1. The pair math agrees with computePairwiseDebts on its own fixture:
  --    A pays 60 split A 30 / B 30 ⇒ B owes A 30; a 30 settlement B→A clears it.
  if public._group_expense_effect('A', '[{"memberId":"A","amount":30},{"memberId":"B","amount":30}]'::jsonb,
                                  array['B'], array['A']) <> -30 then
    raise exception 'notify-direction: expense effect (debtor) is %',
      public._group_expense_effect('A', '[{"memberId":"A","amount":30},{"memberId":"B","amount":30}]'::jsonb, array['B'], array['A']);
  end if;
  if public._group_expense_effect('A', '[{"memberId":"A","amount":30},{"memberId":"B","amount":30}]'::jsonb,
                                  array['A'], null) <> 30 then
    raise exception 'notify-direction: expense effect (payer, group scope) is wrong';
  end if;
  if public._group_settlement_effect('B', 'A', 30, array['B'], array['A']) <> 30
     or public._group_settlement_effect('B', 'A', 30, array['A'], array['B']) <> -30
     or public._group_settlement_effect('B', 'A', 30, array['C'], null) <> 0 then
    raise exception 'notify-direction: settlement effect is wrong';
  end if;

  -- 2. Text.
  if public._group_move_phrase('en', 'expense_added', -50, 'AED') <> 'Your share: AED 50.00 ▼.' then
    raise exception 'notify-direction: move phrase is %', public._group_move_phrase('en', 'expense_added', -50, 'AED');
  end if;
  if public._group_balance_phrase('ur', 'pair', -120, 'AED', 'Ali', 'Flat 12')
     <> 'Ab Flat 12 mein: Aap ne Ali ko AED 120.00 dene hain.' then
    raise exception 'notify-direction: balance phrase (ur) is %',
      public._group_balance_phrase('ur', 'pair', -120, 'AED', 'Ali', 'Flat 12');
  end if;
  select t.title, t.body into v_title, v_body
    from public._group_notice_text('expense_added',
      '{"actorName":"Ali","groupName":"Flat 12","description":"Dinner","amount":150,"currency":"AED","delta":-50,"balanceAfter":-120,"balanceScope":"pair","counterpartyName":"Ali"}'::jsonb,
      'en') t;
  if v_title <> 'Ali added an expense'
     or v_body <> 'Dinner for AED 150.00 was added in Flat 12. Your share: AED 50.00 ▼. Now in Flat 12: You owe Ali AED 120.00.' then
    raise exception 'notify-direction: composed body is %', v_body;
  end if;
  -- A row without the balance facts keeps the catalog sentence exactly.
  select t.body into v_body
    from public._group_notice_text('expense_added',
      '{"actorName":"Ali","groupName":"Flat 12","description":"Dinner","amount":150,"currency":"AED"}'::jsonb, 'en') t;
  if v_body <> 'Dinner for AED 150.00 was added in Flat 12.' then
    raise exception 'notify-direction: plain body drifted: %', v_body;
  end if;
  if public._notify_now_phrase('en', 'now', -300, -700, 'AED', 'Abdullah') <> 'Now: ▼ You owe Abdullah AED 700.00' then
    raise exception 'notify-direction: now phrase is %', public._notify_now_phrase('en', 'now', -300, -700, 'AED', 'Abdullah');
  end if;
  if public._lsr_collapse_key('intent-1:loan-9') <> 'linked_settlement:batch:intent-1'
     or public._lsr_collapse_key('plain-id') is not null then
    raise exception 'notify-direction: batch collapse key is wrong';
  end if;

  -- 3. The replaced functions carry their new branches.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fan_out_group_notification';
  if v_src is null or v_src not like '%_group_reader_balance%' or v_src not like '%is_blocked_either_way%'
     or v_src not like '%notification_muted%' or v_src not like '%c_max_per_minute%' then
    raise exception 'notify-direction: fan_out_group_notification lost a filter';
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_lsr_notify';
  if v_src is null or v_src not like '%lsr_quiet_insert%' or v_src not like '%lsr_recorded%'
     or v_src not like '%lsr_undone%' or v_src not like '%_lsr_collapse_key%' then
    raise exception 'notify-direction: tg_lsr_notify lost a branch';
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_ltr_notify';
  if v_src is null or v_src not like '%''delta''%' then
    raise exception 'notify-direction: tg_ltr_notify carries no delta';
  end if;

  -- 4. Nothing new is client-executable.
  for v_fn in
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('_notify_move_glyph', '_notify_lang', '_group_split_sum', '_group_expense_effect',
                         '_group_settlement_effect', '_group_member_ids', '_group_member_set', '_group_net',
                         '_group_reader_balance', '_group_move_phrase', '_group_balance_phrase',
                         '_group_notice_text', '_notify_now_phrase', '_lsr_collapse_key',
                         '_kameti_member_notice', 'fan_out_group_notification')
       and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE'))
  loop
    raise exception 'notify-direction: % is client-executable', v_fn;
  end loop;

  if not exists (select 1 from pg_trigger where tgname = 'committee_payments_notify')
     or not exists (select 1 from pg_trigger where tgname = 'committee_members_payout_notify') then
    raise exception 'notify-direction: kameti triggers missing';
  end if;
end $$;
