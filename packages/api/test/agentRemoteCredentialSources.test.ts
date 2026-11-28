import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { closeConnection, shutdownQueue, type AgentConfig } from '@propr/core';
import { getManagedAgentConfigPath } from '@propr/shared';
import { remoteCredentialProblem } from '../services/agentCredentialStore.js';
import { createAgentHealthCheck } from '../services/agentHealthCheck.js';

// The remote health check must recognize every credential source a run
// authenticates with, not only pasted credentials and login files.

after(async () => { await shutdownQueue(); await closeConnection(); });

const ENV_NAMES = ['PROPR_MANAGED_CREDENTIALS_DIR', 'VIBE_CONFIG_PATH', 'MISTRAL_API_KEY', 'HOME'] as const;
let root: string;
let saved: Partial<Record<(typeof ENV_NAMES)[number], string>>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-sources-'));
  saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  process.env.PROPR_MANAGED_CREDENTIALS_DIR = path.join(root, 'managed');
  delete process.env.VIBE_CONFIG_PATH;
  delete process.env.MISTRAL_API_KEY;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const noSettings = { loadSettings: async () => ({}) };

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function vibe(configPath: string, envVars?: Record<string, string>): AgentConfig {
  return { id: 'vibe-1', type: 'vibe', alias: 'vibe', enabled: true, dockerImage: 'propr/agent:test', configPath, supportedModels: ['mistral-medium-3.5'], ...(envVars ? { envVars } : {}) };
}

function opencode(supportedModels = ['opencode-openrouter/qwen/qwen4-coder'], envVars?: Record<string, string>): AgentConfig {
  return {
    id: 'opencode-1', type: 'opencode', alias: 'opencode', enabled: true, dockerImage: 'propr/agent:test',
    configPath: getManagedAgentConfigPath('opencode-1', 'opencode'), supportedModels, ...(envVars ? { envVars } : {}),
  };
}

const openCodeConfigDir = () => path.join(root, 'managed', 'opencode-1', '.config', 'opencode');

describe('Vibe on a remote runtime', () => {
  test('the .env MISTRAL_API_KEY the broker supplies to the run counts as a credential', async () => {
    const dir = path.join(root, 'vibe');
    fs.mkdirSync(dir);
    assert.match((await remoteCredentialProblem(vibe(dir), noSettings)) ?? '', /No Mistral API key or Vibe login/);
    write(dir, '.env', 'OTHER=1\nMISTRAL_API_KEY=\n');
    assert.match((await remoteCredentialProblem(vibe(dir), noSettings)) ?? '', /No Mistral API key/, 'an empty key authenticates nothing');
    write(dir, '.env', '# Vibe\nexport MISTRAL_API_KEY="mistral-key-abcdefgh"\n');
    assert.equal(await remoteCredentialProblem(vibe(dir), noSettings), undefined);
  });

  test('a config path the login resolver refuses is read where the run reads it', async () => {
    // `~/…` custom paths are refused for logins but expanded by Vibe execution.
    process.env.HOME = root;
    write(path.join(root, 'vibe-store'), '.env', 'MISTRAL_API_KEY=mistral-key-abcdefgh\n');
    assert.equal(await remoteCredentialProblem(vibe('~/vibe-store'), noSettings), undefined);
  });

  test('VIBE_CONFIG_PATH overrides the saved path, as at run time', async () => {
    const saved = path.join(root, 'saved');
    fs.mkdirSync(saved);
    process.env.VIBE_CONFIG_PATH = path.join(root, 'override');
    write(process.env.VIBE_CONFIG_PATH, 'credentials.json', '{"token":"t"}');
    assert.equal(await remoteCredentialProblem(vibe(saved), noSettings), undefined);
  });

  test('the ProPR MISTRAL_API_KEY and the Mistral key setting count; unreadable settings do not', async () => {
    const dir = path.join(root, 'empty');
    fs.mkdirSync(dir);
    assert.equal(await remoteCredentialProblem(vibe(dir), { loadSettings: async () => ({ mistral_api_key: 'mistral-key-abcdefgh' }) }), undefined);
    assert.match((await remoteCredentialProblem(vibe(dir), { loadSettings: async () => { throw new Error('db down'); } })) ?? '', /No Mistral API key/);
    process.env.MISTRAL_API_KEY = 'mistral-key-abcdefgh';
    assert.equal(await remoteCredentialProblem(vibe(dir), noSettings), undefined);
  });
});

describe('OpenCode on a remote runtime', () => {
  test('a provider options.apiKey in opencode.json or opencode.jsonc counts as a credential', async () => {
    assert.match((await remoteCredentialProblem(opencode())) ?? '', /No credentials are stored/);
    write(openCodeConfigDir(), 'opencode.json', JSON.stringify({ provider: { openrouter: { options: { apiKey: '  ' } } } }));
    assert.match((await remoteCredentialProblem(opencode())) ?? '', /No credentials are stored/, 'a blank key authenticates nothing');
    write(openCodeConfigDir(), 'opencode.json', JSON.stringify({ provider: { openrouter: { options: { apiKey: 'sk-or-v1-abcdefgh' } } } }));
    assert.equal(await remoteCredentialProblem(opencode()), undefined);
    fs.rmSync(path.join(openCodeConfigDir(), 'opencode.json'));
    write(openCodeConfigDir(), 'opencode.jsonc', '{\n  // OpenRouter\n  "provider": { "openrouter": { "options": { "apiKey": "sk-or-v1-abcdefgh", }, }, },\n}\n');
    assert.equal(await remoteCredentialProblem(opencode()), undefined);
  });

  test('a provider key among the forwarded agent env vars counts; GitHub tokens do not', async () => {
    assert.match((await remoteCredentialProblem(opencode(undefined, { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' }))) ?? '', /No credentials are stored/);
    assert.equal(await remoteCredentialProblem(opencode(undefined, { OPENROUTER_API_KEY: 'sk-or-v1-abcdefgh' })), undefined);
  });

  test('an agent offering a built-in free model needs no credential', async () => {
    assert.equal(await remoteCredentialProblem(opencode(['opencode-big-pickle'])), undefined);
  });
});

describe('remote health check with file-based credentials', () => {
  test('Vibe with only its .env and OpenCode with only its config-file key are ready, not auth_required', async () => {
    const dir = path.join(root, 'vibe');
    write(dir, '.env', 'MISTRAL_API_KEY=mistral-key-abcdefgh\n');
    write(openCodeConfigDir(), 'opencode.json', JSON.stringify({ provider: { openrouter: { options: { apiKey: 'sk-or-v1-abcdefgh' } } } }));
    const agents = [vibe(dir), opencode()];
    const unexpected = async () => { throw new Error('Docker must not be used for a remote agent'); };
    const check = createAgentHealthCheck({
      loadAgents: async () => agents,
      createAgent: () => ({ analyze: unexpected }) as never,
      imageExists: unexpected,
      prepareImage: unexpected,
      remoteReadiness: async () => ({ runtime: 'sprites', ready: true }),
      remoteCredentialProblem: config => remoteCredentialProblem(config, noSettings),
    });
    for (const config of agents) assert.equal((await check(config.id))?.status, 'ready', config.type);
    fs.rmSync(path.join(dir, '.env'));
    assert.equal((await check('vibe-1', true))?.errorCode, 'auth_required');
  });
});
