// Bank-alert text → a transaction candidate. Pure, dependency-light, tested.
//
// Feeds the "Record this?" capture flow (src/components/CaptureSheet.tsx):
// text arrives either from the Android share sheet (the user shares a bank
// email / SMS / app message into Hisaab) or from the Android notification
// listener (android/.../capture/HisaabNotificationListener.java). Either way
// NOTHING is written until the user taps Record — this module only proposes.
//
// Scope, deliberately: UAE / Pakistan / Gulf bank and wallet alerts written in
// English (the founder's market — ENBD, Mashreq, CBD, Emirates Islamic, RAK,
// Wio, HBL, Meezan, JazzCash, Easypaisa). Templates differ per bank, so the
// rules here are keyword heuristics, not per-bank parsers; real samples refine
// them. Returns null whenever it cannot find an amount it believes is the
// transaction itself — a balance line alone is not a transaction.
//
// Never capture: OTPs / verification codes (secrets), declined or failed
// transactions (no money moved), future-tense notices ("will be debited",
// "payment due") — the user would record money that has not moved.

import { CURRENCY_CODES } from './currencies';

export type AlertDirection = 'debit' | 'credit';

export interface ParsedAlert {
  /** Positive amount of the transaction itself (never the balance). */
  amount: number;
  /** ISO 4217 code (`Rs`/`Rs.` → PKR, `Dhs` → AED, `$` → USD, …). */
  currency: string;
  /** Money out (debit) or in (credit); null when the text does not say. */
  direction: AlertDirection | null;
  /** Merchant / counterparty label, cleaned, ≤ 40 chars. */
  merchant: string | null;
  /** Last four digits of the card / account the alert names, if any. */
  accountHint: string | null;
  /** Transaction date as YYYY-MM-DD when the text carries one (DD/MM order). */
  occurredAt: string | null;
  /** Balance the alert reports AFTER the transaction, same currency, if any. */
  balanceAfter: number | null;
  /** high = direction + amount + (merchant or account); medium = direction +
   *  amount; low = amount only. The sheet asks the user to confirm more when
   *  confidence is low. */
  confidence: 'high' | 'medium' | 'low';
}

// Symbols and local shorthands → ISO. Each pattern is tested against the
// isolated currency token the amount regexes captured, so it is anchored.
const CURRENCY_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:Rs\.?|Rupees?|PKR|₨)$/i, 'PKR'],
  [/^(?:Dhs?\.?|DHS|AED)$/i, 'AED'],
  [/^(?:SAR|SR\.?|Riyals?)$/i, 'SAR'],
  [/^(?:QAR|QR\.?)$/i, 'QAR'],
  [/^(?:US\$|USD|\$)$/i, 'USD'],
  [/^(?:GBP|£)$/, 'GBP'],
  [/^(?:EUR|€)$/, 'EUR'],
  [/^(?:INR|₹)$/, 'INR'],
];

const KNOWN_CODES = new Set(CURRENCY_CODES.map((c) => c.toUpperCase()));

// 1,234.56 · 1234.56 · 1,234 · 1234 · 12.5 — thousands groups must be exact.
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
// A currency token: an alias/symbol or any 3-letter ISO code.
const CUR = String.raw`(Rs\.?|Rupees?|PKR|₨|Dhs?\.?|DHS|AED|SAR|SR\.?|Riyals?|QAR|QR\.?|US\$|USD|\$|GBP|£|EUR|€|INR|₹|[A-Z]{3})`;
// "AED 1,234.56" / "AED1234" / "Rs. 5,000" / "$20"
const CUR_THEN_AMOUNT = new RegExp(String.raw`${CUR}\s?${AMOUNT}\b`, 'g');
// "1,234.56 AED" / "5000 Rs" / "20 USD"
const AMOUNT_THEN_CUR = new RegExp(String.raw`\b${AMOUNT}\s?${CUR}(?![A-Za-z])`, 'g');

// Words that mark an amount as a running balance / limit, not the transaction.
const BALANCE_CONTEXT = /\b(?:bal(?:ance)?|avail(?:able)?|limit|outstanding|remaining|total due|minimum|min\.?\s*due)\b/i;

const DEBIT_WORDS = /\b(?:debited|debit|spent|purchase[ds]?|bought|paid|payment (?:of|to|made)|withdrawn|withdrawal|charged|charge|pos|used (?:at|for)|spending|sent to|transferred to|transfer to|bill payment|cash withdrawal|atm)\b/gi;
const CREDIT_WORDS = /\b(?:credited|credit|received|deposit(?:ed)?|refund(?:ed)?|salary|reversal|reversed|cashback|cash back|transfer from|received from|inward|top[- ]?up received)\b/gi;

// Secrets and non-events: never offered as a transaction.
const NEVER_CAPTURE = /\b(?:otp|one[- ]time (?:password|pin|code)|verification code|passcode|security code|declined|failed|unsuccessful|insufficient|will be (?:debited|charged|deducted)|is due|due on|payment due|minimum (?:amount )?due|reminder)\b/i;

const MERCHANT_AT = /(?:\bat|@)\s+([A-Za-z0-9][A-Za-z0-9&'’.*/ -]{1,60}?)(?=\s*(?:\bon\b|\bdated?\b|\bfor\b|\busing\b|\bvia\b|\bwith\b|\bref\b|\btxn\b|\bavail|\bbal|\bfrom\b|\bto\b|[,;\n]|\.(?:\s|$)|$))/i;
const MERCHANT_TO_FROM = /\b(?:to|from)\s+([A-Za-z][A-Za-z0-9&'’.*/ -]{1,60}?)(?=\s*(?:\bon\b|\bdated?\b|\bfor\b|\busing\b|\bvia\b|\bwith\b|\bref\b|\btxn\b|\bavail|\bbal|\bending|\ba\/c|\baccount|\bcard|\bfrom\b|\bto\b|[,;\n]|\.(?:\s|$)|$))/i;
const MERCHANT_LABEL = /\b(?:merchant|payee|beneficiary|description)\s*[:-]\s*([^\n,;]{2,60})/i;

const ACCOUNT_HINT = /(?:\b(?:ending(?: in| with)?|ends with|last(?: four| 4)? digits?|no\.?|number|a\/c|acct\.?|account|card)\s*:?\s*(?:[*xX•·]{2,}\s*)?(\d{4})\b)|(?:[*xX•·]{2,}\s?(\d{4})\b)/i;

const DATE_DMY = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/;
const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DATE_TEXTUAL = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?[\s-]+(\d{2}|\d{4})\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface AmountCandidate {
  amount: number;
  currency: string;
  index: number;
  isBalance: boolean;
}

function normaliseCurrency(token: string): string | null {
  for (const [re, code] of CURRENCY_ALIASES) {
    if (re.test(token)) return code;
  }
  const upper = token.toUpperCase();
  return KNOWN_CODES.has(upper) ? upper : null;
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

function collectCandidates(text: string): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  const push = (curToken: string, amountRaw: string, index: number) => {
    const currency = normaliseCurrency(curToken);
    const amount = toNumber(amountRaw);
    if (!currency || !Number.isFinite(amount) || amount <= 0) return;
    // Context = the 32 chars before the match: "Available balance AED 500".
    const before = text.slice(Math.max(0, index - 32), index);
    out.push({ amount, currency, index, isBalance: BALANCE_CONTEXT.test(before) });
  };
  for (const m of text.matchAll(CUR_THEN_AMOUNT)) push(m[1], m[2], m.index ?? 0);
  for (const m of text.matchAll(AMOUNT_THEN_CUR)) {
    // Skip a hit that is the same span as a currency-first match
    // ("AED 50 USD" is nonsense anyway; the first form wins).
    if (out.some((c) => c.index === (m.index ?? 0))) continue;
    push(m[2], m[1], m.index ?? 0);
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function detectDirection(text: string): AlertDirection | null {
  // "credit card" is a noun here, not a direction.
  const cleaned = text.replace(/\bcredit cards?\b/gi, ' card ');
  const debits = [...cleaned.matchAll(DEBIT_WORDS)];
  const credits = [...cleaned.matchAll(CREDIT_WORDS)];
  if (debits.length === 0 && credits.length === 0) return null;
  if (debits.length !== credits.length) return debits.length > credits.length ? 'debit' : 'credit';
  // Tie: the first keyword in reading order decides.
  return (debits[0].index ?? 0) <= (credits[0].index ?? 0) ? 'debit' : 'credit';
}

function cleanMerchant(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Trailing reference junk: "CARREFOUR REF 1234", "NOON.COM DUBAI AE 17/10"
  s = s.replace(/\s+(?:ref|txn|trx|rrn|auth)\b.*$/i, '');
  s = s.replace(/[\s\-.,]+$/, '');
  if (s.length < 2) return null;
  return s.length > 40 ? s.slice(0, 40).trim() : s;
}

function extractMerchant(text: string, direction: AlertDirection | null): string | null {
  const labelled = MERCHANT_LABEL.exec(text);
  if (labelled) return cleanMerchant(labelled[1]);
  const at = MERCHANT_AT.exec(text);
  if (at) return cleanMerchant(at[1]);
  if (direction) {
    // Transfers: "sent to AHMED", "received from ALI K".
    const tf = MERCHANT_TO_FROM.exec(text);
    if (tf) {
      const label = cleanMerchant(tf[1]);
      // "to your account" / "from your account" is not a counterparty.
      if (label && !/^your\b|^the\b|^a\/c|^account|^card/i.test(label)) return label;
    }
  }
  return null;
}

function extractAccountHint(text: string): string | null {
  const m = ACCOUNT_HINT.exec(text);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function validDate(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function extractDate(text: string): string | null {
  const iso = DATE_ISO.exec(text);
  if (iso) {
    const r = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (r) return r;
  }
  const dmy = DATE_DMY.exec(text);
  if (dmy) {
    const yy = Number(dmy[3]);
    const r = validDate(yy < 100 ? 2000 + yy : yy, Number(dmy[2]), Number(dmy[1]));
    if (r) return r;
  }
  const textual = DATE_TEXTUAL.exec(text);
  if (textual) {
    const mo = MONTHS.indexOf(textual[2].slice(0, 3).toLowerCase()) + 1;
    const yy = Number(textual[3]);
    const r = validDate(yy < 100 ? 2000 + yy : yy, mo, Number(textual[1]));
    if (r) return r;
  }
  return null;
}

/** True when the text must never be offered as a transaction. */
export function isNeverCapture(text: string): boolean {
  return NEVER_CAPTURE.test(text);
}

/**
 * Parse a bank / wallet alert. Returns null when there is no transaction to
 * propose — no amount, only a balance, or a message that must not be captured.
 */
export function parseBankAlert(input: string): ParsedAlert | null {
  const text = (input ?? '').replace(/\r/g, '').trim();
  if (!text || isNeverCapture(text)) return null;

  const candidates = collectCandidates(text);
  const txn = candidates.find((c) => !c.isBalance);
  if (!txn) return null;

  const direction = detectDirection(text);
  const merchant = extractMerchant(text, direction);
  const accountHint = extractAccountHint(text);
  const balance = candidates.find((c) => c.isBalance && c.currency === txn.currency && c !== txn);

  const confidence: ParsedAlert['confidence'] =
    direction && (merchant || accountHint) ? 'high' : direction ? 'medium' : 'low';

  return {
    amount: txn.amount,
    currency: txn.currency,
    direction,
    merchant,
    accountHint,
    occurredAt: extractDate(text),
    balanceAfter: balance ? balance.amount : null,
    confidence,
  };
}
