import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as notificationSchema } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as preferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as badgePreference } from '../src/db/migrations/20260824010000_add_notification_badge_preference.js';
import { up as advertisedActions } from '../src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import { up as planActions } from '../src/db/migrations/20260824030000_add_plan_notification_actions.js';
import { up as systemFailureState } from '../src/db/migrations/20260829000000_add_notification_system_failure_state.js';
import { up as pullRequestState } from '../src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';

/**
 * Delivery of recorded blocked events: one Inbox card of kind `plan` per blocked state for
 * the plan owner and the repository's recipients, none for an agent-reported blocker (its
 * task notification already exists), and a plan-domain activity frame for every event.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const activity: Array<{ domain: string; change: string; entityId: string; repository: string | null }> = [];
let repositories: Array<{ name: string; notificationsEnabled?: boolean }> = [];
const log = { info() {}, warn(...args: unknown[]) { if (process.env.DEBUG_NOTIFY) console.error(...args); }, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
const publisher = await import('../src/utils/eventPublisher.js');
await mock.module('../src/utils/eventPublisher.js', { namedExports: { ...publisher, getEventPublisher: () => ({
  publishActivity: async (frame: (typeof activity)[number]) => { activity.push(frame); return true; },
  publishNotificationUpdate: async () => true,
}) } });
const config = await import('../src/config/configManager.js');
await mock.module('../src/config/configManager.js', { namedExports: { ...config, loadMonitoredReposRaw: async () => repositories } });
const { deliverEpicQueueBlockedEvents, blockedNotificationKey } = await import('../src/services/taskPlanning/epicQueueBlockedNotify.js');
const { NotificationService } = await import('../src/services/notificationService.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.string('user_id'); table.string('repository'); table.string('name');
});
await database.schema.createTable('instance_members', table => { table.string('github_user_id'); });
for (const migrate of [notificationSchema, preferenceApis, badgePreference, advertisedActions, planActions, systemFailureState,
  pullRequestState, blockedEvents]) await migrate(database);
after(async () => database.destroy());

beforeEach(async () => {
  for (const table of ['epic_queue_blocked_events', 'task_drafts', 'instance_members']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', user_id: 'owner', repository: 'acme/repo', name: 'Checkout epic' });
  await database('instance_members').insert([{ github_user_id: 'member' }, { github_user_id: 'owner' }]);
  activity.length = 0;
  repositories = [];
  // Inbox rows are append-only: each test reads only its own execution's cards.
  execution = `exec-${++executions}`;
});
let executions = 0;
let execution = 'exec';

let created = 1_800_000_000_000;
async function record(event: Partial<Record<string, unknown>> = {}): Promise<number> {
  const [row] = await database('epic_queue_blocked_events').insert({ draft_id: 'draft', execution_id: execution, issue_number: 2, position: 1,
    event: 'blocked', blocked_kind: 'dispatch_failed', blocked_reason: 'Could not start issue #2: GitHub unavailable',
    blocked_event_id: null, resolution: null, created_at: created++, notified_at: null, ...event }).returning('id');
  return Number(typeof row === 'object' ? row.id : row);
}
const inbox = async (userId: string) => (await new NotificationService({ database }).listNotifications(userId)).notifications
  .filter(card => card.deduplicationKey.includes(`:${execution}:`));

test('a blocked event raises one plan notification per blocked state for the owner and recipients', async () => {
  const first = await record();
  await deliverEpicQueueBlockedEvents([first], { database });
  for (const userId of ['owner', 'member']) {
    const [card, ...rest] = await inbox(userId);
    assert.deepEqual(rest, []);
    assert.equal(card.kind, 'plan');
    assert.equal(card.severity, 'warning');
    assert.deepEqual(card.target, { type: 'plan', repository: 'acme/repo', draftId: 'draft' });
    assert.equal(card.title, 'Issue #2 is blocked in Checkout epic');
    assert.equal(card.body, 'Could not start issue #2: GitHub unavailable');
    assert.equal(card.deduplicationKey, blockedNotificationKey({ executionId: execution, issueNumber: 2, position: 1,
      blockedKind: 'dispatch_failed', reason: 'Could not start issue #2: GitHub unavailable' }));
  }
  // Delivering again, or the same blocked state recurring after the queue retried it, adds no card.
  await deliverEpicQueueBlockedEvents([first], { database });
  await record({ event: 'resolved', blocked_event_id: first, resolution: 'cleared' });
  const recurred = await record();
  await deliverEpicQueueBlockedEvents([recurred], { database });
  assert.equal((await inbox('owner')).length, 1);
  // A different blocker is a new blocked state.
  await deliverEpicQueueBlockedEvents([await record({ blocked_reason: 'Could not start issue #2: rate limited' })], { database });
  assert.equal((await inbox('owner')).length, 2);
  assert.deepEqual(activity.map(frame => [frame.domain, frame.change, frame.entityId, frame.repository]),
    [['plan', 'blocked', 'draft', 'acme/repo'], ['plan', 'blocked', 'draft', 'acme/repo'], ['plan', 'blocked', 'draft', 'acme/repo']]);
  assert.equal(await database('epic_queue_blocked_events').whereNull('notified_at').whereNot('event', 'resolved').count({ count: '*' })
    .first().then(row => Number(row?.count)), 0);
});

test('an agent-reported blocker keeps only its task notification; a resolution publishes progress', async () => {
  const blocked = await record({ blocked_kind: 'agent_blocked', blocked_reason: 'Issue #2 stopped on a blocker reported by the agent;' });
  const resolved = await record({ event: 'resolved', blocked_kind: 'agent_blocked', blocked_event_id: blocked, resolution: 'retried' });
  await deliverEpicQueueBlockedEvents([blocked, resolved], { database });
  assert.deepEqual(await inbox('owner'), []);
  assert.deepEqual(activity.map(frame => frame.change), ['blocked', 'progressed']);
  assert.deepEqual(await database('epic_queue_blocked_events').whereNull('notified_at').pluck('id'), []);
});

test('a repository with notifications disabled gets no card, and the event counts as delivered', async () => {
  repositories = [{ name: 'acme/repo', notificationsEnabled: false }];
  const id = await record();
  await deliverEpicQueueBlockedEvents([id], { database });
  assert.deepEqual(await inbox('owner'), []);
  assert.deepEqual(await database('epic_queue_blocked_events').whereNull('notified_at').pluck('id'), []);
});
