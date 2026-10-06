import type { Knex } from 'knex';
import {
  createNotificationEvent, loadMonitoredReposRaw, loadUnattendedAdmissionSettings, logger,
  type ScheduleDependencies, type ScheduleNotification, type TaskSchedule,
} from '@propr/core';
import {
  defaultTaskSubmissionServices, prepareTaskSubmission, startTaskSubmission, type TaskSubmissionServices,
} from './taskSubmissionCreation.js';

/** Settings section that lists schedules; notifications link here. */
export const SCHEDULES_SETTINGS_HREF = '/settings?tab=automation#scheduled-tasks';

/**
 * Creates a scheduled run's task through the same path as a REST task
 * submission, on behalf of the schedule's owner. The idempotency key is the
 * submission identity, so a repeated dispatch for one slot resumes the same
 * submission instead of opening a second issue.
 */
export async function dispatchScheduledTask(db: Knex, schedule: TaskSchedule, idempotencyKey: string,
  { services = defaultTaskSubmissionServices, repositories = loadMonitoredReposRaw }: { services?: TaskSubmissionServices; repositories?: typeof loadMonitoredReposRaw } = {}) {
  const config = (await repositories()).find(candidate => candidate.enabled && candidate.name.toLowerCase() === schedule.repository);
  if (!config) throw new Error(`${schedule.repository} is no longer an enabled repository on this instance`);
  const { instruction } = schedule;
  const row = await prepareTaskSubmission(db, {
    actor: { id: schedule.owner.userId, username: schedule.owner.username },
    key: idempotencyKey,
    repository: schedule.repository,
    baseBranch: config.baseBranch,
    body: {
      repository: schedule.repository, instruction: instruction.text, agentAlias: instruction.agentAlias, model: instruction.model,
      autoMerge: instruction.autoMerge, runUltrafix: instruction.runUltrafix, ultrafixGoal: instruction.ultrafixGoal,
      ultrafixMaxCycles: instruction.ultrafixMaxCycles, maxCostUsd: instruction.maxCostUsd,
    },
    schedule: { id: schedule.id, name: schedule.name },
  }, services);
  const result = await startTaskSubmission(db, row, services);
  return { submissionId: result.id, state: result.state, taskId: result.task_id, error: result.error };
}

/** Schedule events reach the schedule's owner in the Inbox; a pause is also pushed. */
export async function notifyScheduleEvent(notification: ScheduleNotification): Promise<void> {
  const { schedule } = notification;
  await createNotificationEvent({
    deduplicationKey: notification.deduplicationKey,
    kind: 'system_failure',
    severity: notification.kind === 'skipped' ? 'info' : 'warning',
    target: { type: 'system_failure', component: 'scheduled-tasks', correlationId: schedule.id },
    title: notification.title,
    body: notification.body,
    action: { type: 'navigate', label: 'Open schedules', href: SCHEDULES_SETTINGS_HREF },
    metadata: { event: `schedule.${notification.kind}`, scheduleId: schedule.id, scheduleName: schedule.name, repository: schedule.repository },
    recipients: [{ userId: schedule.owner.userId, pushEnabled: notification.kind !== 'skipped' }],
  });
}

export function createScheduleDependencies(db: Knex, overrides: Partial<ScheduleDependencies> = {}): ScheduleDependencies {
  return {
    dispatch: (schedule, key) => dispatchScheduledTask(db, schedule, key),
    admissionSettings: loadUnattendedAdmissionSettings,
    notify: async notification => {
      try { await notifyScheduleEvent(notification); }
      catch (error) { logger.warn({ scheduleId: notification.schedule.id, error: (error as Error).message }, 'Schedule notification failed'); }
    },
    ...overrides,
  };
}
