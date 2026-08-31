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

const wireDetail = {
  goal: { ...wireGoal, terminalReason: null },
  hierarchy: { nodes: [], dependencies: [] },
  providerTodos: [], messages: [],
  stats: {
    issues: { total: 0, ready: 0, active: 0, processed: 0, failed: 0, blocked: 0 },
    pullRequests: { open: 0, reviewPending: 0, ultrafixPending: 0, mergeReady: 0, merged: 0 },
    tokens: { total: 0, byModel: [] },
    time: { elapsedSeconds: 10, activeSeconds: 8, pausedSeconds: 1, recoverySeconds: 1 },
  },
  recovery: { state: 'healthy', attempt: 0, reason: null },
  epicPrUrl: null, completionBlockers: [], latestSequence: 0,
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
    [{ search: '🚀'.repeat(201) }, 'query.search'],
    [{ cursor: 'not+a+base64url' }, 'query.cursor'],
  ])('rejects an invalid bounded query before sending it: %j', async (options, path) => {
    await expect(goalsApi.getGoals(options)).rejects.toThrow(path);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes search like the backend and bounds it by Unicode code points', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ goals: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ goals: [], nextCursor: null }));

    await goalsApi.getGoals({ search: `  ${'🚀'.repeat(200)}  ` });
    const [unicodeUrl] = fetchMock.mock.calls[0];
    expect(new URL(unicodeUrl as string, 'http://localhost').searchParams.get('search')).toBe('🚀'.repeat(200));

    await goalsApi.getGoals({ search: '   \t  ' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/goals');
  });

  it.each(['bad+cursor', 'bad/cursor', 'bad=cursor', '', 'x'.repeat(1025)])(
    'rejects malformed response nextCursor %j at the response boundary',
    async nextCursor => {
      fetchMock.mockResolvedValue(jsonResponse({ goals: [wireSummary], nextCursor }));
      const error = await goalsApi.getGoals().catch(caught => caught);
      expect(error).toBeInstanceOf(goalsApi.GoalContractError);
      expect(error).toHaveProperty('message', expect.stringContaining('response.nextCursor'));
    }
  );

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

  it('strictly decodes authoritative active time in a ready projection', async () => {
    const projection = {
      status: 'ready',
      checklist: { total: 4, completed: 1 },
      issues: { total: 5, ready: 2, active: 1, processed: 3, failed: 0, blocked: 1 },
      pullRequests: { open: 1, reviewPending: 0, ultrafixPending: 0, mergeReady: 1, merged: 2 },
      tokens: { total: 100 },
      time: { elapsedSeconds: 900, activeSeconds: 610, pausedSeconds: 200 },
      latestEvent: null,
      connectionState: 'connected',
      epicPrUrl: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ goals: [{ ...wireSummary, projection }], nextCursor: null }));
    await expect(goalsApi.getGoals()).resolves.toMatchObject({
      goals: [{ projection: { time: { elapsedSeconds: 900, activeSeconds: 610, pausedSeconds: 200 } } }],
    });

    const { activeSeconds: _activeSeconds, ...missingActiveTime } = projection.time;
    fetchMock.mockResolvedValueOnce(jsonResponse({
      goals: [{ ...wireSummary, projection: { ...projection, time: missingActiveTime } }],
      nextCursor: null,
    }));
    await expect(goalsApi.getGoals()).rejects.toThrow('projection.time.activeSeconds');
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

  it('validates and sends the same canonical trimmed Unicode objective', async () => {
    const canonicalObjective = `${'🚀'.repeat(3998)}e\u0301`;
    const params: goalsApi.CreateGoalParams = {
      objective: ` \n${canonicalObjective}\t `,
      repository: wireGoal.repository,
      agent: 'codex',
      model: 'gpt-requested',
      maxActiveTasks: 4,
      mergePolicy: 'manual',
      ultrafixEnabled: false,
      ultrafixGoal: null,
      ultrafixMaxCycles: null,
    };
    expect(Array.from(canonicalObjective)).toHaveLength(4000);
    fetchMock.mockResolvedValue(jsonResponse({ goal: { ...wireGoal, objective: canonicalObjective } }, 201));

    await goalsApi.createGoal(params, 'goal-create-key');
    expect(fetchMock).toHaveBeenCalledWith('/api/goals', expect.objectContaining({
      body: JSON.stringify({ ...params, objective: canonicalObjective }),
    }));

    fetchMock.mockClear();
    await expect(goalsApi.createGoal({ ...params, objective: ` ${canonicalObjective}x ` }, 'goal-create-key'))
      .rejects.toBeInstanceOf(goalsApi.GoalContractError);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each([403, 404])('types HTTP %s as access loss even when a non-goal code is returned', async status => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN', error: 'Unavailable' }, status));
    await expect(goalsApi.getGoal('goal-1')).rejects.toMatchObject({ status, code: status === 403 ? 'goal_access_denied' : 'goal_not_found' });
  });

  it('strictly reads detail and sends keyed, versioned lifecycle mutations', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ...wireDetail, goal: { ...wireDetail.goal, goalId: 'goal/special' } }))
      .mockResolvedValueOnce(jsonResponse({ goal: { ...wireGoal, goalId: 'goal/special', state: 'pausing', version: 4 } }));
    await expect(goalsApi.getGoal('goal/special')).resolves.toEqual({
      ...wireDetail,
      goal: { ...wireDetail.goal, goalId: 'goal/special' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/goals/goal%2Fspecial', { credentials: 'include', signal: undefined });
    await expect(goalsApi.pauseGoal('goal/special', 3, 'pause-key')).resolves.toMatchObject({ state: 'pausing', version: 4 });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/goals/goal%2Fspecial/pause', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedVersion: 3 }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pause-key' },
    }));
  });

  it('rejects a detail response for another goal before exposing it to the UI', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...wireDetail, goal: { ...wireDetail.goal, goalId: 'goal-2' } }));

    const error = await goalsApi.getGoal('goal-1').catch(caught => caught);
    expect(error).toBeInstanceOf(goalsApi.GoalContractError);
    expect(error).toHaveProperty('message', expect.stringContaining('response.goal.goalId'));
  });

  it('rejects a lifecycle mutation response for another goal before it can be committed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ goal: { ...wireGoal, goalId: 'goal-2', state: 'pausing', version: 4 } }));

    const error = await goalsApi.pauseGoal('goal-1', 3, 'pause-key').catch(caught => caught);
    expect(error).toBeInstanceOf(goalsApi.GoalContractError);
    expect(error).toHaveProperty('message', expect.stringContaining('response.goal.goalId'));
  });

  it.each([
    ['providerTodos', (value: typeof wireDetail) => { delete (value as Partial<typeof wireDetail>).providerTodos; }, 'response.providerTodos'],
    ['issues.ready', (value: typeof wireDetail) => { delete (value.stats.issues as Partial<typeof value.stats.issues>).ready; }, 'response.stats.issues.ready'],
    ['latestSequence', (value: typeof wireDetail) => { delete (value as Partial<typeof wireDetail>).latestSequence; }, 'response.latestSequence'],
  ])('rejects a detail response missing canonical %s', async (_field, mutate, path) => {
    const malformed = JSON.parse(JSON.stringify(wireDetail)) as typeof wireDetail;
    mutate(malformed);
    fetchMock.mockResolvedValue(jsonResponse(malformed));
    await expect(goalsApi.getGoal('goal-1')).rejects.toThrow(path);
  });

  it('pages replay history with mutually exclusive cursors and one canonical event envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      events: [{ goalId: 'goal-1', sequence: 8, type: 'stderr', source: 'output', content: '<b>inert</b>', payload: { streamId: 'stderr' }, timestamp: wireGoal.updatedAt, turnId: null }],
      previousCursor: 8, nextCursor: 8, hasMoreBefore: true,
    }));
    await expect(goalsApi.getGoalEvents('goal-1', { afterSequence: 7, limit: 200 })).resolves.toEqual({
      events: [{ goalId: 'goal-1', sequence: 8, type: 'stderr', source: 'output', content: '<b>inert</b>', payload: { streamId: 'stderr' }, timestamp: wireGoal.updatedAt, turnId: null }],
      previousCursor: 8, nextCursor: 8, hasMoreBefore: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/goals/goal-1/events?afterSequence=7&limit=200', { credentials: 'include', signal: undefined });
    await expect(goalsApi.getGoalEvents('goal-1', { afterSequence: 7, beforeSequence: 8 })).rejects.toThrow('event cursor');
  });

  it.each([
    ['type', { eventType: 'stderr' }],
    ['source', { kind: 'output' }],
    ['timestamp', { createdAt: wireGoal.updatedAt }],
    ['type', { payload: { type: 'stderr' } }],
    ['type', { payload: { stream: 'stderr' } }],
    ['content', {}],
    ['payload', {}],
    ['turnId', {}],
  ])('rejects event aliases or omission at canonical field %s', async (field, alias) => {
    const canonical = { goalId: 'goal-1', sequence: 8, type: 'stderr', source: 'output', content: 'line', payload: null, timestamp: wireGoal.updatedAt, turnId: null };
    const malformed = { ...canonical, [field]: undefined, ...alias };
    fetchMock.mockResolvedValue(jsonResponse({ events: [malformed], previousCursor: 8, nextCursor: 8, hasMoreBefore: false }));
    await expect(goalsApi.getGoalEvents('goal-1')).rejects.toThrow(`response.events[0].${field}`);
  });

  it('rejects queued as a non-canonical durable message state', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: {
      messageId: 'message-1', sequence: 9, body: 'Status?', predefinedKind: null, state: 'queued', responseSource: null,
      response: null, error: null, createdAt: wireGoal.createdAt, updatedAt: wireGoal.updatedAt,
    } }, 201));
    await expect(goalsApi.sendGoalMessage('goal-1', { body: 'Status?' }, 'message-key')).rejects.toMatchObject({
      name: 'GoalMutationUncertainError',
      cause: expect.objectContaining({ name: 'GoalContractError', message: expect.stringContaining('response.message.state') }),
    });
  });

  it('distinguishes pre-dispatch validation from a malformed 2xx mutation response', async () => {
    await expect(goalsApi.sendGoalMessage('goal-1', { body: '   ' }, 'message-key')).rejects.toBeInstanceOf(goalsApi.GoalContractError);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ message: { body: 'missing canonical fields' } }, 200));
    await expect(goalsApi.sendGoalMessage('goal-1', { body: 'Status?' }, 'message-key')).rejects.toBeInstanceOf(goalsApi.GoalMutationUncertainError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('validates and sends the same canonical trimmed Unicode message', async () => {
    const canonicalBody = `${'🚀'.repeat(3998)}e\u0301`;
    const rawBody = ` \n${canonicalBody}\t `;
    const wireMessage = { messageId: 'message-1', sequence: 9, body: canonicalBody, predefinedKind: null, state: 'delivered', responseSource: null, response: null, error: null, createdAt: wireGoal.createdAt, updatedAt: wireGoal.updatedAt };
    expect(Array.from(canonicalBody)).toHaveLength(4000);
    fetchMock.mockResolvedValue(jsonResponse({ message: wireMessage }, 201));

    await expect(goalsApi.sendGoalMessage('goal-1', { body: rawBody }, 'message-key')).resolves.toEqual(wireMessage);
    expect(fetchMock).toHaveBeenCalledWith('/api/goals/goal-1/messages', expect.objectContaining({
      body: JSON.stringify({ body: canonicalBody }),
    }));

    fetchMock.mockClear();
    await expect(goalsApi.sendGoalMessage('goal-1', { body: ` ${canonicalBody}x ` }, 'message-key')).rejects.toBeInstanceOf(goalsApi.GoalContractError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for steering and exposes all durable message states', async () => {
    const wireMessage = { messageId: 'message-1', sequence: 9, body: 'Status?', predefinedKind: 'whats_done', state: 'failed', responseSource: 'controller', response: 'Still running', error: 'Provider unavailable', createdAt: wireGoal.createdAt, updatedAt: wireGoal.updatedAt };
    await expect(goalsApi.sendGoalMessage('goal-1', { body: 'Status?' }, '')).rejects.toThrow('Idempotency-Key');
    fetchMock.mockResolvedValue(jsonResponse({ message: wireMessage }, 201));
    await expect(goalsApi.sendGoalMessage('goal-1', { body: 'Status?', predefinedKind: 'whats_done' }, 'message-key')).resolves.toEqual(wireMessage);
    expect(fetchMock).toHaveBeenCalledWith('/api/goals/goal-1/messages', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'message-key' },
    }));
  });

  it('replays steering after token refresh with the exact payload and idempotency key', async () => {
    const wireMessage = { messageId: 'message-1', sequence: 9, body: 'Status?', predefinedKind: null, state: 'delivered', responseSource: null, response: null, error: null, createdAt: wireGoal.createdAt, updatedAt: wireGoal.updatedAt };
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'TOKEN_REFRESHED' }, 401)).mockResolvedValueOnce(jsonResponse({ message: wireMessage }, 201));
    const params = { body: 'Status?' };
    await expect(goalsApi.sendGoalMessage('goal-1', params, 'stable-message-key')).resolves.toEqual(wireMessage);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({
      body: JSON.stringify(params), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'stable-message-key' },
    });
  });

  it.each(['body', 'predefinedKind', 'responseSource', 'response', 'error', 'createdAt', 'updatedAt'])(
    'rejects a durable message missing canonical %s',
    async field => {
      const malformed: Record<string, unknown> = { messageId: 'message-1', sequence: 9, body: 'Status?', predefinedKind: null, state: 'pending', responseSource: null, response: null, error: null, createdAt: wireGoal.createdAt, updatedAt: wireGoal.updatedAt };
      delete malformed[field];
      fetchMock.mockResolvedValue(jsonResponse({ message: malformed }, 201));
      await expect(goalsApi.sendGoalMessage('goal-1', { body: 'Status?' }, 'message-key')).rejects.toMatchObject({
        name: 'GoalMutationUncertainError',
        cause: expect.objectContaining({ message: expect.stringContaining(`response.message.${field}`) }),
      });
    }
  );
});
