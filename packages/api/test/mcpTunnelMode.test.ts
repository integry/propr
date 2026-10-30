import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex, { type Knex } from 'knex';
import { proprInstanceProxyUrl } from '@propr/shared';
import { closeConnection } from '@propr/core';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as adminSettingsMigration } from '../../core/src/db/migrations/20260911000000_add_mcp_admin_settings.js';
import { loadMcpConfig } from '../mcp/config.js';
import { invalidateMcpConfigCache, loadHostedTunnelMcpConfig, resolveMcpConfig, resolveMcpStatus, saveMcpAdminSettingRows } from '../mcp/configResolver.js';
import { registerMcpInstance, type InstanceIdentity } from '../mcp/connect.js';
import { connectRegistrationRetryDelayMs, startConnectMcpRegistration, CONNECT_REGISTRATION_REFRESH_MS } from '../mcp/connectRegistration.js';
import { McpStore } from '../mcp/store.js';
import { clearTunnelMcpKeyCache, deriveTunnelMcpEnvironment, isHostedTunnelMode, loadTunnelMcpEncryptionKey, McpSetupError, setConnectMcpState, tunnelMcpKeyPath } from '../mcp/tunnelMode.js';
import { configureDemoMode } from '../demoMode.js';

const TUNNEL_ID = '0f8a2c34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const RELAY = `prt_${'r'.repeat(43)}`;

let database: Knex;
let dataDir: string;
const nativeFetch = globalThis.fetch;

function tunnelEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { DATA_DIR: dataDir, PROPR_UI_TUNNEL_ENABLED: 'true', PROPR_INSTANCE_ID: TUNNEL_ID,
    GH_INSTALLATION_ID: '42', PROPR_GH_RELAY_TOKEN: RELAY, ...overrides };
}

/** A Connect stand-in that accepts every registration and records it. */
function stubConnect(respond: (body: Record<string, unknown>) => Response | Promise<Response> = body => Response.json({
  registered: true, instance_id: body.instance_id, audience: `urn:propr:instance:${body.instance_id as string}:mcp`, contract_version: 'propr-connect-mcp/1',
})) {
  const registrations: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://mcp.propr.dev/v1/mcp/instances/register');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${RELAY}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    registrations.push(body);
    return respond(body);
  }) as typeof fetch;
  return registrations;
}

function fakeTimers() {
  const scheduled: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  return {
    scheduled,
    setTimer: (callback: () => void, ms: number) => { const entry = { callback, ms, cleared: false }; scheduled.push(entry); return entry; },
    clearTimer: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
    pending: () => scheduled.filter(entry => !entry.cleared),
  };
}

const quietLogger = { info() {}, warn() {} };

after(closeConnection);

beforeEach(async () => {
  configureDemoMode(false);
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('name'); });
  await mcpMigration(database);
  await adminSettingsMigration(database);
  dataDir = await mkdtemp(join(tmpdir(), 'propr-mcp-tunnel-'));
  clearTunnelMcpKeyCache();
  invalidateMcpConfigCache();
  setConnectMcpState('disabled');
});

afterEach(async () => {
  globalThis.fetch = nativeFetch;
  await database.destroy();
  await rm(dataDir, { recursive: true, force: true });
});

test('tunnel mode derives the public origin, instance id and Connect trust from the tunnel setup', async () => {
  const env = tunnelEnv();
  assert.equal(isHostedTunnelMode(env), true);
  const config = await loadHostedTunnelMcpConfig(database, env);
  // The same derivation as the tunnel-mode API_PUBLIC_URL, so they cannot drift.
  assert.equal(config.origin, proprInstanceProxyUrl(TUNNEL_ID));
  assert.equal(config.origin, `https://t-${TUNNEL_ID}.propr.dev`);
  assert.equal(config.resource, `https://t-${TUNNEL_ID}.propr.dev/api/mcp`);
  assert.equal(config.instanceId, TUNNEL_ID);
  assert.equal(config.encryptionKey.length, 32);
  assert.deepEqual(config.connect, { issuer: 'https://mcp.propr.dev', jwks: 'https://mcp.propr.dev/.well-known/jwks.json',
    resource: 'https://mcp.propr.dev/mcp', installationId: 42, tunnelId: TUNNEL_ID, relayToken: RELAY });
  // The tunnel token stays with the cloudflared sidecar; tunnel mode does not need it.
  assert.equal(env.PROPR_UI_TUNNEL_TOKEN, undefined);

  // Default-on, under the Settings scope ceiling.
  const resolved = await resolveMcpConfig(database, env);
  assert.equal(resolved?.instanceId, TUNNEL_ID);
  assert.deepEqual(resolved?.scopeCeiling, ['read', 'plan', 'review']);
  const status = await resolveMcpStatus(database, env);
  assert.equal(status.enabled, true);
  assert.equal(status.tunnelMode, true);
  assert.equal(status.connectEnabled, true);
  assert.equal(status.connectResource, 'https://mcp.propr.dev/mcp');
  assert.equal(status.operatorForced, undefined);
  assert.ok(!JSON.stringify(status).includes(config.encryptionKey.toString('base64')), 'status never carries the key');
});

test('explicit MCP values override every derived value', async () => {
  const key = randomBytes(32);
  const env = tunnelEnv({ MCP_PUBLIC_ORIGIN: 'https://mcp-instance.example', MCP_INSTANCE_ID: 'explicit-instance-identity-0001',
    MCP_ENCRYPTION_KEY: key.toString('base64'), MCP_CONNECT_TUNNEL_ID: 'tunnel-explicit', MCP_CONNECT_ISSUER: 'https://connect.example' });
  const config = await loadHostedTunnelMcpConfig(database, env);
  assert.equal(config.origin, 'https://mcp-instance.example');
  assert.equal(config.instanceId, 'explicit-instance-identity-0001');
  assert.deepEqual(config.encryptionKey, key);
  assert.equal(config.connect?.tunnelId, 'tunnel-explicit');
  assert.equal(config.connect?.issuer, 'https://connect.example');
  await assert.rejects(stat(tunnelMcpKeyPath(env)), { code: 'ENOENT' }, 'an explicit key never creates a persisted one');

  // An explicit MCP_CONNECT_TRUST=false opts out of Connect.
  const noTrust = await loadHostedTunnelMcpConfig(database, tunnelEnv({ MCP_CONNECT_TRUST: 'false', MCP_ENCRYPTION_KEY: key.toString('base64') }));
  assert.equal(noTrust.connect, undefined);
  assert.equal(deriveTunnelMcpEnvironment(tunnelEnv({ MCP_CONNECT_TRUST: 'false' })).MCP_CONNECT_TRUST, 'false');
});

test('the encryption key is generated once, persisted owner-only, and reused', async () => {
  const env = tunnelEnv();
  const first = await loadTunnelMcpEncryptionKey(env, database);
  const path = tunnelMcpKeyPath(env);
  assert.equal(path, join(dataDir, 'mcp', 'encryption-key'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDir, 'mcp'))).mode & 0o777, 0o700);
  clearTunnelMcpKeyCache();
  const second = await loadTunnelMcpEncryptionKey(env, database);
  assert.deepEqual(second, first, 'a restart reuses the persisted key');
  const config = await loadHostedTunnelMcpConfig(database, env);
  assert.deepEqual(config.encryptionKey, first);
});

test('a missing or replaced persisted key after first use is a setup error, never a new key', async () => {
  const env = tunnelEnv();
  await loadTunnelMcpEncryptionKey(env, database);
  const path = tunnelMcpKeyPath(env);
  await unlink(path);
  clearTunnelMcpKeyCache();
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), (error: unknown) => error instanceof McpSetupError && error.code === 'KEY_MISSING');
  await assert.rejects(stat(path), { code: 'ENOENT' }, 'no replacement key is written');

  await writeFile(path, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), (error: unknown) => error instanceof McpSetupError && error.code === 'KEY_CHANGED');

  // The resolver reports the code instead of failing open or regenerating.
  const resolved = await resolveMcpConfig(database, env);
  assert.equal(resolved, null);
  const status = await resolveMcpStatus(database, env);
  assert.equal(status.enabled, false);
  assert.equal(status.setupError, 'KEY_CHANGED');
});

test('a Connect identity created under an earlier key also blocks generating a new key', async () => {
  const env = tunnelEnv();
  await database('mcp_records').insert({ kind: 'connect_identity', id: 'instance', value: 'sealed-under-an-earlier-key' });
  await assert.rejects(loadTunnelMcpEncryptionKey(env, database), (error: unknown) => error instanceof McpSetupError && error.code === 'KEY_MISSING');
});

test('automatic registration is idempotent and reports registered', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv();
  const timers = fakeTimers();
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...timers });
  try {
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].instance_id, TUNNEL_ID);
    assert.equal(registrations[0].tunnel_id, TUNNEL_ID);
    assert.equal(manager.scheduledDelayMs(), CONNECT_REGISTRATION_REFRESH_MS, 'a fresh registration is refreshed daily');
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 1, 'a current registration is not sent again');
    assert.equal((await resolveMcpStatus(database, env)).connectMcp, 'registered');
  } finally { manager.stop(); }
});

test('a stale registration is refreshed with the same identity', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv();
  let clock = 1_000_000;
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, now: () => clock, ...fakeTimers() });
  try {
    await manager.trigger();
    clock = Date.now() + CONNECT_REGISTRATION_REFRESH_MS + 1;
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 2);
    assert.deepEqual(registrations[1].public_jwk, registrations[0].public_jwk, 'refresh reuses the persisted key');
  } finally { manager.stop(); }
});

test('a changed tunnel id re-registers', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv({ MCP_INSTANCE_ID: 'explicit-instance-identity-0001' });
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try {
    await manager.trigger();
    env.PROPR_INSTANCE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
    invalidateMcpConfigCache();
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 2);
    assert.equal(registrations[1].tunnel_id, 'a1b2c3d4-0000-4000-8000-000000000001');
    assert.deepEqual(registrations[1].public_jwk, registrations[0].public_jwk, 'an explicit instance id keeps its identity');
  } finally { manager.stop(); }
});

test('a re-provisioned tunnel with a derived instance id registers a new identity', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv();
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try {
    await manager.trigger();
    env.PROPR_INSTANCE_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
    invalidateMcpConfigCache();
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 2);
    assert.equal(registrations[1].instance_id, 'a1b2c3d4-0000-4000-8000-000000000002');
    assert.equal(registrations[1].tunnel_id, 'a1b2c3d4-0000-4000-8000-000000000002');
  } finally { manager.stop(); }
});

test('registration failures back off exponentially, then recover', async () => {
  let available = false;
  const registrations = stubConnect(body => available
    ? Response.json({ registered: true, instance_id: body.instance_id, audience: `urn:propr:instance:${body.instance_id as string}:mcp`, contract_version: 'propr-connect-mcp/1' })
    : new Response('unavailable', { status: 503 }));
  const timers = fakeTimers();
  const manager = startConnectMcpRegistration({ database, env: tunnelEnv(), logger: quietLogger, ...timers });
  try {
    assert.equal(await manager.trigger(), 'failed:CONNECT_UNAVAILABLE');
    assert.equal(manager.scheduledDelayMs(), 5_000);
    timers.pending().at(-1)!.callback();
    await manager.trigger();
    assert.equal(manager.scheduledDelayMs(), 20_000, 'third consecutive failure');
    assert.deepEqual([1, 2, 3, 4].map(connectRegistrationRetryDelayMs), [5_000, 10_000, 20_000, 40_000]);
    assert.equal(connectRegistrationRetryDelayMs(30), 15 * 60 * 1000, 'capped');
    available = true;
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(manager.scheduledDelayMs(), CONNECT_REGISTRATION_REFRESH_MS, 'success resets the backoff');
    assert.equal(registrations.length, 4);
  } finally { manager.stop(); }
});

test('a Connect rejection (409) of request traffic forces re-registration', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv();
  let clock = 1_000_000;
  const timers = fakeTimers();
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, now: () => clock, ...timers });
  try {
    await manager.trigger();
    const config = (await resolveMcpConfig(database, env))!;
    const { McpConnect } = await import('../mcp/connect.js');
    globalThis.fetch = (async () => new Response('', { status: 409 })) as typeof fetch;
    await assert.rejects(new McpConnect(config, new McpStore(database, config.encryptionKey)).online('/v1/mcp/delegations/validate', 'delegation'));
    assert.equal(manager.scheduledDelayMs(), 60_000, 'a rejection right after registering waits instead of looping');
    const resumed = stubConnect();
    clock += 60_000;
    timers.pending().at(-1)!.callback();
    await manager.trigger();
    assert.equal(registrations.length, 1);
    assert.equal(resumed.length, 1, 'the rejected registration is sent again');
  } finally { manager.stop(); }
});

test('a 409 keeps forcing registration through transient failures until one succeeds', async () => {
  let available = true;
  let rejectDuringRequest: (() => Promise<void>) | undefined;
  const registrations = stubConnect(async body => { await rejectDuringRequest?.(); rejectDuringRequest = undefined; return available
    ? Response.json({ registered: true, instance_id: body.instance_id, audience: `urn:propr:instance:${body.instance_id as string}:mcp`, contract_version: 'propr-connect-mcp/1' })
    : new Response('unavailable', { status: 503 }); });
  const env = tunnelEnv();
  let clock = Date.now();
  const timers = fakeTimers();
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, now: () => clock, ...timers });
  try {
    await manager.trigger();
    const config = (await resolveMcpConfig(database, env))!;
    const { McpConnect } = await import('../mcp/connect.js');
    const reject = async () => {
      const stub = globalThis.fetch;
      globalThis.fetch = (async () => new Response('', { status: 409 })) as typeof fetch;
      try { await assert.rejects(new McpConnect(config, new McpStore(database, config.encryptionKey)).online('/v1/mcp/delegations/validate', 'delegation')); }
      finally { globalThis.fetch = stub; }
    };
    await reject();
    available = false;
    clock += 60_000;
    assert.equal(await manager.trigger(), 'registered', 'the fresh receipt stays usable while Connect is unavailable');
    assert.equal(registrations.length, 2);
    assert.equal(manager.scheduledDelayMs(), 5_000, 'a short retry, not the daily refresh');
    available = true;
    clock += 5_000;
    // The callback starts the check; trigger() joins it (its coalesced rerun sends nothing once registered).
    timers.pending().at(-1)!.callback();
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 3, 'the timer-driven retry registers again despite the fresh receipt');
    assert.equal(manager.scheduledDelayMs(), CONNECT_REGISTRATION_REFRESH_MS);
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 3, 'success clears the obligation');
    // A rejection during the awaited request may postdate it, so it survives that success.
    await reject();
    clock += 60_000;
    rejectDuringRequest = reject;
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(registrations.length, 4);
    assert.equal(manager.scheduledDelayMs(), 60_000, 'the success keeps the newer rejection\'s cooldown, not the daily refresh');
    clock += 60_000;
    timers.pending().at(-1)!.callback();
    for (let tick = 0; tick < 100 && registrations.length < 5; tick += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(registrations.length, 5, 'the newer rejection still forces a registration through the timer');
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(manager.scheduledDelayMs(), CONNECT_REGISTRATION_REFRESH_MS);
  } finally { manager.stop(); }
});

test('a Connect identity the explicit key cannot decrypt is never replaced', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv({ MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const first = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try { assert.equal(await first.trigger(), 'registered'); } finally { first.stop(); }
  const before = await database('mcp_records').where({ kind: 'connect_identity', id: 'instance' }).first<{ value: string }>('value');
  env.MCP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  invalidateMcpConfigCache();
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try { assert.equal(await manager.trigger(), 'failed:KEY_CHANGED'); } finally { manager.stop(); }
  const config = (await resolveMcpConfig(database, env))!;
  await assert.rejects(registerMcpInstance(config, new McpStore(database, config.encryptionKey), { replaceIdentity: true }), { code: 'KEY_CHANGED' });
  const afterwards = await database('mcp_records').where({ kind: 'connect_identity', id: 'instance' }).first<{ value: string }>('value');
  assert.equal(afterwards?.value, before?.value, 'the original identity is preserved');
  assert.equal(registrations.length, 1, 'nothing is sent to Connect');
});

test('the Settings toggle disables MCP through Connect, and MCP_ENABLED=false forces it off', async () => {
  const registrations = stubConnect();
  const env = tunnelEnv();
  await saveMcpAdminSettingRows({ connect_enabled: 'false' }, database);
  assert.equal(await resolveMcpConfig(database, env), null);
  const status = await resolveMcpStatus(database, env);
  assert.equal(status.enabled, false);
  assert.equal(status.connectEnabled, false);
  assert.equal(status.setupError, undefined);
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try {
    assert.equal(await manager.trigger(), 'disabled');
    assert.equal(registrations.length, 0);
    await assert.rejects(stat(tunnelMcpKeyPath(env)), { code: 'ENOENT' }, 'turned off before first use creates no key');

    await saveMcpAdminSettingRows({ connect_enabled: 'true' }, database);
    invalidateMcpConfigCache();
    assert.equal(await manager.trigger(), 'registered');
  } finally { manager.stop(); }

  invalidateMcpConfigCache();
  const forcedOff = tunnelEnv({ MCP_ENABLED: 'false' });
  assert.equal(await resolveMcpConfig(database, forcedOff), null);
  assert.equal((await resolveMcpStatus(database, forcedOff)).operatorForced, 'off');
  const offManager = startConnectMcpRegistration({ database, env: forcedOff, logger: quietLogger, ...fakeTimers() });
  try { assert.equal(await offManager.trigger(), 'disabled'); } finally { offManager.stop(); }
});

test('MCP_ENABLED=true in tunnel mode is operator-managed and still derives unset values', async () => {
  const env = tunnelEnv({ MCP_ENABLED: 'true' });
  await saveMcpAdminSettingRows({ connect_enabled: 'false' }, database);
  const config = await resolveMcpConfig(database, env);
  assert.equal(config?.origin, `https://t-${TUNNEL_ID}.propr.dev`);
  assert.equal(config?.scopeCeiling, undefined);
  assert.equal((await resolveMcpStatus(database, env)).operatorForced, 'on');
});

test('outside tunnel mode nothing changes', async () => {
  const registrations = stubConnect();
  for (const env of [
    { DATA_DIR: dataDir },
    { DATA_DIR: dataDir, PROPR_UI_TUNNEL_ENABLED: 'false', PROPR_INSTANCE_ID: TUNNEL_ID },
    { DATA_DIR: dataDir, PROPR_UI_TUNNEL_ENABLED: 'true' },
  ] as NodeJS.ProcessEnv[]) {
    invalidateMcpConfigCache();
    assert.equal(isHostedTunnelMode(env), false);
    assert.equal(await resolveMcpConfig(database, env), null, 'the UI-managed path stays off by default');
    const status = await resolveMcpStatus(database, env);
    assert.equal(status.tunnelMode, undefined);
    const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
    try { assert.equal(await manager.trigger(), 'disabled'); } finally { manager.stop(); }
  }
  assert.equal(registrations.length, 0);
  await assert.rejects(stat(join(dataDir, 'mcp')), { code: 'ENOENT' });
  // The explicit settings are still required, including the tunnel token.
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'true' }), /MCP_PUBLIC_ORIGIN/);
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://instance.example', MCP_INSTANCE_ID: 'explicit-instance-identity-0001',
    MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MCP_CONNECT_TRUST: 'true', GH_INSTALLATION_ID: '42', PROPR_GH_RELAY_TOKEN: RELAY,
    PROPR_INSTANCE_ID: TUNNEL_ID, PROPR_UI_TUNNEL_ENABLED: 'true' }), /enabled configured UI tunnel/);
});

test('manual registration outside tunnel mode is only reported, never performed automatically', async () => {
  const registrations = stubConnect();
  const key = randomBytes(32);
  const env: NodeJS.ProcessEnv = { MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://instance.example', MCP_INSTANCE_ID: 'explicit-instance-identity-0001',
    MCP_ENCRYPTION_KEY: key.toString('base64'), MCP_CONNECT_TRUST: 'true', GH_INSTALLATION_ID: '42', PROPR_GH_RELAY_TOKEN: RELAY,
    MCP_CONNECT_TUNNEL_ID: 'tunnel-explicit', PROPR_UI_TUNNEL_ENABLED: 'true', PROPR_UI_TUNNEL_TOKEN: 'connector-only' };
  const manager = startConnectMcpRegistration({ database, env, logger: quietLogger, ...fakeTimers() });
  try {
    assert.equal(await manager.trigger(), 'pending');
    assert.equal(registrations.length, 0);
    const config = loadMcpConfig(env)!;
    await registerMcpInstance(config, new McpStore(database, config.encryptionKey));
    assert.equal(await manager.trigger(), 'registered');
    assert.equal(manager.scheduledDelayMs(), undefined, 'no automatic refresh outside tunnel mode');
    const identity = await new McpStore(database, key).get<InstanceIdentity>('connect_identity', 'instance');
    assert.equal(identity?.instanceId, 'explicit-instance-identity-0001');
  } finally { manager.stop(); }
});
