import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: api.fetch, handleApiResponse: async () => undefined }));
import { updateAutomationDefinition } from './automationDefinitionsApi';
import { submitTask } from './taskSubmissions';
const selection = { instanceId: 'instance', profileId: 'profile', revision: 1 };
beforeEach(() => { api.fetch.mockReset(); api.fetch.mockImplementation(async () => new Response('{}', { status: 200 })); });
it('automation requests send the preflight header only when selecting a profile', async () => {
  for (const patch of [{ prompt: 'Edit' }, { extensionProfile: null }, { extensionProfile: selection }]) {
    await updateAutomationDefinition('automation', patch, 1);
    const init = api.fetch.mock.lastCall![1] as RequestInit;
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init.headers).get('X-ProPR-Extensions')).toBe('extensionProfile' in patch && patch.extensionProfile ? '1' : null);
  }
});
it('task multipart requests send the preflight header only when selecting a profile', async () => {
  for (const extensionProfile of [undefined, null, selection]) {
    await submitTask('submission', { repository: 'example/repo', instruction: 'Fix it', extensionProfile }, []);
    const init = api.fetch.mock.lastCall![1] as RequestInit;
    expect(new Headers(init.headers).get('X-ProPR-Extensions')).toBe(extensionProfile ? '1' : null);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('submission');
  }
});
