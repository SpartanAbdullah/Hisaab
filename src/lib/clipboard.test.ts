import { describe, expect, it, vi } from 'vitest';
import { copyText, legacyCopyText, shareText, type ShareDeps } from './clipboard';

// The founder's "copy group invite link not working" (2026-09-19): the write
// ran after the invite was minted, the WebView refused it, and the rejection
// was either swallowed or reported as "could not create invite". These pin the
// contract that replaced it: try both paths, never throw, and only ever say
// "copied" when a path actually reported success.

describe('copyText', () => {
  it('uses the async Clipboard API when it succeeds, and does not touch the legacy path', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const legacyCopy = vi.fn(() => true);
    await expect(copyText('https://usehisaab.com/join/abc', { writeText, legacyCopy })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://usehisaab.com/join/abc');
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the WebView refuses the write (NotAllowedError)', async () => {
    const refusal = Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' });
    const writeText = vi.fn(() => Promise.reject(refusal));
    const legacyCopy = vi.fn(() => true);
    await expect(copyText('link', { writeText, legacyCopy })).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith('link');
  });

  it('issues the write synchronously, i.e. still inside the tap that called it', () => {
    const writeText = vi.fn(() => Promise.resolve());
    void copyText('link', { writeText, legacyCopy: null });
    // No await yet: the call has already happened.
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy path when there is no Clipboard API (non-secure context, old WebView)', async () => {
    const legacyCopy = vi.fn(() => true);
    await expect(copyText('code', { writeText: null, legacyCopy })).resolves.toBe(true);
  });

  it('reports failure honestly when every path fails — never a false "copied"', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    await expect(copyText('link', { writeText, legacyCopy: () => false })).resolves.toBe(false);
    await expect(copyText('link', { writeText: null, legacyCopy: null })).resolves.toBe(false);
  });

  it('never throws, even when a path throws synchronously', async () => {
    const writeText = vi.fn(() => { throw new TypeError('clipboard is undefined'); });
    const legacyCopy = vi.fn(() => { throw new Error('execCommand blew up'); });
    await expect(copyText('link', { writeText, legacyCopy })).resolves.toBe(false);
  });

  it('does not wait forever on a WebView that never settles the promise', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn(() => new Promise<void>(() => {}));
      const legacyCopy = vi.fn(() => true);
      const result = copyText('link', { writeText, legacyCopy, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toBe(true);
      expect(legacyCopy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to "copy" an empty string', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await expect(copyText('', { writeText, legacyCopy: () => true })).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('legacyCopyText', () => {
  it('is a safe no-op without a DOM (SSR, the test runner)', () => {
    expect(legacyCopyText('anything')).toBe(false);
  });
});

describe('shareText', () => {
  const input = { title: 'Invite', text: 'Join Trip on Hisaab', url: 'https://usehisaab.com/join/abc' };

  it('uses the native share sheet in the Android app — it needs no user activation', async () => {
    const nativeShare = vi.fn(() => Promise.resolve({}));
    const webShare = vi.fn(() => Promise.resolve());
    const deps: ShareDeps = { isNative: () => true, nativeShare, webShare };
    await expect(shareText(input, deps)).resolves.toBe('shared');
    expect(nativeShare).toHaveBeenCalledWith(input);
    expect(webShare).not.toHaveBeenCalled();
  });

  it('uses navigator.share on the web', async () => {
    const webShare = vi.fn(() => Promise.resolve());
    await expect(shareText(input, { isNative: () => false, nativeShare: null, webShare })).resolves.toBe('shared');
    expect(webShare).toHaveBeenCalledWith({ title: input.title, text: input.text, url: input.url });
  });

  it('tells a dismissed sheet apart from a failure', async () => {
    const abort = Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    await expect(
      shareText(input, { isNative: () => false, webShare: () => Promise.reject(abort) }),
    ).resolves.toBe('cancelled');
    await expect(
      shareText(input, { isNative: () => true, nativeShare: () => Promise.reject(new Error('Share canceled')) }),
    ).resolves.toBe('cancelled');
    await expect(
      shareText(input, { isNative: () => false, webShare: () => Promise.reject(new Error('boom')) }),
    ).resolves.toBe('failed');
  });

  it('says "unavailable" when the runtime has no share sheet at all', async () => {
    await expect(shareText(input, { isNative: () => false, nativeShare: null, webShare: null })).resolves.toBe('unavailable');
  });
});
