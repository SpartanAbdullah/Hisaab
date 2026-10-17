// Inbound-mail webhook payload → { token, from, subject, text }. Pure, no
// Deno or browser globals, so it is unit-tested from the Vitest suite
// (src/lib/inboundEmail.test.ts) and imported by index.ts next to it. Kept inside
// the function folder so a deploy ships exactly this file.
//
// Providers: Postmark's inbound JSON is handled natively; any other provider
// can be adapted by POSTing the generic shape { to, from, subject, text|html }.
// The token is the hex part of the per-user address `hisaab-<token>@<domain>`
// (supabase-migration-email-capture.sql §2).

export interface InboundEmail {
  token: string | null;
  from: string | null;
  subject: string | null;
  text: string;
}

/** Mirrors the CHECK on capture_addresses.token. */
export const CAPTURE_TOKEN_RE = /^[a-f0-9]{12}$/;
/** Mirrors the CHECK on capture_candidates.raw_text. */
export const INBOUND_TEXT_MAX = 8000;

const ADDRESS_IN_ANGLE = /<([^<>\s]+@[^<>\s]+)>/;

/** "Name <addr>" or a bare address → the address, lower-cased. */
export function extractAddress(value: string): string | null {
  const s = (value ?? '').trim();
  if (!s) return null;
  const angle = ADDRESS_IN_ANGLE.exec(s);
  const addr = (angle ? angle[1] : s).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

/** hisaab-<token>@anything → token; anything else → null. */
export function tokenFromAddress(value: string): string | null {
  const addr = extractAddress(value);
  if (!addr) return null;
  const m = /^hisaab-([a-f0-9]{12})@/.exec(addr);
  return m ? m[1] : null;
}

export function tokenFromRecipients(recipients: ReadonlyArray<string>): string | null {
  for (const r of recipients) {
    const t = tokenFromAddress(r);
    if (t) return t;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function htmlToText(html: string): string {
  let s = html ?? '';
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent: string) => {
    const lower = ent.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10) || 32);
    return ENTITIES[lower] ?? whole;
  });
  return s;
}

// Lines that are forwarding chrome rather than the alert itself. The bank's
// own text is what the parser needs; "From:/Date:/Subject:/To:" blocks at the
// top of a forward and ">" quote markers only get in its way.
const FORWARD_SEPARATOR = /^-{3,}\s*(forwarded message|original message)\s*-{3,}$/i;
const HEADER_LINE = /^(from|date|sent|subject|to|cc):\s/i;

export function cleanForwardedText(input: string): string {
  const lines = (input ?? '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let inHeaderBlock = false;
  for (const raw of lines) {
    let line = raw.replace(/^(\s*>)+\s?/, '').replace(/[ \t]+$/, '');
    if (FORWARD_SEPARATOR.test(line.trim())) {
      inHeaderBlock = true;
      continue;
    }
    if (inHeaderBlock) {
      if (HEADER_LINE.test(line.trim())) continue;
      if (line.trim() === '') continue;
      inHeaderBlock = false;
    }
    // Zero-width and non-breaking spaces from HTML mail.
    line = line.replace(/[​‌‍﻿]/g, '').replace(/ /g, ' ');
    out.push(line);
  }
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined.length > INBOUND_TEXT_MAX ? joined.slice(0, INBOUND_TEXT_MAX) : joined;
}

interface PostmarkPayload {
  From?: string;
  FromFull?: { Email?: string };
  To?: string;
  ToFull?: Array<{ Email?: string }>;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalisePostmark(payload: unknown): InboundEmail | null {
  if (!isObject(payload)) return null;
  const p = payload as PostmarkPayload;
  const recipients: string[] = [];
  if (typeof p.OriginalRecipient === 'string') recipients.push(p.OriginalRecipient);
  if (Array.isArray(p.ToFull)) for (const r of p.ToFull) if (r && typeof r.Email === 'string') recipients.push(r.Email);
  if (typeof p.To === 'string') recipients.push(...p.To.split(','));
  const token = tokenFromRecipients(recipients);
  const from = extractAddress(p.FromFull?.Email ?? p.From ?? '');
  const subject = typeof p.Subject === 'string' ? p.Subject.trim().slice(0, 500) : null;
  const body = typeof p.TextBody === 'string' && p.TextBody.trim()
    ? p.TextBody
    : typeof p.HtmlBody === 'string' ? htmlToText(p.HtmlBody) : '';
  return { token, from, subject: subject || null, text: cleanForwardedText(body) };
}

export function normaliseGeneric(payload: unknown): InboundEmail | null {
  if (!isObject(payload)) return null;
  const to = payload.to;
  const recipients = Array.isArray(to) ? to.filter((x): x is string => typeof x === 'string')
    : typeof to === 'string' ? to.split(',') : [];
  const token = tokenFromRecipients(recipients);
  const from = typeof payload.from === 'string' ? extractAddress(payload.from) : null;
  const subject = typeof payload.subject === 'string' ? payload.subject.trim().slice(0, 500) : null;
  const body = typeof payload.text === 'string' && payload.text.trim()
    ? payload.text
    : typeof payload.html === 'string' ? htmlToText(payload.html) : '';
  return { token, from, subject: subject || null, text: cleanForwardedText(body) };
}

/** Postmark when its field names are present, else the generic shape. */
export function normaliseInbound(payload: unknown): InboundEmail | null {
  if (!isObject(payload)) return null;
  if ('TextBody' in payload || 'HtmlBody' in payload || 'ToFull' in payload || 'OriginalRecipient' in payload) {
    return normalisePostmark(payload);
  }
  return normaliseGeneric(payload);
}
