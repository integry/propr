import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, RequestHandler, Response } from 'express';
import knex, { type Knex } from 'knex';
import { createAgentDefinition, getAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import {
  claimAgentRunAction,
  createAgentRun,
  getAgentRunById,
  transitionAgentRun,
  type StoredAgentRun,
} from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  findUnproductiveScheduledStreak,
  pauseScheduleForUnproductiveStreak,
  recordAgentRunActingMutations,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

const { createAutomationDefinitionRoutes } = await import('../packages/api/routes/automationDefinitionRoutes.ts');
const { evaluateUnproductiveStreak } = await import('../src/jobs/agentRuns/unproductiveStreak.ts');
type UnproductiveStreakDeps = import('../src/jobs/agentRuns/unproductiveStreak.ts').UnproductiveStreakDeps;

/**
 * F18/F19: a run the owner cancels while it waits for approval has no worker left
 * to evaluate it, so the cancel route brings the streak it completes to the owner
 * (and pauses an opted-in schedule) at once. A run whose claimed acting step still
 * holds its grant stays pending until that step's worker settles the count.
 */

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 12, 22, 0);
const THRESHOLD = 3;

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

let database: Knex;
let clock: number;
let definition: StoredAgentDefinition;
let inbox: Array<{ deduplicationKey: string; metadata?: { event?: string; pauseIntended?: unknown } }>;
let stopped: string[];
let routes: ReturnType<typeof createAutomationDefinitionRoutes>;
const deps = () => ({ database, now: () => clock });

function streakDeps(): UnproductiveStreakDeps {
  const stored = new Map<string, { pauseIntended: boolean }>();
  return {
    loadThreshold: async () => THRESHOLD,
    findStreak: (definitionId, threshold) => findUnproductiveScheduledStreak(definitionId, threshold, { database }),
    getDefinition: (definitionId, ownerId) => getAgentDefinition(definitionId, ownerId, { database }),
    pauseSchedule: (definitionId, pause) => pauseScheduleForUnproductiveStreak(definitionId, pause, deps()),
    findNotification: async key => stored.get(key) ?? null,
    createEvent: (async (event: (typeof inbox)[number]) => {
      if (!stored.has(event.deduplicationKey)) inbox.push(event);
      stored.set(event.deduplicationKey, { pauseIntended: event.metadata?.pauseIntended === true });
      return event;
    }) as never,
  };
}

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  clock = NOW;
  inbox = [];
  stopped = [];
  definition = await createAgentDefinition({
    ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', repositories: ['acme/web'], autonomyMode: 'preview',
    scheduleCron: '0 22 * * *', scheduleEnabled: true, pauseWhenUnproductive: true,
  }, deps());
  const evaluate = streakDeps();
  routes = createAutomationDefinitionRoutes({
    db: database,
    services: {
      now: () => clock,
      startActing: async run => run,
      stopTask: (async (taskId: string) => { stopped.push(taskId); }) as never,
      // The production evaluation, with a known threshold and an in-memory Inbox.
      evaluateStreak: async run => { await evaluateUnproductiveStreak(run, evaluate); },
    },
  });
});
afterEach(async () => { await database.destroy(); });

/** A scheduled preview run whose report repeated the previous one, now waiting for approval. */
async function awaitingUnchangedRun(): Promise<StoredAgentRun> {
  clock += 60_000;
  const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
  await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps());
  await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'Nothing changed.', reportHash: 'f'.repeat(64), reportNovelty: 'unchanged' }, deps());
  return (await transitionAgentRun(run.id, ['report_ready'], 'awaiting_approval', {}, deps()))!;
}

async function cancel(runId: string): Promise<{ status: number; body: { run?: { state: string } } }> {
  const result = { status: 200, body: {} as { run?: { state: string } } };
  const res = {
    headersSent: false,
    status(code: number) { result.status = code; return this; },
    json(payload: typeof result.body) { result.body = payload; return this; },
    end() { return this; },
  } as unknown as Response;
  const req = { user: { id: 'alice', username: 'alice' }, params: { runId }, body: {}, query: {}, get: () => undefined } as unknown as Request;
  await (routes.cancelRun as RequestHandler)(req, res, () => undefined);
  return result;
}

const streakItems = () => inbox.filter(event => event.metadata?.event === 'automation.unproductive_streak');
const scheduleEnabled = async () => (await getAgentDefinition(definition.id, 'alice', { database }))!.scheduleEnabled;

describe('cancelling an unproductive scheduled run', () => {
  test('the third unchanged run cancelled while awaiting approval notifies the owner and pauses the schedule', async () => {
    const runs = [await awaitingUnchangedRun(), await awaitingUnchangedRun(), await awaitingUnchangedRun()];
    for (const [index, run] of runs.entries()) {
      assert.equal(streakItems().length, 0, `no item before cancel ${index + 1}`);
      assert.equal(await scheduleEnabled(), true);
      const response = await cancel(run.id);
      assert.equal(response.status, 200);
      assert.equal(response.body.run?.state, 'cancelled');
    }
    assert.equal(streakItems().length, 1);
    assert.equal(streakItems()[0].metadata?.pauseIntended, true);
    assert.equal(await scheduleEnabled(), false);
    // No task ran for a run waiting for approval, so none was stopped.
    assert.deepEqual(stopped, []);
  });

  test('two finished runs and a third cancelled while awaiting approval complete the streak at the cancel', async () => {
    for (let index = 0; index < 2; index += 1) {
      const run = await awaitingUnchangedRun();
      const rejected = await transitionAgentRun(run.id, ['awaiting_approval'], 'rejected', {}, deps());
      assert.equal(await evaluateUnproductiveStreak(rejected!, streakDeps()), null, `run ${index + 1} is below the threshold`);
    }
    const third = await awaitingUnchangedRun();
    assert.equal(streakItems().length, 0);
    assert.equal((await cancel(third.id)).status, 200);
    assert.equal(streakItems().length, 1);
    assert.equal(await scheduleEnabled(), false);
  });

  test('a run cancelled while its claimed acting step holds the grant waits for that step to settle its count', async () => {
    await cancel((await awaitingUnchangedRun()).id);
    await cancel((await awaitingUnchangedRun()).id);
    const third = await awaitingUnchangedRun();
    await transitionAgentRun(third.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice' }, deps());
    const actionTaskId = `agent-run-${third.id}-action`;
    assert.ok(await claimAgentRunAction(third.id, actionTaskId, deps()));

    assert.equal((await cancel(third.id)).status, 200);
    assert.deepEqual(stopped, [actionTaskId]);
    // The step's count is still outstanding, so the cancel neither notified nor paused.
    assert.equal(streakItems().length, 0);
    assert.equal(await scheduleEnabled(), true);

    // The step's worker stores its count (nothing changed) and evaluates the run.
    const settled = await recordAgentRunActingMutations(third.id, { actionTaskId, actingMutations: 0 }, deps());
    assert.equal(await evaluateUnproductiveStreak(settled!, streakDeps()), 'paused');
    assert.equal(await scheduleEnabled(), false);
  });

  test('a run cancelled while its claimed acting step changed something is not counted after it settles', async () => {
    await cancel((await awaitingUnchangedRun()).id);
    await cancel((await awaitingUnchangedRun()).id);
    const third = await awaitingUnchangedRun();
    await transitionAgentRun(third.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice' }, deps());
    const actionTaskId = `agent-run-${third.id}-action`;
    await claimAgentRunAction(third.id, actionTaskId, deps());
    await cancel(third.id);
    const settled = await recordAgentRunActingMutations(third.id, { actionTaskId, actingMutations: 2 }, deps());
    assert.equal(await evaluateUnproductiveStreak(settled!, streakDeps()), null);
    assert.equal(streakItems().length, 0);
    assert.equal(await scheduleEnabled(), true);
    assert.equal((await getAgentRunById(third.id, deps()))!.actingMutations, 2);
  });
});
