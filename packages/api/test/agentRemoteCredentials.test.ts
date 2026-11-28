import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Response } from 'express';
import { closeConnection, credentialRunRoot, MAX_RETURNED_CREDENTIAL_BYTES, RemoteLoginCapacityError, shutdownQueue, withCredentialStoreLock, type AgentConfig, type RemoteLoginProcess, type RemoteLoginRequest } from '@propr/core';
import { getManagedAgentConfigPath } from '@propr/shared';
import type { FlatRequest } from '../requestTypes.js';
import { createAgentLoginRoutes } from '../routes/agentLoginRoutes.js';
import {
  AgentCredentialInputError,
  clearAgentPastedCredential,
  readAgentCredentialStatus,
  remoteCredentialProblem,
  setAgentPastedCredential,
  storeReturnedLoginFiles,
} from '../services/agentCredentialStore.js';
import { AgentLoginSessionManager, type AgentLoginSessionSnapshot } from '../services/agentLoginSessionManager.js';
import { collectRemoteLoginFiles, localDockerAvailable, remoteLoginDirectories, type RemoteLoginBackend } from '../services/agentLoginRemote.js';
import { createAgentHealthCheck } from '../services/agentHealthCheck.js';

after(async () => { await shutdownQueue(); await closeConnection(); });

let root: string;
const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
const previousRunDir = process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-managed-'));
  process.env.PROPR_MANAGED_CREDENTIALS_DIR = root;
  process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR = path.join(root, '.propr-runs');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
  else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
  if (previousRunDir === undefined) delete process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR;
  else process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR = previousRunDir;
});

function agent(type: 'claude' | 'codex' | 'opencode' | 'antigravity' = 'claude', id = `${type}-1`): AgentConfig {
  return {
    id, type, alias: type, enabled: true, dockerImage: 'propr/agent:test',
    configPath: getManagedAgentConfigPath(id, type), supportedModels: ['model'],
  };
}

const STORE_DIRS: Record<string, string> = { claude: '.claude', codex: '.codex', antigravity: '.gemini', opencode: '.config/opencode' };
const storeDir = (config: AgentConfig) => path.join(root, config.id, STORE_DIRS[config.type]);

/** Holds the store lock of `dir` (as a run's write-back would) until `release` is called. */
async function holdStoreLock(dir: string) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const done = withCredentialStoreLock(dir, { lockRoot: path.join(credentialRunRoot(), '.locks') }, () => { entered(); return held; });
  await inside;
  return { release: async () => { release(); await done; } };
}

function recorder() {
  const record: { status: number; body?: unknown; headers: Record<string, string> } = { status: 200, headers: {} };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
    setHeader(name: string, value: string) { record.headers[name] = value; return response; },
  };
  return { record, response: response as unknown as Response };
}

describe('pasted agent credentials', () => {
  test('a Claude API key lands in the managed settings.json env and is reported only as set + last 4', async () => {
    const claude = agent('claude');
    const status = await setAgentPastedCredential(claude, 'anthropic-api-key', 'sk-ant-api03-supersecretvalueWXYZ');
    assert.deepEqual(status.credentials.find(item => item.kind === 'anthropic-api-key'), { kind: 'anthropic-api-key', set: true, last4: 'WXYZ' });
    assert.ok(!JSON.stringify(status).includes('supersecret'));
    const settings = JSON.parse(fs.readFileSync(path.join(storeDir(claude), 'settings.json'), 'utf8'));
    assert.equal(settings.env.ANTHROPIC_API_KEY, 'sk-ant-api03-supersecretvalueWXYZ');
    assert.equal(fs.statSync(path.join(storeDir(claude), 'settings.json')).mode & 0o777, 0o600);
    assert.equal(remoteCredentialProblem(claude), undefined);
  });

  test('a Codex API key or auth.json replaces auth.json; wrong-provider kinds are refused', async () => {
    const codex = agent('codex');
    assert.match(remoteCredentialProblem(codex) ?? '', /No credentials are stored/);
    await setAgentPastedCredential(codex, 'openai-api-key', 'sk-proj-abcdefghijklmnopqrst');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir(codex), 'auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-proj-abcdefghijklmnopqrst');
    await assert.rejects(setAgentPastedCredential(codex, 'anthropic-api-key', 'sk-ant-x'), AgentCredentialInputError);
    await assert.rejects(setAgentPastedCredential(codex, 'codex-auth-json', 'not json'), /not valid JSON/);
  });

  test('routes are write-only, no-store, and map bad input to 400', async () => {
    const claude = agent('claude');
    const routes = createAgentLoginRoutes({ resolveAgent: async id => id === claude.id ? claude : undefined });
    const put = recorder();
    await routes.putCredential({ params: { agentId: claude.id }, body: { kind: 'claude-oauth-token', value: 'sk-ant-oat01-longlivedtoken0000AbCd' } } as unknown as FlatRequest, put.response);
    assert.equal(put.record.status, 200);
    assert.equal(put.record.headers['Cache-Control'], 'no-store');
    assert.ok(!JSON.stringify(put.record.body).includes('longlived'));
    const get = recorder();
    await routes.getCredentials({ params: { agentId: claude.id } } as unknown as FlatRequest, get.response);
    assert.deepEqual((get.record.body as ReturnType<typeof readAgentCredentialStatus>).credentials,
      [{ kind: 'anthropic-api-key', set: false }, { kind: 'claude-oauth-token', set: true, last4: 'AbCd' }]);
    const bad = recorder();
    await routes.putCredential({ params: { agentId: claude.id }, body: { kind: 'nope', value: 'x' } } as unknown as FlatRequest, bad.response);
    assert.equal(bad.record.status, 400);
    const del = recorder();
    await routes.deleteCredential({ params: { agentId: claude.id, kind: 'claude-oauth-token' } } as unknown as FlatRequest, del.response);
    assert.equal((del.record.body as ReturnType<typeof readAgentCredentialStatus>).credentials.some(item => item.set), false);
    const missing = recorder();
    await routes.getCredentials({ params: { agentId: 'other' } } as unknown as FlatRequest, missing.response);
    assert.equal(missing.record.status, 404);
  });

  test('overlapping replace and remove requests each merge into the current settings.json', async () => {
    const claude = agent('claude');
    await setAgentPastedCredential(claude, 'anthropic-api-key', 'sk-ant-api03-originalkeyvalue0001');
    const settingsPath = path.join(storeDir(claude), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, model: 'opus' }));
    // Both requests are issued while the store is busy, so both read before either publishes unless the merge is under the lock.
    const lock = await holdStoreLock(storeDir(claude));
    const replace = setAgentPastedCredential(claude, 'claude-oauth-token', 'sk-ant-oat01-replacementtoken00Zz');
    const remove = clearAgentPastedCredential(claude, 'anthropic-api-key');
    await lock.release();
    await Promise.all([replace, remove]);
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(merged.model, 'opus');
    assert.equal(merged.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-replacementtoken00Zz');
    assert.equal(merged.env.ANTHROPIC_API_KEY, undefined);
  });

  test('an Antigravity agent without its login file is not ready on a remote runtime', async () => {
    const antigravity = agent('antigravity');
    assert.match(remoteCredentialProblem(antigravity) ?? '', /No login is stored/);
    await storeReturnedLoginFiles(antigravity, [{ store: 'config', path: 'antigravity-cli/antigravity-oauth-token', content: Buffer.from('{"refresh_token":"r"}') }]);
    assert.equal(remoteCredentialProblem(antigravity), undefined);
  });

  test('returned login files are limited to the manifest login files', async () => {
    const opencode = agent('opencode');
    await storeReturnedLoginFiles(opencode, [{ store: 'data', path: 'auth.json', content: Buffer.from('{"anthropic":{"type":"api","key":"k"}}') }]);
    assert.ok(fs.existsSync(path.join(root, opencode.id, '.local/share/opencode/auth.json')));
    await assert.rejects(storeReturnedLoginFiles(opencode, [{ store: 'config', path: 'opencode.json', content: Buffer.from('{}') }]), /Unexpected login file/);
  });

  test('an oversized existing settings.json is refused, not overwritten, by set and remove', async () => {
    const claude = agent('claude');
    fs.mkdirSync(storeDir(claude), { recursive: true });
    const settingsPath = path.join(storeDir(claude), 'settings.json');
    const oversized = JSON.stringify({ model: 'opus', padding: 'x'.repeat(MAX_RETURNED_CREDENTIAL_BYTES) });
    fs.writeFileSync(settingsPath, oversized);
    await assert.rejects(setAgentPastedCredential(claude, 'anthropic-api-key', 'sk-ant-api03-supersecretvalueWXYZ'),
      (error: Error) => error instanceof AgentCredentialInputError && /settings\.json could not be read/.test(error.message));
    await assert.rejects(clearAgentPastedCredential(claude, 'anthropic-api-key'), AgentCredentialInputError);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), oversized);
    // Status reporting stays tolerant.
    assert.equal(readAgentCredentialStatus(claude).credentials.some(item => item.set), false);
  });

  test('a Claude interactive login drops a pasted key from settings.json and keeps other settings', async () => {
    const claude = agent('claude');
    await setAgentPastedCredential(claude, 'anthropic-api-key', 'sk-ant-api03-pastedkeyvalue00001');
    const settingsPath = path.join(storeDir(claude), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, model: 'opus', env: { ...settings.env, DISABLE_TELEMETRY: '1' } }));
    const descriptor = { type: 'claude' as const, containerConfigPath: '/home/node/.claude', command: ['claude', '/login'] };
    const stored = await collectRemoteLoginFiles(claude, descriptor, {
      async readFile(file) { return file.endsWith('/.credentials.json') ? Buffer.from('{"claudeAiOauth":{"refreshToken":"r"}}') : undefined; },
    });
    assert.equal(stored, 1);
    assert.ok(fs.existsSync(path.join(storeDir(claude), '.credentials.json')));
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(after, { model: 'opus', env: { DISABLE_TELEMETRY: '1' } });
    assert.equal(readAgentCredentialStatus(claude).credentials.some(item => item.set), false);
    assert.equal(readAgentCredentialStatus(claude).loginPresent, true);
  });

  test('a Claude login whose settings.json cannot be read stores nothing', async () => {
    const claude = agent('claude');
    fs.mkdirSync(storeDir(claude), { recursive: true });
    const settingsPath = path.join(storeDir(claude), 'settings.json');
    fs.writeFileSync(settingsPath, 'x'.repeat(MAX_RETURNED_CREDENTIAL_BYTES + 1));
    await assert.rejects(storeReturnedLoginFiles(claude, [{ store: 'config', path: '.credentials.json', content: Buffer.from('{}') }]), AgentCredentialInputError);
    assert.ok(!fs.existsSync(path.join(storeDir(claude), '.credentials.json')));
    assert.equal(fs.statSync(settingsPath).size, MAX_RETURNED_CREDENTIAL_BYTES + 1);
  });
});

/** A remote login whose CLI prints a prompt, takes one input, then exits with `code`. */
function fakeRemote(code = 0, files: Record<string, string> = {}) {
  const calls = { requests: [] as RemoteLoginRequest[], inputs: [] as string[], closed: 0, killed: 0 };
  let finish!: (value: number) => void;
  const process: RemoteLoginProcess = {
    location: 'Sprite propr-test',
    onOutput(listener) { listener('Visit https://example.test/device\n'); },
    async write(input) { calls.inputs.push(input); finish(code); },
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { calls.killed++; },
    async readFile(file) { return file in files ? Buffer.from(files[file]) : undefined; },
    async close() { calls.closed++; },
  };
  const backend: RemoteLoginBackend = {
    runtime: 'sprites',
    async start(request) { calls.requests.push(request); return process; },
  };
  return { backend, process, calls };
}

async function until(manager: AgentLoginSessionManager, id: string, predicate: (session: AgentLoginSessionSnapshot) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = manager.get(id, 'alice');
    if (predicate(session)) return session;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('session did not reach the expected state');
}

describe('interactive login on a remote runtime (no Docker socket)', () => {
  test('without DOCKER_HOST or a socket there is no local Docker, and nothing to sweep', async () => {
    assert.equal(localDockerAvailable({}, () => false), false);
    assert.equal(localDockerAvailable({ DOCKER_HOST: 'tcp://x' }, () => false), true);
    const manager = new AgentLoginSessionManager({ resolveRemoteLogin: async () => undefined, dockerAvailable: () => false });
    assert.equal(await manager.cleanupOrphanedContainers(), 0);
  });

  test('streams output, forwards input, stores the manifest login files and destroys the runtime', async () => {
    const claude = agent('claude');
    const { backend, calls } = fakeRemote(0, { '/home/node/.claude/.credentials.json': '{"claudeAiOauth":{"refreshToken":"r"}}' });
    let docker = 0;
    const manager = new AgentLoginSessionManager({
      resolveRemoteLogin: async () => backend,
      runDocker: async () => { docker++; return { stdout: '', stderr: '' }; },
      id: () => 'remote-1',
    });
    const started = await manager.start(claude, 'alice');
    assert.equal(started.status, 'starting');
    const running = await until(manager, 'remote-1', session => session.status === 'running');
    assert.match(running.output, /No local Docker daemon: running the claude login on Sprites/);
    assert.match(running.output, /Visit https:\/\/example.test\/device/);
    assert.deepEqual(calls.requests[0].command, ['claude', 'auth', 'login']);
    assert.deepEqual(calls.requests[0].directories, ['/home/node/.claude']);
    manager.write('remote-1', 'alice', 'code\r');
    const done = await until(manager, 'remote-1', session => session.status !== 'running');
    assert.equal(done.status, 'succeeded', done.error);
    assert.match(done.output, /Saved 1 credential file to this agent's credential store/);
    assert.deepEqual(calls.inputs, ['code\r']);
    assert.equal(calls.closed, 1);
    assert.equal(docker, 0, 'no Docker command runs for a remote login');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir(claude), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken, 'r');
    assert.equal(readAgentCredentialStatus(claude).loginPresent, true);
    await manager.close();
  });

  test('a login that wrote no credential files fails, and the runtime is still destroyed', async () => {
    const { backend, calls } = fakeRemote(0);
    const manager = new AgentLoginSessionManager({ resolveRemoteLogin: async () => backend, runDocker: async () => ({ stdout: '', stderr: '' }), id: () => 'remote-2' });
    await manager.start(agent('codex'), 'alice');
    await until(manager, 'remote-2', session => session.status === 'running');
    manager.write('remote-2', 'alice', '\r');
    const done = await until(manager, 'remote-2', session => session.status !== 'running');
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /wrote no credential files/);
    assert.equal(calls.closed, 1);
    await manager.close();
  });

  test('no free Sprite or Machine fails with the capacity message', async () => {
    const backend: RemoteLoginBackend = {
      runtime: 'fly-machines',
      async start() { throw new RemoteLoginCapacityError('No Fly Machine is free for the login: 3 of 3 Machines (PROPR_FLY_MACHINES_MAX) exist in app agents.'); },
    };
    const manager = new AgentLoginSessionManager({ resolveRemoteLogin: async () => backend, runDocker: async () => ({ stdout: '', stderr: '' }), id: () => 'remote-3' });
    await manager.start(agent('claude'), 'alice');
    const done = await until(manager, 'remote-3', session => session.status !== 'starting');
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /PROPR_FLY_MACHINES_MAX/);
    await manager.close();
  });

  test('cancel kills the CLI and destroys the runtime', async () => {
    const { backend, calls } = fakeRemote(0);
    const manager = new AgentLoginSessionManager({ resolveRemoteLogin: async () => backend, runDocker: async () => ({ stdout: '', stderr: '' }), id: () => 'remote-4' });
    await manager.start(agent('claude'), 'alice');
    await until(manager, 'remote-4', session => session.status === 'running');
    const cancelled = await manager.cancel('remote-4', 'alice');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(calls.killed, 1);
    assert.equal(calls.closed, 1);
    await manager.close();
  });

  test('a session cancelled while its collection waits for the store lock stores nothing and does not succeed', async () => {
    const claude = agent('claude');
    const { backend, process: remote, calls } = fakeRemote(0, { '/home/node/.claude/.credentials.json': '{"claudeAiOauth":{"refreshToken":"r"}}' });
    const reads: string[] = [];
    const readFile = remote.readFile.bind(remote);
    remote.readFile = async file => { reads.push(file); return readFile(file); };
    fs.mkdirSync(storeDir(claude), { recursive: true });
    const lock = await holdStoreLock(storeDir(claude));
    const manager = new AgentLoginSessionManager({ resolveRemoteLogin: async () => backend, runDocker: async () => ({ stdout: '', stderr: '' }), id: () => 'remote-5' });
    try {
      await manager.start(claude, 'alice');
      await until(manager, 'remote-5', session => session.status === 'running');
      manager.write('remote-5', 'alice', 'code\r');
      for (let attempt = 0; attempt < 200 && reads.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(reads.length > 0, 'collection started after the CLI exited');
      const cancelled = await manager.cancel('remote-5', 'alice');
      assert.equal(cancelled.status, 'cancelled');
    } finally {
      await lock.release();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const after = manager.get('remote-5', 'alice');
    assert.equal(after.status, 'cancelled');
    assert.doesNotMatch(after.output, /Saved \d+ credential file|Could not save the login/);
    assert.equal(fs.existsSync(path.join(storeDir(claude), '.credentials.json')), false);
    assert.equal(calls.closed, 1);
    await manager.close();
  });

  test('collection after the session aborted reads and stores nothing', async () => {
    const opencode = agent('opencode');
    const descriptor = { type: 'opencode' as const, containerConfigPath: '/home/node/.config/opencode', command: ['opencode', 'auth', 'login'] };
    const abort = new AbortController();
    abort.abort();
    let stores = 0;
    await assert.rejects(collectRemoteLoginFiles(opencode, descriptor, { async readFile() { return Buffer.from('{}'); } },
      { signal: abort.signal, store: async () => { stores++; return 1; } }), { name: 'AbortError' });
    assert.equal(stores, 0);
  });

  test('OpenCode logins create and collect its data directory', async () => {
    const opencode = agent('opencode');
    const descriptor = { type: 'opencode' as const, containerConfigPath: '/home/node/.config/opencode', command: ['opencode', 'auth', 'login'] };
    assert.deepEqual(remoteLoginDirectories(opencode, descriptor), ['/home/node/.config/opencode', '/home/node/.local/share/opencode']);
    const reads: string[] = [];
    const stored = await collectRemoteLoginFiles(opencode, descriptor, {
      async readFile(file) { reads.push(file); return file.endsWith('share/opencode/auth.json') ? Buffer.from('{"a":{"type":"api"}}') : undefined; },
    });
    assert.equal(stored, 1);
    assert.ok(reads.includes('/home/node/.local/share/opencode/account.json'));
  });
});

describe('health check on a remote runtime', () => {
  const config = { ...agent('claude'), supportedModels: ['claude-haiku-5-5'] };
  const unexpected = async () => { throw new Error('Docker must not be used for a remote agent'); };

  test('reports readiness without touching the local Docker image or probing a model run', async () => {
    let probes = 0;
    const check = createAgentHealthCheck({
      loadAgents: async () => [config],
      createAgent: () => { probes++; return { analyze: unexpected } as never; },
      imageExists: unexpected,
      prepareImage: unexpected,
      resolveExecutionImage: unexpected,
      remoteReadiness: async () => ({ runtime: 'sprites', ready: true, detail: 'Sprites, claude CLI 2.1.330' }),
      remoteCredentialProblem: () => undefined,
    });
    assert.deepEqual(await check(config.id), {
      agentId: config.id, runtime: 'sprites', status: 'ready', model: 'claude-haiku-5-5', detail: 'Sprites, claude CLI 2.1.330',
    });
    assert.equal(probes, 0);
  });

  test('never reports image preparation for a remote runtime: a bad token is runtime_unavailable, no credentials is auth_required', async () => {
    let ready = false;
    const check = createAgentHealthCheck({
      loadAgents: async () => [config],
      createAgent: () => ({ analyze: unexpected }) as never,
      imageExists: unexpected,
      prepareImage: unexpected,
      remoteReadiness: async () => ready
        ? { runtime: 'fly-machines', ready: true }
        : { runtime: 'fly-machines', ready: false, error: 'The Fly Machines API refused PROPR_FLY_API_TOKEN (HTTP 401).' },
      remoteCredentialProblem: () => 'No credentials are stored for this agent.',
    });
    const failed = await check(config.id);
    assert.equal(failed?.errorCode, 'runtime_unavailable');
    assert.doesNotMatch(failed?.error ?? '', /image preparation/i);
    ready = true;
    const auth = await check(config.id, true);
    assert.equal(auth?.errorCode, 'auth_required');
  });
});
