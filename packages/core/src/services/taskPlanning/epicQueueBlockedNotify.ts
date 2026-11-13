import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { EPIC_QUEUE_BLOCKED_EVENTS, toBlockedEvent, type EpicQueueBlockedEvent } from './epicQueueBlockedEvents.js';

/**
 * Delivers recorded blocked events after commit: each one is published as plan-domain
 * activity on the realtime channel (`blocked`, or `progressed` for a resolution), and a
 * new blocker raises one Inbox notification of kind `plan` for the plan's owner and the
 * repository's notification recipients. The notification is deduplicated per blocked
 * state (execution, occurrence, kind and reason), so a blocker that recurs after the queue
 * retried it does not raise a second card. An agent-reported blocker already has its task
 * notification (`task-blocked:<task>`), so it raises no plan card for the same cause.
 * Delivery is per event, and `notified_at` acknowledges both halves: it is set only after the
 * notification is stored and the activity was published. An event whose notification could not be
 * written, or whose publication failed (or that a crash interrupted in between), stays undelivered
 * and the sweep delivers it again; the notification's deduplication key makes that replay add no card.
 */
const NO_PLAN_CARD_KINDS = new Set(['agent_blocked']);

export function blockedNotificationKey(event: Pick<EpicQueueBlockedEvent, 'executionId' | 'issueNumber' | 'position' | 'blockedKind' | 'reason'>): string {
  const state = createHash('sha256').update(`${event.blockedKind}\n${event.reason}`).digest('hex').slice(0, 24);
  return `epic-queue-blocked:${event.executionId}:${event.issueNumber}:${event.position}:${state}`;
}

type Draft = { user_id?: string | null; repository?: string | null; name?: string | null };

async function repositoryNotificationsEnabled(repository: string): Promise<boolean> {
  const { loadMonitoredReposRaw } = await import('../../config/configManager.js');
  const entries = (await loadMonitoredReposRaw()).filter(entry => entry.name.toLowerCase() === repository.toLowerCase());
  // Mirrors the Inbox projection: disabled only when every configured entry opts out.
  return entries.length === 0 || entries.some(entry => (entry as { notificationsEnabled?: boolean }).notificationsEnabled !== false);
}

/** The plan's owner and every instance member, as the Inbox projection addresses repository notifications. */
async function recipientsFor(database: Knex, draft: Draft): Promise<Array<{ userId: string; pushEnabled: boolean }>> {
  const members = await database.schema.hasTable('instance_members')
    ? await database('instance_members').distinct('github_user_id') as Array<{ github_user_id?: unknown }> : [];
  const ids = new Set<string>();
  if (typeof draft.user_id === 'string' && draft.user_id) ids.add(draft.user_id);
  for (const member of members) if (typeof member.github_user_id === 'string' && member.github_user_id) ids.add(member.github_user_id);
  return [...ids].map(userId => ({ userId, pushEnabled: true }));
}

function planLabel(draft: Draft): string {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  return name && name !== 'Untitled Plan' ? name : 'an epic plan';
}

async function notify(database: Knex, event: EpicQueueBlockedEvent, draft: Draft): Promise<void> {
  if (event.type !== 'blocked' || NO_PLAN_CARD_KINDS.has(event.blockedKind) || !draft.repository) return;
  if (!await repositoryNotificationsEnabled(draft.repository)) return;
  const recipients = await recipientsFor(database, draft);
  if (!recipients.length) return;
  const { NotificationService } = await import('../notificationService.js');
  await new NotificationService({ database }).createNotificationEvent({
    deduplicationKey: blockedNotificationKey(event),
    kind: 'plan',
    severity: 'warning',
    target: { type: 'plan', repository: draft.repository, draftId: event.draftId },
    title: `Issue #${event.issueNumber} is blocked in ${planLabel(draft)}`,
    body: event.reason,
    actions: ['dismiss'],
    metadata: { event: 'plan.issue_blocked', executionId: event.executionId, issueNumber: event.issueNumber,
      blockedKind: event.blockedKind, blockedEventId: event.id },
    // The queue's clock is injectable; an Inbox event may not occur after it is stored.
    occurredAt: new Date(Math.min(event.createdAt, Date.now())),
  }, recipients);
}

/** Whether the realtime publisher accepted the activity frame. */
async function publish(event: EpicQueueBlockedEvent, draft: Draft): Promise<boolean> {
  try {
    const { getEventPublisher } = await import('../../utils/eventPublisher.js');
    return await getEventPublisher().publishActivity({ domain: 'plan', entityId: event.draftId, repository: draft.repository ?? null,
      change: event.type === 'blocked' ? 'blocked' : 'progressed' });
  } catch (error) {
    logger.warn?.({ eventId: event.id, error: (error as Error).message }, 'Could not publish epic queue blocked activity');
    return false;
  }
}

export async function deliverEpicQueueBlockedEvents(ids: number[], { database = db }: { database?: Knex } = {}): Promise<void> {
  if (!ids.length) return;
  const rows = await database(EPIC_QUEUE_BLOCKED_EVENTS).whereIn('id', ids).whereNull('notified_at').orderBy('id').select();
  for (const row of rows) {
    const event = toBlockedEvent(row);
    const draft: Draft = await database('task_drafts').where({ draft_id: event.draftId }).first('user_id', 'repository', 'name') ?? {};
    try {
      await notify(database, event, draft);
    } catch (error) {
      logger.warn?.({ eventId: event.id, error: (error as Error).message }, 'Could not record the epic queue blocked notification');
      continue;
    }
    if (!await publish(event, draft)) {
      logger.warn?.({ eventId: event.id }, 'Epic queue blocked activity was not published; the sweep delivers it again');
      continue;
    }
    await database(EPIC_QUEUE_BLOCKED_EVENTS).where({ id: event.id }).whereNull('notified_at').update({ notified_at: Date.now() });
  }
}
