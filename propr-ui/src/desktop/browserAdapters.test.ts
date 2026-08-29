import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBaseUrl, resolveDesktopAdapters } from './browserAdapters';

describe('desktop browser fixtures', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    delete window.__PROPR_DESKTOP__;
  });

  it('does not enable desktop presentation for the normal hosted web app', () => {
    expect(resolveDesktopAdapters()).toBeNull();
  });

  it('explicitly enables deterministic screenshot fixtures', async () => {
    window.history.replaceState(null, '', '/?desktop-fixture=recents');
    const adapters = resolveDesktopAdapters();
    expect(adapters).not.toBeNull();
    await expect(adapters?.profiles.list()).resolves.toHaveLength(2);
  });

  it('normalizes safe instance origins and rejects non-http protocols', () => {
    expect(normalizeBaseUrl(' https://propr.example.com/// ')).toBe('https://propr.example.com');
    expect(() => normalizeBaseUrl('file:///tmp/propr')).toThrow(/http/);
    expect(() => normalizeBaseUrl('https://user:secret@example.com')).toThrow(/credentials/);
  });
});

