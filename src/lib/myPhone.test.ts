import { describe, expect, it } from 'vitest';
import { discoverableForSave, legacyPhoneDraft, readMyPhone } from './myPhone';

describe('readMyPhone', () => {
  it('is null when there is no profile row', () => {
    expect(readMyPhone(null)).toBeNull();
    expect(readMyPhone(undefined)).toBeNull();
  });

  it('is null when the discovery columns are missing (migration not applied)', () => {
    expect(readMyPhone({ id: 'u1', name: 'Ali' })).toBeNull();
  });

  it('reads a saved, discoverable number', () => {
    expect(readMyPhone({ phone_e164: '+923001234567', phone_discoverable: true }))
      .toEqual({ e164: '+923001234567', discoverable: true });
  });

  it('reads a saved number the user hid', () => {
    expect(readMyPhone({ phone_e164: '+971501234567', phone_discoverable: false }))
      .toEqual({ e164: '+971501234567', discoverable: false });
  });

  it('treats a null or empty number as none', () => {
    expect(readMyPhone({ phone_e164: null, phone_discoverable: false }))
      .toEqual({ e164: null, discoverable: false });
    expect(readMyPhone({ phone_e164: '', phone_discoverable: false }))
      .toEqual({ e164: null, discoverable: false });
  });

  it('never reports findable without a number, whatever the flag says', () => {
    expect(readMyPhone({ phone_e164: null, phone_discoverable: true }))
      .toEqual({ e164: null, discoverable: false });
  });

  it('only a literal true flag counts', () => {
    expect(readMyPhone({ phone_e164: '+923001234567', phone_discoverable: 'true' }))
      .toEqual({ e164: '+923001234567', discoverable: false });
  });
});

describe('discoverableForSave — the consent default', () => {
  it('the first number on file switches discovery on', () => {
    expect(discoverableForSave({ e164: null, discoverable: false })).toBe(true);
  });

  it('replacing a hidden number keeps it hidden', () => {
    expect(discoverableForSave({ e164: '+923001234567', discoverable: false })).toBe(false);
  });

  it('replacing a findable number keeps it findable', () => {
    expect(discoverableForSave({ e164: '+923001234567', discoverable: true })).toBe(true);
  });
});

describe('legacyPhoneDraft — the old device-only My Account field', () => {
  it('seeds "Add" when the server holds no number', () => {
    expect(legacyPhoneDraft(' 0300 1234567 ', { e164: null, discoverable: false })).toBe('0300 1234567');
  });

  it('is dropped when the server already holds a number (the one discovery uses wins)', () => {
    expect(legacyPhoneDraft('0300 1234567', { e164: '+971501234567', discoverable: true })).toBe('');
  });

  it('is unused when the phone columns are unavailable', () => {
    expect(legacyPhoneDraft('0300 1234567', null)).toBe('');
  });

  it('is empty when nothing was ever typed', () => {
    expect(legacyPhoneDraft(null, { e164: null, discoverable: false })).toBe('');
    expect(legacyPhoneDraft(undefined, { e164: null, discoverable: false })).toBe('');
  });
});
