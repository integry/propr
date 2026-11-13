import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import type { RedisClientType } from 'redis';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps, McpTool } from '../mcp/tools.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

const repository = 'acme/repo';
const ownerId = '123';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-lineage-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
process.env.NODE_ENV = 'test';
const core = await import('@propr/core');
const boundary = await mock.module('@propr/core', { namedExports: { ...core,
  loadMonitoredReposRaw: async () => [{ name: repository, enabled: true, baseBranch: 'main' }],
} });
const { McpPolicy } = await import('../mcp/policy.js');
const { McpStore } = await import('../mcp/store.js');
const { McpOAuthProvider } = await import('../mcp/oauth.js');
const { MAX_TOOL_RESULT_BYTES } = await import('../mcp/config.js');
const { createToolCatalog, executeTool } = await import('../mcp/tools.js');

after(async () => {
  boundary.restore();
  await core.closeConnection();
  await rm(root, { recursive: true, force: true });
});

async function harness() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const redisClient = withLiveOutputReads({ get: async () => null }) as unknown as RedisClientType;
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'lineage-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => {};
  const deps: ToolDeps = { db, policy, redisClient, taskQueue: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const principal = { user: { id: ownerId, username: 'tester', login: 'tester' },
    authorization: { role: 'member', source: 'local', permissions: [] }, scopes: ['read'],
    grant: { id: 'lineage-grant', ownerId, clientId: 'client', clientName: 'Lineage', instanceId: config.instanceId,
      resource: config.resource, scopes: ['read'], repositories: [repository],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;
  const tool = (name: string): McpTool => catalog.find(candidate => candidate.name === name)!;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await executeTool(tool(name), args, principal, deps);
    return { data: result.data as Json, bytes: Buffer.byteLength(JSON.stringify(result.data)) };
  };
  return { db, call };
}

test('get_task and list_tasks report automatic-replacement lineage in both directions', async () => {
  const { db, call } = await harness();
  try {
    await db('tasks').insert([
      { task_id: 'attempt-1', repository, task_type: 'issue', issue_number: 7, created_at: '2026-10-06 08:00:00',
        replaced_by_task_id: 'attempt-2', lineage_root_task_id: 'attempt-1', replacement_state: 'dispatched' },
      { task_id: 'attempt-2', repository, task_type: 'issue', issue_number: 7, created_at: '2026-10-06 09:00:00',
        replaces_task_id: 'attempt-1', attempt_number: 2, lineage_root_task_id: 'attempt-1', replacement_cause: 'provider_transient' },
      { task_id: 'single', repository, task_type: 'issue', issue_number: 8, created_at: '2026-10-06 07:00:00' },
    ]);
    await db('task_history').insert([
      { task_id: 'attempt-1', state: 'failed', reason: 'Provider returned 503', timestamp: '2026-10-06 08:30:00' },
      { task_id: 'attempt-2', state: 'processing', reason: 'started', timestamp: '2026-10-06 09:01:00' },
      { task_id: 'single', state: 'completed', reason: 'done', timestamp: '2026-10-06 07:30:00' },
    ]);

    const attempts = [
      { taskId: 'attempt-1', attemptNumber: 1, replacementCause: null, state: 'failed', createdAt: '2026-10-06 08:00:00' },
      { taskId: 'attempt-2', attemptNumber: 2, replacementCause: 'provider_transient', state: 'processing', createdAt: '2026-10-06 09:00:00' },
    ];
    const replaced = (await call('get_task', { repository, taskId: 'attempt-1' })).data;
    assert.deepEqual(replaced.lineage, {
      attemptNumber: 1, rootTaskId: 'attempt-1', replacesTaskId: null, replacedByTaskId: 'attempt-2',
      replacementCause: null, replacementState: 'dispatched', attempts,
    });
    const replacement = (await call('get_task', { repository, taskId: 'attempt-2' })).data;
    assert.deepEqual(replacement.lineage, {
      attemptNumber: 2, rootTaskId: 'attempt-1', replacesTaskId: 'attempt-1', replacedByTaskId: null,
      replacementCause: 'provider_transient', replacementState: null, attempts,
    });
    // Each side points at the other.
    assert.equal(replaced.lineage.replacedByTaskId, replacement.task_id);
    assert.equal(replacement.lineage.replacesTaskId, replaced.task_id);

    const single = (await call('get_task', { repository, taskId: 'single' })).data;
    assert.deepEqual(single.lineage, {
      attemptNumber: 1, rootTaskId: 'single', replacesTaskId: null, replacedByTaskId: null,
      replacementCause: null, replacementState: null,
    });
    assert.equal('attempts' in single.lineage, false);

    const rows = (await call('list_tasks', { repository, state: 'all' })).data.tasks as Json[];
    const byId = new Map(rows.map(row => [row.task_id, row]));
    const lineageOf = (row: Json) => ({ attemptNumber: row.attemptNumber, replacesTaskId: row.replacesTaskId, replacedByTaskId: row.replacedByTaskId });
    assert.deepEqual(lineageOf(byId.get('attempt-1')!), { attemptNumber: 1, replacesTaskId: null, replacedByTaskId: 'attempt-2' });
    assert.deepEqual(lineageOf(byId.get('attempt-2')!), { attemptNumber: 2, replacesTaskId: 'attempt-1', replacedByTaskId: null });
    // A first and only attempt keeps its compact row.
    for (const field of ['attemptNumber', 'replacesTaskId', 'replacedByTaskId']) assert.equal(field in byId.get('single')!, false, field);
  } finally { await db.destroy(); }
});

test('a full list_tasks page of replacement attempts stays within the tool result budget', async () => {
  const { db, call } = await harness();
  try {
    const long = (label: string, length: number) => `${label}-${'x'.repeat(length)}`.slice(0, length);
    const id = (index: number) => long(`task-${index}`, 120);
    const tasks = Array.from({ length: 100 }, (_, index) => ({
      task_id: id(index), repository, task_type: 'issue', issue_number: index + 1,
      created_at: `2026-10-06 08:${String(index % 60).padStart(2, '0')}:00`,
      model_name: long('model', 200), pr_number: 900 + index,
      initial_job_data: JSON.stringify({ title: long('Title', 1000), subtitle: long('Summary', 2000), agentAlias: long('agent', 200) }),
      replaces_task_id: id(index + 100), replaced_by_task_id: id(index + 200), attempt_number: 3,
      lineage_root_task_id: id(index + 100), replacement_cause: 'provider_transient',
    }));
    await db.batchInsert('tasks', tasks, 25);
    await db.batchInsert('task_history', tasks.map(task => ({
      task_id: task.task_id, state: 'failed', reason: long('Failure', 4000), timestamp: '2026-10-06 09:00:00',
    })), 25);

    const page = await call('list_tasks', { repository, state: 'all', limit: 100 });
    assert.equal(page.data.tasks.length, 100);
    assert.ok(page.data.tasks.every((row: Json) => row.attemptNumber === 3 && row.replacesTaskId && row.replacedByTaskId));
    assert.ok(page.bytes < MAX_TOOL_RESULT_BYTES, `${page.bytes} bytes`);
  } finally { await db.destroy(); }
});
