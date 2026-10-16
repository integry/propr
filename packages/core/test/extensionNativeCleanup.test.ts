import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ExtensionTestResources } from './helpers/extensionTestResources.js';
import { resolveExtensionEndpoint } from '../src/extensions/endpointPolicy.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const profiles = 'packages/core/test/extensionProfiles.test.ts';
// This is a new test runner, not an IPC child of the enclosing node:test runner.
const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
delete childEnv.NODE_TEST_CONTEXT;

// Natural child exit is the assertion: no process.exit(), force-exit flag,
// skipped native tests or accepted signals. Timeout and abort reject run().
test('the native extension suite exits normally in a fresh process', async () => {
  const { stdout, stderr } = await run(process.execPath, [
    '--import', 'tsx', '--experimental-test-module-mocks', '--test-reporter=tap', '--test', profiles,
  ], { cwd: root, env: childEnv, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.match(stdout, /# fail 0\b/);
  assert.match(stdout, /# skipped 0\b/);
  assert.match(stdout, /native durable instance-admin CRUD/);
  assert.match(stdout, /synthetic HTTPS MCP enforces TLS/);
  assert.doesNotMatch(stderr, /Assertion failed|RemoveEnvironmentCleanupHook/);
});

test('closed SQLite statements survive I/O-driven GC and natural worker/process teardown', async () => {
  const { stdout } = await run(process.execPath, ['packages/core/test/fixtures/extensionSqliteLifecycle.mjs'], {
    cwd: root, env: childEnv, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /SQLite process and worker cleanup complete/);
});

test('failed fixture cleanup still releases every database and pool', async () => {
  const resources = new ExtensionTestResources();
  const database = resources.database();
  const connection = await database.client.acquireConnection();
  await database.client.releaseConnection(connection);
  resources.defer(() => { throw new Error('synthetic release failure'); });
  await assert.rejects(resources.close(), (error: AggregateError) => {
    assert.deepEqual(error.errors.map(error => error.message), ['synthetic release failure']); return true;
  });
  assert.equal(connection.open, false);
  assert.equal(database.client.pool, undefined);
});

test('DNS deadline timers are cleared after successful and failed lookup', async t => {
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  let expire: (() => void) | undefined;
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    expire = args[0] as () => void;
    const timer = set(...args); scheduled.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
    scheduled.delete(timer); clear(timer);
  });
  await resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(scheduled.size, 0);
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', async () => { throw new Error('synthetic DNS failure'); }), /synthetic DNS failure/);
  assert.equal(scheduled.size, 0);
  const timeout = resolveExtensionEndpoint('https://tools.example.com/mcp', async () => new Promise(() => {}));
  expire!();
  await assert.rejects(timeout, /Endpoint DNS timeout/);
  assert.equal(scheduled.size, 0);
});
