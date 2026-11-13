import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import {
  closeConnection,
  closeEventPublisher,
  dismissClosedGoalBlockerNotifications,
  goalBlockerNotificationKey,
  NotificationService,
  notifyGoalBlockerOpened,
  recordGoalBlocker,
  resolveGoalBlocker,
  type GoalBlockerNotificationDeps,
} from '@propr/core';
import { GOAL_BLOCKER_NOTIFICATION_EVENT, notificationHref } from '@propr/shared';
import { VoiceBriefingService } from '../services/voiceBriefingService.js';
import { blockerSignal, isOperatorRelevant } from '../mcp/activityDigest.js';
import { waitForGoal } from '../services/goalWait.js';
import { goalId, insertGoal, openDatabase, ownerId, repository } from './goalWaitHarness.js';

/**
 * A goal blocker reaches its operator outside the goal console: one Inbox card
 * per blocker that links to the goal, closed with the blocker, a Voice Briefing
 * item, an activity-digest blocker signal and a goal-wait wake-up.
 */

let db: Knex;
let service: NotificationService;
let deps: GoalBlockerNotificationDeps;
const attempt = { goalId, taskId: `goal-task-${goalId}`, generation: 1, claimId: 'claim-1' };
const owner = { owner_id: ownerId, repository, session_id: 'session-1', agent_type: 'claude' };
const question = (key: string, summary = 'Which region should the deploy target?') => ({
  category: 'question' as const, source: 'ask_operator', requestKey: key, summary,
  questions: [], responseActions: ['answer' as const],
});

async function openBlocker(key: string, summary?: string) {
  const recorded = (await recordGoalBlocker(db, attempt, owner, question(key, summary)))!;
  const row = await db('goal_blockers').where({ blocker_id: recorded.blockerId }).first();
  return { recorded, row };
}

async function notify(row: { blocker_id: string; summary: string; category: string; provider: string }) {
  return notifyGoalBlockerOpened({
    blockerId: row.blocker_id, goalId, ownerId, repository, taskId: attempt.taskId,
    category: row.category, provider: row.provider, summary: row.summary, goalTitle: 'Ship the deploy',
  }, deps);
}

const inbox = async (userId = ownerId) => (await service.listNotifications(userId)).notifications;

beforeEach(async () => {
  // Notification events are immutable, so every test starts from a fresh database.
  await db?.destroy();
  db = await openDatabase();
  await insertGoal(db);
  let clock = Date.parse('2026-11-12T10:00:00.000Z');
  service = new NotificationService({ database: db, now: () => new Date(clock += 1000), publishNotificationUpdate: () => {} });
  deps = {
    createEvent: service.createNotificationEvent.bind(service),
    dismissByKeys: service.dismissNotificationsByDeduplicationKeys.bind(service),
    notificationsEnabled: async () => true,
  };
});

after(async () => {
  await db.destroy();
  await closeConnection();
  await closeEventPublisher();
});

describe('goal blocker notifications', () => {
  test('an opened blocker gives its owner one warning card that links to the goal', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { recorded, row } = await openBlocker('q-1', `Use token ${secret}? ${'Long detail. '.repeat(100)}`);
    assert.equal(recorded.opened, true);
    assert.equal(await notify(row), true);

    const [card, ...rest] = await inbox();
    assert.equal(rest.length, 0);
    assert.equal(card.kind, 'task');
    assert.equal(card.severity, 'warning');
    assert.equal(card.deduplicationKey, goalBlockerNotificationKey(row.blocker_id));
    assert.equal(card.title, 'Goal needs your answer: Ship the deploy');
    assert.deepEqual(card.metadata, {
      event: GOAL_BLOCKER_NOTIFICATION_EVENT, goalId, blockerId: row.blocker_id, category: 'question', provider: 'claude',
    });
    assert.equal(notificationHref(card), `/goals/${goalId}`);
    assert.ok(!card.body.includes(secret), 'the summary is redacted');
    assert.ok([...card.body].length <= 280, 'the summary is bounded');
    assert.ok(card.body.startsWith('Use token'));
    assert.deepEqual(await inbox('someone-else'), [], 'only the goal owner is told');
  });

  test('a repeated observation of one blocker never adds a second card; a new blocker adds its own', async () => {
    const first = await openBlocker('q-1');
    await notify(first.row);
    const repeat = await recordGoalBlocker(db, attempt, owner, question('q-1'));
    assert.equal(repeat?.opened, false, 'a refresh is not a new opening, so the worker does not notify again');
    await notify(first.row);
    assert.equal((await inbox()).length, 1);
    assert.equal(Number((await db('notification_events').count({ count: '*' }).first())?.count), 1);

    const second = await openBlocker('q-2', 'And which database?');
    await notify(second.row);
    assert.deepEqual((await inbox()).map(card => card.metadata?.blockerId).sort(),
      [first.row.blocker_id, second.row.blocker_id].sort());
  });

  test('closing a blocker dismisses only its card, and is idempotent', async () => {
    const answered = await openBlocker('q-1');
    const waiting = await openBlocker('q-2', 'Still open?');
    await notify(answered.row);
    await notify(waiting.row);

    assert.equal(await resolveGoalBlocker(db, attempt, 'q-1', 'answered'), true);
    assert.equal(await dismissClosedGoalBlockerNotifications(db, goalId, deps), 1);
    assert.deepEqual((await inbox()).map(card => card.metadata?.blockerId), [waiting.row.blocker_id]);
    assert.equal(await dismissClosedGoalBlockerNotifications(db, goalId, deps), 0);
    assert.equal(await service.getUnreadNotificationCount(ownerId), 1);
  });

  test('the owner\'s per-kind Inbox preference and the repository switch are respected', async () => {
    await service.updateNotificationPreference(ownerId, 'task', { inboxEnabled: false, pushEnabled: false });
    const { row } = await openBlocker('q-1');
    await notify(row);
    assert.deepEqual(await inbox(), []);
    assert.equal(Number((await db('notification_user_states').count({ count: '*' }).first())?.count), 0);

    await service.updateNotificationPreference(ownerId, 'task', { inboxEnabled: true, pushEnabled: true });
    const muted = await openBlocker('q-2');
    assert.equal(await notifyGoalBlockerOpened({
      blockerId: muted.row.blocker_id, goalId, ownerId, repository, taskId: attempt.taskId,
      category: 'question', provider: 'claude', summary: muted.row.summary,
    }, { ...deps, notificationsEnabled: async () => false }), false);
    assert.deepEqual(await inbox(), []);
  });

  test('the Voice Briefing lists the card as attention with a link to the goal', async () => {
    const { row } = await openBlocker('q-1');
    await notify(row);
    const notifications = await inbox();
    const briefing = await new VoiceBriefingService({
      loaders: {
        loadQueueJobs: async () => ({ active: [], waiting: [], delayed: [] }),
        loadPlans: async () => [],
        loadNotifications: async () => notifications,
      },
      now: () => new Date('2026-11-12T11:00:00.000Z'),
    }).getBriefing(ownerId, 'attention');
    assert.equal(briefing.counts.attention, 1);
    const [item] = briefing.items;
    assert.equal(item.href, `/goals/${goalId}`);
    assert.equal(item.requiresAttention, true);
    assert.equal(item.summary, `Goal needs your answer: Ship the deploy in ${repository} is waiting for you.`);
  });

  test('the activity digest reports the card as a blocker signal', async () => {
    const { row } = await openBlocker('q-1');
    await notify(row);
    const [card] = await inbox();
    assert.equal(blockerSignal(card), 'goal_needs_input');
    assert.equal(isOperatorRelevant(card), true);
    assert.equal(isOperatorRelevant({ ...card, metadata: { ...card.metadata, event: 'agent_run.awaiting_approval' } }), false);
  });
});

describe('goal wait on blockers', () => {
  const wait = (options: Partial<Parameters<typeof waitForGoal>[0]> = {}) => waitForGoal({
    db, ownerId, goalId, repository, timeoutSeconds: 2, pollIntervalMs: 25, ...options,
  });

  test('until blocked wakes when a blocker opens and reports it', async () => {
    const waiting = wait({ until: 'blocked' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const { row } = await openBlocker('q-1');
    const result = await waiting;
    assert.equal(result.outcome, 'matched');
    assert.equal(result.matchedImmediately, false);
    assert.equal(result.event?.kind, 'blocker');
    assert.deepEqual(result.event?.blocker, { id: row.blocker_id, status: 'open', category: 'question' });
    assert.equal(result.event?.state, null);

    // Resuming from that cursor, the next blocker event is its closing.
    await resolveGoalBlocker(db, attempt, 'q-1', 'answered');
    const next = await wait({ afterCursor: result.cursor });
    assert.equal(next.event?.kind, 'blocker');
    assert.equal(next.event?.blocker?.status, 'resolved');
    // A closing never satisfies until blocked.
    const quiet = await wait({ until: 'blocked', afterCursor: result.cursor, timeoutSeconds: 0.2 });
    assert.equal(quiet.outcome, 'timed_out');
  });

  test('without a cursor until blocked matches a still-open blocker of the current attempt only', async () => {
    const none = await wait({ until: 'blocked', timeoutSeconds: 0.1 });
    assert.equal(none.outcome, 'timed_out');

    const { row } = await openBlocker('q-1');
    const immediate = await wait({ until: 'blocked', timeoutSeconds: 0.1 });
    assert.equal(immediate.outcome, 'matched');
    assert.equal(immediate.matchedImmediately, true);
    assert.equal(immediate.event?.blocker?.id, row.blocker_id);

    // A newer attempt fences the old session's blocker out, as the attention projection does.
    await db('goals').where({ goal_id: goalId }).update({ run_generation: 2, run_claim: 'claim-2' });
    const fenced = await wait({ until: 'blocked', timeoutSeconds: 0.1 });
    assert.equal(fenced.outcome, 'timed_out');
  });

  test('lifecycle and checkpoint conditions ignore blocker events', async () => {
    const waiting = wait({ until: 'checkpoint', timeoutSeconds: 0.3 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await openBlocker('q-1');
    assert.equal((await waiting).outcome, 'timed_out');
  });
});
