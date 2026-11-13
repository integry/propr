import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: api.fetch, handleApiResponse: async (response: Response) => { if (!response.ok) throw new Error('Request failed'); } }));
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
  // No submission exists under the key yet: it is submitted new, without the selection.
  api.fetch.mockImplementationOnce(async () => new Response('{}', { status: 404 }));
  await submitTask('submission', legacy as Parameters<typeof submitTask>[1], []);
  expect(api.fetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([['/api/task-submissions/submission/retry', 'POST'], ['/api/task-submissions', 'POST']]);
  const init = api.fetch.mock.lastCall![1] as RequestInit;
  expect(lastHeaders().get('X-ProPR-Extensions')).toBeNull();
  expect(lastHeaders().get('Idempotency-Key')).toBe('submission');
  expect(JSON.parse((init.body as FormData).get('payload') as string)).toEqual({ repository: 'example/repo', instruction: 'Fix it' });
});
it('an older draft already accepted under its key resumes that submission instead of replaying a changed payload', async () => {
  const legacy = { repository: 'example/repo', instruction: 'Fix it', extensionProfile: { instanceId: 'instance', profileId: 'old', revision: 1 } };
  const receipt = { id: 'id', state: 'queued', issueNumber: 7, issueUrl: null, taskId: 'task', error: null };
  api.fetch.mockImplementationOnce(async () => new Response(JSON.stringify(receipt), { status: 200 }));
  expect(await submitTask('accepted', legacy as Parameters<typeof submitTask>[1], [])).toEqual(receipt);
  expect(api.fetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([['/api/task-submissions/accepted/retry', 'POST']]);
  // Other failures are reported, never turned into a new submission.
  api.fetch.mockReset(); api.fetch.mockImplementation(async () => new Response('{}', { status: 503 }));
  await expect(submitTask('accepted', legacy as Parameters<typeof submitTask>[1], [])).rejects.toMatchObject({ status: 503 });
  expect(api.fetch).toHaveBeenCalledTimes(1);
});
it('a current draft submits directly', async () => {
  await submitTask('current', { repository: 'example/repo', instruction: 'Fix it' }, []);
  expect(api.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/task-submissions']);
});
