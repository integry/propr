import type { GoalDetail, GoalEvent, GoalEventType, GoalMessage } from '../../api/goalsApi';

export const timestamp = '2026-08-31T12:00:00.000Z';

export const event = (
  sequence: number,
  eventType: GoalEventType = 'provider.output',
  content = `line ${sequence}`,
): GoalEvent => ({
  schemaVersion: 1, goalId: 'goal-1', sequence, eventType,
  kind: eventType === 'provider.output' ? 'output' : eventType === 'lifecycle.state_changed' ? 'lifecycle' : 'domain',
  payload: { provider: 'codex', sessionId: 'session-1', generation: 1, turnId: 'turn-1', stream: 'stdout', outputType: 'text', chunk: content },
  createdAt: timestamp, cursor: `cursor:${sequence}`,
});

export const goalEvent = (
  sequence: number,
  type: GoalEventType | 'stdout' | 'stderr' | 'assistant' | 'tool' = 'provider.output',
  content = `line ${sequence}`,
): GoalEvent => {
  const eventType: GoalEventType = type === 'assistant' ? 'provider.assistant'
    : type === 'tool' ? 'provider.tool'
      : ['stdout', 'stderr'].includes(type) ? 'provider.output' : type as GoalEventType;
  return {
    ...event(sequence, eventType, content),
    payload: eventType === 'provider.output'
      ? { provider: 'codex', sessionId: 'session-1', generation: 1, turnId: 'turn-1', stream: type, outputType: 'text', chunk: content }
      : { provider: 'codex', sessionId: 'session-1', generation: 1, turnId: 'turn-1', content },
  };
};

export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};

export const message = (
  sequence: number,
  state: GoalMessage['state'] = 'delivered',
): GoalMessage => ({
  messageId: `message-${sequence}`, sequence, body: `message ${sequence}`, cannedAction: null, state,
  error: state === 'failed' ? 'Provider unavailable' : null,
  createdAt: timestamp, updatedAt: timestamp,
});

export const capabilities = {
  nativeGoal: true,
  pause: { supported: true, application: 'safe_boundary' as const },
  resume: { supported: true, application: 'immediate' as const },
  steer: { supported: true, application: 'next_turn' as const },
  modelChange: { supported: true, application: 'safe_boundary' as const },
};

export const artifacts = {
  issues: { total: 2, open: 1, closed: 1 },
  pullRequests: { total: 1, open: 1, merged: 0, draft: 1 },
  finalPullRequest: null,
};

export const detail = (): GoalDetail => ({
  goal: {
    goalId: 'goal-1', objective: 'Ship durable goal controls', repository: 'integry/propr', state: 'running', agent: 'codex',
    requestedModel: 'gpt-new', effectiveModel: 'gpt-old',
    maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: true, ultrafixGoal: 8, ultrafixMaxCycles: 10,
    version: 4, terminalReason: null, createdAt: timestamp, updatedAt: timestamp,
  },
  provider: { sessionId: 'session-1', generation: 1, eventSequence: 5, status: 'working', statusDetail: 'Implementing', updatedAt: timestamp, checkpoint: null, capabilities },
  plan: { status: 'not-reported' },
  messages: [],
  stats: {
    tokens: { total: 175, byProviderModel: [{ provider: 'openai', model: 'gpt-old', input: 100, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 10, total: 175 }] },
    time: { elapsedSeconds: 3600, activeSeconds: 3000, pausedSeconds: 500 },
    messages: { queued: 0, oldestQueuedSeconds: null }, artifacts,
  },
  infrastructure: { recovery: { state: 'healthy', attempt: 0, reason: null }, warnings: [] },
  latestSequence: 5, latestCursor: 'cursor:5',
});
