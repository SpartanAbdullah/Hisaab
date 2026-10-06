-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — linked money notices say where the total stands (2026-10-06)
-- ----------------------------------------------------------------------------
-- The Ghulam exercise: a linked user could not follow how his total with a
-- contact moved, and the notices that should have told him were English-only
-- server text with no total at all ("Abdullah wants to record AED 13.00 with
-- you"). After this file every linked money notice:
--
--   • is composed in the RECIPIENT's language (profiles.lang, default 'ur' —
--     the same rule _lsr_notify_info already follows) — the push tray shows
--     this text verbatim;
--   • carries `template` + structured `params` so the in-app card re-renders
--     it in whatever language the reader has now (notificationContent.ts);
--   • states the reader's net with the other person: "Now: …" after a change,
--     "If you accept: …" on something waiting for them. `balanceAfter` in
--     params is the reader's signed net in that currency (positive ⇒ the other
--     person owes the reader) — computed from the reader's OWN loans, so a
--     pending request is never counted until accepted.
--
-- Replaces (latest definitions):
--   tg_ltr_notify     — supabase-migration-linked-notifications-realtime.sql
--   tg_lsr_notify     — supabase-migration-settlement-receiver-records.sql §5
--   _lsr_notify_info  — supabase-migration-settlement-receiver-records.sql §3
-- Adds three internal helpers: _pair_net_balance, _notify_money_text,
-- _notify_balance_phrase (security definer / immutable, revoked from clients).
--
-- Unchanged on purpose:
--   • notification TYPES ('linked_request' / 'linked_settlement' /
--     'linked_info') — bell counting (notificationCounts.ts) and channel /
--     href / collapse stamping (tg_notifications_defaults) key on them;
--   • every English TITLE the old triggers wrote (the 8s DB test pins
--     'Repayment recorded'; the client recognises the rest);
--   • tg_lsr_notify's three branches [R1] quiet insert, [R2] recorded,
--     [R3] undone — only their text gains the balance.
--   • RULE 4 (p2-notification-maturity): a notice is never worth rolling back
--     money — every notify path swallows its own errors.
--   • actor_id stays NULL on linked_request / linked_settlement rows, as
--     before: the group fan-out rate limit (fan_out_group_notification) counts a
--     sender's rows by actor_id, and fifteen loan requests sent in one sitting
--     must not silence that person's group notifications for a minute.
--
-- Safe to re-run (create or replace). Apply in Supabase Studio, then re-run
-- supabase-migration-p3-rpc-execute-grants.sql (the least-privilege sweep).
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- The owner's signed net with a linked counterparty in one currency, from the
-- owner's own loans: given +, taken −. Same sign rule as the app's statement
-- (statementOfAccount.ts) and ContactDetailSheet's balance card.
create or replace function public._pair_net_balance(
  p_owner uuid,
  p_counterparty uuid,
  p_currency text
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(case when l.type = 'given' then l.remaining_amount
                                 else -l.remaining_amount end), 2), 0)
    from public.loans l
    join public.persons p
      on p.id = l.person_id
     and p.user_id = l.user_id
   where l.user_id = p_owner
     and p.linked_profile_id = p_counterparty
     and l.currency = p_currency
     and l.deleted_at is null;
$$;

-- "AED 5,225.01" — unsigned, grouped, 2dp (the push text; the in-app card
-- re-formats from params with the currency's own minor units).
create or replace function public._notify_money_text(p_currency text, p_amount numeric)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(p_currency, '') || ' ' || trim(to_char(abs(coalesce(p_amount, 0)), 'FM999,999,999,990.00'));
$$;

-- The reader's net with `p_other`, in the statement's own words
-- (i18n stmt_net_owes_you / stmt_net_you_owe / stmt_net_settled).
create or replace function public._notify_balance_phrase(
  p_lang text,
  p_net numeric,
  p_currency text,
  p_other text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when abs(coalesce(p_net, 0)) < 0.005 then
      case when p_lang = 'en' then 'Settled up with ' || p_other
           else p_other || ' ke saath hisaab barabar' end
    when p_net > 0 then
      case when p_lang = 'en' then p_other || ' owes you ' || public._notify_money_text(p_currency, p_net)
           else p_other || ' ne aap ko ' || public._notify_money_text(p_currency, p_net) || ' dene hain' end
    else
      case when p_lang = 'en' then 'You owe ' || p_other || ' ' || public._notify_money_text(p_currency, p_net)
           else 'Aap ne ' || p_other || ' ko ' || public._notify_money_text(p_currency, p_net) || ' dene hain' end
  end;
$$;

revoke all on function public._pair_net_balance(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public._notify_money_text(text, numeric) from public, anon, authenticated;
revoke all on function public._notify_balance_phrase(text, numeric, text, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. tg_ltr_notify — shared loan requests
--   INSERT                     → the receiver: what it is + total if accepted
--   pending → accepted/rejected → the sender: the outcome + total now
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_ltr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name      text;
  v_lang      text;
  v_amount    text;
  v_now       numeric;
  v_after     numeric;
  v_kind      text;   -- the READER's side: 'borrowed' | 'lent'
  v_title     text;
  v_body      text;
  v_template  text;
begin
  v_amount := public._notify_money_text(new.currency, new.amount);

  if tg_op = 'INSERT' then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    select coalesce(p.lang, 'ur') into v_lang
      from public.profiles p where p.id = new.to_user_id;
    v_lang := coalesce(v_lang, 'ur');
    -- `kind` is the sender's side: they lent ⇒ the reader borrowed (−).
    v_kind  := case when new.kind = 'lent' then 'borrowed' else 'lent' end;
    v_now   := public._pair_net_balance(new.to_user_id, new.from_user_id, new.currency);
    v_after := v_now + case when v_kind = 'borrowed' then -new.amount else new.amount end;

    if v_lang = 'en' then
      v_title := 'New shared loan to review';
      v_body  := v_name || ' recorded ' || v_amount
              || case when v_kind = 'borrowed' then ' that you borrowed' else ' that you lent' end
              || '. If you accept: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name)
              || '. Open Inbox to confirm.';
    else
      v_title := 'Naya qarz — tasdeeq karein';
      v_body  := v_name || ' ne ' || v_amount
              || case when v_kind = 'borrowed' then ' likha jo aap ne udhaar liya' else ' likha jo aap ne udhaar diya' end
              || '. Accept karne par: ' || public._notify_balance_phrase('ur', v_after, new.currency, v_name)
              || '. Inbox mein tasdeeq karein.';
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_request',
      left(v_title, 200), left(v_body, 1000), 'ltr_request',
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'kind', v_kind, 'requestId', new.id,
                         'balanceNow', v_now, 'balanceAfter', v_after),
      now()
    );

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    select coalesce(p.lang, 'ur') into v_lang
      from public.profiles p where p.id = new.from_user_id;
    v_lang := coalesce(v_lang, 'ur');
    -- accept_linked_request inserts both loans BEFORE it flips the status, so
    -- an accepted request is already in the sender's books here.
    v_after    := public._pair_net_balance(new.from_user_id, new.to_user_id, new.currency);
    v_template := case when new.status = 'accepted' then 'ltr_accepted' else 'ltr_rejected' end;

    if v_lang = 'en' then
      if new.status = 'accepted' then
        v_title := 'Shared loan confirmed';
        v_body  := v_name || ' confirmed the shared loan of ' || v_amount
                || '. Now: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name) || '.';
      else
        v_title := 'Shared loan declined';
        v_body  := v_name || ' declined the shared loan of ' || v_amount
                || ' — it was not added. Still: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name) || '.';
      end if;
    else
      if new.status = 'accepted' then
        v_title := 'Qarz tasdeeq ho gaya';
        v_body  := v_name || ' ne ' || v_amount || ' ka qarz tasdeeq kar diya. Ab: '
                || public._notify_balance_phrase('ur', v_after, new.currency, v_name) || '.';
      else
        v_title := 'Qarz radd ho gaya';
        v_body  := v_name || ' ne ' || v_amount || ' ka qarz radd kar diya — total mein shamil nahi hua. Ab bhi: '
                || public._notify_balance_phrase('ur', v_after, new.currency, v_name) || '.';
      end if;
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_request',
      left(v_title, 200), left(v_body, 1000), v_template,
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceAfter', v_after),
      now()
    );
  end if;
  return null;  -- AFTER trigger: return value ignored.
exception when others then
  -- RULE 4: the request row is the record; a notice must never block it.
  raise warning 'ltr notify skipped: %', sqlerrm;
  return null;
end $$;

drop trigger if exists ltr_notify on public.linked_transaction_requests;
create trigger ltr_notify
  after insert or update on public.linked_transaction_requests
  for each row execute function public.tg_ltr_notify();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. _lsr_notify_info — the payer's informational notice ([R2]/[R3])
--   Same contract as settlement-receiver-records §3; the body now ends with
--   where the payer's total stands ("Ab: …" / "Now: …").
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_phrase text;
  v_title  text;
  v_body   text;
begin
  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_actor
    from public.profiles p where p.id = p_req.from_user_id;
  select coalesce(p.lang, 'ur') into v_lang
    from public.profiles p where p.id = p_req.to_user_id;
  v_actor := coalesce(v_actor, 'A Hisaab user');
  v_lang  := coalesce(v_lang, 'ur');
  -- Both callers fire AFTER the pair was applied / reversed.
  v_after  := public._pair_net_balance(p_req.to_user_id, p_req.from_user_id, p_req.currency);
  v_phrase := public._notify_balance_phrase(v_lang, v_after, p_req.currency, v_actor);

  if p_template = 'lsr_recorded' then
    if v_lang = 'en' then
      v_title := 'Repayment recorded';
      v_body  := v_actor || ' recorded your repayment of ' || v_amount || '. Nothing to confirm. Now: ' || v_phrase || '.';
    else
      v_title := 'Repayment record ho gayi';
      v_body  := v_actor || ' ne aap ki ' || v_amount || ' ki repayment record kar di. Kuch confirm nahi karna. Ab: ' || v_phrase || '.';
    end if;
  else
    if v_lang = 'en' then
      v_title := 'Repayment removed';
      v_body  := v_actor || ' removed the repayment of ' || v_amount || ' they had recorded. Now: ' || v_phrase || '.';
    else
      v_title := 'Repayment hata di gayi';
      v_body  := v_actor || ' ne ' || v_amount || ' ki record ki hui repayment hata di. Ab: ' || v_phrase || '.';
    end if;
  end if;

  insert into public.notifications(
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, channel_id, href, created_at
  ) values (
    gen_random_uuid()::text, p_req.to_user_id, null, null, 'linked_info',
    left(v_title, 200), left(v_body, 1000),
    p_template,
    jsonb_build_object('actorName', v_actor, 'amount', p_req.amount,
                       'currency', p_req.currency, 'requestId', p_req.id,
                       'balanceAfter', v_after),
    p_req.from_user_id, 'money', '/inbox', now()
  );
exception when others then
  raise warning 'lsr notify (%) skipped: %', p_template, sqlerrm;
end $$;

revoke all on function public._lsr_notify_info(public.linked_settlement_requests, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. tg_lsr_notify — [R1] quiet insert, [R2] recorded, [R3] undone
--   (unchanged), plus the two original branches with text + balance:
--   INSERT                       → the other side: claim + total if confirmed
--   pending → accepted/rejected  → the requester: outcome + total now
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_lsr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name     text;
  v_lang     text;
  v_amount   text;
  v_now      numeric;
  v_after    numeric;
  v_type     text;
  v_title    text;
  v_body     text;
  v_template text;
begin
  v_amount := public._notify_money_text(new.currency, new.amount);

  if tg_op = 'INSERT' then
    -- [R1] record_received_repayment inserts, applies and flips the row to
    -- accepted in one transaction: "Repayment to confirm" would be false.
    if coalesce(current_setting('hisaab.lsr_quiet_insert', true), '') = new.id then
      return null;
    end if;
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    select coalesce(p.lang, 'ur') into v_lang
      from public.profiles p where p.id = new.to_user_id;
    v_lang := coalesce(v_lang, 'ur');
    -- A repayment moves the reader's balance toward zero: on the reader's
    -- 'given' loan what they're owed drops (−); on a 'taken' one what they owe
    -- drops (+).
    select l.type into v_type from public.loans l where l.id = new.responder_loan_id;
    v_now   := public._pair_net_balance(new.to_user_id, new.from_user_id, new.currency);
    v_after := v_now + case when v_type = 'taken' then new.amount else -new.amount end;

    if v_lang = 'en' then
      v_title := 'Repayment to confirm';
      v_body  := v_name || ' recorded a repayment of ' || v_amount
              || '. If you confirm: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name)
              || '. Open Inbox to confirm.';
    else
      v_title := 'Wapsi — tasdeeq karein';
      v_body  := v_name || ' ne ' || v_amount || ' wapas dene ki entry ki. Tasdeeq karne par: '
              || public._notify_balance_phrase('ur', v_after, new.currency, v_name)
              || '. Inbox mein dekhein.';
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_settlement',
      left(v_title, 200), left(v_body, 1000), 'lsr_request',
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceNow', v_now, 'balanceAfter', v_after),
      now()
    );

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status = 'accepted'
        and new.recorded_by_receiver then
    -- [R2] The receiver recorded it (or applied their own request): tell the
    -- payer; nobody has anything to confirm, so no "confirmed" notice either.
    perform public._lsr_notify_info(new, 'lsr_recorded');

  elsif tg_op = 'UPDATE'
        and old.status = 'accepted'
        and new.status = 'cancelled'
        and new.undone_at is not null then
    -- [R3] Undone within the window.
    perform public._lsr_notify_info(new, 'lsr_undone');

  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    v_name := coalesce(v_name, 'A Hisaab user');
    select coalesce(p.lang, 'ur') into v_lang
      from public.profiles p where p.id = new.from_user_id;
    v_lang := coalesce(v_lang, 'ur');
    -- accept_settlement_request moves both loans BEFORE it flips the status.
    v_after    := public._pair_net_balance(new.from_user_id, new.to_user_id, new.currency);
    v_template := case when new.status = 'accepted' then 'lsr_accepted' else 'lsr_rejected' end;

    if v_lang = 'en' then
      if new.status = 'accepted' then
        v_title := 'Repayment confirmed';
        v_body  := v_name || ' confirmed the repayment of ' || v_amount
                || '. Now: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name) || '.';
      else
        v_title := 'Repayment declined';
        v_body  := v_name || ' declined the repayment of ' || v_amount
                || '. Still: ' || public._notify_balance_phrase('en', v_after, new.currency, v_name) || '.';
      end if;
    else
      if new.status = 'accepted' then
        v_title := 'Wapsi tasdeeq ho gayi';
        v_body  := v_name || ' ne ' || v_amount || ' ki wapsi tasdeeq kar di. Ab: '
                || public._notify_balance_phrase('ur', v_after, new.currency, v_name) || '.';
      else
        v_title := 'Wapsi radd ho gayi';
        v_body  := v_name || ' ne ' || v_amount || ' ki wapsi radd kar di. Ab bhi: '
                || public._notify_balance_phrase('ur', v_after, new.currency, v_name) || '.';
      end if;
    end if;

    insert into public.notifications(
      id, user_id, group_id, event_id, type, title, body, template, params, created_at
    ) values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_settlement',
      left(v_title, 200), left(v_body, 1000), v_template,
      jsonb_build_object('actorName', v_name, 'amount', new.amount, 'currency', new.currency,
                         'requestId', new.id, 'balanceAfter', v_after),
      now()
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

-- Trigger functions are invoked by the trigger, never by a client.
revoke all on function public.tg_ltr_notify() from public, anon, authenticated;
revoke all on function public.tg_lsr_notify() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Self-check — any failure rolls the whole file back
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_src text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_ltr_notify';
  if v_src is null or v_src not like '%ltr_request%' or v_src not like '%_pair_net_balance%' then
    raise exception 'notify-balance-after: tg_ltr_notify was not replaced';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_lsr_notify';
  if v_src is null or v_src not like '%lsr_quiet_insert%' or v_src not like '%lsr_recorded%'
     or v_src not like '%lsr_undone%' or v_src not like '%lsr_request%' then
    raise exception 'notify-balance-after: tg_lsr_notify lost a branch';
  end if;

  if public._notify_balance_phrase('en', -5225.01, 'AED', 'Abdullah') <> 'You owe Abdullah AED 5,225.01' then
    raise exception 'notify-balance-after: balance phrase (en) is %',
      public._notify_balance_phrase('en', -5225.01, 'AED', 'Abdullah');
  end if;
  if public._notify_balance_phrase('ur', -5225.01, 'AED', 'Abdullah') <> 'Aap ne Abdullah ko AED 5,225.01 dene hain' then
    raise exception 'notify-balance-after: balance phrase (ur) is %',
      public._notify_balance_phrase('ur', -5225.01, 'AED', 'Abdullah');
  end if;

  if has_function_privilege('authenticated', 'public._pair_net_balance(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public._pair_net_balance(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'notify-balance-after: _pair_net_balance is client-executable';
  end if;
end $$;
