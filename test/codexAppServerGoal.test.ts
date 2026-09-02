import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { runGoalProtocol } from '../packages/core/src/agents/impl/codexAppServer.ts';
import { boundedCodexJsonlTail } from '../packages/core/src/agents/impl/codexAppServerConnection.ts';
import type { AgentTaskOptions, GoalExecutionControl } from '../packages/core/src/agents/types.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

class FakeConnection {
  started: string[] = [];
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  effectiveModel?: string;
  closeError: Error | null = null;
  private goalReads = 0;

  constructor(private resume: boolean, private startOrder: 'before' | 'after', private alreadyComplete = false) {}

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'thread/start' || method === 'thread/resume') {
      if (method === 'thread/resume') this.startNativeTurn();
      return { thread: { id: 'thread-1', sessionId: 'conversation-1' }, model: 'gpt-5.6' };
    }
    if (method === 'thread/goal/set') {
      this.startNativeTurn();
      return { goal: { status: 'active', objective: params.objective } };
    }
    if (method === 'thread/goal/get') {
      this.goalReads += 1;
      const complete = this.alreadyComplete || this.goalReads > (this.resume ? 1 : 0);
      return { goal: { status: complete ? 'complete' : 'active', objective: this.resume ? 'Ship it\n\nPolicy' : params.objective } };
    }
    if (method === 'turn/steer' || method === 'turn/interrupt') return {};
    throw new Error(`Unexpected request ${method}`);
  }

  notify(): void {}
  takeStartedTurn(): string | null { return this.started.shift() ?? null; }
  discardStartedTurn(): void {}
  waitForTurn(): Promise<Record<string, unknown>> {
    return Promise.resolve({ params: { turn: { status: 'completed' } } });
  }
  private startNativeTurn(): void {
    if (this.alreadyComplete) return;
    if (this.startOrder === 'before') this.started.push('turn-native');
    else setTimeout(() => this.started.push('turn-native'), 0);
  }
}

function controls() {
  const delivered: string[] = [];
  const undeliverable: string[] = [];
  const control: GoalExecutionControl = {
    load: async () => ({ desiredState: 'running', requestedModel: 'gpt-5.6', pendingInputs: [], controlGeneration: 0 }),
    heartbeat: async () => {},
    setActiveTurn: async () => {},
    markInputDelivered: async id => { delivered.push(id); },
    markInputUndeliverable: async id => { undeliverable.push(id); },
    appendOutput: async () => {},
  };
  return { control, delivered, undeliverable };
}

function options(control: GoalExecutionControl, resume = false, input = false): AgentTaskOptions {
  return {
    worktreePath: '/tmp/worktree', issueRef: { number: 0, repoOwner: 'acme', repoName: 'repo' },
    prompt: input ? 'Late guidance' : '/goal Ship it\n\nPolicy', githubToken: 'token',
    nativeGoalObjective: '/goal Ship it\n\nPolicy', goalControl: control,
    ...(resume ? { resumeSessionId: 'thread-1', resumeConversationId: 'conversation-1' } : {}),
    ...(input ? { initialControlInputId: 'input-1' } : {}),
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
        assert.equal(connection.requests.filter(request => request.method === (resume ? 'thread/resume' : 'thread/goal/set')).length, 1);
        if (resume) assert.equal(connection.requests.find(request => request.method === 'thread/resume')?.params.model, 'gpt-5.6');
        if (resume) {
          assert.deepEqual(state.delivered, ['input-1']);
          assert.equal(connection.requests.filter(request => request.method === 'turn/steer').length, 1);
        }
      });
    }
  }

  test('a FIFO input racing with an already-complete native goal is closed once', async () => {
    const state = controls();
    const connection = new FakeConnection(true, 'before', true);
    const result = await runGoalProtocol(connection as never, options(state.control, true, true), 'gpt-5.6');
    assert.equal(result.completion?.status, 'completed');
    assert.deepEqual(state.delivered, []);
    assert.deepEqual(state.undeliverable, ['input-1']);
    assert.equal(connection.requests.some(request => request.method === 'turn/start' || request.method === 'turn/steer'), false);
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
});
