/* eslint-disable max-lines -- service privacy and identity regressions share focused fixtures */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Knex } from 'knex';
import type { Notification } from '@propr/shared';
import {
  VoiceBriefingService,
  createVoiceBriefingDataLoaders,
  type VoiceBriefingDataLoaders,
  type VoiceBriefingPlanRow,
  type VoiceBriefingQueueJob,
  type VoiceBriefingQueueSnapshot,
} from '../services/voiceBriefingService.js';

const NOW = '2026-09-07T01:30:00.000Z';

function job(
  id: string,
  title: string,
  timestamp: string,
  extraData: Record<string, unknown> = {},
): VoiceBriefingQueueJob {
  return {
    id,
    name: 'task',
    timestamp: Date.parse(timestamp),
    data: {
      taskId: id,
      title,
      repository: 'integry/propr',
      ...extraData,
    },
  } as VoiceBriefingQueueJob;
}

function notification(input: {
  id: string;
  severity: 'warning' | 'error';
  title: string;
  target: Notification['target'];
  occurredAt: string;
  actions?: Notification['actions'];
  body?: string;
  metadata?: Record<string, string>;
}): Notification {
  return {
    id: input.id,
    deduplicationKey: `dedupe-${input.id}`,
    kind: input.target.type,
    severity: input.severity,
    target: input.target,
    title: input.title,
    body: input.body ?? 'Notification body must not enter the briefing',
    actions: input.actions ?? [],
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
    readAt: null,
    dismissedAt: null,
  } as Notification;
}

function loaders(input: {
  queue: VoiceBriefingQueueSnapshot;
  plans?: VoiceBriefingPlanRow[];
  notifications?: Notification[];
}): VoiceBriefingDataLoaders {
  return {
    loadQueueJobs: async () => input.queue,
    loadPlans: async () => input.plans ?? [],
    loadNotifications: async () => input.notifications ?? [],
  };
}

test('briefing preserves complete job counts, prioritizes attention, deduplicates tasks, and caps details at eight', async () => {
  const queue: VoiceBriefingQueueSnapshot = {
    active: [
      job('task-1', 'Implement voice briefing', '2026-09-07T01:20:00.000Z', {
        prompt: 'SECRET PROMPT',
        toolOutput: 'SECRET TOOL OUTPUT',
      }),
      job('task-2', 'Update queue status', '2026-09-07T01:19:00.000Z'),
      job('task-3', 'Add parser validation', '2026-09-07T01:18:00.000Z'),
      job('task-4', 'Check navigation', '2026-09-07T01:17:00.000Z'),
      job('task-5', 'Write documentation', '2026-09-07T01:16:00.000Z'),
    ],
    waiting: [
      job('task-6', 'Queued one', '2026-09-07T01:15:00.000Z'),
      job('task-7', 'Queued two', '2026-09-07T01:14:00.000Z'),
      job('task-8', 'Queued three', '2026-09-07T01:13:00.000Z'),
    ],
    delayed: [
      job('task-9', 'Delayed one', '2026-09-07T01:12:00.000Z'),
      job('task-10', 'Delayed two', '2026-09-07T01:11:00.000Z'),
    ],
  };
  const plans: VoiceBriefingPlanRow[] = [{
    draft_id: 'draft-1',
    name: 'SECRET PLAN PROMPT',
    repository: 'integry/propr',
    status: 'review',
    updated_at: '2026-09-07T01:10:00.000Z',
    initial_prompt: 'SECRET PLAN PROMPT',
  } as VoiceBriefingPlanRow];
  const notifications = [
    notification({
      id: 'notification-error',
      severity: 'error',
      title: 'Voice task failed',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' },
      occurredAt: '2026-09-07T01:05:00.000Z',
      actions: ['stop', 'follow_up'],
      body: 'SECRET LOG OUTPUT',
      metadata: { credential: 'SECRET CREDENTIAL' },
    }),
    notification({
      id: 'notification-warning',
      severity: 'warning',
      title: 'Worker needs attention',
      target: { type: 'system_failure', component: 'worker' },
      occurredAt: '2026-09-07T01:04:00.000Z',
    }),
  ];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, plans, notifications }),
    now: () => NOW,
  });

  const first = await service.getBriefing('user-1');
  const second = await service.getBriefing('user-1');

  assert.deepEqual(first.counts, {
    running: 5,
    queued: 5,
    attention: 3,
    plans: 1,
    total: 12,
  });
  assert.equal(first.items.length, 8);
  assert.deepEqual(first.items.slice(0, 3).map(item => item.status), [
    'error',
    'warning',
    'review',
  ]);
  assert.deepEqual(first.items.slice(0, 3).map(item => item.reference), [
    'task 1',
    'system 1',
    'plan 1',
  ]);
  assert.equal(first.items.filter(item => item.id === 'task-1').length, 1);
  assert.equal(first.items.find(item => item.id === 'draft-1')?.title, 'Plan for integry/propr');
  assert.deepEqual(second.items, first.items, 'the same snapshot has stable reference ordering');

  const serialized = JSON.stringify(first);
  for (const secret of [
    'SECRET PROMPT',
    'SECRET TOOL OUTPUT',
    'SECRET PLAN PROMPT',
    'SECRET LOG OUTPUT',
    'SECRET CREDENTIAL',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('running and attention scopes filter details while retaining complete snapshot counts', async () => {
  const requestedQueueUsers: string[] = [];
  const requestedPlanUsers: string[] = [];
  const requestedNotificationUsers: string[] = [];
  const queue: VoiceBriefingQueueSnapshot = {
    active: [job('active-task', 'Active task', '2026-09-07T01:20:00.000Z')],
    waiting: [job('queued-task', 'Queued task', '2026-09-07T01:19:00.000Z')],
    delayed: [],
  };
  const testLoaders: VoiceBriefingDataLoaders = {
    loadQueueJobs: async userId => {
      requestedQueueUsers.push(userId);
      return queue;
    },
    loadPlans: async userId => {
      requestedPlanUsers.push(userId);
      return [
        {
          draft_id: 'generating-plan', repository: 'integry/propr',
          status: 'generating', updated_at: '2026-09-07T01:18:00.000Z',
        },
        {
          draft_id: 'refining-plan', repository: 'integry/propr',
          status: 'refining', updated_at: '2026-09-07T01:17:30.000Z',
        },
        {
          draft_id: 'review-plan', repository: 'integry/propr',
          status: 'review', updated_at: '2026-09-07T01:17:00.000Z',
        },
        {
          draft_id: 'approved-plan', repository: 'integry/propr',
          status: 'approved', updated_at: '2026-09-07T01:16:00.000Z',
        },
      ];
    },
    loadNotifications: async userId => {
      requestedNotificationUsers.push(userId);
      return [notification({
        id: 'warning-1',
        severity: 'warning',
        title: 'Task is stalled',
        target: { type: 'task', repository: 'integry/propr', taskId: 'stalled-task' },
        occurredAt: '2026-09-07T01:15:00.000Z',
      })];
    },
  };
  const service = new VoiceBriefingService({ loaders: testLoaders, now: () => NOW });

  const running = await service.getBriefing('authenticated-user', 'running');
  const attention = await service.getBriefing('authenticated-user', 'attention');

  assert.deepEqual(running.items.map(item => item.id), [
    'active-task',
    'generating-plan',
    'refining-plan',
  ]);
  assert.equal(
    running.items.find(item => item.id === 'refining-plan')?.summary,
    'Plan for integry/propr is refining.',
  );
  assert.deepEqual(attention.items.map(item => item.id), ['stalled-task', 'review-plan']);
  assert.ok(attention.items.every(item => item.requiresAttention));
  assert.deepEqual(running.counts, attention.counts);
  assert.deepEqual(requestedQueueUsers, ['authenticated-user', 'authenticated-user']);
  assert.deepEqual(requestedPlanUsers, ['authenticated-user', 'authenticated-user']);
  assert.deepEqual(requestedNotificationUsers, ['authenticated-user', 'authenticated-user']);
});

test('advertises plan stop only for draft-scoped generating and refining operations', async () => {
  const queue: VoiceBriefingQueueSnapshot = { active: [], waiting: [], delayed: [] };
  const plans: VoiceBriefingPlanRow[] = [
    {
      draft_id: 'generating-plan', repository: 'integry/propr',
      status: 'generating', updated_at: '2026-09-07T01:20:00.000Z',
    },
    {
      draft_id: 'refining-plan', repository: 'integry/propr',
      status: 'refining', updated_at: '2026-09-07T01:19:00.000Z',
    },
    {
      draft_id: 'executing-plan', repository: 'integry/propr',
      status: 'executing', updated_at: '2026-09-07T01:18:00.000Z',
    },
    {
      draft_id: 'notified-executing-plan', repository: 'integry/propr',
      status: 'executing', updated_at: '2026-09-07T01:17:00.000Z',
    },
  ];
  const notifications = [notification({
    id: 'executing-plan-warning',
    severity: 'warning',
    title: 'Executing plan needs attention',
    target: {
      type: 'plan',
      repository: 'integry/propr',
      draftId: 'notified-executing-plan',
    },
    occurredAt: '2026-09-07T01:21:00.000Z',
    actions: ['stop', 'follow_up'],
  })];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, plans, notifications }),
    now: () => NOW,
  });

  const briefing = await service.getBriefing('authenticated-user');

  assert.deepEqual(
    briefing.items.find(item => item.id === 'generating-plan')?.actions,
    ['open', 'stop'],
  );
  assert.deepEqual(
    briefing.items.find(item => item.id === 'refining-plan')?.actions,
    ['open', 'stop'],
  );
  assert.deepEqual(
    briefing.items.find(item => item.id === 'executing-plan')?.actions,
    ['open'],
  );
  assert.deepEqual(
    briefing.items.find(item => item.id === 'notified-executing-plan')?.actions,
    ['open', 'follow_up'],
  );
});

test('advertises notification mutations only for canonical task and draft targets', async () => {
  const queue: VoiceBriefingQueueSnapshot = { active: [], waiting: [], delayed: [] };
  const advertisedActions: Notification['actions'] = ['stop', 'follow_up'];
  const notifications = [
    notification({
      id: 'system-warning',
      severity: 'warning',
      title: 'System needs attention',
      target: { type: 'system_failure', component: 'worker' },
      occurredAt: '2026-09-07T01:20:00.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'indexing-warning',
      severity: 'warning',
      title: 'Indexing needs attention',
      target: { type: 'indexing', repository: 'integry/propr', branch: 'release/2026 Q1' },
      occurredAt: '2026-09-07T01:19:00.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'pull-request-warning',
      severity: 'warning',
      title: 'Pull request needs attention',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 42 },
      occurredAt: '2026-09-07T01:18:00.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'review-without-task',
      severity: 'warning',
      title: 'Review needs attention',
      target: { type: 'review', repository: 'integry/propr', prNumber: 43 },
      occurredAt: '2026-09-07T01:17:00.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'review-with-task',
      severity: 'warning',
      title: 'Task review needs attention',
      target: {
        type: 'review', repository: 'integry/propr', prNumber: 44, taskId: 'review-task',
      },
      occurredAt: '2026-09-07T01:16:00.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'task-warning',
      severity: 'warning',
      title: 'Task needs attention',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-target' },
      occurredAt: '2026-09-07T01:15:30.000Z',
      actions: advertisedActions,
    }),
    notification({
      id: 'plan-warning',
      severity: 'warning',
      title: 'Plan needs attention',
      target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-target' },
      occurredAt: '2026-09-07T01:15:00.000Z',
      actions: advertisedActions,
    }),
  ];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, notifications }),
    now: () => NOW,
  });

  const briefing = await service.getBriefing('authenticated-user');
  const actionsById = Object.fromEntries(briefing.items.map(item => [item.id, item.actions]));

  assert.deepEqual(actionsById['system-warning'], []);
  assert.deepEqual(actionsById['indexing-warning'], []);
  assert.equal(
    briefing.items.find(item => item.id === 'indexing-warning')?.href,
    '/summaries/integry/propr?branch=release%2F2026%20Q1',
  );
  assert.deepEqual(actionsById['pull-request-warning'], ['open']);
  assert.deepEqual(actionsById['review-without-task'], ['open']);
  assert.deepEqual(actionsById['review-task'], ['open', 'stop', 'follow_up']);
  assert.deepEqual(actionsById['task-target'], ['open', 'stop', 'follow_up']);
  assert.deepEqual(actionsById['draft-target'], ['open', 'follow_up']);
});

test('running scope retains an active task that also has an attention notification', async () => {
  const queue: VoiceBriefingQueueSnapshot = {
    active: [job('active-task', 'Active task', '2026-09-07T01:20:00.000Z')],
    waiting: [],
    delayed: [],
  };
  const notifications = [notification({
    id: 'active-task-warning',
    severity: 'warning',
    title: 'Active task needs attention',
    target: { type: 'task', repository: 'integry/propr', taskId: 'active-task' },
    occurredAt: '2026-09-07T01:21:00.000Z',
  })];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, notifications }),
    now: () => NOW,
  });

  const all = await service.getBriefing('authenticated-user');
  const running = await service.getBriefing('authenticated-user', 'running');

  assert.deepEqual(all.items.map(item => [item.id, item.status]), [
    ['active-task', 'warning'],
  ]);
  assert.deepEqual(running.counts, {
    running: 1,
    queued: 0,
    attention: 1,
    plans: 0,
    total: 1,
  });
  assert.equal(running.headline, '1 job is running.');
  assert.deepEqual(running.items.map(item => [item.id, item.status]), [
    ['active-task', 'running'],
  ]);
});

test('deduplicates queued jobs sharing a pull request identity in aggregate counts', async () => {
  const queue: VoiceBriefingQueueSnapshot = {
    active: [],
    waiting: [
      {
        ...job('comment-job-1', 'First comment', '2026-09-07T01:20:00.000Z', {
          repoOwner: 'integry',
          repoName: 'propr',
          pullRequestNumber: 42,
        }),
        name: 'processPullRequestComment',
      },
      {
        ...job('comment-job-2', 'Second comment', '2026-09-07T01:19:00.000Z', {
          repoOwner: 'integry',
          repoName: 'propr',
          pullRequestNumber: 42,
        }),
        name: 'processPullRequestComment',
      },
    ],
    delayed: [],
  };
  const service = new VoiceBriefingService({
    loaders: loaders({ queue }),
    now: () => NOW,
  });

  const briefing = await service.getBriefing('authenticated-user');

  assert.deepEqual(briefing.counts, {
    running: 0,
    queued: 1,
    attention: 0,
    plans: 0,
    total: 1,
  });
  assert.deepEqual(briefing.items.map(item => item.id), ['comment-job-1']);
});

test('deduplicates task and pull request notifications joined by a later queue alias', async () => {
  const queue: VoiceBriefingQueueSnapshot = {
    active: [],
    waiting: [job('bridge-job', 'Queue bridge', '2026-09-07T01:18:00.000Z', {
      taskId: 'task-alias',
      pullRequestNumber: 42,
    })],
    delayed: [],
  };
  const notifications = [
    notification({
      id: 'task-error',
      severity: 'error',
      title: 'Task failed',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-alias' },
      occurredAt: '2026-09-07T01:20:00.000Z',
    }),
    notification({
      id: 'pr-warning',
      severity: 'warning',
      title: 'Pull request needs review',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 42 },
      occurredAt: '2026-09-07T01:19:00.000Z',
    }),
  ];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, notifications }),
    now: () => NOW,
  });

  const briefing = await service.getBriefing('authenticated-user');
  const attention = await service.getBriefing('authenticated-user', 'attention');

  assert.equal(briefing.counts.total, 1);
  assert.equal(briefing.counts.attention, 1);
  assert.deepEqual(briefing.items.map(item => [item.id, item.title]), [
    ['task-alias', 'Task failed'],
  ]);
  assert.deepEqual(attention.counts, briefing.counts);
  assert.deepEqual(attention.items.map(item => [item.id, item.title]), [
    ['task-alias', 'Task failed'],
  ]);
});

test('queue authorization ignores identical and reassigned username snapshots', async () => {
  const taskQueue = {
    async getJobs(states: string[]) {
      if (states[0] !== 'waiting') return [];
      return [
        {
          ...job('owned-by-id', 'Owned after rename', NOW),
          name: 'processTaskImport',
          data: { userId: 'owner-user', user: 'previous-login' },
        },
        {
          ...job('legacy-same-login', 'LEGACY PRIVATE TITLE', NOW),
          name: 'processTaskImport',
          data: { user: 'shared-login' },
        },
        {
          ...job('reassigned-login', 'REASSIGNED PRIVATE TITLE', NOW),
          name: 'processSystemTask',
          data: { userId: 'different-user', requestingUser: 'shared-login' },
        },
      ];
    },
  };
  const dataLoaders = createVoiceBriefingDataLoaders({
    database: (() => { throw new Error('queue authorization must not load mutable usernames'); }) as unknown as Knex,
    taskQueue: taskQueue as never,
    notificationService: { listNotifications: async () => { throw new Error('unused'); } },
  });

  const snapshot = await dataLoaders.loadQueueJobs('owner-user');

  assert.deepEqual(snapshot.waiting.map(queueJob => queueJob.id), ['owned-by-id']);
});

test('production loaders authorize queue jobs, constrain plans, and load every notification page', async () => {
  const queryTrace: Array<[string, unknown]> = [];
  const planRows = [
    {
      draft_id: 'owned-plan', repository: 'integry/propr',
      status: 'review', updated_at: NOW,
    },
    {
      draft_id: 'refining-plan', repository: 'integry/propr',
      status: 'refining', updated_at: NOW,
    },
  ];
  const planQuery = {
    select(...columns: string[]) {
      queryTrace.push(['select', columns]);
      return this;
    },
    where(value: unknown) {
      queryTrace.push(['where', value]);
      return this;
    },
    whereIn(column: string, values: readonly string[]) {
      queryTrace.push(['whereIn', [column, values]]);
      return Promise.resolve(planRows);
    },
  };
  const database = ((table: string) => {
    queryTrace.push(['table', table]);
    return planQuery;
  }) as unknown as Knex;
  const queueStates: string[][] = [];
  const taskQueue = {
    async getJobs(states: string[]) {
      queueStates.push(states);
      if (states[0] === 'active') {
        return [
          {
            ...job('owned-active', 'Owned active task', NOW),
            name: 'processGitHubIssue',
            data: { userId: 'owner-user', repoOwner: 'integry', repoName: 'propr', number: 2139 },
          },
          job('foreign-active', 'FOREIGN ACTIVE TITLE', NOW, {
            userId: 'foreign-user',
            repository: 'foreign/private',
          }),
        ];
      }
      if (states[0] === 'waiting') {
        return [
          {
            ...job('owned-comment', 'Owned comment', NOW),
            name: 'processPullRequestComment',
            data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 2155, userId: 'owner-user' },
          },
          job('unowned-waiting', 'UNOWNED WAITING TITLE', NOW),
        ];
      }
      return [{
        ...job('foreign-system', 'FOREIGN SYSTEM TITLE', NOW),
        name: 'processSystemTask',
        data: { owner: 'foreign', repoName: 'private', requestingUser: 'someone-else' },
      }];
    },
  };
  const notificationCalls: Array<{ userId: string; cursor: string | null; limit?: number }> = [];
  const pageFourWarning = notification({
    id: 'page-four-warning',
    severity: 'warning',
    title: 'Late notification needs attention',
    target: { type: 'system_failure', component: 'notification-worker' },
    occurredAt: NOW,
  });
  const notificationService = {
    async listNotifications(userId: string, options: { cursor?: string | null; limit?: number }) {
      notificationCalls.push({
        userId,
        cursor: options.cursor ?? null,
        limit: options.limit,
      });
      return {
        notifications: options.cursor === 'page-4' ? [pageFourWarning] : [],
        unreadCount: 0,
        nextCursor: options.cursor === null
          ? 'page-2'
          : options.cursor === 'page-2'
            ? 'page-3'
            : options.cursor === 'page-3' ? 'page-4' : null,
      };
    },
  };
  const dataLoaders = createVoiceBriefingDataLoaders({
    database,
    taskQueue: taskQueue as never,
    notificationService,
  });

  const [snapshot, loadedPlans, loadedNotifications] = await Promise.all([
    dataLoaders.loadQueueJobs('owner-user'),
    dataLoaders.loadPlans('owner-user'),
    dataLoaders.loadNotifications('owner-user'),
  ]);

  assert.deepEqual(snapshot.active.map(queueJob => queueJob.id), ['owned-active']);
  assert.deepEqual(snapshot.waiting.map(queueJob => queueJob.id), ['owned-comment']);
  assert.deepEqual(snapshot.delayed, []);
  const briefing = await new VoiceBriefingService({
    loaders: loaders({
      queue: snapshot,
      plans: [...loadedPlans],
      notifications: [...loadedNotifications],
    }),
    now: () => NOW,
  }).getBriefing('owner-user');
  assert.deepEqual(briefing.counts, {
    running: 1,
    queued: 1,
    attention: 2,
    plans: 2,
    total: 5,
  });
  assert.ok(briefing.items.some(item => item.id === 'page-four-warning'));
  const serialized = JSON.stringify(briefing);
  for (const foreignValue of [
    'foreign-active',
    'FOREIGN ACTIVE TITLE',
    'foreign/private',
    'unowned-waiting',
    'UNOWNED WAITING TITLE',
    'foreign-system',
    'FOREIGN SYSTEM TITLE',
  ]) {
    assert.equal(serialized.includes(foreignValue), false);
  }
  assert.deepEqual(queueStates, [['active'], ['waiting'], ['delayed']]);
  assert.deepEqual(loadedPlans, planRows);
  assert.deepEqual(loadedNotifications, [pageFourWarning]);
  assert.deepEqual(queryTrace, [
    ['table', 'task_drafts'],
    ['select', ['draft_id', 'repository', 'status', 'updated_at']],
    ['where', { user_id: 'owner-user' }],
    ['whereIn', ['status', ['generating', 'refining', 'executing', 'review', 'approved']]],
  ]);
  assert.deepEqual(notificationCalls, [
    { userId: 'owner-user', cursor: null, limit: 100 },
    { userId: 'owner-user', cursor: 'page-2', limit: 100 },
    { userId: 'owner-user', cursor: 'page-3', limit: 100 },
    { userId: 'owner-user', cursor: 'page-4', limit: 100 },
  ]);
});
