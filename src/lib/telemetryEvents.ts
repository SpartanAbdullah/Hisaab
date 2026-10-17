// Typed product-telemetry event catalog.
//
// This is the ONLY place an event name or property may be declared. The schema
// below is both the TypeScript source of truth (`TelemetryProps<'entry_created'>`
// is derived from it) and the RUNTIME guard: `sanitizeEventProps()` drops any
// key that is not declared here and any value whose shape does not match its
// declared kind. That is what makes the PII policy enforceable instead of
// aspirational — a free-form string simply has no representable spec.
//
// PII policy (audit 2026-09 report 10 §5.2, non-negotiable):
//   NEVER send amounts, balances, person/contact names, phone numbers, note or
//   description text, account names, group names, kameti names, AI raw input,
//   or any free text. Magnitudes travel as BUCKETS. Counts travel as BUCKETS.
//   Currency travels as an ISO code. Everything else is a closed enum, an
//   integer, or a boolean.
//
// NOTE: `src/lib/analytics.ts` is the USER'S OWN spending aggregation for their
// charts and is unrelated to this file. Product telemetry lives under the
// `telemetry*` name precisely so the two are never confused.

// ── Buckets ───────────────────────────────────────────────────────────────

/** Money magnitude, in the entry's own currency. Never the amount itself. */
export const AMOUNT_BUCKETS = ['zero', 'lt_100', '100_1k', '1k_10k', 'gt_10k'] as const;
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number];

/** Group/kameti sizes. Capped so a 40-person kameti is not a fingerprint. */
export const COUNT_BUCKETS = ['1', '2', '3', '4', '5', '6-10', '10+'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export function bucketAmount(amount: number): AmountBucket {
  if (!Number.isFinite(amount)) return 'zero';
  const magnitude = Math.abs(amount);
  if (magnitude === 0) return 'zero';
  if (magnitude < 100) return 'lt_100';
  if (magnitude < 1000) return '100_1k';
  if (magnitude < 10000) return '1k_10k';
  return 'gt_10k';
}

export function bucketCount(count: number): CountBucket {
  if (!Number.isFinite(count) || count <= 1) return '1';
  const whole = Math.floor(count);
  if (whole <= 5) return String(whole) as CountBucket;
  if (whole <= 10) return '6-10';
  return '10+';
}

// ── Property specs ────────────────────────────────────────────────────────

export type PropSpec =
  | { readonly kind: 'bool' }
  | { readonly kind: 'int' }
  | { readonly kind: 'currency' }
  | { readonly kind: 'bucket' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

const BOOL = { kind: 'bool' } as const;
const INT = { kind: 'int' } as const;
const CURRENCY = { kind: 'currency' } as const;
const BUCKET = { kind: 'bucket' } as const;
const enumOf = <const V extends readonly string[]>(values: V) => ({ kind: 'enum', values }) as const;

const SURFACE = enumOf(['pwa', 'android']);
const LANGUAGE = enumOf(['ur', 'en']);
const APP_MODE = enumOf(['full_tracker', 'splits_only', 'unknown']);
const AUTH_METHOD = enumOf(['email']);
const ENTRY_TYPE = enumOf([
  'expense', 'income', 'transfer', 'loan_given', 'loan_taken', 'repayment',
  'goal_contribution', 'cash_advance', 'split', 'linked_request',
]);
const ENTRY_SOURCE = enumOf(['quick_entry', 'ai', 'recurring', 'group', 'onboarding', 'loan_page']);
const QUIZ_INTENT = enumOf(['spending', 'loans', 'kameti', 'splits', 'budgets', 'none']);
const ACCOUNT_TYPE = enumOf(['cash', 'bank', 'digital_wallet', 'credit_card', 'savings', 'other']);
const SHARE_CHANNEL = enumOf(['link', 'code', 'whatsapp', 'share_sheet', 'copy', 'other']);
const JOIN_VIA = enumOf(['link', 'code']);

// ── The catalog ───────────────────────────────────────────────────────────
//
// Numbering follows docs/audit-2026-09/10-product-analytics.md §5.3 so the
// implemented set can be diffed against the design.

export const TELEMETRY_SCHEMA = {
  // 1 — Activation funnel
  app_opened: {
    surface: SURFACE,
    language: LANGUAGE,
    app_mode: APP_MODE,
    is_logged_in: BOOL,
  },
  // 2
  signup_started: { method: AUTH_METHOD },
  // 3
  auth_completed: { method: AUTH_METHOD, is_new_user: BOOL },
  // 4
  onboarding_step_viewed: { step: INT },
  // 5
  onboarding_mode_selected: {
    mode: APP_MODE,
    quiz_intent: QUIZ_INTENT,
    was_default_kept: BOOL,
    quiz_skipped: BOOL,
  },
  // 6
  onboarding_completed: {
    mode: APP_MODE,
    language: LANGUAGE,
    currency: CURRENCY,
    created_first_account: BOOL,
  },
  // 7
  account_created: {
    account_type: ACCOUNT_TYPE,
    is_first: BOOL,
    source: enumOf(['onboarding', 'accounts_page', 'quick_entry']),
  },
  // 8
  quick_entry_opened: { source: enumOf(['fab', 'home', 'preset', 'other']) },
  // 9
  entry_created: {
    entry_type: ENTRY_TYPE,
    source: ENTRY_SOURCE,
    is_first_ever: BOOL,
    mode: APP_MODE,
    currency: CURRENCY,
    amount_bucket: BUCKET,
  },
  // 10
  quick_entry_abandoned: { last_step: INT, had_amount: BOOL },

  // 11 — Loans / udhaar
  loan_created: {
    direction: enumOf(['given', 'taken']),
    linked_contact: BOOL,
    has_schedule: BOOL,
    currency: CURRENCY,
    mode: APP_MODE,
  },
  // 12
  repayment_recorded: {
    consolidated: BOOL,
    settles_loan: BOOL,
    mode: APP_MODE,
    currency: CURRENCY,
  },
  // 13 / 14
  contact_link_requested: { via: enumOf(['code', 'phone', 'qr']) },
  contact_link_accepted: { via: enumOf(['code', 'phone', 'qr']) },

  // 15 — Group viral loop
  group_created: { member_count_bucket: BUCKET, currency: CURRENCY },
  // 16
  group_invite_shared: { channel: SHARE_CHANNEL },
  // 17
  group_invite_opened: { is_authed: BOOL },
  // 18
  group_joined: { via: JOIN_VIA, surface: enumOf(['invite_page', 'join_modal']) },
  // 19
  group_expense_added: {
    split_type: enumOf(['equal', 'exact', 'shares', 'percent', 'other']),
    participant_count_bucket: BUCKET,
  },
  // 20
  settle_up_completed: {
    scope: enumOf(['group', 'adhoc']),
    method: enumOf(['record_only', 'account_effect']),
  },

  // 21 — Kameti
  kameti_created: {
    member_count_bucket: BUCKET,
    rounds: INT,
    frequency: enumOf(['daily', 'weekly', 'monthly']),
    payout_method: enumOf(['fixed', 'ballot']),
    currency: CURRENCY,
  },
  // 22
  kameti_ballot_drawn: { member_count_bucket: BUCKET },
  // 23 — anonymous: witnesses are NOT users, never identify() them.
  kameti_witness_viewed: {},

  // 24 — Engagement / infrastructure
  push_permission_result: { granted: BOOL, surface: SURFACE },
  // 25
  notification_opened: { type: enumOf(['reminder', 'inbox', 'loan', 'group', 'kameti', 'other']) },
  // 26
  statement_shared: {
    doc_type: enumOf(['receipt', 'statement', 'settle_slip', 'kameti_slip']),
    channel: SHARE_CHANNEL,
  },
  // 27 — never the raw text
  ai_entry_submitted: { parsed_ok: BOOL, accepted: BOOL },
  // 27b — bank-alert capture (share sheet / Android notification listener).
  // Never the raw alert, the amount or the merchant: only how it went.
  capture_offered: {
    source: enumOf(['share', 'notification']),
    parsed: enumOf(['ok', 'none', 'refused']),
  },
  capture_resolved: { action: enumOf(['record', 'manual', 'dismiss']) },
  capture_listener_toggled: { enabled: BOOL, granted: BOOL },
  // 28 — bridge from errorReporter so error rate joins product data
  error_surfaced: { feature: enumOf(['react.render', 'window.onerror', 'window.unhandledrejection', 'money_mutation', 'other']) },

  // Funnel-top steps for the group loop (measures abandonment between opening
  // the sheet and completing). Not numbered in the report; same shape rules.
  group_create_started: { source: enumOf(['groups_page', 'quick_entry', 'home']) },
  group_join_started: { source: enumOf(['groups_page', 'home', 'invite_link']) },

  // Consent + feedback plumbing (this phase's own surfaces).
  telemetry_consent_changed: { granted: BOOL, source: enumOf(['settings', 'onboarding']) },
  feedback_opened: { channel: enumOf(['whatsapp', 'email', 'in_app']) },
} as const satisfies Record<string, Record<string, PropSpec>>;

export type TelemetryEventName = keyof typeof TELEMETRY_SCHEMA;

type PropValue<S> =
  S extends { kind: 'bool' } ? boolean
  : S extends { kind: 'int' } ? number
  : S extends { kind: 'currency' } ? string
  : S extends { kind: 'bucket' } ? AmountBucket | CountBucket
  : S extends { kind: 'enum'; values: readonly (infer V)[] } ? V
  : never;

/** The exact, fully-typed property object an event accepts. */
export type TelemetryProps<E extends TelemetryEventName> = {
  [K in keyof (typeof TELEMETRY_SCHEMA)[E]]: PropValue<(typeof TELEMETRY_SCHEMA)[E][K]>;
};

/**
 * Person properties (set once / on change). Same rules: enums and codes only.
 * `signup_week` is an ISO week string (2026-W12) — deliberately coarser than a
 * date so it cannot be joined back to a signup timestamp.
 */
export const PERSON_PROPERTY_KEYS = [
  'app_mode', 'language', 'primary_currency', 'surface', 'push_granted',
  'signup_week', 'acquired_via',
] as const;
export type PersonPropertyKey = (typeof PERSON_PROPERTY_KEYS)[number];
export type PersonProperties = Partial<Record<PersonPropertyKey, string | boolean>>;

// ── Runtime validation ────────────────────────────────────────────────────

export function isKnownTelemetryEvent(name: string): name is TelemetryEventName {
  return Object.prototype.hasOwnProperty.call(TELEMETRY_SCHEMA, name);
}

const BUCKET_VALUES: readonly string[] = [...AMOUNT_BUCKETS, ...COUNT_BUCKETS];

function matchesSpec(spec: PropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'currency':
      return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
    case 'bucket':
      return typeof value === 'string' && BUCKET_VALUES.includes(value);
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
  }
}

export interface SanitizeResult {
  /** Only the properties that are declared AND well-shaped. Safe to send. */
  props: Record<string, string | number | boolean>;
  /** Keys refused, for dev-time logging. Values are never echoed. */
  dropped: string[];
}

/**
 * The last line of defence before anything leaves the device. Unknown event →
 * everything is dropped and the caller must not send. Unknown or mis-shaped
 * property → dropped silently in prod, warned in dev.
 */
export function sanitizeEventProps(event: string, props: Record<string, unknown> = {}): SanitizeResult {
  if (!isKnownTelemetryEvent(event)) {
    return { props: {}, dropped: Object.keys(props) };
  }
  const schema = TELEMETRY_SCHEMA[event] as Record<string, PropSpec>;
  const out: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    const spec = schema[key];
    if (spec && matchesSpec(spec, value)) {
      out[key] = value as string | number | boolean;
    } else {
      dropped.push(key);
    }
  }
  return { props: out, dropped };
}

/**
 * Defensive identity check. The distinct id must be the opaque Supabase auth
 * UUID — never an email, phone or name. Anything that does not look like a
 * UUID is refused rather than trusted.
 */
export function isSafeDistinctId(id: unknown): id is string {
  return typeof id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
