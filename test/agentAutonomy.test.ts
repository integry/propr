import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, RequestHandler, Response } from 'express';
import knex, { type Knex } from 'knex';
import type { AgentRunState } from '@propr/shared';
import {
  claimAgentRunAction,
  createAgentDefinition,
  createAgentRun,
  enqueueAgentRunActionOrFail,
  failUnclaimedAgentRunAction,
  getAgentRunById,
  transitionAgentRun,
  type AgentRunJobData,
  type StoredAgentDefinition,
  type StoredAgentRun,
} from '@propr/core';

const { advanceAfterReport, notifyAgentReportAwaitingApproval } = await import('../src/jobs/agentRuns/autonomy.ts');
const { createAgentDefinitionRoutes } = await import('../packages/api/routes/agentDefinitionRoutes.ts');

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));

function definition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    id: 'def-1', ownerId: 'user-1', name: 'Dependency watch', description: null,
    repositories: ['acme/web'], prompt: 'Review outdated dependencies.', attachments: [],
    agentAlias: 'claude', modelName: 'opus', capabilities: ['repository_read'],
    includePreviousReports: false, previousReportsLimit: 0,
    scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
    autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function reportedRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: 'run-1', definitionId: 'def-1', ownerId: 'user-1', trigger: 'schedule', triggerSource: 'schedule',
    idempotencyKey: null, state: 'report_ready', autonomyMode: 'dry_run', definitionSnapshot: definition(),
    reportTaskId: 'agent-run-run-1-report', actionTaskId: null, report: 'Two dependencies are outdated.', reportTruncated: false,
    actionSummary: null, skipReason: null, failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
    createdAt: NOW, startedAt: NOW, reportedAt: NOW, finishedAt: null, updatedAt: NOW,
    ...overrides,
  };
}

/** In-memory compare-and-set store for one run. */
function store(initial: StoredAgentRun) {
  let current = initial;
  const transitions: Array<[readonly AgentRunState[], AgentRunState]> = [];
  const transitionRun = (async (_id: string, from: readonly AgentRunState[], to: AgentRunState, patch: Record<string, unknown> = {}) => {
    transitions.push([from, to]);
    if (!from.includes(current.state)) return null;
    current = { ...current, ...patch, state: to } as StoredAgentRun;
    return current;
  }) as typeof transitionAgentRun;
  /** Mirrors the store guard: fails only an `acting` run no action job has claimed. */
  const failUnclaimedAction = (async (_id: string, failureReason: string) => {
    transitions.push([['acting'], 'failed']);
    if (current.state !== 'acting' || current.actionTaskId !== null) return null;
    current = { ...current, failureReason, state: 'failed' };
    return current;
  }) as typeof failUnclaimedAgentRunAction;
  return { transitionRun, failUnclaimedAction, transitions, run: () => current };
}

describe('advanceAfterReport', () => {
  test('dry_run completes the run and never starts the acting step', async () => {
    const s = store(reportedRun());
    const started: string[] = [];
    const notified: string[] = [];
    const result = await advanceAfterReport(s.run(), {
      transitionRun: s.transitionRun,
      startActing: async run => { started.push(run.id); return run; },
      notifyAwaitingApproval: async run => { notified.push(run.id); },
    });
    assert.equal(result?.state, 'completed');
    assert.equal(s.run().report, 'Two dependencies are outdated.');
    assert.deepEqual(started, []);
    assert.deepEqual(notified, []);
  });

  test('preview waits for approval and notifies the owner without starting the acting step', async () => {
    const s = store(reportedRun({ autonomyMode: 'preview' }));
    const started: string[] = [];
    const notified: StoredAgentRun[] = [];
    const result = await advanceAfterReport(s.run(), {
      transitionRun: s.transitionRun,
      startActing: async run => { started.push(run.id); return run; },
      notifyAwaitingApproval: async run => { notified.push(run); },
    });
    assert.equal(result?.state, 'awaiting_approval');
    assert.deepEqual(started, []);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].state, 'awaiting_approval');
  });

  test('preview still waits for approval when the Inbox notification fails', async () => {
    const s = store(reportedRun({ autonomyMode: 'preview' }));
    const result = await advanceAfterReport(s.run(), {
      transitionRun: s.transitionRun,
      notifyAwaitingApproval: async () => { throw new Error('database locked'); },
    });
    assert.equal(result?.state, 'awaiting_approval');
  });

  test('auto moves straight to acting and enqueues the action phase', async () => {
    const s = store(reportedRun({ autonomyMode: 'auto' }));
    const jobs: Array<[string, AgentRunJobData, { jobId?: string }]> = [];
    const result = await advanceAfterReport(s.run(), {
      transitionRun: s.transitionRun,
      startActing: run => enqueueAgentRunActionOrFail(run, {
        failUnclaimedAction: s.failUnclaimedAction,
        enqueue: async (name, data, options) => { jobs.push([name, data, options]); },
      }),
    });
    assert.equal(result?.state, 'acting');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0][0], 'processAgentAction');
    assert.equal(jobs[0][1].phase, 'action');
    assert.equal(jobs[0][1].runId, 'run-1');
    assert.equal(jobs[0][2].jobId, 'agent-run-run-1-action');
  });

  test('auto fails the run with the reason when the action phase cannot be enqueued', async () => {
    const s = store(reportedRun({ autonomyMode: 'auto' }));
    const result = await advanceAfterReport(s.run(), {
      transitionRun: s.transitionRun,
      startActing: run => enqueueAgentRunActionOrFail(run, {
        failUnclaimedAction: s.failUnclaimedAction,
        enqueue: async () => { throw new Error('Redis unavailable'); },
      }),
    });
    assert.equal(result?.state, 'failed');
    assert.match(s.run().failureReason ?? '', /Redis unavailable/);
    assert.deepEqual(s.transitions.map(([, to]) => to), ['acting', 'failed']);
  });

  test('a run that already left report_ready is not advanced', async () => {
    const s = store(reportedRun({ autonomyMode: 'auto', state: 'cancelled' }));
    const started: string[] = [];
    const result = await advanceAfterReport(reportedRun({ autonomyMode: 'auto' }), {
      transitionRun: s.transitionRun,
      startActing: async run => { started.push(run.id); return run; },
    });
    assert.equal(result, null);
    assert.deepEqual(started, []);
  });
});

describe('notifyAgentReportAwaitingApproval', () => {
  test('creates a task Inbox item for the owner', async () => {
    const events: Array<{ input: Record<string, unknown>; recipients: unknown }> = [];
    await notifyAgentReportAwaitingApproval(reportedRun({ state: 'awaiting_approval' }), {
      createEvent: (async (input: Record<string, unknown>, recipients: unknown) => { events.push({ input, recipients }); }) as never,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].input.kind, 'task');
    assert.equal(events[0].input.title, 'Agent Dependency watch report ready for review');
    assert.deepEqual(events[0].input.target, { type: 'task', repository: 'acme/web', taskId: 'agent-run-run-1-report' });
    assert.deepEqual(events[0].recipients, [{ userId: 'user-1', pushEnabled: true }]);
  });

  test('skips agents without a repository, which have no task target', async () => {
    let created = 0;
    await notifyAgentReportAwaitingApproval(reportedRun({ definitionSnapshot: definition({ repositories: [] }) }), {
      createEvent: (async () => { created += 1; }) as never,
    });
    assert.equal(created, 0);
  });
});

interface CallResult { status: number; body: { run?: StoredAgentRun; error?: string; code?: string } }

async function call(route: RequestHandler, userId: string, runId: string, body: unknown = {}): Promise<CallResult> {
  const state: CallResult = { status: 200, body: {} };
  const res = {
    headersSent: false,
    status(code: number) { state.status = code; return this; },
    json(payload: CallResult['body']) { state.body = payload; return this; },
    end() { return this; },
  } as unknown as Response;
  const req = { user: { id: userId, username: userId }, params: { runId }, body, query: {}, get: () => undefined } as unknown as Request;
  await route(req, res, () => undefined);
  return state;
}

describe('approve and reject routes', () => {
  let database: Knex;
  let started: Array<{ runId: string; note: string | null }>;
  let routes: ReturnType<typeof createAgentDefinitionRoutes>;

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({ directory: migrations });
    started = [];
    routes = createAgentDefinitionRoutes({
      db: database,
      services: {
        now: () => NOW,
        startActing: async (run, note) => { started.push({ runId: run.id, note }); return run; },
      },
    });
  });

  afterEach(async () => {
    await database.destroy();
  });

  async function runIn(state: AgentRunState): Promise<StoredAgentRun> {
    const stored = await createAgentDefinition({
      ownerId: 'alice', name: 'Watch', prompt: 'Check', repositories: ['acme/web'], autonomyMode: 'preview',
    }, { database, now: () => NOW });
    const { run } = await createAgentRun({ definition: stored, trigger: 'manual' }, { database, now: () => NOW });
    const path: AgentRunState[] = ['running', 'report_ready', 'awaiting_approval', 'acting', 'completed'];
    let from: AgentRunState = 'queued';
    for (const next of path) {
      if (from === state) break;
      await transitionAgentRun(run.id, [from], next, next === 'report_ready' ? { report: 'Report' } : {}, { database, now: () => NOW });
      from = next;
    }
    return (await getAgentRunById(run.id, { database }))!;
  }

  test('approve moves an awaiting run to acting, records the approver and starts the acting step with the note', async () => {
    const run = await runIn('awaiting_approval');
    const approved = await call(routes.approveRun, 'alice', run.id, { note: '  Only file TODOs.  ' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.run?.state, 'acting');
    assert.equal(approved.body.run?.approvedBy, 'alice');
    assert.deepEqual(started, [{ runId: run.id, note: 'Only file TODOs.' }]);
    assert.equal((await getAgentRunById(run.id, { database }))?.operatorNote, 'Only file TODOs.');
  });

  test('a double-clicked approve moves the run once and both requests dispatch the same acting step', async () => {
    const run = await runIn('awaiting_approval');
    const enqueued: Array<{ jobId: unknown; data: AgentRunJobData }> = [];
    routes = createAgentDefinitionRoutes({
      db: database,
      services: {
        now: () => NOW,
        startActing: (acting, note) => enqueueAgentRunActionOrFail(acting, {
          database, now: () => NOW, operatorNote: note, enqueue: async (_name, data, options) => { enqueued.push({ jobId: options.jobId, data }); },
        }),
      },
    });
    const [first, second] = await Promise.all([
      call(routes.approveRun, 'alice', run.id, { note: 'First note.' }),
      call(routes.approveRun, 'alice', run.id, { note: 'Second note.' }),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    const stored = await getAgentRunById(run.id, { database });
    assert.equal(stored?.state, 'acting');
    // Only the approval that moved the run stored its note; the other request re-dispatches with it.
    assert.ok(['First note.', 'Second note.'].includes(stored?.operatorNote ?? ''));
    assert.equal(new Set(enqueued.map(entry => entry.jobId)).size, 1);
    assert.deepEqual(enqueued.map(entry => entry.data.operatorNote), [stored?.operatorNote, stored?.operatorNote]);
  });

  test('approving again after an interrupted handoff dispatches the acting step with the stored note', async () => {
    const run = await runIn('awaiting_approval');
    // The first approval committed, then its process stopped before enqueueing the acting step.
    await transitionAgentRun(run.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice', operatorNote: 'Only file TODOs.' }, { database, now: () => NOW });
    const enqueued: AgentRunJobData[] = [];
    routes = createAgentDefinitionRoutes({
      db: database,
      services: {
        now: () => NOW,
        startActing: (acting, note) => enqueueAgentRunActionOrFail(acting, {
          database, now: () => NOW, operatorNote: note, enqueue: async (_name, data) => { enqueued.push(data); },
        }),
      },
    });

    const retried = await call(routes.approveRun, 'alice', run.id);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.run?.state, 'acting');
    assert.equal(retried.body.run?.approvedBy, 'alice');
    assert.deepEqual(enqueued.map(data => [data.runId, data.phase, data.operatorNote]), [[run.id, 'action', 'Only file TODOs.']]);
  });

  test('a failed redundant dispatch does not fail an approval the worker already claimed', async () => {
    const run = await runIn('awaiting_approval');
    let dispatches = 0;
    routes = createAgentDefinitionRoutes({
      db: database,
      services: {
        now: () => NOW,
        startActing: (acting, note) => enqueueAgentRunActionOrFail(acting, {
          database, now: () => NOW, operatorNote: note,
          enqueue: async () => {
            dispatches += 1;
            if (dispatches === 1) return;
            // The first dispatch reached the worker, which claimed the run before this one failed.
            assert.ok(await claimAgentRunAction(run.id, 'action-task-1', { database, now: () => NOW }));
            throw new Error('Redis unavailable');
          },
        }),
      },
    });
    await transitionAgentRun(run.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice' }, { database, now: () => NOW });
    assert.equal((await call(routes.approveRun, 'alice', run.id)).status, 200);

    const retried = await call(routes.approveRun, 'alice', run.id);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.run?.state, 'acting');
    assert.equal(retried.body.run?.actionTaskId, 'action-task-1');
    assert.equal(retried.body.run?.failureReason, null);
    const completed = await transitionAgentRun(run.id, ['acting'], 'completed', { actionSummary: 'Filed 2 issues.' }, { database, now: () => NOW });
    assert.equal(completed?.actionSummary, 'Filed 2 issues.');
  });

  test('a failed dispatch still fails an acting run that no worker claimed', async () => {
    const run = await runIn('acting');
    const result = await enqueueAgentRunActionOrFail(run, {
      database, now: () => NOW, enqueue: async () => { throw new Error('Redis unavailable'); },
    });
    assert.equal(result.state, 'failed');
    assert.match(result.failureReason ?? '', /Redis unavailable/);
    assert.equal(result.finishedAt, NOW);
  });

  test('a failed report-phase redispatch leaves a claimed acting run untouched', async () => {
    const run = await runIn('acting');
    await claimAgentRunAction(run.id, 'action-task-1', { database, now: () => NOW });
    // processAgentRunJob resumes an acting run it read as unclaimed; the claim landed after that read.
    const result = await enqueueAgentRunActionOrFail(run, {
      database, now: () => NOW, enqueue: async () => { throw new Error('Redis unavailable'); },
    });
    assert.equal(result.state, 'acting');
    assert.equal(result.actionTaskId, 'action-task-1');
    assert.equal(result.failureReason, null);
  });

  test('a database upgraded from the original agent tables gains operator_note and approves with it', async () => {
    const name = '20261006010000_add_agent_run_operator_note.js';
    // Return to the schema an installation had after the original agent-tables migration.
    await database.migrate.down({ directory: migrations, name });
    assert.equal(await database.schema.hasColumn('agent_runs', 'operator_note'), false);
    assert.ok(await database.schema.hasTable('agent_runs'));

    await database.migrate.latest({ directory: migrations });
    assert.ok(await database.schema.hasColumn('agent_runs', 'operator_note'));
    const run = await runIn('awaiting_approval');
    const approved = await call(routes.approveRun, 'alice', run.id, { note: 'Only file TODOs.' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.run?.state, 'acting');
    assert.equal((await getAgentRunById(run.id, { database }))?.operatorNote, 'Only file TODOs.');
  });

  test('approve answers 409 once the acting step of an approval was claimed', async () => {
    const run = await runIn('awaiting_approval');
    await transitionAgentRun(run.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice', actionTaskId: 'action-task-1' }, { database, now: () => NOW });
    const approved = await call(routes.approveRun, 'alice', run.id);
    assert.equal(approved.status, 409);
    assert.equal(approved.body.code, 'AGENT_RUN_NOT_AWAITING_APPROVAL');
    assert.deepEqual(started, []);
  });

  test('an auto run that is acting is not dispatched by approve', async () => {
    const run = await runIn('acting');
    assert.equal(run.approvedBy, null);
    assert.equal((await call(routes.approveRun, 'alice', run.id)).status, 409);
    assert.deepEqual(started, []);
  });

  test('reject moves an awaiting run to rejected without starting the acting step', async () => {
    const run = await runIn('awaiting_approval');
    const rejected = await call(routes.rejectRun, 'alice', run.id);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.run?.state, 'rejected');
    assert.deepEqual(started, []);
    assert.equal((await call(routes.approveRun, 'alice', run.id)).status, 409);
  });

  for (const state of ['queued', 'report_ready', 'acting', 'completed'] as const) {
    test(`approve and reject answer 409 for a ${state} run`, async () => {
      const run = await runIn(state);
      const approved = await call(routes.approveRun, 'alice', run.id);
      const rejected = await call(routes.rejectRun, 'alice', run.id);
      assert.equal(approved.status, 409);
      assert.equal(approved.body.code, 'AGENT_RUN_NOT_AWAITING_APPROVAL');
      assert.equal(rejected.status, 409);
      assert.equal((await getAgentRunById(run.id, { database }))?.state, state);
      assert.deepEqual(started, []);
    });
  }

  test('another owner gets 404 and the run is unchanged', async () => {
    const run = await runIn('awaiting_approval');
    assert.equal((await call(routes.approveRun, 'mallory', run.id)).status, 404);
    assert.equal((await call(routes.rejectRun, 'mallory', run.id)).status, 404);
    assert.equal((await getAgentRunById(run.id, { database }))?.state, 'awaiting_approval');
  });

  test('a note longer than the limit is rejected before the run moves', async () => {
    const run = await runIn('awaiting_approval');
    const approved = await call(routes.approveRun, 'alice', run.id, { note: 'x'.repeat(2_001) });
    assert.equal(approved.status, 400);
    assert.equal((await getAgentRunById(run.id, { database }))?.state, 'awaiting_approval');
  });

  test('approve fails the run when its acting step cannot be enqueued', async () => {
    routes = createAgentDefinitionRoutes({
      db: database,
      services: {
        now: () => NOW,
        startActing: run => enqueueAgentRunActionOrFail(run, { database, now: () => NOW, enqueue: async () => { throw new Error('Redis unavailable'); } }),
      },
    });
    const run = await runIn('awaiting_approval');
    const approved = await call(routes.approveRun, 'alice', run.id);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.run?.state, 'failed');
    assert.match(approved.body.run?.failureReason ?? '', /Redis unavailable/);
  });
});
