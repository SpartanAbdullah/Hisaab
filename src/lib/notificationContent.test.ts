import { describe, it, expect } from 'vitest';
import {
  notificationChannel,
  notificationCollapseKey,
  notificationHref,
  readAmount,
  renderNotificationContent,
} from './notificationContent';
import { tStatic, useI18nStore } from './i18n';
import type { I18nKey } from './i18n';

// Echo translator: proves which key was asked for, and that the placeholder
// substitution ran, without depending on the copy itself.
const echo = (key: I18nKey): string => `[${key}]`;

// Real catalog lookups — this is what catches a template key wired to an i18n
// key that doesn't exist (t() falls through and returns the key name).
// setState rather than setLang: setLang also kicks off a reminder reschedule
// (a dynamic import of the Capacitor bridge) that has no business running here.
const en = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'en' });
  return tStatic(key);
};
const ur = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'ur' });
  return tStatic(key);
};

describe('readAmount', () => {
  it('accepts JSON numbers and numeric strings, rejects anything else', () => {
    expect(readAmount({ amount: 250.5 })).toBe(250.5);
    expect(readAmount({ amount: '250.50' })).toBe(250.5);
    expect(readAmount({ amount: 0 })).toBe(0);
    expect(readAmount({})).toBeNull();
    expect(readAmount({ amount: null })).toBeNull();
    expect(readAmount({ amount: 'not a number' })).toBeNull();
    expect(readAmount({ amount: { a: 1 } })).toBeNull();
  });
});

describe('renderNotificationContent — fallback to server text', () => {
  it('uses the stored title/body when there is no template (legacy row)', () => {
    const out = renderNotificationContent(
      { title: 'Repayment to confirm', body: 'Ali recorded AED 100.', template: null, params: {} },
      echo,
    );
    expect(out).toEqual({ title: 'Repayment to confirm', body: 'Ali recorded AED 100.' });
  });

  it('uses the stored text for a template this client does not know', () => {
    const out = renderNotificationContent(
      { title: 'Server title', body: 'Server body', template: 'invented_by_a_newer_server', params: {} },
      echo,
    );
    expect(out).toEqual({ title: 'Server title', body: 'Server body' });
  });

  it('tolerates params that are not an object', () => {
    const out = renderNotificationContent(
      // A jsonb round-trip could hand back an array or a scalar.
      { title: 'T', body: 'B', template: 'member_joined', params: [] as unknown as Record<string, unknown> },
      echo,
    );
    expect(out.title).toBe('[ntf_member_joined_title]');
  });
});

describe('renderNotificationContent — templated rendering', () => {
  it('substitutes actor, group, description and money into the expense template', () => {
    const out = renderNotificationContent(
      {
        title: 'Ali added an expense',
        body: 'Groceries for AED 250.50 was added in Flat 12.',
        template: 'expense_added',
        params: {
          actorName: 'Ali',
          groupName: 'Flat 12',
          description: 'Groceries',
          amount: 250.5,
          currency: 'AED',
        },
      },
      en,
    );
    expect(out.title).toBe('Ali added an expense');
    expect(out.body).toBe('Groceries for AED 250.50 was added in Flat 12.');
  });

  it('renders the same row in Roman Urdu — the reader chooses the language, not the sender', () => {
    const row = {
      title: 'Ali added an expense',
      body: 'Groceries for AED 250.50 was added in Flat 12.',
      template: 'expense_added',
      params: {
        actorName: 'Ali',
        groupName: 'Flat 12',
        description: 'Groceries',
        amount: 250.5,
        currency: 'AED',
      },
    };
    const urdu = renderNotificationContent(row, ur);
    expect(urdu.title).toBe('Ali ne kharcha add kiya');
    expect(urdu.body).toBe('Flat 12 mein Groceries — AED 250.50 add hua.');
    // The English server text is untouched — it is only the fallback.
    expect(urdu.body).not.toBe(row.body);
  });

  it('drops to the amount-free wording when params carry no amount', () => {
    const out = renderNotificationContent(
      {
        title: 'x', body: 'y',
        template: 'expense_added',
        params: { actorName: 'Ali', groupName: 'Flat 12', description: 'Groceries' },
      },
      en,
    );
    expect(out.body).toBe('Groceries was added in Flat 12.');
    expect(out.body).not.toContain('for  ');
  });

  it('formats a settlement with both member names and the amount', () => {
    const out = renderNotificationContent(
      {
        title: 'x', body: 'y',
        template: 'settlement_added',
        params: {
          fromName: 'Sara', toName: 'Ali', groupName: 'Trip',
          amount: 1200, currency: 'PKR', actorName: 'Sara',
        },
      },
      en,
    );
    expect(out.title).toBe('Sara settled up');
    expect(out.body).toBe('Sara settled ₨ 1,200.00 with Ali in Trip.');
  });

  it('substitutes readable placeholders when params are missing', () => {
    const out = renderNotificationContent(
      { title: 'x', body: 'y', template: 'expense_deleted', params: {} },
      en,
    );
    expect(out.title).toBe('A member deleted an expense');
    expect(out.body).toBe('An expense was removed from the group.');
    expect(out.title).not.toContain('{');
    expect(out.body).not.toContain('{');
  });

  it('resolves every template key in the catalog to real copy in both languages', () => {
    const templates = [
      'group_added', 'member_joined', 'expense_added', 'expense_updated',
      'expense_deleted', 'settlement_added', 'settlement_deleted',
      // notify_group_archive_state (group-deletion-guard.sql §6a).
      'group_archived', 'group_unarchived',
      // M5 event gaps (p2-notification-maturity.sql §4 and §6, audit N-11).
      'member_left',
      'kameti_draw_completed', 'kameti_round_due', 'kameti_payout_due',
      // linked_info (settlement-receiver-records.sql §3): the receiver
      // recorded / removed the reader's repayment.
      'lsr_recorded', 'lsr_undone',
    ];
    for (const template of templates) {
      for (const translate of [en, ur]) {
        const out = renderNotificationContent(
          {
            title: 'server title', body: 'server body', template,
            params: {
              actorName: 'Ali', groupName: 'Flat 12', description: 'Groceries',
              amount: 100, currency: 'AED', fromName: 'Ali', toName: 'Sara',
              committeeName: 'Office Kameti', memberName: 'Sara', round: 2, slot: 3,
            },
          },
          translate,
        );
        expect(out.title, template).not.toBe('server title');
        expect(out.title, template).not.toContain('{');
        expect(out.body, template).not.toContain('{');
        // A missing i18n key makes t() return the key name itself.
        expect(out.title, template).not.toMatch(/^ntf_/);
        expect(out.body, template).not.toMatch(/^ntf_/);
      }
    }
  });
});

describe('linked_info — the receiver recorded your repayment', () => {
  it("reads in the reader's own language with the actor and the money", () => {
    const row = {
      title: 'Repayment recorded', body: 'server body', template: 'lsr_recorded',
      params: { actorName: 'Founder', amount: 3000, currency: 'AED', requestId: 'r1' },
    };
    const english = renderNotificationContent(row, en);
    expect(english.title).toBe('Repayment recorded');
    expect(english.body).toContain('Founder');
    expect(english.body).toContain('3,000');
    const urdu = renderNotificationContent(row, ur);
    expect(urdu.body).toContain('Founder');
    expect(urdu.body).not.toBe(english.body);
  });

  it('rides the money channel even without a stamped channel_id', () => {
    expect(notificationChannel({ type: 'linked_info', template: 'lsr_recorded' })).toBe('money');
  });
});

describe('notificationHref', () => {
  it('deep-links a group notification to its group', () => {
    expect(notificationHref({ type: 'group_update', groupId: 'g1' })).toBe('/group/g1');
  });
  it('falls back to the groups list when the row has no group id', () => {
    expect(notificationHref({ type: 'group_update', groupId: null })).toBe('/groups');
  });
  it('sends request-shaped notifications to the inbox', () => {
    expect(notificationHref({ type: 'linked_request', groupId: null })).toBe('/inbox');
    expect(notificationHref({ type: 'linked_settlement', groupId: null })).toBe('/inbox');
    expect(notificationHref({ type: 'contact_linked', groupId: null })).toBe('/inbox');
  });
  // tg_group_members_notify_invited writes an 'invite' row WITH a group_id,
  // but the recipient is only 'invited' — is_group_member() fails and RLS hides
  // that group, so /group/:id would be a permanent "Loading…". The
  // Accept/Decline card lives on the Groups tab, and that is the only correct
  // destination.
  it('sends a group invitation to the groups list, never to the hidden group', () => {
    expect(notificationHref({ type: 'invite', groupId: 'g1' })).toBe('/groups');
    expect(notificationHref({ type: 'invite', groupId: null })).toBe('/groups');
  });
});

// ── M5: the client half of the routing metadata the server now stamps ───────
// Each of these mirrors a SQL helper in
// supabase-migration-p2-notification-maturity.sql §3. Divergence between the
// two is invisible in production — the push and the in-app tap would just
// quietly disagree about where a notification goes — so they are pinned here.
describe('notificationHref — server-stamped href (audit N-8)', () => {
  it('prefers the href the server computed', () => {
    expect(notificationHref({ type: 'group_update', groupId: 'g1', href: '/group/g9' }))
      .toBe('/group/g9');
  });
  it('falls back to the type/group rules for a pre-migration row', () => {
    expect(notificationHref({ type: 'group_update', groupId: 'g1', href: null }))
      .toBe('/group/g1');
  });
  it('refuses an href that is not an in-app absolute path', () => {
    // navigate() gets this value; a full URL or a protocol-relative path would
    // be an open redirect handed to us by whatever wrote the row.
    expect(notificationHref({ type: 'linked_request', href: 'https://evil.example' })).toBe('/inbox');
    expect(notificationHref({ type: 'linked_request', href: '//evil.example' })).toBe('/inbox');
    expect(notificationHref({ type: 'linked_request', href: 'javascript:alert(1)' })).toBe('/inbox');
  });
  it('deep-links a kameti notification to its committee', () => {
    expect(notificationHref({ type: 'kameti', params: { committeeId: 'K1' } })).toBe('/kameti/K1');
  });
  it('sends a kameti row with no committee id to the inbox rather than /kameti/undefined', () => {
    expect(notificationHref({ type: 'kameti', params: {} })).toBe('/inbox');
  });
});

describe('notificationChannel (audit N-10)', () => {
  it('routes actionable money to its own channel', () => {
    expect(notificationChannel({ type: 'linked_request' })).toBe('money');
    expect(notificationChannel({ type: 'linked_settlement' })).toBe('money');
  });
  it('routes group traffic and everything unknown to the group channel', () => {
    expect(notificationChannel({ type: 'group_update', template: 'expense_added' })).toBe('groups');
    expect(notificationChannel({ type: 'contact_linked' })).toBe('groups');
    expect(notificationChannel({ type: 'system' })).toBe('groups');
  });
  it('routes kameti by type or by template prefix', () => {
    expect(notificationChannel({ type: 'kameti' })).toBe('kameti');
    expect(notificationChannel({ type: 'system', template: 'kameti_round_due' })).toBe('kameti');
  });
  it('prefers the stored channel, but only when this build knows it', () => {
    expect(notificationChannel({ type: 'group_update', channelId: 'money' })).toBe('money');
    // An unregistered channel makes Android drop the notification silently —
    // an unknown value must fall back, never pass through.
    expect(notificationChannel({ type: 'group_update', channelId: 'wormhole' })).toBe('groups');
  });
});

describe('notificationCollapseKey (audit N-10)', () => {
  it('collapses group traffic per (group, template) so a trip is one entry', () => {
    const key = (id: string) => notificationCollapseKey({
      id, type: 'group_update', groupId: 'g1', template: 'expense_added',
    });
    expect(key('n1')).toBe('group:g1:expense_added');
    expect(key('n2')).toBe(key('n1'));
  });
  it('does NOT collapse two different money requests together', () => {
    const a = notificationCollapseKey({ id: 'n1', type: 'linked_request' });
    const b = notificationCollapseKey({ id: 'n2', type: 'linked_request' });
    expect(a).not.toBe(b);
  });
  it('keys kameti traffic per (committee, template)', () => {
    expect(notificationCollapseKey({
      id: 'n1', type: 'kameti', template: 'kameti_round_due', params: { committeeId: 'K1' },
    })).toBe('kameti:K1:kameti_round_due');
  });
  it('prefers the server-stamped key', () => {
    expect(notificationCollapseKey({ id: 'n1', type: 'group_update', collapseKey: 'x:y' }))
      .toBe('x:y');
  });
});
