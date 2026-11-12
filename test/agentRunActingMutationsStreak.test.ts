import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Job } from 'bullmq';
import knex, { type Knex } from 'knex';
import type { AgentRunJobData } from '@propr/core';
import { createAgentDefinition, getAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import {
  claimAgentRunAction,
  createAgentRun,
  getAgentRunById,
  transitionAgentRun,
  type StoredAgentRun,
} from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  agentRunProductivity,
  findUnproductiveScheduledStreak,
  pauseScheduleForUnproductiveStreak,
  recordAgentRunActingMutations,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

const { createAgentActionProcessor } = await import('../src/jobs/processAgentActionJob.ts');
const { evaluateUnproductiveStreak } = await import('../src/jobs/agentRuns/unproductiveStreak.ts');
type AgentActionProcessorDeps = import('../src/jobs/processAgentActionJob.ts').AgentActionProcessorDeps;
type UnproductiveStreakDeps = import('../src/jobs/agentRuns/unproductiveStreak.ts').UnproductiveStreakDeps;

/**
 * F12: an acting step that changed something keeps that count on its run however
 * the run ended, against the real store, so the unproductive streak it read
 * afterwards is broken by it instead of paused through it.
 */

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 11, 22, 0);
const THRESHOLD = 3;

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

let database: Knex;
let clock: number;
let definition: StoredAgentDefinition;
const deps = () => ({ database, now: () => clock });

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  clock = NOW;
  definition = await createAgentDefinition({
    ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', repositories: ['acme/web'], autonomyMode: 'auto',
    scheduleCron: '0 22 * * *', scheduleEnabled: true, pauseWhenUnproductive: true,
  }, deps());
});
afterEach(async () => { await database.destroy(); });

/** A scheduled run whose report repeated the previous one, stored and moved on to `next`. */
async function unchangedRun(next: 'completed' | 'acting'): Promise<StoredAgentRun> {
  clock += 60_000;
  const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
  await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps());
  await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'Nothing changed.', reportHash: 'f'.repeat(64), reportNovelty: 'unchanged' }, deps());
  return (await transitionAgentRun(run.id, ['report_ready'], next, {}, deps()))!;
}

interface Inbox { events: Array<{ deduplicationKey: string }> }

function streakDeps(inbox: Inbox): UnproductiveStreakDeps {
  const stored = new Map<string, { pauseIntended: boolean }>();
  return {
    loadThreshold: async () => THRESHOLD,
    findStreak: (definitionId, threshold) => findUnproductiveScheduledStreak(definitionId, threshold, { database }),
    getDefinition: (definitionId, ownerId) => getAgentDefinition(definitionId, ownerId, { database }),
    pauseSchedule: (definitionId, pause) => pauseScheduleForUnproductiveStreak(definitionId, pause, deps()),
    findNotification: async key => stored.get(key) ?? null,
    createEvent: (async (event: { deduplicationKey: string; metadata?: { pauseIntended?: unknown } }) => {
      if (!stored.has(event.deduplicationKey)) inbox.events.push(event);
      stored.set(event.deduplicationKey, { pauseIntended: event.metadata?.pauseIntended === true });
      return event;
    }) as never,
  };
}

/** The production acting-step processor on the real run store; the agent and its MCP grant are stand-ins. */
function actionProcessor(execute: () => Promise<unknown>, grant: { performed: number; uncounted?: boolean }, inbox: Inbox) {
  const taskStates = new Map<string, string>();
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const setTask = (taskId: string, state: string) => { if (!terminal.has(taskStates.get(taskId) ?? '')) taskStates.set(taskId, state); };
  const overrides: Partial<AgentActionProcessorDeps> = {
    getRun: runId => getAgentRunById(runId, deps()),
    transitionRun: (id, from, to, patch) => transitionAgentRun(id, from, to, patch, deps()),
    claimAction: (runId, actionTaskId) => claimAgentRunAction(runId, actionTaskId, deps()),
    recordMutations: (runId, record) => recordAgentRunActingMutations(runId, record, deps()),
    validateDefinition: async () => null,
    stateManager: () => ({
      createTaskStateIfAbsent: async (taskId: string) => { if (!taskStates.has(taskId)) taskStates.set(taskId, 'pending'); },
      getTaskState: async (taskId: string) => (taskStates.has(taskId) ? { state: taskStates.get(taskId) } : null),
      updateTaskState: async (taskId: string, state: string) => setTask(taskId, state),
      markTaskCompleted: async (taskId: string) => setTask(taskId, 'completed'),
      markTaskFailed: async (taskId: string) => setTask(taskId, 'failed'),
      markTaskCancelled: async (taskId: string) => setTask(taskId, 'cancelled'),
    }) as unknown as ReturnType<AgentActionProcessorDeps['stateManager']>,
    getGitHubAccess: async () => ({ token: 'ghs_token', octokit: {} }),
    prepareWorkspace: (async () => ({
      worktreePath: '/tmp/action', branchName: 'agent-run/action',
      promptWorkspace: { repositoriesReadable: true, primaryRepository: '.', contextRepositories: [] }, attachments: [], cleanup: async () => undefined,
    })) as unknown as AgentActionProcessorDeps['prepareWorkspace'],
    resolveAgent: async () => ({ agent: { executeTask: execute } as never, alias: 'claude', model: 'opus' }),
    withCostCap: async (_target, operation) => operation(),
    mcpGrants: {
      request: async (_runId, phase) => ({ grantId: 'grant-1', phase, url: 'http://api:4000/api/mcp', token: 'mcp-secret', expiresAt: clock + 60_000, scopes: ['read', 'plan', 'execute'] }),
      // Like the API: counted once the grant is revoked.
      revoke: async (_runId, issued) => ({ revoked: true, grantId: issued.grantId ?? null, calls: 1, mutatingOperations: grant.uncounted ? null : grant.performed }),
    },
    evaluateStreak: async run => { if (run) await evaluateUnproductiveStreak(run, streakDeps(inbox)); },
    gate: async () => ({ action: 'proceed' }),
  };
  return createAgentActionProcessor(overrides);
}

function actionJob(run: StoredAgentRun): Job<AgentRunJobData> {
  return { id: `agent-run-${run.id}-action`, data: { runId: run.id, definitionId: run.definitionId, ownerId: run.ownerId, phase: 'action', correlationId: 'corr-1' } } as Job<AgentRunJobData>;
}

async function scheduleEnabled(): Promise<boolean | undefined> {
  return (await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled;
}

describe('a mutating acting step breaks the unproductive streak however its run ended (F12)', () => {
  test('a step that changed something and then failed is productive, so the next unchanged run is not paused', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0 };
    const failing = actionProcessor(async () => { grant.performed += 1; throw new Error('agent crashed after creating a TODO'); }, grant, inbox);
    assert.equal((await failing(actionJob(acting))).status, 'failed');

    const failed = await getAgentRunById(acting.id, deps());
    assert.equal(failed?.state, 'failed', 'the run still fails');
    assert.equal(failed?.actingMutations, 1);

    const next = await unchangedRun('completed');
    assert.equal(await evaluateUnproductiveStreak(next, streakDeps(inbox)), null);
    const streak = await findUnproductiveScheduledStreak(definition.id, THRESHOLD, { database });
    assert.deepEqual(streak.runs.map(run => run.id), [next.id]);
    assert.equal(streak.streakKey, acting.id, 'the failed step that changed something ended the previous streak');
    assert.deepEqual(inbox.events, []);
    assert.equal(await scheduleEnabled(), true);
  });

  test('a step that changed something before its run was cancelled elsewhere is productive too', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0 };
    // Like the cancel endpoint: the run is cancelled while its agent is still running.
    const cancelledElsewhere = actionProcessor(async () => {
      grant.performed += 2;
      await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
      throw new Error('container stopped');
    }, grant, inbox);
    assert.equal((await cancelledElsewhere(actionJob(acting))).status, 'cancelled');
    const cancelled = await getAgentRunById(acting.id, deps());
    assert.equal(cancelled?.state, 'cancelled');
    assert.equal(cancelled?.actingMutations, 2);

    assert.equal(await evaluateUnproductiveStreak(await unchangedRun('completed'), streakDeps(inbox)), null);
    assert.equal(await scheduleEnabled(), true);
  });

  test('a failed step that changed nothing extends the streak, and the owner is told by that very run (F14)', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0 };
    assert.equal((await actionProcessor(async () => { throw new Error('agent crashed'); }, grant, inbox)(actionJob(acting))).status, 'failed');
    const failed = await getAgentRunById(acting.id, deps());
    assert.equal(failed?.state, 'failed', 'the run still fails');
    assert.equal(failed?.actingMutations, 0);
    // The third unproductive scheduled run reached the threshold: no later completed run is needed.
    assert.deepEqual(inbox.events.map(event => event.deduplicationKey.split(':')[0]), ['automation-unproductive', 'automation-unproductive-paused']);
    assert.equal(await scheduleEnabled(), false, 'the opted-in schedule was paused by the failed run');
  });

  test('a cancelled step that changed nothing is evaluated once its count is recorded (F14)', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0 };
    const cancelledElsewhere = actionProcessor(async () => {
      await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
      return { success: true, summary: 'nothing to do', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
    }, grant, inbox);
    assert.equal((await cancelledElsewhere(actionJob(acting))).status, 'cancelled');
    assert.equal((await getAgentRunById(acting.id, deps()))?.actingMutations, 0);
    assert.equal(inbox.events.length, 2, 'the streak item, then the one saying the schedule was paused');
    assert.equal(await scheduleEnabled(), false);
  });

  test('a recorded count never replaces one already stored, and only lands on a failed or cancelled run the step claimed', async () => {
    const acting = await unchangedRun('acting');
    const taskId = `agent-run-${acting.id}-action`;
    assert.equal(await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: 1 }, deps()), null, 'not claimed');
    await claimAgentRunAction(acting.id, taskId, deps());
    assert.equal(await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: 1 }, deps()), null, 'still acting');
    await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
    assert.equal(await recordAgentRunActingMutations(acting.id, { actionTaskId: 'another-task', actingMutations: 1 }, deps()), null, 'another task');
    assert.equal((await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: 4 }, deps()))?.actingMutations, 4);
    assert.equal(await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: 0 }, deps()), null, 'already stored');
    assert.equal((await getAgentRunById(acting.id, deps()))?.actingMutations, 4);
  });
});

describe('a run cancelled while its acting step runs stays pending until the step settles its count (F17)', () => {
  test('a run completing in between neither counts the cancelled run nor pauses the schedule', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0 };
    let between: { outcome: unknown; streak: string[]; pending: unknown } | null = null;
    const cancelledElsewhere = actionProcessor(async () => {
      grant.performed += 1;
      await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
      // Another scheduled run completes unproductively before this step's grant is counted.
      const next = await unchangedRun('completed');
      const cancelled = await getAgentRunById(acting.id, deps());
      between = {
        outcome: await evaluateUnproductiveStreak(next, streakDeps(inbox)),
        streak: (await findUnproductiveScheduledStreak(definition.id, THRESHOLD, { database })).runs.map(run => run.id),
        pending: cancelled && agentRunProductivity(cancelled),
      };
      throw new Error('container stopped');
    }, grant, inbox);
    assert.equal((await cancelledElsewhere(actionJob(acting))).status, 'cancelled');

    assert.ok(between);
    const seen = between as { outcome: unknown; streak: string[]; pending: unknown };
    assert.equal(seen.pending, 'pending', 'the cancelled run is not final while its count is outstanding');
    assert.equal(seen.streak.includes(acting.id), false, 'nor is it read as final by the streak query');
    assert.equal(seen.outcome, null);
    assert.deepEqual(inbox.events, []);
    assert.equal(await scheduleEnabled(), true, 'the schedule is not paused through a run that changed something');

    const settled = await getAgentRunById(acting.id, deps());
    assert.equal(settled?.actingMutations, 1);
    assert.equal(settled?.actingMutationsPending, false);
    const streak = await findUnproductiveScheduledStreak(definition.id, THRESHOLD, { database });
    assert.equal(streak.runs.length, 1, 'only the run after the productive one');
    assert.equal(streak.streakKey, acting.id);
  });

  test('an unknown count settles the run on its report flags, and that settlement evaluates the streak', async () => {
    const inbox: Inbox = { events: [] };
    await unchangedRun('completed');
    await unchangedRun('completed');
    const acting = await unchangedRun('acting');
    const grant = { performed: 0, uncounted: true };
    let streakWhileOutstanding: string[] = [];
    const cancelledElsewhere = actionProcessor(async () => {
      await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
      streakWhileOutstanding = (await findUnproductiveScheduledStreak(definition.id, THRESHOLD, { database })).runs.map(run => run.id);
      throw new Error('container stopped');
    }, grant, inbox);
    assert.equal((await cancelledElsewhere(actionJob(acting))).status, 'cancelled');
    assert.equal(streakWhileOutstanding.includes(acting.id), false);

    const settled = await getAgentRunById(acting.id, deps());
    assert.equal(settled?.actingMutations, null, 'an unknown count is not read as a no-op');
    assert.equal(settled?.actingMutationsPending, false);
    assert.equal(agentRunProductivity(settled!), 'unproductive', 'its unchanged report decides once the count is settled');
    assert.equal(inbox.events.length, 2, 'the settled run brought the streak to the threshold');
    assert.equal(await scheduleEnabled(), false);
  });

  test('a run cancelled before its step was claimed has no count outstanding', async () => {
    const acting = await unchangedRun('acting');
    const cancelled = await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
    assert.equal(cancelled?.actingMutationsPending, false);
    assert.equal(agentRunProductivity(cancelled!), 'unproductive');
  });

  test('settling an unknown count applies once, and only while it is outstanding', async () => {
    const acting = await unchangedRun('acting');
    const taskId = `agent-run-${acting.id}-action`;
    assert.equal((await claimAgentRunAction(acting.id, taskId, deps()))?.actingMutationsPending, true);
    await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, deps());
    assert.equal((await getAgentRunById(acting.id, deps()))?.actingMutationsPending, true, 'another writer ending the run leaves it outstanding');
    assert.equal((await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: null }, deps()))?.actingMutationsPending, false);
    assert.equal(await recordAgentRunActingMutations(acting.id, { actionTaskId: taskId, actingMutations: null }, deps()), null, 'already settled');
  });
});
