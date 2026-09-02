import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as createGoals } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as createExecutions } from '../src/db/migrations/20260902000000_add_goal_native_executions.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';
import { GoalExecutionRepository } from '../src/services/goals/goalExecutionRepository.js';
import { GoalArtifactRepository } from '../src/services/goals/goalArtifactRepository.js';
import { GoalRuntimeMap, GoalSupervisor } from '../src/services/goals/goalSupervisor.js';
import type {
  GoalProviderRuntime,
  GoalRuntimeRequest,
  GoalRuntimeResult,
} from '../src/services/goals/goalRuntimeTypes.js';

let database: Knex;
let repository: GoalRepository;

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
}

async function createGoal(overrides: Partial<Parameters<GoalRepository['createGoal']>[0]> = {}) {
  return repository.createGoal({
    ownerUserId: 'owner',
    repository: 'integry/propr',
    objective: 'Ship native goals',
    agent: 'codex-sol',
    requestedModel: 'gpt-5.6-sol',
    maxActiveTasks: 4,
    ultrafixEnabled: true,
    ultrafixGoal: 9,
    ultrafixMaxCycles: 5,
    mergePolicy: 'manual',
    ...overrides,
  });
}

async function reportFinal(request: GoalRuntimeRequest, draft = true): Promise<void> {
  await request.callbacks.onArtifact({
    artifactKey: 'final-pr', kind: 'epic_pr', repository: request.goal.repository,
    externalRef: '2065', marker: `<!-- propr-goal:${request.goal.goalId} -->`,
    headBranch: request.execution.workspace.headBranch,
    baseBranch: request.execution.workspace.baseBranch,
    headSha: 'verified-head', draft, state: 'open', finalEpicPullRequest: true,
  });
}

function runtime(overrides: Partial<GoalProviderRuntime> = {}): GoalProviderRuntime {
  return {
    async start(request): Promise<GoalRuntimeResult> {
      await request.callbacks.onSessionIdentity({
        providerSessionId: 'provider-session-1',
        providerThreadId: 'provider-thread-1',
        runtimeId: 'container-1',
        worktreeId: request.execution.workspace.worktreeId,
      });
      await reportFinal(request);
      return { outcome: 'completed' };
    },
    resume: async request => { await reportFinal(request); return { outcome: 'completed' }; },
    steer: async () => ({ acknowledged: true }),
    pause: async () => {},
    cancel: async () => {},
    changeModel: async (_execution, model) => ({ effectiveModel: model }),
    settle: async () => {},
    terminate: async () => {},
    ...overrides,
  };
}

function supervisor(provider: GoalProviderRuntime, controllerId = 'controller-a') {
  return new GoalSupervisor(
    repository,
    new GoalRuntimeMap(new Map([['codex-sol', provider]])),
    {
      controllerId,
      leaseTtlMs: 500,
      controlPollMs: 5,
      scanIntervalMs: 50,
      resolveBaseBranch: async () => '2003-epic-goal-control-plane',
      artifactVerifier: {
        verifyFinalPullRequest: async artifact => {
          if (artifact.draft !== true || artifact.state !== 'open') {
            throw new Error('GitHub reports a non-draft or non-open pull request');
          }
          return {
            repository: artifact.repository,
            externalRef: artifact.externalRef,
            headBranch: artifact.headBranch!,
            baseBranch: artifact.baseBranch!,
            headSha: artifact.headSha ?? 'verified-head',
            state: 'open', draft: true, merged: false, markerPresent: true,
          };
        },
      },
    }
  );
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

beforeEach(async () => {
  database = createDatabase();
  await createGoals(database);
  await createExecutions(database);
  repository = new GoalRepository(database);
});

afterEach(async () => {
  await database.destroy();
});

describe('GoalSupervisor', () => {
  test('enters native /goal mode with an immutable policy and persists identity before completion', async () => {
    const goal = await createGoal();
    let observed: GoalRuntimeRequest | undefined;
    const provider = runtime({
      start: async request => {
        observed = request;
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'provider-session-2010',
          providerThreadId: 'thread-2010',
          runtimeId: 'container-2010',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await request.callbacks.onEvent({
          eventId: 'plan-1',
          kind: 'domain',
          eventType: 'native.plan',
          payload: { checklist: ['inspect', 'implement', 'test'] },
          nativeSequence: 1,
          checkpoint: 'checkpoint-1',
        });
        await reportFinal(request);
        return { outcome: 'completed' };
      },
    });

    await supervisor(provider).runOnce(goal.goalId);

    assert.ok(observed?.command.startsWith('/goal Ship native goals'));
    assert.deepEqual(observed?.execution.policy, {
      schemaVersion: 1,
      maxActiveTasks: 4,
      mergePolicy: 'manual',
      ultrafix: { enabled: true, goal: 9, maxCycles: 5 },
      finalPullRequest: { draft: true, requireHumanApproval: true },
    });
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'completed');
    const execution = await new GoalExecutionRepository(database).get(goal.goalId);
    assert.equal(execution?.providerThreadId, 'thread-2010');
    assert.equal(execution?.lastCheckpoint, 'checkpoint-1');
    assert.equal(execution?.state, 'completed');
    const events = await repository.readEvents(goal.goalId);
    assert.deepEqual(events.events.map(event => event.eventType), [
      'provider.session.persisted',
      'native.plan',
      'native.final_epic_pr',
    ]);
  });

  test('recovers the same provider thread and deterministic worktree after interruption', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    const firstRuntime = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'stable-session',
          providerThreadId: 'stable-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        return { outcome: 'interrupted', reason: 'container_lost', checkpoint: 'cp-7' };
      },
    });
    await supervisor(firstRuntime, 'controller-before-crash').runOnce(goal.goalId);
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'recovering');
    const before = await new GoalExecutionRepository(database).get(goal.goalId);

    let resumed: GoalRuntimeRequest | undefined;
    const replacement = runtime({
      resume: async request => {
        resumed = request;
        await reportFinal(request);
        return { outcome: 'completed' };
      },
    });
    await supervisor(replacement, 'controller-after-crash').runOnce(goal.goalId);

    assert.equal(resumed?.execution.providerThreadId, 'stable-thread');
    assert.equal(resumed?.execution.workspace.worktreeId, before?.workspace.worktreeId);
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'completed');
  });

  test('delivers queued steering and predefined status questions FIFO to the same session', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    const first = await repository.enqueueMessage(goal.goalId, {
      body: 'Change the API name',
      idempotencyKey: 'message-1',
    });
    const second = await repository.enqueueMessage(goal.goalId, {
      body: 'What is the current status?',
      predefinedKind: 'status',
      idempotencyKey: 'message-2',
    });
    const deliveries: Array<{ id: string; thread: string | null; predefined: string | null }> = [];
    const provider = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'fifo-session',
          providerThreadId: 'fifo-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await new Promise(resolve => setTimeout(resolve, 40));
        await reportFinal(request);
        return { outcome: 'completed' };
      },
      steer: async request => {
        deliveries.push({
          id: request.providerMessageId,
          thread: request.execution.providerThreadId,
          predefined: request.predefinedKind,
        });
        return { acknowledged: true };
      },
    });

    await supervisor(provider).runOnce(goal.goalId);

    assert.deepEqual(deliveries, [
      { id: first.messageId, thread: 'fifo-thread', predefined: null },
      { id: second.messageId, thread: 'fifo-thread', predefined: 'status' },
    ]);
    assert.deepEqual((await repository.getMessages(goal.goalId)).map(message => message.state), [
      'acknowledged',
      'acknowledged',
    ]);
  });

  test('fails closed when a manual final epic PR is not draft', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    const provider = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'unsafe-session',
          providerThreadId: 'unsafe-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await reportFinal(request, false);
        return { outcome: 'completed' };
      },
    });

    await supervisor(provider).runOnce(goal.goalId);
    const failed = await repository.requireGoal(goal.goalId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.terminalReason, 'unrecoverable_error');
    const associated = await new GoalArtifactRepository(database).getFinal(goal.goalId);
    assert.equal(associated?.externalRef, '2065');
    assert.equal(associated?.finalEpicPullRequest, true);
  });

  test('applies model changes and pause only at provider safe boundaries, then resumes the same thread', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    const modelChanges: string[] = [];
    let pauseCalls = 0;
    const provider = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'boundary-session',
          providerThreadId: 'boundary-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { outcome: 'paused' };
      },
      changeModel: async (_execution, model) => {
        modelChanges.push(model);
        return { effectiveModel: model };
      },
      pause: async () => { pauseCalls += 1; },
    });
    const running = supervisor(provider).runOnce(goal.goalId);
    await waitUntil(async () => (await repository.requireGoal(goal.goalId)).state === 'running');
    await repository.requestModelChange(goal.goalId, 'gpt-5.6-terra');
    await waitUntil(async () => (await repository.requireGoal(goal.goalId)).effectiveModel === 'gpt-5.6-terra');
    await repository.requestPause(goal.goalId);
    await running;

    assert.deepEqual(modelChanges, ['gpt-5.6-terra']);
    assert.equal(pauseCalls, 1);
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'paused');
    assert.equal((await new GoalExecutionRepository(database).get(goal.goalId))?.state, 'paused');

    await repository.requestResume(goal.goalId);
    let resumedThread: string | null = null;
    const resumedProvider = runtime({
      resume: async request => {
        resumedThread = request.execution.providerThreadId;
        await reportFinal(request);
        return { outcome: 'completed' };
      },
    });
    await supervisor(resumedProvider, 'controller-resume').runOnce(goal.goalId);
    assert.equal(resumedThread, 'boundary-thread');
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'completed');
  });

  test('operator cancellation reaches the exact provider session even though goal state is terminal', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    const cancelledThreads: Array<string | null> = [];
    const provider = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'cancel-session',
          providerThreadId: 'cancel-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { outcome: 'cancelled' };
      },
      cancel: async execution => { cancelledThreads.push(execution.providerThreadId); },
    });
    const running = supervisor(provider).runOnce(goal.goalId);
    await waitUntil(async () => (await repository.requireGoal(goal.goalId)).state === 'running');
    await repository.requestCancel(goal.goalId);
    await running;

    assert.deepEqual(cancelledThreads, ['cancel-thread']);
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'cancelled');
  });

  test('startup scan launches queued goals without Redis or a queue wake-up', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    let starts = 0;
    const provider = runtime({
      start: async request => {
        starts += 1;
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'scan-session',
          providerThreadId: 'scan-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await reportFinal(request);
        return { outcome: 'completed' };
      },
    });
    const scanner = supervisor(provider, 'startup-controller');
    await scanner.start();
    await waitUntil(async () => (await repository.requireGoal(goal.goalId)).state === 'completed');
    await scanner.stop();
    assert.equal(starts, 1);
  });

  test('replacement lease fences a stale runtime before provider dispatch', async () => {
    const goal = await createGoal({ ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null });
    let staleDispatches = 0;
    const staleRuntime = runtime({
      start: async request => {
        await request.callbacks.onSessionIdentity({
          providerSessionId: 'takeover-session',
          providerThreadId: 'takeover-thread',
          worktreeId: request.execution.workspace.worktreeId,
        });
        await new Promise(resolve => setTimeout(resolve, 60));
        await request.authority.assertCurrent();
        staleDispatches += 1;
        return { outcome: 'interrupted' };
      },
    });
    const staleController = new GoalSupervisor(
      repository,
      new GoalRuntimeMap(new Map([['codex-sol', staleRuntime]])),
      {
        controllerId: 'stale-controller',
        leaseTtlMs: 20,
        controlPollMs: 200,
        resolveBaseBranch: async () => '2003-epic-goal-control-plane',
      }
    );
    const staleRun = staleController.runOnce(goal.goalId);
    await waitUntil(async () => (await repository.requireGoal(goal.goalId)).state === 'running');
    await new Promise(resolve => setTimeout(resolve, 30));

    let resumedThread: string | null = null;
    const replacementRuntime = runtime({
      resume: async request => {
        await request.authority.assertCurrent();
        resumedThread = request.execution.providerThreadId;
        await reportFinal(request);
        return { outcome: 'completed' };
      },
    });
    await supervisor(replacementRuntime, 'replacement-controller').runOnce(goal.goalId);
    await staleRun;

    assert.equal(resumedThread, 'takeover-thread');
    assert.equal(staleDispatches, 0);
    assert.equal((await repository.requireGoal(goal.goalId)).state, 'completed');
  });
});
