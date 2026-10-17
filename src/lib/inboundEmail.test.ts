import { describe, expect, it } from 'vitest';
import {
  cleanForwardedText,
  extractAddress,
  htmlToText,
  INBOUND_TEXT_MAX,
  normaliseInbound,
  tokenFromAddress,
  tokenFromRecipients,
} from '../../supabase/functions/inbound-email/inboundEmail';

describe('addresses and tokens', () => {
  it('reads a bare or display-name address, lower-cased', () => {
    expect(extractAddress('Alerts <Alerts@EmiratesNBD.com>')).toBe('alerts@emiratesnbd.com');
    expect(extractAddress('  noreply@hbl.com ')).toBe('noreply@hbl.com');
    expect(extractAddress('not an address')).toBeNull();
  });
  it('extracts the token only from a hisaab-<12 hex>@ local part', () => {
    expect(tokenFromAddress('hisaab-0123456789ab@in.usehisaab.com')).toBe('0123456789ab');
    expect(tokenFromAddress('Me <HISAAB-0123456789AB@in.usehisaab.com>')).toBe('0123456789ab');
    expect(tokenFromAddress('hisaab-0123456789a@in.usehisaab.com')).toBeNull();
    expect(tokenFromAddress('hisaab-0123456789ag@in.usehisaab.com')).toBeNull();
    expect(tokenFromAddress('support@usehisaab.com')).toBeNull();
  });
  it('takes the first recipient that carries a token', () => {
    expect(tokenFromRecipients(['me@gmail.com', 'hisaab-abcdefabcdef@in.usehisaab.com'])).toBe('abcdefabcdef');
    expect(tokenFromRecipients([])).toBeNull();
  });
});

describe('htmlToText', () => {
  it('drops tags, scripts and styles, keeps line breaks and decodes entities', () => {
    const html = '<style>p{}</style><p>AED&nbsp;120.50 spent at <b>CARREFOUR</b></p><br><script>x()</script><div>Balance &amp; limit</div>';
    const text = htmlToText(html).replace(/\s+/g, ' ').trim();
    expect(text).toBe('AED 120.50 spent at CARREFOUR Balance & limit');
  });
});

describe('cleanForwardedText', () => {
  it('strips the Gmail forward header block and quote markers', () => {
    const raw = [
      '',
      '---------- Forwarded message ---------',
      'From: Emirates NBD <alerts@emiratesnbd.com>',
      'Date: Fri, 17 Oct 2026 14:35',
      'Subject: Card transaction alert',
      'To: <me@gmail.com>',
      '',
      '',
      '> Purchase of AED 120.50 at CARREFOUR with card ending 4599.',
      '> Available balance AED 5,879.50',
    ].join('\n');
    expect(cleanForwardedText(raw)).toBe(
      'Purchase of AED 120.50 at CARREFOUR with card ending 4599.\nAvailable balance AED 5,879.50',
    );
  });
  it('caps the text and collapses runs of blank lines', () => {
    const long = `AED 10 spent\n\n\n\n${'x'.repeat(INBOUND_TEXT_MAX + 100)}`;
    const out = cleanForwardedText(long);
    expect(out.startsWith('AED 10 spent\n\nx')).toBe(true);
    expect(out).toHaveLength(INBOUND_TEXT_MAX);
  });
});

describe('normaliseInbound', () => {
  it('reads a Postmark payload, preferring TextBody and OriginalRecipient', () => {
    const e = normaliseInbound({
      FromFull: { Email: 'alerts@mashreq.com', Name: 'Mashreq' },
      From: 'Mashreq <alerts@mashreq.com>',
      To: 'hisaab-0123456789ab@in.usehisaab.com',
      ToFull: [{ Email: 'hisaab-0123456789ab@in.usehisaab.com' }],
      OriginalRecipient: 'hisaab-0123456789ab@in.usehisaab.com',
      Subject: '  Transaction alert  ',
      TextBody: 'AED 45.00 at NOON.COM',
      HtmlBody: '<p>ignored</p>',
    });
    expect(e).toEqual({ token: '0123456789ab', from: 'alerts@mashreq.com', subject: 'Transaction alert', text: 'AED 45.00 at NOON.COM' });
  });
  it('falls back to HtmlBody when TextBody is empty', () => {
    const e = normaliseInbound({ ToFull: [{ Email: 'hisaab-0123456789ab@in.usehisaab.com' }], TextBody: '', HtmlBody: '<p>Rs. 5,000 debited</p>' });
    expect(e?.text).toBe('Rs. 5,000 debited');
  });
  it('reads the generic shape and reports a missing token as null', () => {
    const e = normaliseInbound({ to: ['x@y.com'], from: 'a@b.com', subject: 'hi', text: 'AED 1' });
    expect(e).toEqual({ token: null, from: 'a@b.com', subject: 'hi', text: 'AED 1' });
    expect(normaliseInbound('nope')).toBeNull();
    expect(normaliseInbound(null)).toBeNull();
  });
});
