import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAgentHealth } from './agentHealthApi';

const result = { agentId: 'codex/primary', status: 'ready', model: 'gpt-6-luna' };
const response = () => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('agent health API', () => {
  it('shares concurrent authenticated probes but issues a fresh request after completion', async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = checkAgentHealth('codex/primary');
    const two = checkAgentHealth('codex/primary');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/agents/codex%2Fprimary/health', expect.objectContaining({
      method: 'POST', credentials: 'include', signal: expect.any(AbortSignal),
    }));
    finish(response());
    expect(await one).toEqual(result);
    expect(await two).toEqual(result);
    fetch.mockResolvedValue(response());
    await checkAgentHealth('codex/primary');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not share probes for edited configurations or explicit retries', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
    await Promise.all([
      checkAgentHealth('codex/primary', 'old-configuration'),
      checkAgentHealth('codex/primary', 'new-configuration'),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns provider errors for display and rejects HTTP failures for retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      agentId: 'codex/primary', status: 'error', error: 'Login expired',
    }), { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await checkAgentHealth('codex/primary')).toMatchObject({ status: 'error', error: 'Login expired' });
    await expect(checkAgentHealth('codex/primary')).rejects.toThrow();
  });
});
