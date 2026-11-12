import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { AUTOMATION_REPORT_NOVELTIES, AUTOMATION_RUN_STATES, type AutomationReportNovelty, type AutomationRunState } from '@propr/shared';
import {
  createAgentDefinition,
  getAgentDefinition,
  updateAgentDefinition,
  type StoredAgentDefinition,
} from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { createAgentRun, transitionAgentRun, type StoredAgentRun } from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  agentRunProductivity,
  findUnproductiveScheduledStreak,
  findUnproductiveStreakNotification,
  pauseScheduleForUnproductiveStreak,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

const { evaluateUnproductiveStreak, unproductiveStreakDeduplicationKey } = await import('../src/jobs/agentRuns/unproductiveStreak.ts');

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 11, 22, 0);
/** Mirrors STREAK_SCAN_LIMIT in agentRunProductivity.ts. */
const SCAN_LIMIT = 1000;

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
    ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', repositories: ['acme/web'],
    scheduleCron: '0 22 * * *', scheduleEnabled: true,
  }, deps());
});
afterEach(async () => { await database.destroy(); });

interface RowFlags { state?: AutomationRunState; novelty?: AutomationReportNovelty | null; mutations?: number | null; trigger?: string }

/** Inserts finished scheduled runs directly, oldest first, so long streaks stay fast to build. */
async function insertRuns(count: number, flags: RowFlags = {}, prefix = 'run'): Promise<string[]> {
  const ids: string[] = [];
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    clock += 1_000;
    const id = `${prefix}-${String(clock).padStart(16, '0')}`;
    ids.push(id);
    rows.push({
      id, definition_id: definition.id, owner_id: 'alice', trigger: flags.trigger ?? 'schedule', state: flags.state ?? 'completed',
      autonomy_mode: 'dry_run', definition_snapshot: '{}', report: 'A report', report_truncated: false, deferrals: 0,
      report_hash: flags.novelty === null ? null : 'f'.repeat(64),
      report_novelty: flags.novelty === undefined ? 'unchanged' : flags.novelty,
      acting_mutations: flags.mutations ?? null,
      created_at: clock, updated_at: clock,
    });
  }
  for (let start = 0; start < rows.length; start += 100) await database('agent_runs').insert(rows.slice(start, start + 100));
  return ids;
}

describe('streak identity past the scan limit (F5)', () => {
  for (const length of [SCAN_LIMIT - 1, SCAN_LIMIT, SCAN_LIMIT + 1, SCAN_LIMIT + 150]) {
    test(`an uninterrupted ${length}-run streak keeps its identity`, async () => {
      await insertRuns(length - 1);
      const before = await findUnproductiveScheduledStreak(definition.id, 3, { database });
      await insertRuns(1);
      const streak = await findUnproductiveScheduledStreak(definition.id, 3, { database });
      assert.equal(streak.reachedThreshold, true);
      assert.equal(before.streakKey, 'start');
      assert.equal(streak.streakKey, 'start', 'no productive run ever ended it');
      assert.equal(streak.runs.length, Math.min(length, SCAN_LIMIT), 'only the scan window is listed');
    });
  }

  for (const length of [SCAN_LIMIT - 1, SCAN_LIMIT, SCAN_LIMIT + 1]) {
    test(`a ${length}-run streak after a productive run stays identified by that run`, async () => {
      await insertRuns(5);
      const [productive] = await insertRuns(1, { novelty: 'new' });
      await insertRuns(length - 1);
      assert.equal((await findUnproductiveScheduledStreak(definition.id, 3, { database })).streakKey, productive);
      await insertRuns(1);
      assert.equal((await findUnproductiveScheduledStreak(definition.id, 3, { database })).streakKey, productive);
    });
  }

  test('pending and manual runs beyond the window neither end the streak nor change its identity', async () => {
    const [productive] = await insertRuns(1, { mutations: 2 });
    await insertRuns(3, { state: 'awaiting_approval', novelty: 'new' });
    await insertRuns(2, { trigger: 'manual', novelty: 'new' });
    await insertRuns(SCAN_LIMIT + 5);
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 3, { database })).streakKey, productive);
  });

  test('the predecessor lookup agrees with agentRunProductivity for every flag combination', async () => {
    const [anchor] = await insertRuns(1, { novelty: 'new' });
    const candidateClock = clock + 1_000;
    clock += 2_000;
    await insertRuns(SCAN_LIMIT + 1);
    for (const state of AUTOMATION_RUN_STATES) {
      for (const novelty of [...AUTOMATION_REPORT_NOVELTIES, null]) {
        for (const mutations of [null, 0, 2]) {
          await database('agent_runs').insert({
            id: 'candidate', definition_id: definition.id, owner_id: 'alice', trigger: 'schedule', state,
            autonomy_mode: 'dry_run', definition_snapshot: '{}', report: 'A report', report_truncated: false, deferrals: 0,
            report_novelty: novelty, acting_mutations: mutations, created_at: candidateClock, updated_at: candidateClock,
          });
          const verdict = agentRunProductivity({ state, reportNovelty: novelty, actingMutations: mutations });
          const { streakKey } = await findUnproductiveScheduledStreak(definition.id, 3, { database });
          assert.equal(streakKey, verdict === 'productive' ? 'candidate' : anchor, `${state}/${novelty}/${mutations}`);
          await database('agent_runs').where({ id: 'candidate' }).delete();
        }
      }
    }
  });

  test('the owner is told once across the scan boundary', async () => {
    const events: unknown[] = [];
    const seen = new Map<string, { schedulePaused: boolean }>();
    const evaluate = {
      loadThreshold: async () => 3,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: async (key: string) => seen.get(key) ?? null,
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: (definitionId: string, key: string) => pauseScheduleForUnproductiveStreak(definitionId, key, deps()),
      createEvent: (async (event: { deduplicationKey: string }) => {
        if (!seen.has(event.deduplicationKey)) { events.push(event); seen.set(event.deduplicationKey, { schedulePaused: false }); }
        return event;
      }) as never,
    };
    const latestRun = async () => ({ id: (await database('agent_runs').orderBy('created_at', 'desc').first()).id, definitionId: definition.id,
      ownerId: 'alice', trigger: 'schedule', state: 'completed', reportNovelty: 'unchanged', actingMutations: null } as unknown as StoredAgentRun);
    await insertRuns(3);
    assert.equal(await evaluateUnproductiveStreak(await latestRun(), evaluate), 'notified');
    await insertRuns(SCAN_LIMIT - 4);
    for (let index = 0; index < 4; index += 1) {
      await insertRuns(1);
      assert.equal(await evaluateUnproductiveStreak(await latestRun(), evaluate), null, `run ${SCAN_LIMIT - 1 + index}`);
    }
    assert.equal(events.length, 1);
  });
});

describe('unfinished schedule pause (F4)', () => {
  async function unproductiveRun(): Promise<StoredAgentRun> {
    clock += 60_000;
    const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps());
    await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'A report', reportHash: 'f'.repeat(64), reportNovelty: 'unchanged' }, deps());
    return (await transitionAgentRun(run.id, ['report_ready'], 'completed', {}, deps()))!;
  }

  async function realInbox() {
    const { NotificationService } = await import('../packages/core/src/services/notificationService.ts');
    const inbox = new NotificationService({ database, publishUpdate: async () => undefined });
    let pauseFailures = 0;
    const pauseCalls: string[] = [];
    const evaluate = {
      loadThreshold: async () => 2,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: (key: string) => findUnproductiveStreakNotification(key, { database }),
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: async (definitionId: string, key: string) => {
        pauseCalls.push(key);
        if (pauseFailures > 0) { pauseFailures -= 1; throw new Error('database unavailable'); }
        return pauseScheduleForUnproductiveStreak(definitionId, key, deps());
      },
      createEvent: inbox.createNotificationEvent.bind(inbox) as never,
    };
    return { evaluate, pauseCalls, failNextPause: () => { pauseFailures = 1; } };
  }

  const key = () => unproductiveStreakDeduplicationKey(definition.id, 'start');
  const scheduleEnabled = async () => (await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled;
  const eventCount = async () => Number((await database('notification_events').where({ deduplication_key: key() }).count({ count: '*' }))[0].count);

  beforeEach(async () => {
    definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
  });

  test('a pause that fails after the item is stored is finished by the next run, without a second item', async () => {
    const { evaluate, failNextPause } = await realInbox();
    await unproductiveRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate), /database unavailable/);
    assert.deepEqual(await findUnproductiveStreakNotification(key(), { database }), { schedulePaused: true }, 'the item claims the pause');
    assert.equal(await scheduleEnabled(), true);

    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'paused');
    assert.equal(await scheduleEnabled(), false);
    assert.equal(await eventCount(), 1);
  });

  test('a worker stopped between the item and the pause is recovered the same way', async () => {
    const { evaluate } = await realInbox();
    const interrupted = { ...evaluate, pauseSchedule: () => new Promise<never>(() => undefined) };
    await unproductiveRun();
    // The evaluation never gets past the pause; the stored item is all that survives it.
    void evaluateUnproductiveStreak(await unproductiveRun(), interrupted);
    for (let tries = 0; tries < 50 && await eventCount() === 0; tries += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await eventCount(), 1);
    assert.equal(await scheduleEnabled(), true);
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'paused');
    assert.equal(await scheduleEnabled(), false);
  });

  test('once the pause is made, an owner who turns the schedule back on is not overridden', async () => {
    const { evaluate, failNextPause, pauseCalls } = await realInbox();
    await unproductiveRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate));
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'paused');
    await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: true }, deps());
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), null);
    assert.equal(await scheduleEnabled(), true);
    assert.equal(pauseCalls.length, 3, 'the later run checks the record, which says the pause was made');
  });

  test('an owner who turned pausing off after a failed pause is respected', async () => {
    const { evaluate, failNextPause } = await realInbox();
    await unproductiveRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate));
    definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: false }, deps()))!;
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), null);
    assert.equal(await scheduleEnabled(), true);
  });

  test('an item that did not claim a pause never pauses later', async () => {
    definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: false }, deps()))!;
    const { evaluate, pauseCalls } = await realInbox();
    await unproductiveRun();
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'notified');
    definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), null);
    assert.equal(await scheduleEnabled(), true);
    assert.deepEqual(pauseCalls, []);
  });

  test('the pause record is written with the schedule change, once per streak', async () => {
    const pauseKey = key();
    const results = await Promise.all([
      pauseScheduleForUnproductiveStreak(definition.id, pauseKey, deps()),
      pauseScheduleForUnproductiveStreak(definition.id, pauseKey, deps()),
    ]);
    assert.deepEqual([...results].sort(), ['disabled', 'done_before']);
    const paused = await getAgentDefinition(definition.id, 'alice', { database });
    assert.equal(paused?.scheduleEnabled, false);
    assert.equal(paused?.revision, definition.revision + 1);
    await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: true }, deps());
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseKey, deps()), 'done_before');
    assert.equal(await scheduleEnabled(), true);
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, unproductiveStreakDeduplicationKey(definition.id, 'other'), deps()), 'disabled',
      'a new streak is paused again');
  });
});
