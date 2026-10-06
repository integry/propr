import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as submissionsMigration } from '../src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { down as scheduleDown, up as scheduleMigration } from '../src/db/migrations/20261007000000_create_task_schedules.js';
import { closeConnection } from '../src/db/connection.js';
import { associateSubmissionTask } from '../src/services/taskSubmissionService.js';
import { createSchedule, getSchedule, listScheduleRuns, updateSchedule, validateScheduleTiming, type TaskSchedule } from '../src/schedules/scheduleService.js';
import { runScheduleNow, runScheduleTick, type ScheduleDependencies, type ScheduleNotification } from '../src/schedules/scheduleDispatcher.js';

after(closeConnection);

const owner = { userId: '42', username: 'octocat' };
const input = { name: 'Nightly patrol', repository: 'Acme/Repo', cron: '0 3 * * *', timezone: 'UTC', instruction: { text: 'Upgrade outdated dependencies' } };

async function fixture(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => { table.string('task_id').primary(); table.string('repository'); });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp').defaultTo(database.fn.now());
  });
  await submissionsMigration(database);
  await identityMigration(database);
  await scheduleMigration(database);
  return database;
}

interface Harness {
  deps: ScheduleDependencies;
  dispatched: Array<{ scheduleId: string; key: string }>;
  notifications: ScheduleNotification[];
  setNow(iso: string): void;
  admission: { maxConcurrent: number; window: string; windowError: string | null };
}

/** A dispatcher that records a task submission row, as the real REST path does. */
function harness(database: Knex, start: string, outcome: (key: string) => { state: string; error?: string } = () => ({ state: 'queued' })): Harness {
  let now = new Date(start);
  const dispatched: Harness['dispatched'] = [];
  const notifications: ScheduleNotification[] = [];
  const admission = { maxConcurrent: 1, window: '', windowError: null as string | null };
  const deps: ScheduleDependencies = {
    now: () => now,
    admissionSettings: async () => admission,
    notify: async notification => { notifications.push(notification); },
    dispatch: async (schedule: TaskSchedule, key: string) => {
      dispatched.push({ scheduleId: schedule.id, key });
      const id = `submission-${dispatched.length}`;
      const result = outcome(key);
      await database('task_submissions').insert({
        id, user_id: schedule.owner.userId, submission_key: key, payload_hash: 'hash', repository: schedule.repository,
        payload: '{}', attachments: '[]', state: result.state, error: result.error ?? null, schedule_id: schedule.id,
      });
      return { submissionId: id, state: result.state, taskId: null, error: result.error ?? null };
    },
  };
  return { deps, dispatched, notifications, admission, setNow: iso => { now = new Date(iso); } };
}

async function finishTask(database: Knex, submissionId: string, taskId: string, state: 'completed' | 'failed') {
  await database('tasks').insert({ task_id: taskId, repository: 'acme/repo' });
  await associateSubmissionTask(database, submissionId, taskId);
  await database('task_history').insert({ task_id: taskId, state });
}

test('a new schedule never fires for a slot in the past', async () => {
  const database = await fixture();
  // Created at 03:00:30: today's 03:00 slot has passed, so the first slot is tomorrow.
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-06T03:00:30Z'));
  assert.equal(schedule.nextRunAt, '2026-10-07T03:00:00.000Z');
  assert.equal(schedule.repository, 'acme/repo');
  const { deps, dispatched, setNow } = harness(database, '2026-10-06T03:01:00Z');
  assert.equal((await runScheduleTick(database, deps)).dispatched, 0);
  setNow('2026-10-07T03:00:10Z');
  assert.equal((await runScheduleTick(database, deps)).dispatched, 1);
  assert.deepEqual(dispatched.map(entry => entry.key), [`schedule:${schedule.id}:2026-10-07T03:00:00.000Z`]);
  await database.destroy();
});

test('dispatch is idempotent across two ticks for the same slot', async () => {
  const database = await fixture();
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-06T00:00:00Z'));
  const { deps, dispatched } = harness(database, '2026-10-06T03:00:05Z');
  const [first, second] = await Promise.all([runScheduleTick(database, deps), runScheduleTick(database, deps)]);
  assert.equal(first.dispatched + second.dispatched, 1);
  assert.equal((await runScheduleTick(database, deps)).dispatched, 0);
  assert.equal(dispatched.length, 1);
  // Even if a stale reader resets the slot, the idempotency key refuses a second claim.
  await database('task_schedules').where({ id: schedule.id }).update({ next_run_at: '2026-10-06T03:00:00.000Z' });
  assert.equal((await runScheduleTick(database, deps)).dispatched, 0);
  assert.equal(dispatched.length, 1);
  const runs = await listScheduleRuns(database, schedule.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'dispatched');
  assert.equal((await getSchedule(database, schedule.id))!.nextRunAt, '2026-10-07T03:00:00.000Z');
  await database.destroy();
});

test('slots missed during downtime are not replayed', async () => {
  const database = await fixture();
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-01T00:00:00Z'));
  // The daemon was down from Oct 1 to Oct 6 12:00: five 03:00 slots were missed.
  const { deps, dispatched } = harness(database, '2026-10-06T12:00:00Z');
  const result = await runScheduleTick(database, deps);
  assert.equal(result.dispatched, 0);
  assert.equal(result.missed, 1);
  assert.equal(dispatched.length, 0);
  assert.equal((await getSchedule(database, schedule.id))!.nextRunAt, '2026-10-07T03:00:00.000Z');
  assert.deepEqual(await listScheduleRuns(database, schedule.id), []);
  await database.destroy();
});

test('admission: the concurrency cap and window skip a slot with a timeline entry and notification', async () => {
  const database = await fixture();
  const first = await createSchedule(database, { ...input, name: 'First' }, owner, new Date('2026-10-06T00:00:00Z'));
  const second = await createSchedule(database, { ...input, name: 'Second' }, owner, new Date('2026-10-06T00:00:00Z'));
  const { deps, dispatched, notifications, admission, setNow } = harness(database, '2026-10-06T03:00:05Z');
  const result = await runScheduleTick(database, deps);
  assert.deepEqual([result.dispatched, result.skipped], [1, 1], 'the default cap of 1 admits one scheduled run');
  assert.equal(dispatched.length, 1);
  const skippedRun = [...await listScheduleRuns(database, first.id), ...await listScheduleRuns(database, second.id)].find(run => run.status === 'skipped');
  assert.ok(skippedRun);
  assert.match(skippedRun.reason ?? '', /already running \(limit 1\)/);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'skipped');
  assert.match(notifications[0].title, /^Scheduled: (First|Second) skipped$/);

  // Next night: outside the window, so nothing is admitted even with room.
  admission.maxConcurrent = 5;
  admission.window = '04:00-05:00@UTC';
  setNow('2026-10-07T03:00:05Z');
  const outside = await runScheduleTick(database, deps);
  assert.deepEqual([outside.dispatched, outside.skipped], [0, 2]);

  // A malformed window blocks unattended work.
  admission.window = '04:00-05:00@Bad/Zone';
  setNow('2026-10-08T03:00:05Z');
  const malformed = await runScheduleTick(database, deps);
  assert.deepEqual([malformed.dispatched, malformed.skipped], [0, 2]);
  assert.match(notifications.at(-1)!.body, /malformed/);
  assert.equal(dispatched.length, 1);
  await database.destroy();
});

test('manual runs are exempt from admission', async () => {
  const database = await fixture();
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-06T00:00:00Z'));
  const { deps, dispatched, admission } = harness(database, '2026-10-06T12:00:00Z');
  admission.maxConcurrent = 0;
  admission.window = 'garbage';
  const { run } = await runScheduleNow(database, deps, schedule.id, 'request-1');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.status, 'dispatched');
  assert.equal(dispatched.length, 1);
  // The same request key does not dispatch twice.
  await runScheduleNow(database, deps, schedule.id, 'request-1');
  assert.equal(dispatched.length, 1);
  await database.destroy();
});

test('three consecutive failed runs pause the schedule; run-now re-enables it', async () => {
  const database = await fixture();
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-06T00:00:00Z'));
  const { deps, notifications, setNow } = harness(database, '2026-10-06T03:00:05Z');
  for (const [index, day] of ['06', '07', '08'].entries()) {
    setNow(`2026-10-${day}T03:00:05Z`);
    await runScheduleTick(database, deps);
    await finishTask(database, `submission-${index + 1}`, `task-${index + 1}`, 'failed');
    setNow(`2026-10-${day}T05:00:00Z`);
    await runScheduleTick(database, deps);
  }
  const paused = (await getSchedule(database, schedule.id))!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.consecutiveFailures, 3);
  assert.match(paused.pausedReason ?? '', /3 consecutive failed runs/);
  assert.equal(notifications.filter(notification => notification.kind === 'paused').length, 1);
  assert.equal((await database('tasks').where({ task_id: 'task-1' }).first()).schedule_id, schedule.id, 'tasks carry their schedule');

  // A paused schedule does not fire.
  setNow('2026-10-09T03:00:05Z');
  assert.equal((await runScheduleTick(database, deps)).dispatched, 0);

  setNow('2026-10-09T12:00:00Z');
  const { schedule: resumed, run } = await runScheduleNow(database, deps, schedule.id);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.consecutiveFailures, 0);
  assert.equal(resumed.pausedReason, null);
  assert.equal(resumed.nextRunAt, '2026-10-10T03:00:00.000Z', 're-enabling does not replay slots missed while paused');
  assert.equal(run.status, 'dispatched');
  await database.destroy();
});

test('a success resets the failure count, and a run whose task never starts fails', async () => {
  const database = await fixture();
  const schedule = await createSchedule(database, input, owner, new Date('2026-10-06T00:00:00Z'));
  const { deps, setNow } = harness(database, '2026-10-06T03:00:05Z', key => key.endsWith('2026-10-07T03:00:00.000Z')
    ? { state: 'failed', error: 'Selected agent or model is no longer available' }
    : { state: 'queued' });
  await runScheduleTick(database, deps);
  await finishTask(database, 'submission-1', 'task-1', 'failed');
  setNow('2026-10-07T03:00:05Z');
  await runScheduleTick(database, deps);
  assert.equal((await getSchedule(database, schedule.id))!.consecutiveFailures, 2, 'a failed dispatch counts as a failed run');
  setNow('2026-10-08T03:00:05Z');
  await runScheduleTick(database, deps);
  await finishTask(database, 'submission-3', 'task-3', 'completed');
  setNow('2026-10-08T04:00:00Z');
  await runScheduleTick(database, deps);
  assert.equal((await getSchedule(database, schedule.id))!.consecutiveFailures, 0);
  const statuses = (await listScheduleRuns(database, schedule.id)).map(run => run.status);
  assert.deepEqual(statuses, ['succeeded', 'failed', 'failed']);

  // A dispatched run with no task after the stale limit is failed, freeing its admission slot.
  setNow('2026-10-09T03:00:05Z');
  await runScheduleTick(database, deps);
  setNow('2026-10-10T03:30:00Z');
  await runScheduleTick(database, { ...deps, staleRunMs: 60 * 60_000 });
  const [latest] = await listScheduleRuns(database, schedule.id);
  assert.equal(latest.status, 'failed');
  assert.equal(latest.reason, 'The task never started');
  await database.destroy();
});

test('validation rejects bad timing and instructions; editing timing recomputes the next run', async () => {
  const database = await fixture();
  assert.throws(() => validateScheduleTiming('* * * * *', 'UTC'), /at most once every 5 minutes/);
  assert.throws(() => validateScheduleTiming('0 3 * * *', 'Moon/Base'), /IANA time zone/);
  assert.throws(() => validateScheduleTiming('0 25 * * *', 'UTC'), /Invalid cron expression/);
  assert.throws(() => validateScheduleTiming('0 0 30 2 *', 'UTC'), /never fires/);
  await assert.rejects(createSchedule(database, { ...input, instruction: { text: ' ' } }, owner), /instruction.text is required/);
  await assert.rejects(createSchedule(database, { ...input, instruction: { text: 'x', ultrafixGoal: 8 } }, owner), /runUltrafix must be true/);
  await assert.rejects(createSchedule(database, { ...input, repository: 'not a repo' }, owner), /owner\/name/);
  const schedule = await createSchedule(database, { ...input, instruction: { text: 'x', runUltrafix: true, ultrafixGoal: 9, maxCostUsd: 5 } }, owner, new Date('2026-10-06T00:00:00Z'));
  assert.deepEqual(schedule.instruction, { text: 'x', runUltrafix: true, ultrafixGoal: 9, maxCostUsd: 5 });
  const updated = await updateSchedule(database, schedule.id, { cron: '30 2 * * *', timezone: 'Europe/Riga' }, new Date('2026-10-06T00:00:00Z'));
  assert.equal(updated.nextRunAt, '2026-10-06T23:30:00.000Z');
  await database.destroy();
});

test('the schedule migration reverts cleanly', async () => {
  const database = await fixture();
  await scheduleDown(database);
  assert.equal(await database.schema.hasTable('task_schedules'), false);
  assert.equal(await database.schema.hasColumn('tasks', 'schedule_id'), false);
  assert.equal(await database.schema.hasColumn('task_submissions', 'schedule_id'), false);
  await database.destroy();
});
