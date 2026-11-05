import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: api.fetch, handleApiResponse: async () => undefined }));
import { triggerAutomationRun } from './automationDefinitionsApi';

beforeEach(() => {
  api.fetch.mockReset();
  api.fetch.mockImplementation(async () => new Response(JSON.stringify({ created: true, run: { id: 'run-1' } }), { status: 202 }));
});

it('declares an attended run as manual so a token or native-bridge request is not classified as api', async () => {
  await expect(triggerAutomationRun('agent 1', { trigger: 'manual', idempotencyKey: 'key-1' })).resolves.toEqual({ created: true, run: { id: 'run-1' } });
  expect(api.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = api.fetch.mock.lastCall! as [string, RequestInit];
  expect(url).toBe('/api/automation-definitions/agent%201/runs');
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include');
  expect(JSON.parse(init.body as string)).toEqual({ trigger: 'manual' });
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1');
});

it('leaves the trigger to the server when the caller does not declare one', async () => {
  await triggerAutomationRun('agent-1');
  const init = api.fetch.mock.lastCall![1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({});
  expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
});
