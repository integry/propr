import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInstanceCatalog } from './proprApi';

describe('getInstanceCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads synthetic agents from the extended instance catalog endpoint', async () => {
    const catalog = {
      agents: [
        {
          id: 'balanced-pool-id',
          kind: 'synthetic' as const,
          alias: 'balanced-pool',
          enabled: true,
          supportedModels: ['balanced'],
          defaultModel: 'balanced',
        },
      ],
      repositories: [],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(catalog),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const response = await getInstanceCatalog();

    expect(response).toEqual(catalog);
    expect(fetchSpy).toHaveBeenCalledWith('/api/instance/catalog', { credentials: 'include' });
    expect(response.agents).toContainEqual(expect.objectContaining({ kind: 'synthetic' }));
  });
});
