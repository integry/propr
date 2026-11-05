import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import knex, { type Knex } from 'knex';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as adminSettingsMigration } from '../../core/src/db/migrations/20260911000000_add_mcp_admin_settings.js';
import { isPrivateWindowsAccess, setPrivateKeyStorageForTests, windowsStorage, type WindowsAccess } from '../mcp/privateKeyStorage.js';
import { clearTunnelMcpKeyCache, loadTunnelMcpEncryptionKey, McpSetupError, tunnelMcpKeyPath } from '../mcp/tunnelMode.js';

const TUNNEL_ID = '0f8a2c34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const USER = 'S-1-5-21-1000-2000-3000-1001';
const USERS = 'S-1-5-32-545';

let database: Knex;
let dataDir: string;
let restore: (() => void) | undefined;

/**
 * Windows semantics over a real directory tree: POSIX mode bits carry no
 * meaning, and access comes from a DACL. Paths without an explicit DACL inherit
 * their parent's; the data directory starts with the usual broad inherited
 * entries. icacls is replaced by recording a protected, user-only DACL.
 */
function fakeWindows() {
  const acl = new Map<string, WindowsAccess>();
  const restricted: string[] = [];
  const access = (path: string): WindowsAccess => acl.get(path)
    ?? (path === dataDir ? { user: USER, owner: USER, allow: [USER, 'S-1-5-18', 'S-1-5-32-544', USERS] } : access(dirname(path)));
  const storage = windowsStorage(access, (directory, userSid) => {
    restricted.push(directory);
    acl.set(directory, { user: USER, owner: USER, allow: [userSid] });
  });
  return { acl, restricted, storage };
}

function tunnelEnv(): NodeJS.ProcessEnv {
  return { DATA_DIR: dataDir, PROPR_UI_TUNNEL_ENABLED: 'true', PROPR_INSTANCE_ID: TUNNEL_ID };
}

const isCode = (code: string) => (error: unknown) => error instanceof McpSetupError && error.code === code;

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('name'); });
  await mcpMigration(database);
  await adminSettingsMigration(database);
  dataDir = await mkdtemp(join(tmpdir(), 'propr-mcp-key-windows-'));
  clearTunnelMcpKeyCache();
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await database.destroy();
  await rm(dataDir, { recursive: true, force: true });
});

test('Windows: the key is created and reused although mode bits are synthesized, with the directory restricted to the account', async () => {
  const windows = fakeWindows();
  restore = setPrivateKeyStorageForTests(windows.storage);
  const env = tunnelEnv();
  const keyPath = tunnelMcpKeyPath(env);
  // What Windows reports for an ordinary directory and writable file.
  await mkdir(dirname(keyPath), { recursive: true });
  await chmod(dirname(keyPath), 0o777);

  const first = await loadTunnelMcpEncryptionKey(env, database);
  assert.deepEqual(windows.restricted, [dirname(keyPath)], 'the key directory is cut off from inherited access');
  assert.equal(Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64').length, 32);

  await chmod(keyPath, 0o666);
  clearTunnelMcpKeyCache();
  assert.deepEqual(await loadTunnelMcpEncryptionKey(env, database), first, 'a restart reuses the persisted key');
  assert.equal(windows.restricted.length, 1, 'reuse does not rewrite the DACL');
});

test('Windows: a key file readable by other accounts is rejected, not regenerated', async () => {
  const windows = fakeWindows();
  restore = setPrivateKeyStorageForTests(windows.storage);
  const env = tunnelEnv();
  const keyPath = tunnelMcpKeyPath(env);
  const first = await loadTunnelMcpEncryptionKey(env, database);
  const original = await readFile(keyPath, 'utf8');

  windows.acl.set(keyPath, { user: USER, owner: USER, allow: [USER, USERS] });
  clearTunnelMcpKeyCache();
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), isCode('KEY_STORAGE_INVALID'));
  assert.equal(await readFile(keyPath, 'utf8'), original);

  windows.acl.set(keyPath, { user: USER, owner: USERS, allow: [USER] });
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), isCode('KEY_STORAGE_INVALID'), 'another owner can rewrite the DACL');

  windows.acl.delete(keyPath);
  assert.deepEqual(await loadTunnelMcpEncryptionKey(env, database), first);
});

test('Windows: a directory that stays shared after restriction never receives a key', async () => {
  const storage = windowsStorage(() => ({ user: USER, owner: USER, allow: [USER, USERS] }), () => {});
  restore = setPrivateKeyStorageForTests(storage);
  const env = tunnelEnv();
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), isCode('KEY_STORAGE_INVALID'));
  await assert.rejects(stat(tunnelMcpKeyPath(env)), { code: 'ENOENT' });
});

test('Windows access is private only for the account, SYSTEM and Administrators', () => {
  assert.equal(isPrivateWindowsAccess({ user: USER, owner: USER, allow: [USER] }), true);
  assert.equal(isPrivateWindowsAccess({ user: USER, owner: 'S-1-5-32-544', allow: [USER, 'S-1-5-18', 'S-1-5-32-544'] }), true);
  assert.equal(isPrivateWindowsAccess({ user: USER, owner: USER, allow: [USER, 'S-1-1-0'] }), false, 'Everyone');
  assert.equal(isPrivateWindowsAccess({ user: USER, owner: USER, allow: [USER, 'S-1-5-11'] }), false, 'Authenticated Users');
  assert.equal(isPrivateWindowsAccess({ user: USER, owner: 'S-1-5-21-1000-2000-3000-1002', allow: [USER] }), false, 'another account owns it');
});

test('POSIX keeps the exact owner-only mode checks', async () => {
  const env = tunnelEnv();
  const keyPath = tunnelMcpKeyPath(env);
  await loadTunnelMcpEncryptionKey(env, database);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(keyPath))).mode & 0o777, 0o700);
  await chmod(keyPath, 0o644);
  clearTunnelMcpKeyCache();
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), isCode('KEY_STORAGE_INVALID'));
});
