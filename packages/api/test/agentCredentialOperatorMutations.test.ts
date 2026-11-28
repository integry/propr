import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import {
  closeConnection, CredentialBroker, credentialRunRoot, FlyMachinesRuntime, shutdownQueue, type AgentConfig,
} from '@propr/core';
import { getManagedAgentConfigPath } from '@propr/shared';
import {
  clearAgentPastedCredential, readAgentCredentialStatus, resolveAgentCredentialStores, setAgentPastedCredential,
} from '../services/agentCredentialStore.js';
import { AgentLoginSessionManager, type AgentLoginSessionSnapshot } from '../services/agentLoginSessionManager.js';

after(async () => { await shutdownQueue(); await closeConnection(); });

let root: string;
const previous = { managed: process.env.PROPR_MANAGED_CREDENTIALS_DIR, runs: process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-operator-mutations-'));
  process.env.PROPR_MANAGED_CREDENTIALS_DIR = root;
  process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR = path.join(root, '.propr-runs');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [['PROPR_MANAGED_CREDENTIALS_DIR', previous.managed], ['PROPR_AGENT_CREDENTIAL_RUN_DIR', previous.runs]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function agent(type: 'claude' | 'codex' | 'opencode', id = `${type}-1`): AgentConfig {
  return { id, type, alias: type, enabled: true, dockerImage: 'propr/agent:test', configPath: getManagedAgentConfigPath(id, type), supportedModels: ['model'] };
}

/** A run of the agent staged now, as the Docker, Sprites and Fly runtimes stage it, and its later write-back. */
function stageRun(config: AgentConfig, store: 'config' | 'data' = 'config') {
  const canonicalRoot = resolveAgentCredentialStores(config)[store]!;
  const broker = new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(), '.locks') } });
  const bundle = broker.materialize([{ id: 'run-store', provider: config.type, store, canonicalRoot }]);
  return {
    canonicalRoot,
    /** The run returns `content` for `relative`, refreshed later than any file in the store. */
    async commit(relative: string, content: string) {
      const results = await broker.commit(bundle, [{ storeId: 'run-store', path: relative, content: Buffer.from(content), mtimeMs: Date.now() + 60_000 }]);
      return results.map(result => result.outcome);
    },
  };
}

describe('operator credential changes while a run is active', () => {
  test('Remove stays effective when a Codex run staged before it returns a refreshed key', async () => {
    const codex = agent('codex');
    await setAgentPastedCredential(codex, 'openai-api-key', 'sk-proj-removedkeyvalue000AAAA');
    const run = stageRun(codex);
    const status = await clearAgentPastedCredential(codex, 'openai-api-key');
    assert.equal(status.credentials.some(item => item.set), false);
    assert.deepEqual(await run.commit('auth.json', '{"OPENAI_API_KEY":"sk-proj-removedkeyvalue000AAAA","tokens":null,"last_refresh":"now"}'),
      ['kept-operator-change']);
    assert.equal(fs.existsSync(path.join(run.canonicalRoot, 'auth.json')), false);
    assert.equal(readAgentCredentialStatus(codex).credentials.some(item => item.set), false);
  });

  test('a replacement pasted account is kept over the old account\'s later refresh', async () => {
    const codex = agent('codex');
    await setAgentPastedCredential(codex, 'codex-auth-json', '{"tokens":{"refresh_token":"old-account-token"}}');
    const run = stageRun(codex);
    await setAgentPastedCredential(codex, 'openai-api-key', 'sk-proj-replacementkey00000WXYZ');
    assert.deepEqual(await run.commit('auth.json', '{"tokens":{"refresh_token":"old-account-rotated"}}'), ['kept-operator-change']);
    const status = readAgentCredentialStatus(codex);
    assert.deepEqual(status.credentials.find(item => item.kind === 'openai-api-key'), { kind: 'openai-api-key', set: true, last4: 'WXYZ' });
    assert.equal(status.credentials.find(item => item.kind === 'codex-auth-json')?.set, false);
  });

  test('a removed OpenCode auth.json is not recreated by a run staged before the removal', async () => {
    const opencode = agent('opencode');
    await setAgentPastedCredential(opencode, 'opencode-auth-json', '{"anthropic":{"type":"oauth","refresh":"r-old"}}');
    const run = stageRun(opencode, 'data');
    await clearAgentPastedCredential(opencode, 'opencode-auth-json');
    assert.deepEqual(await run.commit('auth.json', '{"anthropic":{"type":"oauth","refresh":"r-new"}}'), ['kept-operator-change']);
    assert.equal(fs.existsSync(path.join(run.canonicalRoot, 'auth.json')), false);
  });

  test('a run staged after the change still writes its refresh back', async () => {
    const codex = agent('codex');
    await setAgentPastedCredential(codex, 'codex-auth-json', '{"tokens":{"refresh_token":"t1"}}');
    const run = stageRun(codex);
    assert.deepEqual(await run.commit('auth.json', '{"tokens":{"refresh_token":"t2"}}\n'), ['written']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run.canonicalRoot, 'auth.json'), 'utf8')).tokens.refresh_token, 't2');
  });
});

type MachinesApi = NonNullable<ConstructorParameters<typeof FlyMachinesRuntime>[0]>;

const b64 = (value: string) => Buffer.from(value).toString('base64');

/** A Machines API whose login Machine prompts, takes one input, exits 0 and serves `files`. */
function fakeMachines(files: Record<string, string>) {
  const calls = { created: [] as string[], destroyed: [] as string[] };
  let exited = false;
  let prompted = false;
  const api: MachinesApi = {
    async create(launch) { calls.created.push(launch.config.processes[0].cmd![0]); return 'm-login'; },
    async exec(_id, args) {
      const script = args.includes('-c') ? args[args.indexOf('-c') + 1] : '';
      if (script.includes('tail -c')) {
        const chunk = prompted ? '' : 'Select provider: ';
        prompted = true;
        return { stdout: `${exited && !chunk ? '0' : '-'}\n${b64(chunk)}`, exit_code: 0 };
      }
      if (script.includes('/in"')) { exited = true; return { stdout: '', exit_code: 0 }; }
      if (script.includes('base64 -w0 "$1"')) {
        const file = args[args.length - 1];
        return { stdout: file in files ? `F:${b64(files[file])}` : 'M', exit_code: 0 };
      }
      return { stdout: '', exit_code: 0 };
    },
    async signal() {},
    async destroy(id) { calls.destroyed.push(id); },
    async gone() { return true; },
    async find() { return undefined; },
    async list() { return []; },
    async logs() {},
  };
  return { api, calls };
}

async function until(manager: AgentLoginSessionManager, id: string, predicate: (session: AgentLoginSessionSnapshot) => boolean) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const session = manager.get(id, 'alice');
    if (predicate(session)) return session;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('session did not reach the expected state');
}

describe('OpenCode interactive login on Fly Machines', () => {
  test('runs its login descriptor on a Machine and stores the data-store credentials', async () => {
    const opencode = agent('opencode');
    const { api, calls } = fakeMachines({ '/home/node/.local/share/opencode/auth.json': '{"anthropic":{"type":"oauth","refresh":"r"}}' });
    const runtime = new FlyMachinesRuntime(api, {
      PROPR_FLY_API_TOKEN: 'fly-token-value', PROPR_FLY_APP: `opencode-login-${Date.now()}`, PROPR_FLY_IMAGE: 'registry.fly.io/agents:bundle',
    });
    const manager = new AgentLoginSessionManager({
      resolveRemoteLogin: async () => ({ runtime: 'fly-machines', start: request => runtime.startLogin(request) }),
      runDocker: async () => { throw new Error('Docker must not be used for a remote login'); },
      id: () => 'fly-opencode',
    });
    try {
      await manager.start(opencode, 'alice');
      const running = await until(manager, 'fly-opencode', session => session.status !== 'starting' && session.output.includes('Select provider'));
      assert.equal(running.status, 'running', running.error);
      assert.match(calls.created[0], /opencode\W+auth\W+login/);
      assert.match(calls.created[0], /mkdir -p -m 700 '\/home\/node\/.config\/opencode' '\/home\/node\/.local\/share\/opencode'/);
      manager.write('fly-opencode', 'alice', '\r');
      const done = await until(manager, 'fly-opencode', session => session.status !== 'running');
      assert.equal(done.status, 'succeeded', done.error);
      assert.deepEqual(calls.destroyed, ['m-login']);
      const stored = path.join(resolveAgentCredentialStores(opencode).data!, 'auth.json');
      assert.equal(JSON.parse(fs.readFileSync(stored, 'utf8')).anthropic.refresh, 'r');
      assert.equal(readAgentCredentialStatus(opencode).credentials.find(item => item.kind === 'opencode-auth-json')?.set, true);
    } finally {
      await manager.close();
    }
  });
});
