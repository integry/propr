import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection, type RepoToMonitor } from '@propr/core';
import { parseNotification, trustedPreviewMedia, type Notification } from '@propr/shared';
import { createPreviewMediaReader, goalPreviewSource, projectNotificationPreviews, taskPreviewSource } from '../services/previewMediaProjection.js';
import { createRepositoryMediaRoutes } from '../routes/repositoryMediaRoutes.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';

after(closeConnection);
const url = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const body = (prefix: string) => `![unmarked](${url('ignored')})\n<!-- propr-visual-preview -->\n${Array.from({ length: 5 }, (_, i) => `### ${prefix} ${i}\n\n![Preview](${url(`${prefix}-${i}`)})\n`).join('\n')}`;
function fixture() {
  let repos = [
    { name: 'Acme/Web', enabled: true, baseBranch: 'main', visualPreview: { enabled: false, types: ['image'] } },
    { name: 'acme/web', enabled: true, baseBranch: 'dev', visualPreview: { enabled: true, types: ['image'] } },
    { name: 'acme/legacy', enabled: true },
  ] as RepoToMonitor[];
  const calls: number[] = [];
  const reader = createPreviewMediaReader({ loadRepos: async () => repos, getOctokit: async () => ({
    request: async (_route: string, params: { pull_number: number }) => {
      calls.push(params.pull_number);
      if (params.pull_number === 99) throw new Error('GitHub unavailable');
      return { data: { body: body(String(params.pull_number)) } };
    },
  }) as never });
  return { reader, calls, disable: () => { repos = []; } };
}

test('batch projections preserve branch-sharing, gate cached media, deduplicate reads and truncate rows', async () => {
  const { reader, calls, disable } = fixture();
  const sources = [
    { repository: ' ACME/Web ', prNumbers: [1, 1] },
    { repository: 'acme/web', prNumbers: [1] },
    { repository: 'acme/legacy', prNumbers: [2] },
    { repository: 'acme/disabled', prNumbers: [3] },
  ];
  const media = await reader.project(sources);
  assert.deepEqual(media.map(item => item.previews.length), [3, 3, 0, 0]);
  assert.deepEqual(calls, [1]);
  await reader.project(sources);
  assert.deepEqual(calls, [1]);
  disable();
  assert.deepEqual((await reader.project(sources)).map(item => item.previews), [[], [], [], []]);
  assert.deepEqual(calls, [1]);
});

test('strict published parser rejects unmarked, local, and untrusted Markdown; errors remain optional', async () => {
  const { reader } = fixture();
  assert.equal((await reader.project([{ repository: 'acme/web', prNumbers: [99] }]))[0].unavailable, true);
  const unsafe = createPreviewMediaReader({ loadRepos: async () => [{ name: 'acme/web', enabled: true, visualPreview: { enabled: true, types: ['image'] } }],
    getOctokit: async () => ({ request: async () => ({ data: { body: `![outside](${url('outside')})\n<!-- propr-visual-preview -->\n### Local\n\n![Local](.propr/previews/desktop.png)\n### Evil\n\n![Evil](https://evil.test/preview.png)\n### Query\n\n![Query](${url('query')}?secret=yes)\n### Valid\n\n![Image](${url('valid')})` } }) }) as never });
  assert.deepEqual((await unsafe.project([{ repository: 'acme/web', prNumbers: [1] }]))[0].previews.map(item => item.url), [url('valid')]);
  assert.deepEqual(trustedPreviewMedia([{ title: 'Evil', type: 'image', url: 'https://github.com.evil.test/user-attachments/assets/x' }]), []);
});

const notification = (kind = 'task', severity = 'success') => ({
  id: 'event-1', deduplicationKey: 'event-1', kind, severity,
  target: { type: kind, repository: 'acme/web', taskId: 'task-1', prNumber: 1 },
  title: 'Implementation completed', body: 'Ready to review', actions: ['dismiss'],
  occurredAt: '2026-09-13T12:00:00.000Z', createdAt: '2026-09-13T12:00:00.000Z', readAt: null, dismissedAt: null,
}) as Notification;

test('Inbox projects one preview only for completed tasks and shared parsing preserves the bounded trusted field', async () => {
  const { reader, disable } = fixture();
  const media = await projectNotificationPreviews([notification(), notification('task', 'error'), notification('review')], reader);
  assert.equal(media[0].previewMedia?.length, 1);
  assert.equal(parseNotification(media[0]).previewMedia?.length, 1);
  assert.equal(media[1].previewMedia, undefined);
  assert.equal(media[2].previewMedia, undefined);
  const overfull = Array.from({ length: 5 }, (_, i) => ({ title: `Image ${i}`, type: 'image', url: url(String(i)) }));
  assert.equal(parseNotification({ ...notification(), previewMedia: overfull }).previewMedia?.length, 1);
  assert.equal(parseNotification({ ...notification('task', 'error'), previewMedia: overfull }).previewMedia, undefined);
  disable();
  assert.equal((await projectNotificationPreviews(media, reader))[0].previewMedia, undefined);
});

test('artifact sources use stored PR identities, including final results, and ignore cross-repository goal artifacts', () => {
  assert.deepEqual(taskPreviewSource({ repository: 'acme/web', final_result: JSON.stringify({ postProcessing: { pr: { number: 7 } } }) }).prNumbers, [7]);
  assert.deepEqual(goalPreviewSource({ repository: 'acme/web', final_pr_number: 7, artifact_refs: JSON.stringify([
    { type: 'pull_request', number: 8, url: 'https://github.com/acme/web/pull/8' },
    { type: 'pull_request', number: 9, url: 'https://github.com/other/repo/pull/9' },
  ]) }).prNumbers, [7, 8]);
});

function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: Record<string, unknown>) { state.body = body; } } as Response;
  return { res, state };
}

test('repository gallery scopes tasks and owned goals, paginates, reports empty/unavailable, and skips disabled reads', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { reader, calls, disable } = fixture();
  try {
    await db.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type'); table.integer('pr_number');
      table.text('initial_job_data'); table.text('final_result'); table.string('created_at');
    });
    await db.schema.createTable('goals', table => {
      table.string('goal_id'); table.string('owner_id'); table.string('repository'); table.integer('final_pr_number');
      table.text('artifact_refs'); table.string('created_at');
    });
    await db('tasks').insert(Array.from({ length: 25 }, (_, i) => ({ task_id: String(i), repository: 'acme/web', pr_number: 1, created_at: '2026-09-13' })));
    await db('tasks').insert({ task_id: 'foreign', repository: 'other/repo', pr_number: 80 });
    await db('tasks').insert({ task_id: 'private-goal-task', repository: 'acme/web', task_type: 'goal', pr_number: 81 });
    await db('goals').insert([
      { goal_id: 'owned', owner_id: 'alice', repository: 'acme/web', final_pr_number: 2 },
      { goal_id: 'private', owner_id: 'bob', repository: 'acme/web', final_pr_number: 82 },
      { goal_id: 'failed-read', owner_id: 'alice', repository: 'acme/web', final_pr_number: 99 },
    ]);
    const route = createRepositoryMediaRoutes({ db, reader }).getMedia;
    const req = { user: { id: 'alice' }, query: { repository: 'acme/web' } } as unknown as Request;
    const first = response(); await route(req, first.res);
    assert.ok(Array.isArray(first.state.body.previews));
    assert.equal(first.state.body.previews.length, 10);
    assert.equal(first.state.body.unavailable, true);
    assert.equal(first.state.body.nextOffset, 24);
    assert.deepEqual([...calls].sort((a, b) => a - b), [1, 2, 99]);
    const last = response(); await route({ ...req, query: { ...req.query, offset: '24' } } as Request, last.res);
    assert.equal(last.state.body.nextOffset, null);
    disable();
    const disabled = response(); await route(req, disabled.res);
    assert.deepEqual(disabled.state.body, { previews: [], nextOffset: null });
    const unauthenticated = response(); await route({ ...req, user: undefined } as Request, unauthenticated.res);
    assert.equal(unauthenticated.state.status, 401);
    const invalid = response(); await route({ ...req, query: { repository: '../web' } } as Request, invalid.res);
    assert.equal(invalid.state.status, 400);
  } finally { await db.destroy(); }
});

test('task list includes bounded media in the existing response and omits it after disabling', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { reader, disable } = fixture();
  try {
    await db.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type'); table.integer('pr_number');
      table.text('initial_job_data'); table.text('final_result'); table.string('created_at'); table.integer('issue_number');
    });
    await db.schema.createTable('task_history', table => { table.string('task_id'); table.string('state'); table.string('timestamp'); table.string('reason'); });
    await db.schema.createTable('plan_issues', table => { table.string('task_id'); table.string('status'); });
    await db.schema.createTable('llm_executions', table => { table.string('task_id'); table.string('execution_id'); table.text('analysis_report'); });
    await db('tasks').insert({ task_id: 'task-1', repository: 'acme/web', pr_number: 1, created_at: '2026-09-13' });
    await db('task_history').insert({ task_id: 'task-1', state: 'completed', timestamp: '2026-09-13' });
    const olderNotification = notification();
    if (olderNotification.kind === 'task') delete olderNotification.target.prNumber;
    const inbox = await projectNotificationPreviews([olderNotification], reader, db);
    assert.equal(inbox[0].previewMedia?.length, 1);
    const query = { db, previewReader: reader, status: 'all', repository: 'all', offset: 0, limit: 10 };
    const result = await getTasksFromDb(query);
    assert.equal((result.tasks[0] as { previewMedia: unknown[] }).previewMedia.length, 3);
    disable();
    const disabled = await getTasksFromDb(query);
    assert.equal('previewMedia' in (disabled.tasks[0] as object), false);
  } finally { await db.destroy(); }
});
