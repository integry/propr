import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { AutomationReportNovelty, AutomationRunTrigger } from '@propr/shared';
import {
  createAgentDefinition,
  disableAgentDefinitionSchedule,
  getAgentDefinition,
  updateAgentDefinition,
  type StoredAgentDefinition,
} from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { createAgentRun, getAgentRunById, transitionAgentRun, type StoredAgentRun } from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  agentRunProductivity,
  findUnproductiveScheduledStreak,
  hasNotificationEvent,
  loadUnproductiveRunThreshold,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

const { evaluateUnproductiveStreak, unproductiveStreakDeduplicationKey } = await import('../src/jobs/agentRuns/unproductiveStreak.ts');

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const MIGRATION = '20261112000000_add_agent_run_productivity_flags.js';
const NOW = Date.UTC(2026, 10, 11, 22, 0);

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

async function openDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  return database;
}

describe('productivity flags migration', () => {
  test('adds nullable run flags and a default-off definition flag, keeps existing rows null, and reverses', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await database.migrate.latest({ directory: migrations });
      const migration = await import(`../packages/core/src/db/migrations/${MIGRATION}`);
      await migration.down(database);
      for (const column of ['report_hash', 'report_novelty', 'acting_mutations']) assert.equal(await database.schema.hasColumn('agent_runs', column), false, column);
      assert.equal(await database.schema.hasColumn('agent_definitions', 'pause_when_unproductive'), false);

      // A run recorded before the flags existed.
      const definitionRow = { id: 'def-old', owner_id: 'alice', name: 'Old', prompt: 'p', repositories: '[]', attachments: '[]', capabilities: '[]',
        include_previous_reports: false, previous_reports_limit: 0, schedule_timezone: 'UTC', schedule_enabled: false, autonomy_mode: 'dry_run',
        enabled: true, revision: 0, created_at: NOW, updated_at: NOW };
      await database('agent_definitions').insert(definitionRow);
      await database('agent_runs').insert({ id: 'run-old', definition_id: 'def-old', owner_id: 'alice', trigger: 'schedule', state: 'completed',
        autonomy_mode: 'dry_run', definition_snapshot: '{}', report: 'An old report', report_truncated: false, deferrals: 0, created_at: NOW, updated_at: NOW });

      await migration.up(database);
      await migration.up(database); // safe to repeat
      const run = await getAgentRunById('run-old', { database });
      assert.equal(run?.reportHash, null);
      assert.equal(run?.reportNovelty, null);
      assert.equal(run?.actingMutations, null);
      assert.equal((await getAgentDefinition('def-old', 'alice', { database }))?.pauseWhenUnproductive, false);

      await migration.down(database);
      await migration.down(database); // safe to repeat
      assert.equal(await database.schema.hasColumn('agent_runs', 'report_hash'), false);
      assert.ok(await database('agent_runs').where({ id: 'run-old' }).first(), 'rows survive the rollback');
    } finally {
      await database.destroy();
    }
  });
});

describe('unproductive scheduled streak', () => {
  let database: Knex;
  let clock: number;
  let definition: StoredAgentDefinition;
  const deps = () => ({ database, now: () => clock });

  beforeEach(async () => {
    database = await openDatabase();
    clock = NOW;
    definition = await createAgentDefinition({
      ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', repositories: ['acme/web'],
      scheduleCron: '0 22 * * *', scheduleEnabled: true,
    }, deps());
  });
  afterEach(async () => { await database.destroy(); });

  /** A completed run with the given flags, one minute after the previous one. */
  async function completedRun(
    { trigger = 'schedule', novelty = 'new', mutations = null, state = 'completed' }:
    { trigger?: AutomationRunTrigger; novelty?: AutomationReportNovelty | null; mutations?: number | null; state?: 'completed' | 'acting' | 'awaiting_approval' | 'rejected' } = {},
  ): Promise<StoredAgentRun> {
    clock += 60_000;
    const { run } = await createAgentRun({ definition, trigger }, deps());
    await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps());
    const reported = await transitionAgentRun(run.id, ['running'], 'report_ready',
      { report: 'A report', reportHash: novelty ? 'f'.repeat(64) : null, reportNovelty: novelty }, deps());
    if (state === 'awaiting_approval' || state === 'rejected') {
      const waiting = (await transitionAgentRun(run.id, ['report_ready'], 'awaiting_approval', {}, deps()))!;
      return state === 'rejected' ? (await transitionAgentRun(run.id, ['awaiting_approval'], 'rejected', {}, deps()))! : waiting;
    }
    if (state === 'acting') return (await transitionAgentRun(run.id, ['report_ready'], 'acting', {}, deps()))!;
    if (mutations !== null) {
      await transitionAgentRun(run.id, ['report_ready'], 'acting', {}, deps());
      return (await transitionAgentRun(run.id, ['acting'], 'completed', { actingMutations: mutations }, deps()))!;
    }
    assert.ok(reported);
    return (await transitionAgentRun(run.id, ['report_ready'], 'completed', {}, deps()))!;
  }

  test('the store round-trips the flags', async () => {
    const run = await completedRun({ novelty: 'unchanged', mutations: 0 });
    const stored = await getAgentRunById(run.id, { database });
    assert.equal(stored?.reportHash, 'f'.repeat(64));
    assert.equal(stored?.reportNovelty, 'unchanged');
    assert.equal(stored?.actingMutations, 0);
    assert.equal(stored?.state, 'completed', 'flagged runs still complete');
  });

  test('verdicts: flags decide, an acting step still running is pending', () => {
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: 'new', actingMutations: null }), 'productive');
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: 'unchanged', actingMutations: null }), 'unproductive');
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: 'new', actingMutations: 0 }), 'unproductive');
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: 'unchanged', actingMutations: 3 }), 'productive');
    assert.equal(agentRunProductivity({ state: 'acting', reportNovelty: 'unchanged', actingMutations: null }), 'pending');
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: null, actingMutations: null }), 'pending');
  });

  test('a run waiting for approval is pending until its acting step is decided', () => {
    assert.equal(agentRunProductivity({ state: 'awaiting_approval', reportNovelty: 'unchanged', actingMutations: null }), 'pending');
    assert.equal(agentRunProductivity({ state: 'awaiting_approval', reportNovelty: 'empty', actingMutations: null }), 'pending');
    assert.equal(agentRunProductivity({ state: 'rejected', reportNovelty: 'unchanged', actingMutations: null }), 'unproductive');
    assert.equal(agentRunProductivity({ state: 'rejected', reportNovelty: 'new', actingMutations: null }), 'productive');
  });

  test('a known acting count decides the verdict without a report novelty', () => {
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: null, actingMutations: 0 }), 'unproductive');
    assert.equal(agentRunProductivity({ state: 'completed', reportNovelty: null, actingMutations: 2 }), 'productive');
    assert.equal(agentRunProductivity({ state: 'acting', reportNovelty: null, actingMutations: 0 }), 'unproductive', 'the count is stored once the grant is revoked');
  });

  test('preview runs waiting for approval neither extend nor break the streak', async () => {
    await completedRun({ novelty: 'unchanged' });
    await completedRun({ novelty: 'unchanged', state: 'awaiting_approval' });
    await completedRun({ novelty: 'unchanged', state: 'awaiting_approval' });
    const streak = await findUnproductiveScheduledStreak(definition.id, 2, { database });
    assert.equal(streak.runs.length, 1);
    assert.equal(streak.reachedThreshold, false);
    await completedRun({ novelty: 'unchanged', state: 'rejected' });
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 2, { database })).reachedThreshold, true, 'a rejected run is final');
  });

  test('runs whose report could not be compared still count through their acting step', async () => {
    const productive = await completedRun({ novelty: 'unchanged', mutations: 1 });
    await completedRun({ novelty: null, mutations: 0 });
    await completedRun({ novelty: null, mutations: 0 });
    const streak = await findUnproductiveScheduledStreak(definition.id, 2, { database });
    assert.equal(streak.runs.length, 2);
    assert.equal(streak.reachedThreshold, true);
    assert.equal(streak.streakKey, productive.id, 'identified by the productive run before it');
    await completedRun({ novelty: null, mutations: 3 });
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 2, { database })).runs.length, 0, 'a positive count resets it');
  });

  test('counts consecutive unproductive scheduled runs under one stable identity', async () => {
    const productive = await completedRun({ novelty: 'new' });
    await completedRun({ novelty: 'unchanged' });
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 3, { database })).reachedThreshold, false);
    await completedRun({ novelty: 'empty' });
    const third = await completedRun({ novelty: 'new', mutations: 0 });
    const streak = await findUnproductiveScheduledStreak(definition.id, 3, { database });
    assert.equal(streak.reachedThreshold, true);
    assert.equal(streak.runs.length, 3);
    assert.equal(streak.runs[0].id, third.id, 'newest first');
    assert.equal(streak.streakKey, productive.id);

    await completedRun({ novelty: 'unchanged' });
    const longer = await findUnproductiveScheduledStreak(definition.id, 3, { database });
    assert.equal(longer.reachedThreshold, true, 'still past the threshold, so a lost notification can be retried');
    assert.equal(longer.runs.length, 4);
    assert.equal(longer.streakKey, productive.id, 'the identity does not move as the streak grows');
  });

  test('manual runs neither count nor reset the streak; pending runs are skipped', async () => {
    await completedRun({ novelty: 'unchanged' });
    await completedRun({ novelty: 'unchanged', trigger: 'manual' });
    await completedRun({ novelty: 'new', trigger: 'manual' });
    await completedRun({ novelty: 'unchanged' });
    await completedRun({ novelty: 'unchanged', state: 'acting' });
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 2, { database })).reachedThreshold, true);
  });

  test('a productive scheduled run resets the streak', async () => {
    await completedRun({ novelty: 'unchanged' });
    await completedRun({ novelty: 'unchanged' });
    await completedRun({ novelty: 'unchanged', mutations: 2 });
    const streak = await findUnproductiveScheduledStreak(definition.id, 2, { database });
    assert.equal(streak.runs.length, 0);
    assert.equal(streak.reachedThreshold, false);
  });

  test('the threshold setting falls back to 3 when unset or invalid', async () => {
    assert.equal(await loadUnproductiveRunThreshold({ readConfig: async (_key, fallback) => fallback }), 3);
    assert.equal(await loadUnproductiveRunThreshold({ readConfig: async <T>() => 5 as T }), 5);
    assert.equal(await loadUnproductiveRunThreshold({ readConfig: async <T>() => 0 as T }), 3);
    assert.equal(await loadUnproductiveRunThreshold({ readConfig: async () => { throw new Error('db down'); } }), 3);
  });

  describe('evaluateUnproductiveStreak', () => {
    type Event = Record<string, unknown> & { deduplicationKey: string; kind: string; target: Record<string, unknown>; title: string; body: string };
    function streakDeps(threshold = 3) {
      const events: Array<{ event: Event; recipients: unknown }> = [];
      const seen = new Set<string>();
      return {
        events,
        deps: {
          loadThreshold: async () => threshold,
          findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
          hasNotification: async (key: string) => seen.has(key),
          getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
          disableSchedule: (definitionId: string) => disableAgentDefinitionSchedule(definitionId, { database, now: () => clock }),
          // Mirrors the Inbox: a repeated deduplication key does not create a second item.
          createEvent: (async (event: Event, recipients: unknown) => {
            if (!seen.has(event.deduplicationKey)) events.push({ event, recipients });
            seen.add(event.deduplicationKey);
            return event;
          }) as never,
        },
      };
    }

    test('the owner is told once, naming the automation, after N consecutive unproductive scheduled runs', async () => {
      const { deps: evaluate, events } = streakDeps();
      const first = await completedRun({ novelty: 'unchanged' });
      assert.equal(await evaluateUnproductiveStreak(first, evaluate), null);
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'empty' }), evaluate), null);
      const third = await completedRun({ novelty: 'new', mutations: 0 });
      assert.equal(await evaluateUnproductiveStreak(third, evaluate), 'notified');
      await evaluateUnproductiveStreak(third, evaluate); // a retried evaluation
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), evaluate), null);

      assert.equal(events.length, 1);
      const [{ event, recipients }] = events;
      assert.match(event.title, /Nightly triage/);
      assert.equal(event.deduplicationKey, unproductiveStreakDeduplicationKey(definition.id, 'start'));
      assert.equal(event.kind, 'task');
      assert.deepEqual(event.target, { type: 'task', repository: 'acme/web', taskId: third.reportTaskId });
      assert.match(event.body, /last 3 scheduled runs produced nothing new/);
      assert.match(event.body, /same as the previous run/);
      assert.match(event.body, /acting step changed nothing/);
      assert.deepEqual(recipients, [{ userId: 'alice', pushEnabled: true }]);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true, 'pausing is off by default');
    });

    test('a productive run resets the streak, so a new streak is reported again', async () => {
      const { deps: evaluate, events } = streakDeps(2);
      await completedRun({ novelty: 'unchanged' });
      await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), evaluate);
      await evaluateUnproductiveStreak(await completedRun({ novelty: 'new' }), evaluate);
      await completedRun({ novelty: 'unchanged' });
      await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), evaluate);
      assert.equal(events.length, 2);
      assert.notEqual(events[0].event.deduplicationKey, events[1].event.deduplicationKey);
    });

    test('manual runs are flagged but never trigger or extend the notification', async () => {
      const { deps: evaluate, events } = streakDeps(2);
      for (let index = 0; index < 3; index += 1) {
        assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged', trigger: 'manual' }), evaluate), null);
      }
      assert.equal(events.length, 0);
    });

    test('with pauseWhenUnproductive the schedule is turned off through the schedule-disable path', async () => {
      definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
      assert.equal(definition.pauseWhenUnproductive, true);
      const { deps: evaluate, events } = streakDeps(2);
      await completedRun({ novelty: 'unchanged' });
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'empty' }), evaluate), 'paused');

      const paused = await getAgentDefinition(definition.id, 'alice', { database });
      assert.equal(paused?.scheduleEnabled, false);
      assert.equal(paused?.nextRunAt, null);
      assert.equal(paused?.revision, definition.revision + 1, 'counts as an edit, like every system disable');
      assert.equal(events.length, 1);
      assert.match(events[0].event.title, /paused/);
      assert.match(events[0].event.body, /schedule has been paused/);
      assert.equal((events[0].event.metadata as { schedulePaused: boolean }).schedulePaused, true);
    });

    test('waiting preview runs do not notify or pause; the verdict follows approval or rejection', async () => {
      definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
      const { deps: evaluate, events } = streakDeps(3);
      const waiting = [];
      for (let index = 0; index < 3; index += 1) {
        const run = await completedRun({ novelty: 'unchanged', state: 'awaiting_approval' });
        waiting.push(run);
        assert.equal(await evaluateUnproductiveStreak(run, evaluate), null);
      }
      assert.equal(events.length, 0);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true);

      // Approving the newest one changes something; it is productive, so the older two are a new streak's past.
      await transitionAgentRun(waiting[2].id, ['awaiting_approval'], 'acting', { approvedBy: 'alice' }, deps());
      const acted = (await transitionAgentRun(waiting[2].id, ['acting'], 'completed', { actingMutations: 2 }, deps()))!;
      assert.equal(await evaluateUnproductiveStreak(acted, evaluate), null);
      for (const run of waiting.slice(0, 2)) {
        const rejected = (await transitionAgentRun(run.id, ['awaiting_approval'], 'rejected', {}, deps()))!;
        assert.equal(await evaluateUnproductiveStreak(rejected, evaluate), null, 'older than the productive run');
      }
      assert.equal(events.length, 0);

      for (let index = 0; index < 2; index += 1) await completedRun({ novelty: 'unchanged' });
      const held = await completedRun({ novelty: 'unchanged', state: 'awaiting_approval' });
      assert.equal(await evaluateUnproductiveStreak(held, evaluate), null);
      const rejected = (await transitionAgentRun(held.id, ['awaiting_approval'], 'rejected', {}, deps()))!;
      assert.equal(await evaluateUnproductiveStreak(rejected, evaluate), 'paused', 'a rejection makes the verdict final');
      assert.equal(events.length, 1);
      assert.equal(events[0].event.deduplicationKey, unproductiveStreakDeduplicationKey(definition.id, acted.id));
    });

    test('a scheduled no-op acting step counts even when its report could not be compared', async () => {
      const { deps: evaluate, events } = streakDeps(2);
      await evaluateUnproductiveStreak(await completedRun({ novelty: null, mutations: 0 }), evaluate);
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: null, mutations: 0 }), evaluate), 'notified');
      assert.equal(events.length, 1);
      assert.match(events[0].event.body, /acting step changed nothing/);
    });

    test('a notification that failed to persist is retried by the next run of the streak, then never repeated', async () => {
      definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
      const { deps: evaluate, events } = streakDeps(2);
      let failing = true;
      const flaky = {
        ...evaluate,
        createEvent: (async (event: never, recipients: never) => {
          if (failing) throw new Error('inbox down');
          return (evaluate.createEvent as unknown as (e: never, r: never) => Promise<unknown>)(event, recipients);
        }) as never,
      };
      await completedRun({ novelty: 'unchanged' });
      await assert.rejects(evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), flaky), /inbox down/);
      assert.equal(events.length, 0);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true,
        'the schedule is not paused before the owner is told, so a later run can still retry');

      failing = false;
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'empty' }), flaky), 'paused');
      assert.equal(events.length, 1);
      assert.equal(events[0].event.deduplicationKey, unproductiveStreakDeduplicationKey(definition.id, 'start'));
      assert.match(events[0].event.title, /no change in 3 runs/);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, false);

      // The stored item is the evidence: later runs of the streak neither notify nor pause again.
      await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: true }, deps());
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), flaky), null);
      assert.equal(events.length, 1);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true);
    });

    test('the real Inbox store is the evidence: once its item is persisted, the streak is not notified again', async () => {
      const { NotificationService } = await import('../packages/core/src/services/notificationService.ts');
      const inbox = new NotificationService({ database, publishUpdate: async () => undefined });
      const evaluate = {
        ...streakDeps(2).deps,
        hasNotification: (key: string) => hasNotificationEvent(key, { database }),
        createEvent: inbox.createNotificationEvent.bind(inbox) as never,
      };
      const key = unproductiveStreakDeduplicationKey(definition.id, 'start');
      await completedRun({ novelty: 'unchanged' });
      assert.equal(await hasNotificationEvent(key, { database }), false);
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), evaluate), 'notified');
      assert.equal(await hasNotificationEvent(key, { database }), true);
      assert.equal(await evaluateUnproductiveStreak(await completedRun({ novelty: 'unchanged' }), evaluate), null);
      assert.equal((await database('notification_events').where({ deduplication_key: key }).count({ count: '*' }))[0].count, 1);
    });

    test('an automation without repositories is still notified, through the system target', async () => {
      definition = await createAgentDefinition({ ownerId: 'alice', name: 'Web digest', prompt: 'Read the news', scheduleCron: '0 6 * * *', scheduleEnabled: true }, deps());
      const { deps: evaluate, events } = streakDeps(1);
      await evaluateUnproductiveStreak(await completedRun({ novelty: 'empty' }), evaluate);
      assert.equal(events.length, 1);
      assert.equal(events[0].event.kind, 'system_failure');
      assert.deepEqual(events[0].event.target, { type: 'system_failure', component: 'automations', correlationId: definition.id });
      assert.match(events[0].event.title, /Web digest/);
    });
  });
});

describe('automation_unproductive_run_threshold setting', () => {
  test('accepts whole numbers from 1 to 50 and rejects anything else', async () => {
    const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
    for (const value of [1, 3, 50]) {
      const result = await extractSettingSaves({ automation_unproductive_run_threshold: value });
      assert.equal(result.error, undefined, String(value));
      assert.equal(result.normalized.automation_unproductive_run_threshold, value);
      assert.deepEqual(result.saves, [{ name: 'automation_unproductive_run_threshold' }]);
    }
    for (const value of [0, 51, 2.5, 'three']) {
      assert.match((await extractSettingSaves({ automation_unproductive_run_threshold: value })).error ?? '',
        /automation_unproductive_run_threshold must be an integer from 1 to 50/, String(value));
    }
  });
});
