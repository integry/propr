import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import logger from '../utils/logger.js';
import {
  ACTIVE_RUN_STATUSES, DEFAULT_MISSED_SLOT_GRACE_MS, DEFAULT_STALE_SCHEDULE_RUN_MS, SCHEDULE_FAILURE_PAUSE_THRESHOLD,
  getSchedule, iso, nextRunAfter, requireSchedule, scheduleIdempotencyKey, toTaskSchedule, toTaskScheduleRun,
  type ScheduleRunStatus, type ScheduleRunTrigger, type TaskSchedule, type TaskScheduleRow, type TaskScheduleRun, type TaskScheduleRunRow,
} from './scheduleService.js';
import { decideUnattendedAdmission, type UnattendedAdmissionSettings } from './unattendedAdmission.js';

export interface ScheduleDispatchResult {
  submissionId: string;
  /** Task submission state: `failed` means the task could not be started. */
  state: string;
  taskId: string | null;
  error: string | null;
}

export type ScheduleNotificationKind = 'skipped' | 'paused' | 'dispatch_failed';

export interface ScheduleNotification {
  kind: ScheduleNotificationKind;
  schedule: TaskSchedule;
  deduplicationKey: string;
  title: string;
  body: string;
}

export interface ScheduleDependencies {
  /** Creates the task through the shared task submission path, idempotent per key. */
  dispatch: (schedule: TaskSchedule, idempotencyKey: string) => Promise<ScheduleDispatchResult>;
  admissionSettings: () => Promise<UnattendedAdmissionSettings>;
  notify?: (notification: ScheduleNotification) => Promise<void>;
  now?: () => Date;
  missedSlotGraceMs?: number;
  staleRunMs?: number;
}

export interface ScheduleTickResult {
  dispatched: number;
  skipped: number;
  missed: number;
  failed: number;
  reconciled: number;
}

type FinishedStatus = 'succeeded' | 'failed' | 'cancelled';

/** One pass over the schedules: the database, the injected services and a fixed "now". */
interface RunContext {
  database: Knex;
  deps: ScheduleDependencies;
  now: Date;
}

const context = (database: Knex, deps: ScheduleDependencies): RunContext => ({ database, deps, now: deps.now?.() ?? new Date() });

async function notify({ deps }: RunContext, notification: ScheduleNotification): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(notification);
  } catch (error) {
    logger.warn({ scheduleId: notification.schedule.id, error: (error as Error).message }, 'Could not send a schedule notification');
  }
}

/** Unattended work in flight: scheduled runs dispatched and not yet finished. Manual runs are exempt. */
export async function countRunningUnattendedWork(database: Knex, excludeRunId?: number): Promise<number> {
  const query = database('task_schedule_runs').where({ trigger: 'schedule' }).whereIn('status', ACTIVE_RUN_STATUSES);
  if (excludeRunId !== undefined) query.whereNot({ id: excludeRunId });
  const row = await query.count<{ count: number | string }[]>({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

async function pauseIfFailing(ctx: RunContext, scheduleId: string, runId: number, reason: string | null): Promise<void> {
  const schedule = await getSchedule(ctx.database, scheduleId);
  if (!schedule || !schedule.enabled || schedule.consecutiveFailures < SCHEDULE_FAILURE_PAUSE_THRESHOLD) return;
  const pausedReason = `Paused after ${schedule.consecutiveFailures} consecutive failed runs`;
  const paused = await ctx.database('task_schedules').where({ id: schedule.id, enabled: true })
    .update({ enabled: false, paused_reason: pausedReason, updated_at: iso(ctx.now) });
  if (!paused) return;
  logger.warn({ scheduleId: schedule.id, failures: schedule.consecutiveFailures }, 'Paused a schedule after consecutive failures');
  await notify(ctx, {
    kind: 'paused', schedule: { ...schedule, enabled: false, pausedReason },
    deduplicationKey: `schedule-paused:${schedule.id}:${runId}`,
    title: `Scheduled: ${schedule.name} was paused`,
    body: `${pausedReason} in ${schedule.repository}. Use "Run now" to re-enable it.${reason ? ` Last error: ${reason}` : ''}`,
  });
}

/** Settles a run once. A failure counts towards the auto-pause; a success clears the count. */
async function finishRun(ctx: RunContext, run: TaskScheduleRunRow, outcome: { status: FinishedStatus; reason: string | null }): Promise<void> {
  const updated = await ctx.database('task_schedule_runs').where({ id: run.id }).whereIn('status', ACTIVE_RUN_STATUSES)
    .update({ status: outcome.status, reason: outcome.reason, finished_at: iso(ctx.now) });
  if (!updated || outcome.status === 'cancelled') return;
  if (outcome.status === 'succeeded') {
    await ctx.database('task_schedules').where({ id: run.schedule_id }).update({ consecutive_failures: 0 });
    return;
  }
  await ctx.database('task_schedules').where({ id: run.schedule_id }).increment('consecutive_failures', 1);
  await pauseIfFailing(ctx, run.schedule_id, run.id, outcome.reason);
}

async function runDispatch(ctx: RunContext, run: TaskScheduleRunRow, schedule: TaskSchedule): Promise<ScheduleRunStatus> {
  let failure: string | null;
  try {
    const result = await ctx.deps.dispatch(schedule, run.idempotency_key);
    await ctx.database('task_schedule_runs').where({ id: run.id }).update({ submission_id: result.submissionId, task_id: result.taskId });
    failure = result.state === 'failed' ? (result.error || 'The task could not be started') : null;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await ctx.database('task_schedules').where({ id: schedule.id }).update({ last_run_at: iso(ctx.now) });
  await ctx.database('task_schedule_runs').where({ id: run.id, status: 'dispatching' }).update({ status: 'dispatched' });
  if (failure === null) return 'dispatched';
  await finishRun(ctx, { ...run, status: 'dispatched' }, { status: 'failed', reason: failure });
  await notify(ctx, {
    kind: 'dispatch_failed', schedule,
    deduplicationKey: `schedule-dispatch-failed:${run.idempotency_key}`,
    title: `Scheduled: ${schedule.name} could not start`,
    body: `The ${run.trigger === 'manual' ? 'manual' : 'scheduled'} run for ${schedule.repository} failed to start: ${failure}`,
  });
  return 'failed';
}

/**
 * Claims a run row for a slot. The unique idempotency key means a second tick
 * (or a second daemon) for the same slot gets `null` and must not dispatch.
 */
async function claimRun(ctx: RunContext, schedule: TaskSchedule, claim: { slot: string; trigger: ScheduleRunTrigger; key: string }): Promise<TaskScheduleRunRow | null> {
  try {
    await ctx.database('task_schedule_runs').insert({
      schedule_id: schedule.id, idempotency_key: claim.key, slot: claim.slot, trigger: claim.trigger, status: 'dispatching', created_at: iso(ctx.now),
    });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test((error as Error).message)) return null;
    throw error;
  }
  return (await ctx.database<TaskScheduleRunRow>('task_schedule_runs').where({ idempotency_key: claim.key }).first()) ?? null;
}

async function dispatchSlot(ctx: RunContext, schedule: TaskSchedule, slot: string): Promise<ScheduleRunStatus | null> {
  const run = await claimRun(ctx, schedule, { slot, trigger: 'schedule', key: scheduleIdempotencyKey(schedule.id, slot) });
  if (!run) return null;
  const running = await countRunningUnattendedWork(ctx.database, run.id);
  const admission = decideUnattendedAdmission(await ctx.deps.admissionSettings(), running, ctx.now);
  if (admission.admitted) return runDispatch(ctx, run, schedule);
  await ctx.database('task_schedule_runs').where({ id: run.id }).update({ status: 'skipped', reason: admission.message, finished_at: iso(ctx.now) });
  logger.info({ scheduleId: schedule.id, slot, reason: admission.reason }, 'Skipped a scheduled run: unattended work not admitted');
  await notify(ctx, {
    kind: 'skipped', schedule,
    deduplicationKey: `schedule-skipped:${run.idempotency_key}`,
    title: `Scheduled: ${schedule.name} skipped`,
    body: `The run due at ${slot} for ${schedule.repository} was skipped. ${admission.message}.`,
  });
  return 'skipped';
}

/** Dispatches one due slot of a schedule, subject to unattended-work admission. */
export async function dispatchScheduleSlot(database: Knex, deps: ScheduleDependencies, schedule: TaskSchedule, slot: string): Promise<ScheduleRunStatus | null> {
  return dispatchSlot(context(database, deps), schedule, slot);
}

async function currentTaskState(database: Knex, taskId: string): Promise<string | null> {
  const row = await database('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state');
  return (row as { state?: string } | undefined)?.state ?? null;
}

interface SubmissionProgress {
  state: string;
  error: string | null;
  task_id: string | null;
  latest_task_id: string | null;
}

/** The outcome of a dispatched run, or null while its task is still pending or running. */
async function dispatchedRunOutcome(ctx: RunContext, run: TaskScheduleRunRow, staleBefore: string): Promise<{ status: FinishedStatus; reason: string | null } | null> {
  const submission = run.submission_id
    ? await ctx.database('task_submissions').where({ id: run.submission_id }).first('state', 'error', 'task_id', 'latest_task_id') as SubmissionProgress | undefined
    : undefined;
  // Retries start new tasks; the run follows the submission's latest one.
  const taskId = submission?.latest_task_id ?? submission?.task_id ?? run.task_id;
  if (taskId && taskId !== run.task_id) await ctx.database('task_schedule_runs').where({ id: run.id }).update({ task_id: taskId });
  if (!taskId) {
    if (submission?.state === 'failed') return { status: 'failed', reason: submission.error || 'The task could not be started' };
    return run.created_at < staleBefore ? { status: 'failed', reason: 'The task never started' } : null;
  }
  const state = await currentTaskState(ctx.database, taskId);
  if (state === 'completed') return { status: 'succeeded', reason: null };
  if (state === 'failed') return { status: 'failed', reason: 'The task failed' };
  if (state === 'cancelled') return { status: 'cancelled', reason: 'The task was cancelled' };
  return null;
}

async function reconcileRun(ctx: RunContext, run: TaskScheduleRunRow, staleBefore: string): Promise<boolean> {
  const schedule = await getSchedule(ctx.database, run.schedule_id);
  if (!schedule) return false;
  if (run.status === 'dispatching') {
    // The process stopped between claiming the slot and recording the result.
    // The submission is keyed by the same idempotency key, so this cannot duplicate it.
    if (run.created_at < staleBefore) await finishRun(ctx, run, { status: 'failed', reason: 'The run was interrupted before its task was created' });
    else await runDispatch(ctx, run, schedule);
    return true;
  }
  const outcome = await dispatchedRunOutcome(ctx, run, staleBefore);
  if (!outcome) return false;
  await finishRun(ctx, run, outcome);
  return true;
}

/** Records the outcome of runs whose task finished, retries interrupted dispatches, and pauses failing schedules. */
export async function reconcileScheduleRuns(database: Knex, deps: ScheduleDependencies): Promise<number> {
  const ctx = context(database, deps);
  const staleBefore = iso(new Date(ctx.now.getTime() - (deps.staleRunMs ?? DEFAULT_STALE_SCHEDULE_RUN_MS)));
  const runs = await database<TaskScheduleRunRow>('task_schedule_runs').whereIn('status', ACTIVE_RUN_STATUSES).orderBy('id', 'asc');
  let reconciled = 0;
  for (const run of runs) {
    try {
      if (await reconcileRun(ctx, run, staleBefore)) reconciled++;
    } catch (error) {
      logger.warn({ runId: run.id, error: (error as Error).message }, 'Could not reconcile a scheduled run');
    }
  }
  return reconciled;
}

function nextSlotOrNull(schedule: TaskSchedule, now: Date): string | null {
  try {
    return nextRunAfter(schedule.cron, schedule.timezone, now);
  } catch (error) {
    logger.warn({ scheduleId: schedule.id, error: (error as Error).message }, 'Schedule timing is no longer valid; it will not fire again');
    return null;
  }
}

async function processDueSchedule(ctx: RunContext, row: TaskScheduleRow, result: ScheduleTickResult): Promise<void> {
  const schedule = toTaskSchedule(row);
  const slot = row.next_run_at!;
  const next = nextSlotOrNull(schedule, ctx.now);
  // Compare-and-set on the slot: only one tick advances (and so owns) it.
  const advanced = await ctx.database('task_schedules').where({ id: schedule.id, next_run_at: slot }).update({ next_run_at: next });
  if (!advanced) return;
  if (ctx.now.getTime() - new Date(slot).getTime() > (ctx.deps.missedSlotGraceMs ?? DEFAULT_MISSED_SLOT_GRACE_MS)) {
    result.missed++;
    logger.info({ scheduleId: schedule.id, slot, next }, 'Skipped a missed schedule slot (not replayed)');
    return;
  }
  const status = await dispatchSlot(ctx, schedule, slot);
  if (status === 'dispatched') result.dispatched++;
  else if (status === 'skipped') result.skipped++;
  else if (status === 'failed') result.failed++;
}

/**
 * One scheduler tick: settle finished runs, then dispatch every due slot.
 * Missed slots (due longer ago than the grace period, for example while the
 * daemon was down) are skipped, never replayed; the schedule moves on to its
 * next future slot.
 */
export async function runScheduleTick(database: Knex, deps: ScheduleDependencies): Promise<ScheduleTickResult> {
  const result: ScheduleTickResult = { dispatched: 0, skipped: 0, missed: 0, failed: 0, reconciled: 0 };
  result.reconciled = await reconcileScheduleRuns(database, deps);
  const ctx = context(database, deps);
  const due = await database<TaskScheduleRow>('task_schedules').where({ enabled: true }).whereNotNull('next_run_at')
    .where('next_run_at', '<=', iso(ctx.now)).orderBy('next_run_at', 'asc');
  for (const row of due) {
    try {
      await processDueSchedule(ctx, row, result);
    } catch (error) {
      result.failed++;
      logger.error({ scheduleId: row.id, slot: row.next_run_at, error: (error as Error).message }, 'Scheduled dispatch failed');
    }
  }
  return result;
}

/**
 * Starts a schedule now, outside its timetable. This is a manual run, so it is
 * exempt from unattended-work admission. It also re-enables a paused schedule
 * and clears its failure count.
 */
export async function runScheduleNow(database: Knex, deps: ScheduleDependencies, id: string, requestKey?: string): Promise<{ schedule: TaskSchedule; run: TaskScheduleRun }> {
  const ctx = context(database, deps);
  const current = await requireSchedule(database, id);
  const changes: Partial<TaskScheduleRow> = { enabled: true, consecutive_failures: 0, paused_reason: null, updated_at: iso(ctx.now) };
  // Re-enabling starts from the next future slot: nothing missed while paused is replayed.
  if (!current.enabled || !current.nextRunAt || current.nextRunAt <= iso(ctx.now)) {
    changes.next_run_at = nextRunAfter(current.cron, current.timezone, ctx.now);
  }
  await database('task_schedules').where({ id }).update(changes);
  const schedule = await requireSchedule(database, id);
  const key = `${scheduleIdempotencyKey(id, 'manual')}:${requestKey || randomUUID()}`;
  const run = await claimRun(ctx, schedule, { slot: iso(ctx.now), trigger: 'manual', key });
  if (run) await runDispatch(ctx, run, schedule);
  const stored = (await database<TaskScheduleRunRow>('task_schedule_runs').where({ idempotency_key: key }).first())!;
  return { schedule: await requireSchedule(database, id), run: toTaskScheduleRun(stored) };
}
