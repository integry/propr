import type { GoalDetail, GoalEvent, GoalMessage } from '../../api/goalsApi';

export const timestamp = '2026-08-31T10:00:00.000Z';

export const goalEvent = (
  sequence: number,
  type: GoalEvent['type'] = 'stdout',
  content = `line ${sequence}`
): GoalEvent => ({
  goalId: 'goal-1', sequence, type, content, source: 'codex', timestamp,
  turnId: sequence < 3 ? 'turn-1' : 'turn-2', payload: null,
});

export const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

export const goalMessage = (sequence: number, state: GoalMessage['state']): GoalMessage => ({
  messageId: `message-${sequence}`, sequence, body: `message ${sequence}`, predefinedKind: null, state,
  responseSource: state === 'acknowledged' ? 'provider' : null,
  response: state === 'acknowledged' ? 'Provider response' : null,
  error: state === 'failed' ? 'Delivery failed' : null, createdAt: timestamp, updatedAt: timestamp,
});

export const goalDetail: GoalDetail = {
  goal: {
    goalId: 'goal-1', objective: 'Ship the operator page', repository: 'integry/propr', state: 'running', agent: 'codex',
    requestedModel: 'gpt-new', effectiveModel: 'gpt-old', maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: true,
    ultrafixGoal: 8, ultrafixMaxCycles: 10, version: 4, terminalReason: null, createdAt: timestamp, updatedAt: timestamp,
  },
  hierarchy: { nodes: [], dependencies: [] }, providerTodos: [], messages: [],
  stats: {
    issues: { total: 5, ready: 2, active: 1, processed: 3, failed: 1, blocked: 1 },
    pullRequests: { open: 2, reviewPending: 1, ultrafixPending: 1, mergeReady: 1, merged: 1 },
    tokens: { total: 175, byModel: [{ provider: 'openai', model: 'gpt-old', input: 100, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 10, total: 175 }] },
    time: { elapsedSeconds: 100, activeSeconds: 70, pausedSeconds: 20, recoverySeconds: 10 },
  },
  recovery: { state: 'healthy', attempt: 0, reason: null }, epicPrUrl: null, completionBlockers: [], latestSequence: 5,
};
