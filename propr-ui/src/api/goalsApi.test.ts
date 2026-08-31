import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as goalsApi from './goalsApi';

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
  ultrafixGoal: 8,
  ultrafixMaxCycles: 10,
  version: 3,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T01:00:00.000Z',
};

const wireSummary = {
  ...wireGoal,
  nodeCount: 6,
  activeNodeCount: 2,
  latestSequence: 12,
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

  it('uses only the bounded canonical keyset query and returns cursor data without invented totals', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ goals: [wireSummary], nextCursor: 'bmV4dA' }));

    const result = await goalsApi.getGoals({
      limit: 50,
      state: 'running',
      repository: 'integry/propr',
      search: 'durable',
      cursor: 'Y3Vyc29y',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/goals?limit=50&state=running&repository=integry%2Fpropr&search=durable&cursor=Y3Vyc29y',
      { credentials: 'include', signal: undefined }
    );
    expect(result).toEqual({
      goals: [{ ...wireSummary, projection: { status: 'not-yet-projected' } }],
      nextCursor: 'bmV4dA',
    });
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('hasMore');
  });

  it.each([
    [{ limit: 0 }, 'query.limit'],
    [{ limit: 101 }, 'query.limit'],
    [{ search: 'x'.repeat(201) }, 'query.search'],
    [{ cursor: 'not+a+base64url' }, 'query.cursor'],
  ])('rejects an invalid bounded query before sending it: %j', async (options, path) => {
    await expect(goalsApi.getGoals(options)).rejects.toThrow(path);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['goalId', undefined, 'response.goals[0].goalId'],
    ['objective', undefined, 'response.goals[0].objective'],
    ['state', 'active', 'response.goals[0].state'],
    ['updatedAt', '', 'response.goals[0].updatedAt'],
    ['nodeCount', undefined, 'response.goals[0].nodeCount'],
  ])('rejects malformed or missing %s instead of creating a plausible goal', async (field, value, path) => {
    fetchMock.mockResolvedValue(jsonResponse({ goals: [{ ...wireSummary, [field]: value }], nextCursor: null }));
    await expect(goalsApi.getGoals()).rejects.toThrow(path);
  });

  it('requires a complete ready statistics projection and never fills missing values with zero', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      goals: [{ ...wireSummary, projection: { status: 'ready', checklist: { total: 4, completed: 1 } } }],
      nextCursor: null,
    }));
    await expect(goalsApi.getGoals()).rejects.toThrow('projection.issues');
  });

  it('requires the typed list envelope including nextCursor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ goals: [wireSummary] }));
    await expect(goalsApi.getGoals()).rejects.toThrow('response.nextCursor');
  });

  it('replays creation after token refresh with the identical body and idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 'TOKEN_REFRESHED' }, 401))
      .mockResolvedValueOnce(jsonResponse({ goal: wireGoal }, 201));
    const params: goalsApi.CreateGoalParams = {
      objective: wireGoal.objective,
      repository: wireGoal.repository,
      agent: 'codex',
      model: 'gpt-requested',
      maxActiveTasks: 4,
      mergePolicy: 'auto',
      ultrafixEnabled: true,
      ultrafixGoal: 8,
      ultrafixMaxCycles: 10,
    };

    await expect(goalsApi.createGoal(params, 'goal-create-key')).resolves.toEqual(wireGoal);
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

  it('preserves the idempotency-conflict code for an actionable UI path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'goal_idempotency_conflict', error: 'Key payload differs' }, 409));
    const params: goalsApi.CreateGoalParams = {
      objective: wireGoal.objective,
      repository: wireGoal.repository,
      agent: 'codex',
      model: 'gpt-requested',
      maxActiveTasks: 4,
      mergePolicy: 'manual',
      ultrafixEnabled: false,
      ultrafixGoal: null,
      ultrafixMaxCycles: null,
    };
    await expect(goalsApi.createGoal(params, 'conflicting-key')).rejects.toMatchObject({
      code: 'goal_idempotency_conflict',
      status: 409,
      message: 'Key payload differs',
    });
  });

  it('keeps the read helper but does not expose unkeyed lifecycle mutation helpers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ goal: wireGoal }));
    await expect(goalsApi.getGoal('goal/special')).resolves.toEqual(wireGoal);
    expect(fetchMock).toHaveBeenCalledWith('/api/goals/goal%2Fspecial', { credentials: 'include' });
    expect(goalsApi).not.toHaveProperty('pauseGoal');
    expect(goalsApi).not.toHaveProperty('resumeGoal');
    expect(goalsApi).not.toHaveProperty('cancelGoal');
  });
});
