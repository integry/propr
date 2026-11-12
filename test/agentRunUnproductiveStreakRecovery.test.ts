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
  type UnproductiveStreakPause,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

const { evaluateUnproductiveStreak, unproductivePauseDeduplicationKey, unproductiveStreakDeduplicationKey } = await import('../src/jobs/agentRuns/unproductiveStreak.ts');

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

interface StoredItem { eventId: string; title: string; body: string; metadata: Record<string, unknown> }

async function storedItem(deduplicationKey: string): Promise<StoredItem | null> {
  const row = await database('notification_events').where({ deduplication_key: deduplicationKey })
    .first<{ event_id: string; title: string; body: string; metadata_json: string | null } | undefined>('event_id', 'title', 'body', 'metadata_json');
  return row ? { eventId: row.event_id, title: row.title, body: row.body, metadata: JSON.parse(row.metadata_json ?? '{}') } : null;
}

/** The streak's persisted Inbox items: the streak item, and the one saying the schedule was paused. */
async function streakItems(streakKey = 'start') {
  return {
    streak: await storedItem(unproductiveStreakDeduplicationKey(definition.id, streakKey)),
    paused: await storedItem(unproductivePauseDeduplicationKey(definition.id, streakKey)),
  };
}

/** The streak item is stored before the pause is tried, so it states the intended pause in words true whatever the pause did (F10). */
function assertStatesIntendedPause(item: StoredItem | null): void {
  assert.ok(item, 'the streak item is stored');
  assert.doesNotMatch(item.title, /paused/);
  assert.match(item.body, /set to pause its schedule when this happens/);
  assert.match(item.body, /unless pausing is turned off or a newer scheduled run produces something first/);
  assert.doesNotMatch(item.body, /has been paused|was paused/);
  assert.equal(item.metadata.pauseIntended, true, 'the recovery intent');
  assert.equal(item.metadata.schedulePaused, undefined, 'the streak item never states the outcome');
}

async function receiptChannels(eventId: string) {
  const row = await database('notification_user_states').where({ event_id: eventId, user_id: 'alice' })
    .first<{ inbox_enabled: number | boolean; push_enabled: number | boolean }>('inbox_enabled', 'push_enabled');
  return { inbox: Boolean(row.inbox_enabled), push: Boolean(row.push_enabled) };
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
    const seen = new Map<string, { pauseIntended: boolean }>();
    const evaluate = {
      loadThreshold: async () => 3,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: async (key: string) => seen.get(key) ?? null,
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: (definitionId: string, pause: UnproductiveStreakPause) => pauseScheduleForUnproductiveStreak(definitionId, pause, deps()),
      createEvent: (async (event: { deduplicationKey: string }) => {
        if (!seen.has(event.deduplicationKey)) { events.push(event); seen.set(event.deduplicationKey, { pauseIntended: false }); }
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

describe('pending runs do not use up the streak scan (F16)', () => {
  test('three rejected unproductive runs behind more pending runs than the scan reads still notify at threshold three', async () => {
    const rejected = await insertRuns(3, { state: 'awaiting_approval', novelty: 'unchanged' });
    await insertRuns(SCAN_LIMIT, { state: 'awaiting_approval', novelty: 'unchanged' });
    const events: { deduplicationKey: string }[] = [];
    const evaluate = {
      loadThreshold: async () => 3,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: async () => null,
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: (definitionId: string, pause: UnproductiveStreakPause) => pauseScheduleForUnproductiveStreak(definitionId, pause, deps()),
      createEvent: (async (event: { deduplicationKey: string }) => { events.push(event); return event; }) as never,
    };
    let outcome: unknown = null;
    // The owner rejects the three older runs; each rejection evaluates the streak.
    for (const id of rejected) {
      const run = await transitionAgentRun(id, ['awaiting_approval'], 'rejected', {}, deps());
      assert.ok(run);
      outcome = await evaluateUnproductiveStreak(run, evaluate);
    }
    assert.equal(outcome, 'notified');
    assert.deepEqual(events.map(event => event.deduplicationKey), [unproductiveStreakDeduplicationKey(definition.id, 'start')]);
    const streak = await findUnproductiveScheduledStreak(definition.id, 3, { database });
    assert.deepEqual(streak.runs.map(run => run.id), [...rejected].reverse());
    assert.equal(streak.reachedThreshold, true);
  });

  test('the streak and its identity are found behind pending runs of every undecided state', async () => {
    const [productive] = await insertRuns(1, { novelty: 'new' });
    const unproductive = await insertRuns(3, { state: 'rejected' });
    for (const state of ['report_ready', 'awaiting_approval', 'acting'] as const) await insertRuns(SCAN_LIMIT / 2, { state, novelty: 'new' });
    // Reports that could not be compared, with no acting count yet, are pending too.
    await insertRuns(SCAN_LIMIT / 2, { novelty: null });
    const streak = await findUnproductiveScheduledStreak(definition.id, 3, { database });
    assert.deepEqual(streak.runs.map(run => run.id), [...unproductive].reverse());
    assert.equal(streak.reachedThreshold, true);
    assert.equal(streak.streakKey, productive);
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

  async function realInbox({ onAnnounce = async () => undefined }: { onAnnounce?: () => Promise<unknown> } = {}) {
    const { NotificationService } = await import('../packages/core/src/services/notificationService.ts');
    // Announcements go out after the item is persisted, while the evaluation awaits them.
    const inbox = new NotificationService({ database, publishUpdate: async () => { await onAnnounce(); } });
    let pauseFailures = 0;
    const pauseCalls: string[] = [];
    const evaluate = {
      loadThreshold: async () => 2,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: (key: string) => findUnproductiveStreakNotification(key, { database }),
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: async (definitionId: string, pause: UnproductiveStreakPause) => {
        pauseCalls.push(pause.deduplicationKey);
        if (pauseFailures > 0) { pauseFailures -= 1; throw new Error('database unavailable'); }
        return pauseScheduleForUnproductiveStreak(definitionId, pause, deps());
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
    // Push is opt-in per kind; with it on, only the streak item pushes.
    await database('notification_preferences').insert({ user_id: 'alice', notification_kind: 'task', inbox_enabled: true, push_enabled: true });
    await unproductiveRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate), /database unavailable/);
    assert.deepEqual(await findUnproductiveStreakNotification(key(), { database }), { pauseIntended: true }, 'the item records the intended pause');
    assert.equal(await scheduleEnabled(), true);
    const failed = await streakItems();
    assertStatesIntendedPause(failed.streak);
    assert.equal(failed.paused, null, 'a failed pause is not told as made (F10)');

    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'paused');
    assert.equal(await scheduleEnabled(), false);
    assert.equal(await eventCount(), 1);
    const { streak, paused } = await streakItems();
    assert.deepEqual(streak, failed.streak, 'the streak item is never rewritten');
    assert.ok(paused, 'the run that made the pause says so');
    assert.match(paused.title, /Nightly triage paused: no change in 3 runs/);
    assert.match(paused.body, /^Its schedule was paused after 3 consecutive scheduled runs produced nothing new/);
    assert.equal(paused.metadata.schedulePaused, true);
    assert.equal(paused.metadata.streakDeduplicationKey, key());
    assert.deepEqual(await receiptChannels(paused.eventId), { inbox: true, push: false }, 'the streak item already pushed');
    assert.deepEqual(await receiptChannels(streak.eventId), { inbox: true, push: true });
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
    assert.ok((await streakItems()).paused, 'the recovered pause is told');
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

  test('a schedule the owner turned off while the item was delivered is not told as paused by this pause (F10)', async () => {
    const { evaluate } = await realInbox({ onAnnounce: async () => {
      assert.ok(await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: false }, deps()));
    } });
    await unproductiveRun();
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'paused', 'the schedule is off');
    assert.equal((await pauseRecord()).unproductive_paused_streak, key(), 'the pause is recorded, so it is not made later');
    const items = await streakItems();
    assertStatesIntendedPause(items.streak);
    assert.equal(items.paused, null, 'the owner turned it off, not this pause');
  });

  test('a paused item that cannot be stored keeps the pause and is not sent late (F10)', async () => {
    const { evaluate } = await realInbox();
    const pausedKey = unproductivePauseDeduplicationKey(definition.id, 'start');
    const pausedWrites: string[] = [];
    const lossy = {
      ...evaluate,
      createEvent: (async (event: { deduplicationKey: string }, recipients: unknown) => {
        if (event.deduplicationKey === pausedKey) { pausedWrites.push(event.deduplicationKey); throw new Error('inbox down'); }
        return (evaluate.createEvent as unknown as (input: unknown, to: unknown) => Promise<unknown>)(event, recipients);
      }) as never,
    };
    await unproductiveRun();
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), lossy), 'paused');
    assert.equal(await scheduleEnabled(), false);
    assert.deepEqual(pausedWrites, [pausedKey]);
    assertStatesIntendedPause((await streakItems()).streak);
    // Turned back on, the streak goes on; a paused item now would describe a schedule that is on.
    await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: true }, deps());
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), lossy), null);
    assert.deepEqual(pausedWrites, [pausedKey], 'the paused item is not retried');
    assert.equal((await streakItems()).paused, null);
  });

  test('of two evaluations racing to pause, only the one that turned the schedule off says so (F10)', async () => {
    const { evaluate } = await realInbox();
    const pausedWrites: string[] = [];
    const counting = {
      ...evaluate,
      createEvent: (async (event: { deduplicationKey: string }, recipients: unknown) => {
        if (event.deduplicationKey === unproductivePauseDeduplicationKey(definition.id, 'start')) pausedWrites.push(event.deduplicationKey);
        return (evaluate.createEvent as unknown as (input: unknown, to: unknown) => Promise<unknown>)(event, recipients);
      }) as never,
    };
    await unproductiveRun();
    const last = await unproductiveRun();
    const outcomes = await Promise.all([evaluateUnproductiveStreak(last, counting), evaluateUnproductiveStreak(last, counting)]);
    assert.ok(outcomes.includes('paused'), String(outcomes));
    assert.equal(pausedWrites.length, 1, 'the evaluation that found the pause made does not tell it again');
    assert.equal(await scheduleEnabled(), false);
    assert.ok((await streakItems()).paused);
  });

  const optOut = async () => updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: false }, deps());
  const pauseRecord = async () => (await database('agent_definitions').where({ id: definition.id })
    .first('pending_schedule_slot', 'unproductive_paused_streak', 'schedule_enabled'));

  test('an owner who turns pausing off while the Inbox item is delivered keeps the schedule (F7)', async () => {
    await database('agent_definitions').where({ id: definition.id }).update({ pending_schedule_slot: NOW + 86_400_000 });
    let optedOut = 0;
    const { evaluate, pauseCalls } = await realInbox({ onAnnounce: async () => { optedOut += 1; assert.ok(await optOut()); } });
    await unproductiveRun();
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), evaluate), 'notified');
    assert.equal(optedOut, 1, 'the opt-out committed during notification creation');
    assert.equal(pauseCalls.length, 1, 'the evaluation still tried the pause it had decided on');
    assert.equal(await scheduleEnabled(), true);
    const record = await pauseRecord();
    assert.equal(record.unproductive_paused_streak, null, 'the streak is not claimed');
    assert.equal(Number(record.pending_schedule_slot), NOW + 86_400_000, 'the pending slot is kept');
    const items = await streakItems();
    assertStatesIntendedPause(items.streak);
    assert.equal(items.paused, null, 'nothing says the kept schedule was paused (F10)');
  });

  test('an owner who turns pausing off after the recovery run read the definition keeps the schedule (F7)', async () => {
    const { evaluate, failNextPause } = await realInbox();
    await unproductiveRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate), /database unavailable/);
    const racing = {
      ...evaluate,
      getDefinition: async (definitionId: string, ownerId: string) => {
        const read = await evaluate.getDefinition(definitionId, ownerId);
        await optOut();
        return read;
      },
    };
    assert.equal(await evaluateUnproductiveStreak(await unproductiveRun(), racing), null);
    assert.equal(await scheduleEnabled(), true);
    assert.equal((await pauseRecord()).unproductive_paused_streak, null);
    const items = await streakItems();
    assertStatesIntendedPause(items.streak);
    assert.equal(items.paused, null);
  });

  /** The streak of two unproductive runs since `streakKey`, as the evaluation found it. */
  const pauseFor = (streakKey = 'start') => ({ deduplicationKey: unproductiveStreakDeduplicationKey(definition.id, streakKey), streakKey, threshold: 2 });

  test('the pause transaction reads the opt-in itself (F7)', async () => {
    await insertRuns(2);
    await database('agent_definitions').where({ id: definition.id }).update({ pending_schedule_slot: NOW });
    await optOut();
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()), 'opted_out');
    const record = await pauseRecord();
    assert.equal(Boolean(record.schedule_enabled), true);
    assert.equal(Number(record.pending_schedule_slot), NOW);
    assert.equal(record.unproductive_paused_streak, null);
    // Opting back in lets the same streak's pause be made; once made it stays made.
    await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps());
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()), 'disabled');
    await optOut();
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()), 'done_before');
  });

  test('the pause record is written with the schedule change, once per streak', async () => {
    await insertRuns(2);
    const results = await Promise.all([
      pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()),
      pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()),
    ]);
    assert.deepEqual([...results].sort(), ['disabled', 'done_before']);
    const paused = await getAgentDefinition(definition.id, 'alice', { database });
    assert.equal(paused?.scheduleEnabled, false);
    assert.equal(paused?.revision, definition.revision + 1);
    await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: true }, deps());
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseFor(), deps()), 'done_before');
    assert.equal(await scheduleEnabled(), true);
    const [productive] = await insertRuns(1, { novelty: 'new' });
    await insertRuns(2);
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, pauseFor(productive), deps()), 'disabled',
      'a new streak is paused again');
  });
});

describe('streak ended before the pause (F9)', () => {
  beforeEach(async () => {
    definition = (await updateAgentDefinition(definition.id, 'alice', { pauseWhenUnproductive: true }, deps()))!;
  });

  async function scheduledRun(): Promise<StoredAgentRun> {
    clock += 60_000;
    const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps());
    return (await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'A report', reportHash: 'f'.repeat(64), reportNovelty: 'unchanged' }, deps()))!;
  }
  const unproductiveRun = async () => (await transitionAgentRun((await scheduledRun()).id, ['report_ready'], 'completed', {}, deps()))!;
  /** A newer scheduled run whose acting step is still running: pending, so the streak skips it. */
  const actingRun = async () => (await transitionAgentRun((await scheduledRun()).id, ['report_ready'], 'acting', {}, deps()))!;
  const completeProductively = async (run: StoredAgentRun) => {
    assert.ok(await transitionAgentRun(run.id, ['acting'], 'completed', { actionSummary: 'Labelled 2 issues', actingMutations: 2 }, deps()));
  };

  async function realInbox({ onAnnounce = async () => undefined }: { onAnnounce?: () => Promise<unknown> } = {}) {
    const { NotificationService } = await import('../packages/core/src/services/notificationService.ts');
    const inbox = new NotificationService({ database, publishUpdate: async () => { await onAnnounce(); } });
    let pauseFailures = 0;
    const pauseCalls: UnproductiveStreakPause[] = [];
    const evaluate = {
      loadThreshold: async () => 2,
      findStreak: (definitionId: string, limit: number) => findUnproductiveScheduledStreak(definitionId, limit, { database }),
      findNotification: (key: string) => findUnproductiveStreakNotification(key, { database }),
      getDefinition: (definitionId: string, ownerId: string) => getAgentDefinition(definitionId, ownerId, { database }),
      pauseSchedule: async (definitionId: string, pause: UnproductiveStreakPause) => {
        pauseCalls.push(pause);
        if (pauseFailures > 0) { pauseFailures -= 1; throw new Error('database unavailable'); }
        return pauseScheduleForUnproductiveStreak(definitionId, pause, deps());
      },
      createEvent: inbox.createNotificationEvent.bind(inbox) as never,
    };
    return { evaluate, pauseCalls, failNextPause: () => { pauseFailures = 1; } };
  }

  const definitionRecord = async () => (await database('agent_definitions').where({ id: definition.id })
    .first('pending_schedule_slot', 'unproductive_paused_streak', 'schedule_enabled'));

  test('a newer run completing productively while the Inbox item is delivered keeps the schedule', async () => {
    await database('agent_definitions').where({ id: definition.id }).update({ pending_schedule_slot: NOW + 86_400_000 });
    await unproductiveRun();
    const acting = await actingRun();
    let completed = 0;
    const { evaluate, pauseCalls } = await realInbox({ onAnnounce: async () => { completed += 1; await completeProductively(acting); } });
    const last = await unproductiveRun();
    const found = await findUnproductiveScheduledStreak(definition.id, 2, { database });
    assert.deepEqual([found.reachedThreshold, found.streakKey], [true, 'start'], 'the acting run is skipped as pending');

    assert.equal(await evaluateUnproductiveStreak(last, evaluate), 'notified');
    assert.equal(completed, 1, 'the productive completion committed during notification delivery');
    assert.deepEqual(pauseCalls.map(pause => pause.streakKey), ['start'], 'the pause was tried for the streak the evaluation found');
    const record = await definitionRecord();
    assert.equal(Boolean(record.schedule_enabled), true);
    assert.equal(record.unproductive_paused_streak, null, 'the streak is not claimed');
    assert.equal(Number(record.pending_schedule_slot), NOW + 86_400_000, 'the pending slot is kept');
    const items = await streakItems();
    assertStatesIntendedPause(items.streak);
    assert.equal(items.paused, null, 'nothing says the kept schedule was paused (F10)');
    // The productive run started a new streak, which a later run may still pause for.
    assert.equal((await findUnproductiveScheduledStreak(definition.id, 2, { database })).streakKey, acting.id);
  });

  test('a recovered pause is not finished once a newer run ended the streak', async () => {
    const { evaluate, failNextPause } = await realInbox();
    await unproductiveRun();
    const acting = await actingRun();
    failNextPause();
    await assert.rejects(evaluateUnproductiveStreak(await unproductiveRun(), evaluate), /database unavailable/);
    const key = unproductiveStreakDeduplicationKey(definition.id, 'start');
    assert.deepEqual(await findUnproductiveStreakNotification(key, { database }), { pauseIntended: true }, 'the item records the intended pause');

    // The recovery run finds the old streak, then the acting run completes productively.
    const recovering = await unproductiveRun();
    const racing = {
      ...evaluate,
      getDefinition: async (definitionId: string, ownerId: string) => {
        const read = await evaluate.getDefinition(definitionId, ownerId);
        await completeProductively(acting);
        return read;
      },
    };
    assert.equal(await evaluateUnproductiveStreak(recovering, racing), null);
    const record = await definitionRecord();
    assert.equal(Boolean(record.schedule_enabled), true);
    assert.equal(record.unproductive_paused_streak, null);
    const items = await streakItems();
    assertStatesIntendedPause(items.streak);
    assert.equal(items.paused, null);
  });

  test('the pause transaction rechecks the streak identity and threshold', async () => {
    await database('agent_definitions').where({ id: definition.id }).update({ pending_schedule_slot: NOW });
    await insertRuns(1);
    const start = { deduplicationKey: unproductiveStreakDeduplicationKey(definition.id, 'start'), streakKey: 'start' };
    // One unproductive run does not reach a threshold of two.
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, { ...start, threshold: 2 }, deps()), 'streak_ended');
    await insertRuns(1);
    // A productive run ended the streak the caller found.
    await insertRuns(1, { novelty: 'new' });
    await insertRuns(2);
    assert.equal(await pauseScheduleForUnproductiveStreak(definition.id, { ...start, threshold: 2 }, deps()), 'streak_ended');
    const record = await definitionRecord();
    assert.equal(Boolean(record.schedule_enabled), true);
    assert.equal(record.unproductive_paused_streak, null, 'the claim is rolled back');
    assert.equal(Number(record.pending_schedule_slot), NOW, 'the pending slot is kept');
  });
});
