import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: api.fetch, handleApiResponse: async () => undefined }));
import { createAutomationDefinition, updateAutomationDefinition } from './automationDefinitionsApi';
import { submitTask } from './taskSubmissions';
const extensions = { servers: ['docs'], skills: ['075bb20e-4156-4f6c-a7e2-20fd6c8ba84e'] };
beforeEach(() => { api.fetch.mockReset(); api.fetch.mockImplementation(async () => new Response('{}', { status: 200 })); });
const lastHeaders = () => new Headers((api.fetch.mock.lastCall![1] as RequestInit).headers);
it('automation requests send the preflight header whenever they carry extensions', async () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ prompt: 'Edit' }, null],
    [{ prompt: 'Edit', extensions: undefined }, null],
    [{ extensions: null }, '1'],
    [{ extensions: { servers: [], skills: [] } }, '1'],
    [{ extensions }, '1'],
  ];
  for (const [patch, expected] of cases) {
    await updateAutomationDefinition('automation', patch, 1);
    expect(lastHeaders().get('Content-Type')).toBe('application/json');
    expect(lastHeaders().get('X-ProPR-Extensions')).toBe(expected);
  }
  await createAutomationDefinition({ name: 'Weekly', prompt: 'Review', extensions });
  expect(lastHeaders().get('X-ProPR-Extensions')).toBe('1');
  await createAutomationDefinition({ name: 'Weekly', prompt: 'Review' });
  expect(lastHeaders().get('X-ProPR-Extensions')).toBeNull();
});
it('task submissions never send extension selection, even from an older draft', async () => {
  const legacy = { repository: 'example/repo', instruction: 'Fix it', extensionProfile: { instanceId: 'instance', profileId: 'old', revision: 1 }, extensionAllowWrite: true };
  await submitTask('submission', legacy as Parameters<typeof submitTask>[1], []);
  const init = api.fetch.mock.lastCall![1] as RequestInit;
  expect(lastHeaders().get('X-ProPR-Extensions')).toBeNull();
  expect(lastHeaders().get('Idempotency-Key')).toBe('submission');
  expect(JSON.parse((init.body as FormData).get('payload') as string)).toEqual({ repository: 'example/repo', instruction: 'Fix it' });
});
