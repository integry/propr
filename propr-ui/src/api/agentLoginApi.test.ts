import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAgentLogin,
  getAgentLogin,
  sendAgentLoginInput,
  startAgentLogin,
} from './agentLoginApi';

const session = {
  id: 'login-1',
  agentId: 'codex/primary',
  agentType: 'codex' as const,
  status: 'running' as const,
  output: '',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  expiresAt: '2026-07-29T00:10:00.000Z',
};

describe('agent login API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses authenticated, encoded session endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await startAgentLogin('codex/primary');
    await getAgentLogin('codex/primary', 'login/1');
    await sendAgentLoginInput('codex/primary', 'login/1', 'ABCD\n');
    await cancelAgentLogin('codex/primary', 'login/1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/agents/codex%2Fprimary/login-sessions', {
      method: 'POST',
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/agents/codex%2Fprimary/login-sessions/login%2F1', {
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/agents/codex%2Fprimary/login-sessions/login%2F1/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ABCD\n' }),
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/agents/codex%2Fprimary/login-sessions/login%2F1', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('surfaces a safe backend conflict message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: 'A login is already active for this agent credential directory',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(startAgentLogin('codex-1')).rejects.toThrow(
      'A login is already active for this agent credential directory',
    );
  });
});
