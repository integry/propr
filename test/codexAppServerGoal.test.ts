import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import {
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  runGoalProtocol,
} from '../packages/core/src/agents/impl/codexAppServer.ts';
import { AppServerConnection, boundedCodexJsonlTail } from '../packages/core/src/agents/impl/codexAppServerConnection.ts';
import type { AgentTaskOptions, GoalExecutionControl } from '../packages/core/src/agents/types.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

class FakeConnection {
  started: string[] = [];
  summaryParts: string[] = [];
  private summarySequence = 0;
  requests: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  effectiveModel?: string;
  closeError: Error | null = null;
  private goalReads = 0;
  private goalStatus: string;
  private objective = '/goal Ship it';
  private turnResolver?: (message: Record<string, unknown>) => void;
  private nextAgentMessage?: string;

  constructor(
    private resume: boolean,
    private startOrder: 'before' | 'after',
    private alreadyComplete = false,
    initialStatus = 'active',
    private holdTurn = false,
    private reportedModel = 'gpt-5.6',
  ) { this.goalStatus = alreadyComplete ? 'complete' : initialStatus; }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    this.requests.push({ method, params, timeoutMs });
    if (method === 'initialize') return {};
    if (method === 'thread/start' || method === 'thread/resume') {
      if (method === 'thread/resume' && this.goalStatus === 'active') this.startNativeTurn();
      return { thread: { id: 'thread-1', sessionId: 'conversation-1', model: this.reportedModel } };
    }
    if (method === 'thread/goal/set') {
      if (typeof params.objective === 'string') this.objective = params.objective;
      if (typeof params.status === 'string') this.goalStatus = params.status;
      if (this.goalStatus === 'active') this.startNativeTurn();
      return { goal: { status: this.goalStatus, objective: this.objective } };
    }
    if (method === 'thread/goal/get') {
      this.goalReads += 1;
      const complete = this.alreadyComplete || (this.goalStatus === 'active' && this.goalReads > (this.resume ? 1 : 0));
      if (complete) this.goalStatus = 'complete';
      return { goal: { status: this.goalStatus, objective: this.objective } };
    }
    if (method === 'thread/goal/clear') {
      this.goalStatus = 'cleared';
      return {};
    }
    if (method === 'turn/interrupt') {
      this.turnResolver?.({ params: { turn: { status: 'interrupted' } } });
      return {};
    }
    if (method === 'turn/steer') {
      const rejection = this.steerRejections.shift();
      if (rejection) throw new Error(rejection);
      return {};
    }
    throw new Error(`Unexpected request ${method}`);
  }

  /** Errors the next turn/steer calls fail with, in order. */
  steerRejections: string[] = [];
  finishedTurns = new Set<string>();
  running: string | null = null;
  isTurnFinished(turnId: string): boolean { return this.finishedTurns.has(turnId); }
  runningTurn(): string | null { return this.running; }
  agentMessagesForTurn(_turnId: string, cursor: number): string[] { return this.agentMessagesAfter(cursor); }
  serverRequests: Array<Record<string, unknown>> = [];
  resolvedServerRequests: Array<number | string> = [];
  responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  notify(): void {}
  takeServerRequests(): Array<Record<string, unknown>> { return this.serverRequests.splice(0); }
  takeResolvedServerRequests(): Array<number | string> { return this.resolvedServerRequests.splice(0); }
  respond(id: number | string, result: Record<string, unknown>): void { this.responses.push({ id, result }); }
  get agentMessageCursor(): number { return this.summarySequence; }
  agentMessagesAfter(cursor: number): string[] { return cursor < this.summarySequence ? this.summaryParts.slice(-1) : []; }
  completeGoal(): void { this.goalStatus = 'complete'; }
  get observingTurn(): boolean { return Boolean(this.turnResolver); }
  finishTurn(): void { this.turnResolver?.({ params: { turn: { status: 'completed' } } }); }
  declareCheckpoint(value: Record<string, unknown>): void { this.nextAgentMessage = JSON.stringify(value); }
  takeStartedTurn(): string | null { return this.started.shift() ?? null; }
  discardStartedTurn(): void {}
  waitForTurn(): Promise<Record<string, unknown>> {
    if (this.holdTurn) return new Promise(resolve => { this.turnResolver = resolve; });
    if (this.nextAgentMessage) {
      this.summaryParts.push(this.nextAgentMessage);
      this.summarySequence += 1;
      this.nextAgentMessage = undefined;
    }
    return Promise.resolve({ params: { turn: { status: 'completed' } } });
  }
  private startNativeTurn(): void {
    if (this.alreadyComplete) return;
    if (this.startOrder === 'before') this.started.push('turn-native');
    else setTimeout(() => this.started.push('turn-native'), 0);
  }
}

function controls(onCheckpoint?: () => void) {
  const delivered: string[] = [];
  const undeliverable: string[] = [];
  const checkpoints: string[] = [];
  const checkpointRequests: Array<Record<string, unknown>> = [];
  const checkpointRejections: Array<Record<string, unknown>> = [];
  let desiredState: 'running' | 'paused' | 'cancelled' = 'running';
  const control: GoalExecutionControl = {
    load: async () => ({
      desiredState, requestedModel: 'gpt-5.6', pendingInputs: [], controlGeneration: 0,
    }),
    heartbeat: async () => {},
    setActiveTurn: async () => {},
    markInputDelivered: async id => { delivered.push(id); },
    markInputUndeliverable: async id => { undeliverable.push(id); },
    publishCheckpoint: async (request, turnId) => {
      checkpoints.push(`${request.kind}:${turnId}`);
      checkpointRequests.push(request as unknown as Record<string, unknown>);
      onCheckpoint?.();
      return { accepted: true, commitSha: 'abc123' };
    },
    rejectCheckpoint: async (request, turnId) => { checkpointRejections.push({ ...request, turnId }); },
    appendOutput: async () => {},
  };
  return {
    control, delivered, undeliverable, checkpoints, checkpointRequests, checkpointRejections,
    setDesiredState: (state: typeof desiredState) => { desiredState = state; },
  };
}

function options(control: GoalExecutionControl, resume = false, input = false): AgentTaskOptions {
  return {
    worktreePath: '/tmp/worktree', issueRef: { number: 0, repoOwner: 'acme', repoName: 'repo' },
    prompt: resume && input ? 'Late guidance' : '/goal Ship it', githubToken: 'token',
    nativeGoalObjective: '/goal Ship it', goalControl: control,
    ...(resume ? { resumeSessionId: 'thread-1', resumeConversationId: 'conversation-1' } : {}),
    ...(input ? {
      initialControlInputId: 'input-1',
      initialControlInputMessage: resume
        ? 'Late guidance'
        : 'Additional ProPR delivery context for the goal above:\n\nPolicy',
    } : {}),
  };
}

describe('pinned Codex 0.146 native external-goal activation', () => {
  for (const resume of [false, true]) {
    for (const order of ['before', 'after'] as const) {
      test(`${resume ? 'resume' : 'fresh'} observes the one native turn when turn/started arrives ${order} activation response`, async () => {
        const state = controls();
        const connection = new FakeConnection(resume, order);
        const result = await runGoalProtocol(connection as never, options(state.control, resume, resume), 'gpt-5.6');
        assert.equal(result.completion?.status, 'completed');
        assert.equal(connection.requests.filter(request => request.method === 'turn/start').length, 0);
        assert.equal(connection.requests.filter(request => request.method === (resume ? 'thread/resume' : 'thread/goal/set')).length, resume ? 1 : 2);
        if (!resume) assert.deepEqual(
          connection.requests.filter(request => request.method === 'thread/goal/set').map(request => request.params.status),
          ['paused', 'active'],
        );
        if (resume) assert.equal(connection.requests.find(request => request.method === 'thread/resume')?.params.model, 'gpt-5.6');
        if (resume) {
          assert.deepEqual(state.delivered, ['input-1']);
          assert.equal(connection.requests.filter(request => request.method === 'turn/steer').length, 1);
        }
      });
    }
  }

  test('steers initial ProPR context separately from the bounded native objective', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    await runGoalProtocol(connection as never, options(state.control, false, true), 'gpt-5.6');

    assert.equal(connection.requests.find(request => request.method === 'thread/goal/set')?.params.objective, '/goal Ship it');
    assert.match(JSON.stringify(connection.requests.find(request => request.method === 'turn/steer')?.params.input), /Additional ProPR delivery context/);
    assert.deepEqual(state.delivered, ['input-1']);
  });

  test('a FIFO input racing with an already-complete native goal is closed once', async () => {
    const state = controls();
    const connection = new FakeConnection(true, 'before', true);
    const result = await runGoalProtocol(connection as never, options(state.control, true, true), 'gpt-5.6');
    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.delivered, []);
    assert.deepEqual(state.undeliverable, ['input-1']);
    assert.equal(connection.requests.some(request => request.method === 'turn/start' || request.method === 'turn/steer'), false);
  });

  for (const status of ['complete', 'cleared', 'budgetLimited', 'active']) {
    test(`continuing a goal whose Codex thread is ${status} re-arms it and delivers the continuation`, async () => {
      const state = controls();
      const connection = new FakeConnection(true, 'before', false, status);
      const result = await runGoalProtocol(
        connection as never,
        { ...options(state.control, true, true), continueTerminalGoal: true },
        'gpt-5.6',
      );

      assert.equal(result.completion?.status, 'completed');
      assert.deepEqual(state.undeliverable, []);
      assert.deepEqual(state.delivered, ['input-1']);
      const activation = connection.requests.find(request => request.method === 'thread/goal/set');
      assert.deepEqual(activation?.params, { threadId: 'thread-1', objective: '/goal Ship it', status: 'active' });
    });
  }

  test('continuing an active but idle thread starts and observes a turn', async () => {
    const state = controls();
    const connection = new FakeConnection(true, 'before', false, 'active');
    const request = connection.request.bind(connection);
    connection.request = async (method, params, timeout) => {
      const result = await request(method, params, timeout);
      if (method === 'thread/resume') connection.started = [];
      return result;
    };
    const result = await runGoalProtocol(connection as never, { ...options(state.control, true, true), continueTerminalGoal: true }, 'gpt-5.6');
    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.delivered, ['input-1']);
  });

  for (const checkpoint of [false, true]) {
    test(`completion with undelivered continuation fails visibly (checkpoint: ${checkpoint})`, async () => {
      const state = controls();
      const connection = new FakeConnection(true, 'before', false, 'complete');
      connection.steerRejections.push(new Error('no active turn to steer').message);
      if (checkpoint) connection.declareCheckpoint({ kind: 'checkpoint', commitMessage: 'checkpoint', include: ['.'] });
      const result = await runGoalProtocol(connection as never, { ...options(state.control, true, true), continueTerminalGoal: true }, 'gpt-5.6');
      assert.equal(result.completion?.status, 'failed');
      assert.match(result.completion?.error ?? '', /before the continuation input could be delivered/);
      assert.deepEqual(state.delivered, []);
    });
  }

  test('continuing refuses a thread whose native goal has a different objective', async () => {
    const state = controls();
    const connection = new FakeConnection(true, 'before', false, 'complete');
    await connection.request('thread/goal/set', { objective: '/goal Something else', status: 'complete' });
    await assert.rejects(
      runGoalProtocol(connection as never, { ...options(state.control, true, true), continueTerminalGoal: true }, 'gpt-5.6'),
      /different native goal objective/,
    );
  });

  test('fresh pause/crash then process restart resumes the native goal with a different FIFO input and immutable identity', async () => {
    const freshState = controls();
    freshState.setDesiredState('paused');
    const fresh = new FakeConnection(false, 'before', false, 'active', true);
    const paused = await runGoalProtocol(fresh as never, options(freshState.control), 'gpt-5.6');
    assert.equal(paused.completion?.status, 'interrupted');
    const nativePause = fresh.requests.find(request => request.method === 'thread/goal/set' && request.params.status === 'paused');
    assert.equal(nativePause?.params.objective, '/goal Ship it');
    assert.equal(fresh.requests.filter(request => request.method === 'turn/interrupt').length, 0);

    const resumedState = controls();
    const resumed = new FakeConnection(true, 'after', false, 'paused');
    const completed = await runGoalProtocol(resumed as never, options(resumedState.control, true, true), 'gpt-5.6');
    assert.equal(completed.completion?.status, 'completed');
    assert.equal(resumed.requests.find(request => request.method === 'thread/goal/set')?.params.objective, '/goal Ship it');
    assert.equal(resumed.requests.find(request => request.method === 'thread/goal/set')?.params.status, 'active');
    assert.equal(resumed.requests.find(request => request.method === 'turn/steer')?.params.input instanceof Array, true);
    assert.deepEqual(resumedState.delivered, ['input-1']);
  });

  test('cancel clears the native Codex goal before interrupting its active turn', async () => {
    const state = controls();
    state.setDesiredState('cancelled');
    const connection = new FakeConnection(false, 'before', false, 'active', true);
    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');
    assert.equal(result.completion?.status, 'interrupted');
    assert.equal(connection.requests.filter(request => request.method === 'thread/goal/clear').length, 1);
    assert.equal(connection.requests.filter(request => request.method === 'turn/interrupt').length, 0);
  });

  test('publishes a fresh thread only after the paused native goal exists', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    let statusesAtPublication: unknown[] = [];
    const runOptions = options(state.control);
    runOptions.onSessionId = async () => {
      statusesAtPublication = connection.requests
        .filter(request => request.method === 'thread/goal/set')
        .map(request => request.params.status);
    };

    await runGoalProtocol(connection as never, runOptions, 'gpt-5.6');
    assert.deepEqual(statusesAtPublication, ['paused']);
  });

  test('keeps provider-returned model evidence when a different model was requested', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before', false, 'active', false, 'provider-effective-model');
    const result = await runGoalProtocol(connection as never, options(state.control), 'requested-model');

    assert.equal(result.effectiveModel, 'provider-effective-model');
    assert.equal(connection.effectiveModel, 'provider-effective-model');
    assert.equal(connection.requests.find(request => request.method === 'thread/start')?.params.model, 'requested-model');
  });

  test('delivers durable checkpoint feedback when a Codex session resumes after publication', async () => {
    const state = controls();
    const connection = new FakeConnection(true, 'before');
    const runOptions = options(state.control, true);
    runOptions.initialGoalFeedback = 'ProPR accepted and published your checkpoint as commit durable123. Continue working toward the goal.';

    await runGoalProtocol(connection as never, runOptions, 'gpt-5.6');

    const feedback = connection.requests.find(request => request.method === 'turn/steer');
    assert.match(JSON.stringify(feedback?.params.input), /durable123/);
    assert.deepEqual(state.delivered, []);
  });

  test('allows repository setup to finish before initialize times out', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');

    await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(
      connection.requests.find(request => request.method === 'initialize')?.timeoutMs,
      CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
    );
    assert.equal(
      connection.requests.find(request => request.method === 'thread/start')?.timeoutMs,
      undefined,
      'ordinary requests retain the default RPC timeout',
    );
  });

  test('pauses native auto-continuation while ProPR publishes an agent-declared checkpoint', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    connection.declareCheckpoint({
      checkpointReady: true,
      message: 'feat: stable slice',
      include: ['src/stable.ts'],
      exclude: ['src/in-progress.ts'],
      summary: 'The stable slice is tested.',
    });

    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.checkpoints, ['agent:turn-native']);
    assert.deepEqual(state.checkpointRequests, [{
      kind: 'agent',
      commitMessage: 'feat: stable slice',
      include: ['src/stable.ts'],
      exclude: ['src/in-progress.ts'],
      summary: 'The stable slice is tested.',
    }]);
    assert.deepEqual(
      connection.requests
        .filter(request => request.method === 'thread/goal/set')
        .map(request => request.params.status),
      ['paused', 'active', 'paused', 'active'],
    );
    const acknowledgement = connection.requests.find(request => request.method === 'turn/steer');
    assert.match(JSON.stringify(acknowledgement?.params.input), /accepted and published.*abc123/);
  });

  test('records a malformed declaration and explicitly asks Codex to correct it', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    connection.declareCheckpoint({ checkpointReady: true, message: '', include: ['../outside.ts'] });
    connection.started.push('turn-correction');

    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.equal(state.checkpoints.length, 0);
    assert.equal(state.checkpointRejections.length, 1);
    assert.match(String(state.checkpointRejections[0].error), /message must be a non-empty string/);
    const feedback = connection.requests.find(request => request.method === 'turn/steer');
    assert.match(JSON.stringify(feedback?.params.input), /rejected your checkpoint declaration/);
    assert.match(JSON.stringify(feedback?.params.input), /No checkpoint was committed/);
  });

  test('does not reactivate a native goal that completed while its final turn was checkpointed', async () => {
    const connection = new FakeConnection(false, 'before');
    const state = controls(() => connection.completeGoal());
    connection.declareCheckpoint({ checkpointReady: true, message: 'feat: final slice' });

    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.checkpoints, ['agent:turn-native']);
    assert.deepEqual(
      connection.requests
        .filter(request => request.method === 'thread/goal/set')
        .map(request => request.params.status),
      ['paused', 'active', 'paused'],
    );
  });
});

test('Codex live output retains resumed records and rotates a long stream on record boundaries', () => {
  const resumed = boundedCodexJsonlTail('{"attempt":1}\n' + '{"attempt":2}\n', 100);
  assert.match(resumed, /"attempt":1/);
  assert.match(resumed, /"attempt":2/);
  const long = Array.from({ length: 200 }, (_, index) => JSON.stringify({ index, text: 'x'.repeat(20) })).join('\n') + '\n';
  const bounded = boundedCodexJsonlTail(long, 512);
  assert.ok(Buffer.byteLength(bounded) <= 512);
  assert.doesNotMatch(bounded, /"index":0[,}]/);
  assert.match(bounded, /"index":199/);
  for (const line of bounded.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));

  const multibyte = Array.from({ length: 100 }, (_, index) => JSON.stringify({ index, text: '😀'.repeat(8) })).join('\n') + '\n';
  const multibyteTail = boundedCodexJsonlTail(multibyte, 300);
  assert.ok(Buffer.byteLength(multibyteTail) <= 300);
  for (const line of multibyteTail.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));

  assert.equal(boundedCodexJsonlTail(`${JSON.stringify({ text: '😀'.repeat(500) })}\n`, 128), '');
});

test('app server child is cleaned up even when final output publication fails', async () => {
  const failure = new Error('unacknowledged output');
  let ended = false;
  const connection = {
    child: { exitCode: 0, stdin: { end: () => { ended = true; } } },
    output: { close: async () => { assert.equal(ended, true); throw failure; } },
  } as unknown as AppServerConnection;
  await assert.rejects(AppServerConnection.prototype.close.call(connection), error => error === failure);
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('Codex provider requests become blockers, inputs answer questions, and only provider evidence resolves them', async () => {
  const connection = new FakeConnection(false, 'before', false, 'active', true);
  const { control } = controls();
  const reports: Array<Record<string, unknown>> = [];
  const resolutions: string[] = [];
  const delivered: string[] = [];
  let pending: Array<{ id: string; message: string; sequence: number }> = [];
  control.load = async () => ({ desiredState: 'running', requestedModel: 'gpt-5.6', pendingInputs: pending, controlGeneration: 0 });
  control.markInputDelivered = async id => { delivered.push(id); pending = pending.filter(input => input.id !== id); };
  control.reportBlocker = async report => {
    reports.push(report as unknown as Record<string, unknown>);
    return Math.max(0, ...pending.map(input => input.sequence));
  };
  control.resolveBlocker = async (key, resolution) => { resolutions.push(`${key}=${resolution}`); };
  const run = runGoalProtocol(connection as never, options(control), 'gpt-5.6');
  await waitFor(() => connection.observingTurn, 'the native turn');

  connection.serverRequests.push(
    { id: 0, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-native', itemId: 'item-1',
      isBlocking: true, questions: [{ id: 'db', header: 'Database', question: 'Which database?', isOther: false, isSecret: false, options: null }] } },
    { id: 1, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: 'thread-1',
      turnId: 'turn-native', itemId: 'item-2', startedAtMs: 1, environmentId: null, command: 'npm publish', reason: null } },
  );
  await waitFor(() => reports.length === 2, 'both blockers to be reported');
  assert.deepEqual(reports.map(report => report.category), ['question', 'approval']);
  assert.deepEqual(connection.responses, [], 'nothing is answered or approved on the operator\'s behalf');

  pending = [{ id: 'input-1', message: 'Postgres', sequence: 1 }];
  await waitFor(() => delivered.includes('input-1'), 'the answer to be delivered');
  assert.deepEqual(connection.responses, [{ id: 0, result: { answers: { db: { answers: ['Postgres'] } } } }]);
  assert.equal(connection.requests.some(request => request.method === 'turn/steer'
    && request.params.clientUserMessageId === 'input-1'), false, 'the answer is the reply, not a second steer');
  assert.deepEqual(resolutions, [], 'sending an answer alone resolves nothing');

  connection.resolvedServerRequests.push(0);
  await waitFor(() => resolutions.length === 1, 'the provider to resolve the question');
  assert.deepEqual(resolutions, ['codex:thread-1:turn-native:item-1:user-input=provider_resolved']);

  connection.finishTurn();
  await run;
  assert.deepEqual(resolutions.slice(1),
    ['codex:thread-1:turn-native:item-2:item/commandExecution/requestApproval=turn_ended']);
  assert.equal(connection.responses.length, 1, 'the approval was never answered by ProPR');
});

test('a correction queued before a Codex question is steered, not sent as its answer', async () => {
  const connection = new FakeConnection(false, 'before', false, 'active', true);
  const { control } = controls();
  const delivered: string[] = [];
  let pending: Array<{ id: string; message: string; sequence: number }> = [];
  let latest = 0;
  control.load = async () => ({ desiredState: 'running', requestedModel: 'gpt-5.6', pendingInputs: pending, controlGeneration: 0 });
  control.markInputDelivered = async id => { delivered.push(id); pending = pending.filter(input => input.id !== id); };
  control.reportBlocker = async () => latest;
  control.resolveBlocker = async () => {};
  const run = runGoalProtocol(connection as never, options(control), 'gpt-5.6');
  await waitFor(() => connection.observingTurn, 'the native turn');

  // Both become visible within one polling interval: the loop registers the
  // question and only then loads the older, still undelivered correction.
  latest = 1;
  pending = [{ id: 'input-1', message: 'Also update the documentation', sequence: 1 }];
  connection.serverRequests.push({ id: 0, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1',
    turnId: 'turn-native', itemId: 'item-1', isBlocking: true,
    questions: [{ id: 'db', header: 'Database', question: 'Which database?', isOther: false, isSecret: false, options: null }] } });
  await waitFor(() => delivered.includes('input-1'), 'the correction to be delivered');
  assert.equal(connection.requests.some(request => request.method === 'turn/steer'
    && request.params.clientUserMessageId === 'input-1'), true, 'the correction is steered as ordinary input');
  assert.deepEqual(connection.responses, [], 'the correction is never the question\'s answer');

  latest = 2;
  pending = [{ id: 'input-2', message: 'Postgres', sequence: 2 }];
  await waitFor(() => delivered.includes('input-2'), 'the answer to be delivered');
  assert.deepEqual(connection.responses, [{ id: 0, result: { answers: { db: { answers: ['Postgres'] } } } }]);

  connection.finishTurn();
  await run;
});

describe('steering a native goal whose App Server already moved to a newer turn', () => {
  test('retries a steer that App Server rejected for a newer running turn', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    connection.declareCheckpoint({ checkpointReady: true, message: 'feat: stable slice' });
    connection.steerRejections.push('Codex expected active turn id `turn-native` but found `turn-later` (-32600)');

    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(
      connection.requests.filter(request => request.method === 'turn/steer').map(request => request.params.expectedTurnId),
      ['turn-native', 'turn-later'],
    );
  });

  test('keeps checkpoint feedback pending instead of failing when no turn is running', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    connection.declareCheckpoint({ checkpointReady: true, message: 'feat: stable slice' });
    connection.steerRejections.push('Codex no active turn to steer (-32600)');

    const result = await runGoalProtocol(connection as never, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.checkpoints, ['agent:turn-native']);
  });

  test('still fails on a steer error that is not about the running turn', async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before');
    connection.declareCheckpoint({ checkpointReady: true, message: 'feat: stable slice' });
    connection.steerRejections.push('Codex input must not be empty (-32600)');

    await assert.rejects(
      runGoalProtocol(connection as never, options(state.control), 'gpt-5.6'),
      /input must not be empty/,
    );
  });

  test('replays the checkpoint race: Codex ran a turn while ProPR published, then started another', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, signalCode: null, kill: () => true,
    });
    const send = (message: Record<string, unknown>) => child.stdout.write(`${JSON.stringify(message)}\n`);
    const started = (id: string) => send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id, status: 'inProgress' } } });
    const said = (turnId: string, text: string) => send({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId, completedAtMs: 0, item: { type: 'agentMessage', id: `m-${turnId}`, text } },
    });
    const completed = (id: string) => send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } });
    let goalStatus = 'paused';
    let activations = 0;
    let runningTurn: string | null = null;
    const steers: unknown[] = [];
    readline.createInterface({ input: child.stdin }).on('line', line => {
      const request = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> };
      if (request.id === undefined) return;
      const reply = (result: Record<string, unknown>) => send({ id: request.id, result });
      if (request.method === 'initialize') return reply({});
      if (request.method === 'thread/start') return reply({ thread: { id: 'thread-1', sessionId: 'conversation-1', model: 'gpt-5.6' } });
      if (request.method === 'thread/goal/get') return reply({ goal: { status: goalStatus, objective: '/goal Ship it' } });
      if (request.method === 'thread/goal/set') {
        goalStatus = String(request.params.status);
        reply({ goal: { status: goalStatus, objective: '/goal Ship it' } });
        if (goalStatus !== 'active') return;
        activations += 1;
        setImmediate(() => {
          if (activations === 1) {
            // The checkpoint turn, then App Server continues the still-active
            // goal on its own before ProPR pauses it to publish.
            started('turn-a');
            said('turn-a', JSON.stringify({ checkpointReady: true, message: 'feat: stable slice' }));
            completed('turn-a');
            started('turn-b');
            said('turn-b', 'Waiting for ProPR to acknowledge the checkpoint.');
            completed('turn-b');
          } else {
            runningTurn = 'turn-c';
            started('turn-c');
          }
        });
        return;
      }
      if (request.method === 'turn/steer') {
        steers.push(request.params.expectedTurnId);
        if (request.params.expectedTurnId !== runningTurn) {
          return send({
            id: request.id,
            error: runningTurn
              ? { code: -32600, message: `expected active turn id \`${String(request.params.expectedTurnId)}\` but found \`${runningTurn}\`` }
              : { code: -32600, message: 'no active turn to steer' },
          });
        }
        reply({});
        goalStatus = 'complete';
        runningTurn = null;
        setImmediate(() => completed('turn-c'));
        return;
      }
      send({ id: request.id, error: { code: -32601, message: `unexpected ${request.method}` } });
    });
    const connection = new AppServerConnection(child as never, undefined);
    const state = controls();

    const result = await runGoalProtocol(connection, options(state.control), 'gpt-5.6');

    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.checkpoints, ['agent:turn-a']);
    assert.deepEqual(steers, ['turn-c'], 'the acknowledgement goes to the running turn, not the finished one');
    child.stdout.end();
  });
});

for (const pollingRetry of [false, true]) {
  test(`initial continuation and checkpoint feedback are delivered together once (${pollingRetry ? 'polling retry' : 'first steer'})`, async () => {
    const state = controls();
    const connection = new FakeConnection(false, 'before', false, 'active', pollingRetry);
    let pending = [{ id: 'input-1', message: 'Continue with the tests', sequence: 1 }];
    state.control.load = async () => ({ desiredState: 'running', requestedModel: 'gpt-5.6', pendingInputs: pending, controlGeneration: 0 });
    state.control.markInputDelivered = async id => { state.delivered.push(id); pending = []; };
    let turns = 0;
    const originalWait = connection.waitForTurn.bind(connection);
    connection.waitForTurn = () => {
      turns += 1;
      if (turns === 1) return originalWait();
      return Promise.resolve({ params: { turn: { status: 'completed' } } });
    };
    const originalRequest = connection.request.bind(connection);
    connection.request = async (method, params, timeout) => {
      if (pollingRetry && method === 'thread/goal/get') {
        return { goal: { status: turns >= 2 ? 'complete' : 'active', objective: '/goal Ship it' } };
      }
      return originalRequest(method, params, timeout);
    };
    if (pollingRetry) connection.steerRejections.push('Codex no active turn to steer (-32600)');
    const run = runGoalProtocol(connection as never, {
      ...options(state.control, false, true),
      initialControlInputMessage: 'Continue with the tests',
      initialGoalFeedback: 'Checkpoint abc123 was published.',
    }, 'gpt-5.6');
    if (pollingRetry) {
      await waitFor(() => state.delivered.length === 1, 'polling delivery of initial input');
      connection.started.push('turn-second');
      connection.finishTurn();
    }
    await run;
    assert.deepEqual(state.delivered, ['input-1']);
    const steers = connection.requests.filter(request => request.method === 'turn/steer');
    assert.equal(steers.length, pollingRetry ? 2 : 1);
    const sent = JSON.stringify(steers.at(-1)?.params.input);
    assert.match(sent, /Checkpoint abc123 was published/);
    assert.match(sent, /Continue with the tests/);
  });
}
