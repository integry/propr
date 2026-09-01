import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl, resolveDesktopAdapters } from './browserAdapters';
import { DESKTOP_AUTHENTICATION_COMPLETE_EVENT } from './types';

describe('desktop browser fixtures', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
    delete window.__PROPR_DESKTOP__;
    vi.restoreAllMocks();
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

  it('does not enable query-driven fixtures in production mode', () => {
    vi.stubEnv('DEV', false);
    window.history.replaceState(null, '', '/?desktop-fixture=connected');

    expect(resolveDesktopAdapters()).toBeNull();
  });

  it('normalizes safe instance origins and rejects non-http protocols', () => {
    expect(normalizeBaseUrl(' https://propr.example.com/// ')).toBe('https://propr.example.com');
    expect(() => normalizeBaseUrl('file:///tmp/propr')).toThrow(/http/);
    expect(() => normalizeBaseUrl('https://user:secret@example.com')).toThrow(/credentials/);
  });

  it('resolves fixture authentication only after the matching desktop completion signal', async () => {
    window.history.replaceState(null, '', '/?desktop-fixture=connected');
    const adapters = resolveDesktopAdapters();
    const profile = (await adapters?.profiles.list())?.[0];
    expect(adapters).not.toBeNull();
    expect(profile).toBeDefined();

    let completed = false;
    const authentication = adapters!.authentication.authenticate(profile!);
    void authentication.then(() => { completed = true; });
    await Promise.resolve();

    expect(completed).toBe(false);
    window.dispatchEvent(new CustomEvent(DESKTOP_AUTHENTICATION_COMPLETE_EVENT, {
      detail: { profileId: 'another-profile' },
    }));
    await Promise.resolve();
    expect(completed).toBe(false);

    window.dispatchEvent(new CustomEvent(DESKTOP_AUTHENTICATION_COMPLETE_EVENT, {
      detail: { profileId: profile!.id },
    }));
    await expect(authentication).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });
});
