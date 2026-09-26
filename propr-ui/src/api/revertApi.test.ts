import { beforeEach, expect, it, vi } from 'vitest';

const apiClientMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  handleApiResponse: vi.fn(),
}));

vi.mock('./apiClient', () => ({
  API_BASE_URL: 'https://api.gitfix.dev',
  ...apiClientMocks,
}));

import { postTaskFollowup } from './revertApi';

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
