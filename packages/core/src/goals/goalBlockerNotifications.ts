import type { Knex } from 'knex';
import { boundGoalBlockerText, GOAL_BLOCKER_NOTIFICATION_EVENT } from '@propr/shared';
import { loadMonitoredReposRaw } from '../config/configManager.js';
import {
    createNotificationEvent,
    dismissNotificationsByDeduplicationKeys,
} from '../services/notificationService.js';
import { redactSecrets } from '../utils/github/secretRedaction.js';
import logger from '../utils/logger.js';

/**
 * Inbox (and push, and Voice Briefing) item for a goal waiting on its operator.
 *
 * One notification per blocker: the deduplication key carries the blocker id,
 * so a refreshed observation of the same provider request never adds a second
 * card, and a new question opens a new one. It reuses `kind: 'task'` with the
 * goal's task as its target and `metadata.goalId`, so the shared link builder
 * already sends Inbox, push and briefing clicks to `/goals/<id>`. The Inbox
 * text is the bounded, redacted blocker summary; push text is generic for
 * every warning, so the question never leaves ProPR through a push service.
 *
 * The card describes a condition, not an outcome: once the blocker closes
 * (answered, timed out, turn or attempt ended) its receipts are dismissed so
 * the Inbox does not keep a stale "needs you".
 */

export { GOAL_BLOCKER_NOTIFICATION_EVENT };

/** Characters of the blocker summary shown in the Inbox body. */
export const GOAL_BLOCKER_NOTIFICATION_SUMMARY_LIMIT = 280;
const GOAL_TITLE_LIMIT = 80;
const TITLE_BYTES = 256;

export function goalBlockerNotificationKey(blockerId: string): string {
    return `goal-blocker:${blockerId}`;
}

export interface OpenedGoalBlockerNotification {
    blockerId: string;
    goalId: string;
    ownerId: string;
    repository: string;
    taskId: string;
    category: string;
    provider: string;
    summary: string;
    goalTitle?: string | null;
}

export interface GoalBlockerNotificationDeps {
    createEvent?: typeof createNotificationEvent;
    dismissByKeys?: typeof dismissNotificationsByDeduplicationKeys;
    notificationsEnabled?: (repository: string) => Promise<boolean>;
}

/** Mirrors the Inbox projection: disabled only when every configured entry for the repository opts out. */
async function repositoryNotificationsEnabled(repository: string): Promise<boolean> {
    const entries = (await loadMonitoredReposRaw()).filter(entry => entry.name.toLowerCase() === repository.toLowerCase());
    return entries.length === 0 || entries.some(entry => (entry as { notificationsEnabled?: boolean }).notificationsEnabled !== false);
}

function boundBytes(value: string, maximum: number): string {
    if (Buffer.byteLength(value) <= maximum) return value;
    const characters = [...value];
    while (characters.length > 0 && Buffer.byteLength(`${characters.join('')}…`) > maximum) characters.pop();
    return `${characters.join('').trimEnd()}…`;
}

export function goalBlockerNotificationContent(blocker: Pick<OpenedGoalBlockerNotification, 'category' | 'summary' | 'goalTitle'>): {
    title: string;
    body: string;
} {
    const goalTitle = boundGoalBlockerText(redactSecrets(blocker.goalTitle ?? ''), GOAL_TITLE_LIMIT);
    const lead = blocker.category === 'approval' ? 'Goal needs your approval' : 'Goal needs your answer';
    const summary = boundGoalBlockerText(redactSecrets(blocker.summary), GOAL_BLOCKER_NOTIFICATION_SUMMARY_LIMIT);
    return {
        title: boundBytes(goalTitle ? `${lead}: ${goalTitle}` : lead, TITLE_BYTES),
        body: summary || (blocker.category === 'approval'
            ? 'The agent is waiting for your approval.'
            : 'The agent asked a question and is waiting for you.'),
    };
}

/** Tell the goal's owner that a newly opened blocker waits on them. */
export async function notifyGoalBlockerOpened(
    blocker: OpenedGoalBlockerNotification,
    deps: GoalBlockerNotificationDeps = {},
): Promise<boolean> {
    const notificationsEnabled = deps.notificationsEnabled ?? repositoryNotificationsEnabled;
    if (!await notificationsEnabled(blocker.repository)) return false;
    const { title, body } = goalBlockerNotificationContent(blocker);
    // Recipients are the owner only; their per-kind Inbox and push preferences
    // and quiet hours are applied when the receipt is assigned.
    await (deps.createEvent ?? createNotificationEvent)({
        deduplicationKey: goalBlockerNotificationKey(blocker.blockerId),
        kind: 'task',
        severity: 'warning',
        target: { type: 'task', repository: blocker.repository, taskId: blocker.taskId },
        title,
        body,
        metadata: {
            event: GOAL_BLOCKER_NOTIFICATION_EVENT,
            goalId: blocker.goalId,
            blockerId: blocker.blockerId,
            category: blocker.category,
            provider: blocker.provider,
        },
    }, [{ userId: blocker.ownerId, pushEnabled: true }]);
    return true;
}

/**
 * Dismiss the Inbox cards of every closed blocker of a goal. Idempotent, so it
 * is safe after any close and also repairs a card created after its blocker
 * was already answered.
 */
export async function dismissClosedGoalBlockerNotifications(
    database: Knex | Knex.Transaction,
    goalId: string,
    deps: Pick<GoalBlockerNotificationDeps, 'dismissByKeys'> = {},
): Promise<number> {
    const closed = await database('goal_blockers').where({ goal_id: goalId }).whereNot('status', 'open')
        .pluck('blocker_id') as string[];
    if (closed.length === 0) return 0;
    return (deps.dismissByKeys ?? dismissNotificationsByDeduplicationKeys)(closed.map(goalBlockerNotificationKey));
}

/** Best-effort wrappers: the blocker itself is already durable, so a lost card must not fail its writer. */
export async function notifyGoalBlockerOpenedSafely(
    database: Knex,
    blocker: OpenedGoalBlockerNotification,
    deps: GoalBlockerNotificationDeps = {},
): Promise<void> {
    try {
        if (!await notifyGoalBlockerOpened(blocker, deps)) return;
        // The blocker may have closed while the card was being written.
        await dismissClosedGoalBlockerNotifications(database, blocker.goalId, deps);
    } catch (error) {
        logger.warn({ goalId: blocker.goalId, blockerId: blocker.blockerId, error: (error as Error).message },
            'Could not notify the operator that a goal needs input');
    }
}

export async function dismissClosedGoalBlockerNotificationsSafely(
    database: Knex,
    goalId: string,
    deps: Pick<GoalBlockerNotificationDeps, 'dismissByKeys'> = {},
): Promise<void> {
    try {
        await dismissClosedGoalBlockerNotifications(database, goalId, deps);
    } catch (error) {
        logger.warn({ goalId, error: (error as Error).message }, 'Could not resolve goal blocker notifications');
    }
}
