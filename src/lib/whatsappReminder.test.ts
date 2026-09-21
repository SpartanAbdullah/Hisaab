import { describe, it, expect } from 'vitest';
import { normalizeWhatsAppPhone, hasWhatsAppNumber, buildWhatsAppUrl } from './whatsappReminder';

describe('normalizeWhatsAppPhone', () => {
  it('strips + and separators to bare international digits', () => {
    expect(normalizeWhatsAppPhone('+971 50 123 4567')).toBe('971501234567');
    expect(normalizeWhatsAppPhone('+92 (300) 123-4567')).toBe('923001234567');
    expect(normalizeWhatsAppPhone('+44 7911 123456')).toBe('447911123456');
  });

  it('treats 00 as a written +', () => {
    expect(normalizeWhatsAppPhone('00971501234567')).toBe('971501234567');
  });

  // 2026-09-19 founder report "Remind doesn't work": wa.me cannot dial a
  // national-format number, so "0300 1234567" opened WhatsApp on an invalid-
  // number error. PK/UAE mobiles written the local way now resolve.
  it('resolves Pakistani and UAE mobiles saved in national format', () => {
    expect(normalizeWhatsAppPhone('(0300) 123-4567')).toBe('923001234567');
    expect(normalizeWhatsAppPhone('0300 1234567')).toBe('923001234567');
    expect(normalizeWhatsAppPhone('050 123 4567')).toBe('971501234567');
    // Bare national digits and a pasted country code without the +.
    expect(normalizeWhatsAppPhone('501234567')).toBe('971501234567');
    expect(normalizeWhatsAppPhone('923001234567')).toBe('923001234567');
  });

  it('never guesses a country for a national number it cannot place', () => {
    // UK mobile / Lahore landline written with a trunk 0 — wa.me can't dial
    // these, so no chat link rather than a dead or wrong one.
    expect(normalizeWhatsAppPhone('07911 123456')).toBe(null);
    expect(normalizeWhatsAppPhone('042 1234567')).toBe(null);
  });

  it('keeps digits that already carry a country code', () => {
    expect(normalizeWhatsAppPhone('447911123456')).toBe('447911123456');
  });

  it('returns null for missing, too-short or too-long input', () => {
    expect(normalizeWhatsAppPhone(null)).toBe(null);
    expect(normalizeWhatsAppPhone(undefined)).toBe(null);
    expect(normalizeWhatsAppPhone('')).toBe(null);
    expect(normalizeWhatsAppPhone('123')).toBe(null);
    expect(normalizeWhatsAppPhone('+++')).toBe(null);
    expect(normalizeWhatsAppPhone('1234567890123456')).toBe(null);
  });
});

describe('hasWhatsAppNumber', () => {
  it('reflects whether a usable number exists', () => {
    expect(hasWhatsAppNumber('+971501234567')).toBe(true);
    expect(hasWhatsAppNumber('03001234567')).toBe(true);
    expect(hasWhatsAppNumber(null)).toBe(false);
    expect(hasWhatsAppNumber('12')).toBe(false);
    expect(hasWhatsAppNumber('07911123456')).toBe(false);
  });
});

describe('buildWhatsAppUrl', () => {
  it('targets a specific chat when the number is known', () => {
    const url = buildWhatsAppUrl('+971501234567', 'Salam Bilal');
    expect(url).toBe('https://wa.me/971501234567?text=Salam%20Bilal');
  });

  it('opens the right chat for a national-format number', () => {
    expect(buildWhatsAppUrl('0300 1234567', 'Salam')).toBe('https://wa.me/923001234567?text=Salam');
  });

  it('falls back to the contact picker when the number is unknown', () => {
    const url = buildWhatsAppUrl(null, 'Salam');
    expect(url).toBe('https://wa.me/?text=Salam');
    expect(buildWhatsAppUrl('07911123456', 'Salam')).toBe('https://wa.me/?text=Salam');
  });

  it('url-encodes multi-line bodies', () => {
    const url = buildWhatsAppUrl('+971501234567', 'Line one\nLine two & more');
    expect(url).toContain('text=Line%20one%0ALine%20two%20%26%20more');
  });
});
