import { beforeEach, expect, it, vi } from 'vitest';

const apiClientMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  handleApiResponse: vi.fn(),
}));

vi.mock('./apiClient', () => ({
  API_BASE_URL: 'https://api.gitfix.dev',
  ...apiClientMocks,
}));

import { AGENT_TANK_LEGACY_BACKEND_MESSAGE } from '@propr/shared';
import { enableAgentTank, postTaskFollowup, updateAgentTankSettings } from './revertApi';

beforeEach(() => {
  apiClientMocks.apiFetch.mockReset();
  apiClientMocks.handleApiResponse.mockReset();
  apiClientMocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: true })));
});

it('encodes a task ID before placing it in the follow-up URL', async () => {
  await postTaskFollowup('task-opencode-openai/gpt-5.6-luna', '/review', 'pull_request');

  expect(apiClientMocks.apiFetch).toHaveBeenCalledWith(
    'https://api.gitfix.dev/api/tasks/task-opencode-openai%2Fgpt-5.6-luna/followup',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ body: '/review', target: 'pull_request' }),
    }),
  );
});

/** Answer the settings GET with a body, and every write with `{ success: true }`. */
function backendAnswering(settings: Record<string, unknown>) {
  apiClientMocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ success: true }))
      : new Response(JSON.stringify(settings)));
}

/** The parsed body of the last POST the client made, if any. */
function lastPostBody(): unknown {
  const post = apiClientMocks.apiFetch.mock.calls
    .map(call => call[1] as RequestInit | undefined)
    .filter(init => init?.method === 'POST')
    .at(-1);
  return post ? JSON.parse(post.body as string) : undefined;
}

it('sends the derived enabled flag so a pre-mode backend does not store the opposite state', async () => {
  // An older backend handler reads `{ enabled, url }` and saves
  // `enabled: !!enabled`. A body carrying only `mode` therefore disables
  // tracking while the server still answers success.
  backendAnswering({ enabled: true, url: 'http://legacy:3456' });

  await updateAgentTankSettings({ mode: 'external', url: 'http://legacy:3456' });
  expect(lastPostBody()).toEqual({ mode: 'external', enabled: true, url: 'http://legacy:3456' });

  await updateAgentTankSettings({ mode: 'disabled', url: 'http://legacy:3456' });
  expect(lastPostBody()).toEqual({ mode: 'disabled', enabled: false, url: 'http://legacy:3456' });

  await enableAgentTank('external', 'http://legacy:3456');
  expect(lastPostBody()).toEqual({ mode: 'external', enabled: true, url: 'http://legacy:3456' });
});

it('refuses a bundled write against a backend that does not understand modes', async () => {
  backendAnswering({ enabled: true, url: 'http://legacy:3456' });

  await expect(updateAgentTankSettings({ mode: 'bundled', url: 'http://legacy:3456' }))
    .rejects.toThrow(AGENT_TANK_LEGACY_BACKEND_MESSAGE);
  await expect(enableAgentTank('bundled')).rejects.toThrow(AGENT_TANK_LEGACY_BACKEND_MESSAGE);
  // Reporting success while persisting "external at the saved URL" is exactly
  // what this guard exists to prevent, so nothing may be written.
  expect(lastPostBody()).toBeUndefined();
});

it('writes bundled mode when the backend reports one', async () => {
  backendAnswering({ mode: 'disabled', enabled: false, url: 'http://0.0.0.0:3456' });

  await updateAgentTankSettings({ mode: 'bundled', url: 'http://0.0.0.0:3456' });

  expect(lastPostBody()).toEqual({ mode: 'bundled', enabled: true, url: 'http://0.0.0.0:3456' });
});
