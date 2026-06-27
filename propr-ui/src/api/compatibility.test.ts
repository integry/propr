import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPR_API_COMPATIBILITY, PROPR_VERSION } from '@propr/shared';

const loadCheck = async () => {
  const mod = await import('./compatibility');
  return mod.checkProprApiCompatibility;
};

describe('checkProprApiCompatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete window.__PROPR_CONFIG__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete window.__PROPR_CONFIG__;
  });

  it('accepts a compatible local API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        version: PROPR_VERSION,
        apiCompatibility: PROPR_API_COMPATIBILITY,
        uiCompatibility: PROPR_API_COMPATIBILITY,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const checkProprApiCompatibility = await loadCheck();

    await expect(checkProprApiCompatibility()).resolves.toMatchObject({
      compatible: true,
      apiCompatibility: PROPR_API_COMPATIBILITY,
      apiVersion: PROPR_VERSION,
    });
  });

  it('reports older APIs that do not expose compatibility metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));

    const checkProprApiCompatibility = await loadCheck();

    await expect(checkProprApiCompatibility()).resolves.toMatchObject({
      compatible: false,
      reason: 'missing',
    });
  });

  it('surfaces unreachable APIs as check errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network failed'));

    const checkProprApiCompatibility = await loadCheck();

    await expect(checkProprApiCompatibility()).rejects.toThrow('Cannot reach the local ProPR API');
  });

  it('uses the runtime API base URL when checking compatibility', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://abc123.proxy.propr.dev' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        version: PROPR_VERSION,
        apiCompatibility: PROPR_API_COMPATIBILITY,
        uiCompatibility: PROPR_API_COMPATIBILITY,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const checkProprApiCompatibility = await loadCheck();
    await checkProprApiCompatibility();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://abc123.proxy.propr.dev/api/compatibility',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' })
    );
  });
});
