// Supabase Edge Function: inbound-mail provider webhook → capture candidate.
//
// A user forwards a bank email to their private address
// hisaab-<token>@<inbound domain>. The provider (Postmark inbound by default;
// any provider can POST the generic { to, from, subject, text|html } shape)
// calls this function, which authenticates the call, normalises the payload
// (_shared/inboundEmail.ts), and hands the text to
// _capture_candidate_received() with the service role. The database does the
// rest: one capture_candidates row, one notification whose tap opens the
// "Record this?" sheet. Nothing is ever recorded from here.
//
// Deploy + configure: docs/bank-alert-capture.md §"Route 3 — runbook"
//
//   supabase functions deploy inbound-email --no-verify-jwt
//   supabase secrets set INBOUND_EMAIL_SECRET="$(openssl rand -hex 32)"
//
// --no-verify-jwt: the caller is the mail provider, not a signed-in user.
// Authentication is the shared secret, accepted either as HTTP Basic auth in
// the webhook URL (https://hisaab:<secret>@…, what Postmark supports) or as
// the x-hisaab-inbound-secret header.
//
// Every authenticated request is answered 200, including unknown tokens and
// unparseable bodies: a 4xx would make the provider retry for hours and a
// different status per outcome would let someone probe which addresses exist.

import { normaliseInbound } from '../_shared/inboundEmail.ts';

const SECRET = Deno.env.get('INBOUND_EMAIL_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Providers send the whole email; a 2 MB cap keeps a runaway attachment from
// costing anything. The text itself is capped again at 8000 chars downstream.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): boolean {
  if (!SECRET) return false;
  const header = req.headers.get('x-hisaab-inbound-secret');
  if (header && timingSafeEqual(header, SECRET)) return true;
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
      if (timingSafeEqual(password, SECRET)) return true;
    } catch {
      // Malformed base64 — treated as no credentials.
    }
  }
  return false;
}

async function queueCandidate(token: string, from: string | null, subject: string | null, text: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_capture_candidate_received`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_token: token, p_from: from, p_subject: subject, p_text: text }),
  });
  if (!res.ok) {
    console.error('[inbound-email] rpc failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  const id = await res.json().catch(() => null);
  return typeof id === 'string' && id.length > 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!authorised(req)) return new Response('unauthorized', { status: 401 });

  const length = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, reason: 'too_large' }, { status: 200 });
  }

  let payload: unknown;
  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else if (contentType.includes('form')) {
      // Mailgun / SendGrid style multipart or urlencoded posts.
      const form = await req.formData();
      const obj: Record<string, string> = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') obj[k] = v;
      payload = {
        to: obj.recipient ?? obj.to ?? obj.To ?? '',
        from: obj.sender ?? obj.from ?? obj.From ?? '',
        subject: obj.subject ?? obj.Subject ?? '',
        text: obj['stripped-text'] ?? obj['body-plain'] ?? obj.text ?? '',
        html: obj['body-html'] ?? obj.html ?? '',
      };
    } else {
      payload = JSON.parse(await req.text());
    }
  } catch {
    return Response.json({ ok: false, reason: 'unparseable' }, { status: 200 });
  }

  const email = normaliseInbound(payload);
  if (!email || !email.token || !email.text) {
    return Response.json({ ok: false, reason: 'ignored' }, { status: 200 });
  }

  const queued = await queueCandidate(email.token, email.from, email.subject, email.text);
  return Response.json({ ok: queued }, { status: 200 });
});
