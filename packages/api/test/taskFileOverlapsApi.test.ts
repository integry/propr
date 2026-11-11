import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import type { RedisClientType } from 'redis';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

const root = await mkdtemp(path.join(tmpdir(), 'propr-file-overlaps-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
process.env.NODE_ENV = 'test';
const core = await import('@propr/core');
// The route's own file-changes cache read opens a connection of its own; serve it from the fixture.
const storedFileChanges = new Map<string, unknown>();
mock.module('@propr/core', { namedExports: { ...core, getStoredFileChanges: async (taskId: string) => storedFileChanges.get(taskId) ?? null } });
const { createFileChangesRoutes } = await import('../routes/fileChangesRoutes.js');
const { taskDetail } = await import('../mcp/goalTaskDetail.js');
after(() => core.db.destroy());

const repository = 'acme/widget';
const now = Date.now();
const strings = new Map<string, string>();
const scores = new Map<string, number>([['task-a', now], ['task-b', now]]);
const activeKey = core.activeFileChangesTasksKey(repository);
const redisClient = withLiveOutputReads({
  get: async (key: string) => strings.get(key) ?? null,
  zScore: async (key: string, member: string) => (key === activeKey ? scores.get(member) ?? null : null),
}) as unknown as RedisClientType;

const overlap = { taskId: 'task-b', paths: ['src/shared.ts'], totalPaths: 1, repository, issueNumber: 22, taskType: 'issue' };
strings.set('task:file-overlaps:task-a', JSON.stringify({ repository, computedAt: new Date(now).toISOString(), overlaps: [overlap] }));

async function fileChangesResponse(deps: Parameters<typeof createFileChangesRoutes>[0], taskId: string) {
  let body: unknown;
  await createFileChangesRoutes(deps).getFileChanges(
    { params: { taskId } } as never,
    { json: (value: unknown) => { body = value; }, status: () => ({ json: (value: unknown) => { body = value; } }) } as never,
  );
  return body as { files: unknown[]; overlaps: unknown[] };
}

test('the task file-changes API returns current overlaps beside the files', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  after(() => db.destroy());
  await db.schema.createTable('tasks', table => { table.string('task_id'); table.string('commit_hash'); table.string('repository'); });
  storedFileChanges.set('task-a', { taskId: 'task-a', lastUpdated: '', files: [{ path: 'src/shared.ts', linesAdded: 1, linesRemoved: 0, diff: '', status: 'modified' }] });

  const response = await fileChangesResponse({ db, redisClient, normalizeJobReferences: false }, 'task-a');
  assert.equal(response.files.length, 1);
  assert.deepEqual(response.overlaps, [overlap]);
  // No stored changes still answers with an (empty) overlaps field; a server without Redis reports none.
  assert.deepEqual((await fileChangesResponse({ db, redisClient, normalizeJobReferences: false }, 'task-none')).overlaps, []);
  assert.deepEqual((await fileChangesResponse({ db, normalizeJobReferences: false }, 'task-a')).overlaps, []);

  // Once the other task stops capturing, the overlap is no longer current.
  scores.set('task-b', now - 10 * 60_000);
  assert.deepEqual((await fileChangesResponse({ db, redisClient, normalizeJobReferences: false }, 'task-a')).overlaps, []);
  scores.set('task-b', now);
});

test('MCP get_task detail exposes fileOverlaps', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('tasks').insert([{ task_id: 'task-a', repository, task_type: 'issue', issue_number: 11 }, { task_id: 'task-c', repository, task_type: 'issue' }]);
  await db('task_history').insert({ task_id: 'task-a', state: 'claude_execution', timestamp: new Date(now).toISOString() });
  const detail = await taskDetail({ db, redisClient }, { repository, taskId: 'task-a' }, '1', async () => undefined);
  assert.deepEqual(detail.fileOverlaps, [overlap]);
  assert.deepEqual((await taskDetail({ db, redisClient }, { repository, taskId: 'task-c' }, '1', async () => undefined)).fileOverlaps, []);
});
