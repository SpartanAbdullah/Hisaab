import { describe, expect, it } from 'vitest';
import { composeCaptureAddress, isCaptureToken } from './captureAddress';

describe('captureAddress', () => {
  it('accepts only 12 lower-case hex chars as a token', () => {
    expect(isCaptureToken('0123456789ab')).toBe(true);
    expect(isCaptureToken('0123456789AB')).toBe(false);
    expect(isCaptureToken('0123456789a')).toBe(false);
    expect(isCaptureToken(null)).toBe(false);
  });
  it('composes the address and refuses a bad domain', () => {
    expect(composeCaptureAddress('0123456789ab', 'in.usehisaab.com')).toBe('hisaab-0123456789ab@in.usehisaab.com');
    expect(composeCaptureAddress('0123456789ab', ' In.UseHisaab.com ')).toBe('hisaab-0123456789ab@in.usehisaab.com');
    expect(composeCaptureAddress('0123456789ab', '')).toBeNull();
    expect(composeCaptureAddress('0123456789ab', 'not a domain')).toBeNull();
    expect(composeCaptureAddress(null, 'in.usehisaab.com')).toBeNull();
  });
});
