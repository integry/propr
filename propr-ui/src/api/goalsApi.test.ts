import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelGoal, createGoal, getGoal, getGoals, pauseGoal, resumeGoal } from './goalsApi';

const wireGoal = {
  goalId: 'goal-1',
  objective: 'Ship durable goal orchestration',
  repository: 'integry/propr',
  state: 'running',
  agent: 'codex',
  requestedModel: 'gpt-requested',
  effectiveModel: 'gpt-effective',
  maxActiveTasks: 4,
  mergePolicy: 'auto',
  ultrafixEnabled: true,
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('goalsApi', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('serializes list filters and normalizes the #2006 summary contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ goals: [wireGoal], nextCursor: 'next' }));

    const result = await getGoals({ page: 2, limit: 50, state: 'running', repository: 'integry/propr', search: 'durable' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/goals?page=2&limit=50&state=running&repository=integry%2Fpropr&search=durable',
      { credentials: 'include' }
    );
    expect(result).toMatchObject({ total: 1, hasMore: true });
    expect(result.goals[0]).toMatchObject({
      id: 'goal-1',
      agentAlias: 'codex',
      maxConcurrentTasks: 4,
      autoMergePolicy: 'auto',
      requestedModel: 'gpt-requested',
      effectiveModel: 'gpt-effective',
      checklistTotal: 0,
    });
  });

  it('replays creation after token refresh with the same body and idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 'TOKEN_REFRESHED' }, 401))
      .mockResolvedValueOnce(jsonResponse({ goal: wireGoal }, 201));
    const params = {
      objective: wireGoal.objective,
      repository: wireGoal.repository,
      agent: 'codex',
      model: 'gpt-requested',
      maxActiveTasks: 4,
      mergePolicy: 'auto' as const,
      ultrafixEnabled: true,
      ultrafixGoal: 8,
      ultrafixMaxCycles: 10,
    };

    const result = await createGoal(params, 'goal-create-key');

    expect(result.id).toBe('goal-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify(params),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'goal-create-key' },
      });
    }
  });

  it('surfaces actionable API errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'goal_validation_error', error: 'Objective is invalid' }, 422));

    await expect(getGoals()).rejects.toThrow('Objective is invalid');
  });

  it.each([
    ['get', getGoal, '/api/goals/goal%2Fspecial', undefined],
    ['pause', pauseGoal, '/api/goals/goal%2Fspecial/pause', 'POST'],
    ['resume', resumeGoal, '/api/goals/goal%2Fspecial/resume', 'POST'],
    ['cancel', cancelGoal, '/api/goals/goal%2Fspecial/cancel', 'POST'],
  ])('sends the %s request and accepts wrapped goal responses', async (_name, request, url, method) => {
    fetchMock.mockResolvedValue(jsonResponse({ goal: wireGoal }));

    await expect(request('goal/special')).resolves.toMatchObject({ id: 'goal-1', state: 'running' });
    expect(fetchMock).toHaveBeenCalledWith(url, method
      ? { method, credentials: 'include' }
      : { credentials: 'include' });
  });
});
