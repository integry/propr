import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  runGoalProtocol,
} from '../packages/core/src/agents/impl/codexAppServer.ts';
import { boundedCodexJsonlTail } from '../packages/core/src/agents/impl/codexAppServerConnection.ts';
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
    if (method === 'turn/steer') return {};
    throw new Error(`Unexpected request ${method}`);
  }

  notify(): void {}
  get agentMessageCursor(): number { return this.summarySequence; }
  agentMessagesAfter(cursor: number): string[] { return cursor < this.summarySequence ? this.summaryParts.slice(-1) : []; }
  completeGoal(): void { this.goalStatus = 'complete'; }
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
