import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AntigravityAgent, closeConnection, shutdownQueue, type AgentConfig, type AnalysisResult } from '@propr/core';
import { agentHealthModel, createAgentHealthCheck } from '../services/agentHealthCheck.js';

const config: AgentConfig = {
  id: 'codex', type: 'codex', alias: 'codex', enabled: true,
  configPath: '~/.codex', dockerImage: 'propr/agent:test',
  supportedModels: ['gpt-6-astra', 'gpt-6-luna'], defaultModel: 'gpt-6-astra',
};

after(async () => { await shutdownQueue(); await closeConnection(); });

test('probes use configured lightweight models for each provider and respect custom configurations', () => {
  for (const [type, models, expected] of [
    ['codex', ['gpt-6-astra', 'gpt-6-luna'], 'gpt-6-luna'],
    ['claude', ['claude-opus-5-5', 'claude-haiku-4-5-20251001'], 'claude-haiku-4-5-20251001'],
    ['claude', ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'], 'claude-haiku-5-5'],
    ['claude', ['claude-opus-5-5', 'claude-sonnet-5-5'], 'claude-sonnet-5-5'],
    ['antigravity', ['antigravity-gemini-4-argon', 'antigravity-gemini-3.8-flash'], 'antigravity-gemini-3.8-flash'],
    ['antigravity', ['antigravity-claude-opus-5.5', 'antigravity-gemini-3.8-flash'], 'antigravity-gemini-3.8-flash'],
    ['opencode', ['opencode-big-pickle', 'opencode-deepseek-v4.1-flash-free'], 'opencode-deepseek-v4.1-flash-free'],
    ['vibe', ['zai-glm-5-3', 'mistral-medium-3.5'], 'mistral-medium-3.5'],
  ] as const) {
    assert.equal(agentHealthModel({ ...config, type, supportedModels: [...models] }), expected);
  }
  assert.equal(agentHealthModel({ ...config, supportedModels: ['custom'], defaultModel: 'custom' }), 'custom');
  assert.equal(agentHealthModel({ ...config, supportedModels: [], defaultModel: undefined }), undefined);
});

test('does not execute disabled, missing, or unconfigured agents', async () => {
  let executions = 0;
  const check = createAgentHealthCheck({
    loadAgents: async () => [{ ...config, enabled: false }, { ...config, id: 'empty', supportedModels: [] }],
    createAgent: () => { executions++; throw new Error('Should not execute'); },
  });
  assert.equal((await check('codex'))?.status, 'disabled');
  assert.equal(await check('missing'), undefined);
  assert.match((await check('empty'))?.error ?? '', /No models configured/);
  assert.equal(executions, 0);
});

test('shares concurrent probes and passes a bounded lightweight analysis without repository access', async () => {
  let finish!: (result: AnalysisResult) => void;
  let calls = 0;
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    createAgent: () => ({ analyze: async (prompt, options) => {
      calls++;
      assert.match(prompt, /only OK/);
      assert.equal(options?.model, 'gpt-6-luna');
      assert.equal(options?.timeoutMs, 30_000);
      assert.equal(options?.skipUsageTracking, true);
      assert.equal(options?.readOnlyWorkspacePath, undefined);
      assert.equal(options?.allowReadOnlyCommands, undefined);
      return new Promise(resolve => { finish = resolve; });
    } }),
  });
  const one = check('codex');
  const two = check('codex');
  await new Promise(resolve => setImmediate(resolve));
  finish({ success: true, response: 'OK' });
  assert.equal((await one)?.status, 'ready');
  assert.equal((await two)?.status, 'ready');
  assert.equal(calls, 1);
});

test('post-login refresh waits for the pending old-credential probe and analyzes updated credentials', async () => {
  const finishes: ((result: AnalysisResult) => void)[] = [];
  const credentialsUsed: string[] = [];
  let credentials = 'expired';
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    createAgent: () => {
      credentialsUsed.push(credentials);
      return { analyze: async () => new Promise(resolve => { finishes.push(resolve); }) };
    },
  });
  const initial = check(config.id);
  await new Promise(resolve => setImmediate(resolve));
  credentials = 'logged-in';
  const refresh = check(config.id, true);
  const concurrentRefresh = check(config.id, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(credentialsUsed, ['expired']);
  finishes[0]({ success: false, response: '', error: 'Login expired' });
  assert.equal((await initial)?.errorCode, 'auth_required');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(credentialsUsed, ['expired', 'logged-in']);
  // A normal concurrent read must share the new probe, not the settled old one.
  const sibling = check(config.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finishes.length, 2);
  finishes[1]({ success: true, response: 'OK' });
  assert.equal((await refresh)?.status, 'ready');
  assert.equal((await concurrentRefresh)?.status, 'ready');
  assert.equal((await sibling)?.status, 'ready');
});

test('queued refresh reloads configuration after waiting, including disabled and deleted agents', async () => {
  for (const update of ['edit', 'disable', 'delete'] as const) {
    let configured = [config];
    let finish!: (result: AnalysisResult) => void;
    const probedPaths: string[] = [];
    const check = createAgentHealthCheck({
      loadAgents: async () => configured,
      createAgent: agent => {
        probedPaths.push(agent.configPath);
        return { analyze: async () => probedPaths.length === 1
          ? new Promise(resolve => { finish = resolve; })
          : { success: true, response: 'OK' } };
      },
    });
    const initial = check(config.id);
    await new Promise(resolve => setImmediate(resolve));
    const refresh = check(config.id, true);
    await new Promise(resolve => setImmediate(resolve));
    configured = update === 'delete' ? [] : [{ ...config,
      ...(update === 'disable' ? { enabled: false } : { configPath: '/updated/credentials' }),
    }];
    finish({ success: false, response: '', error: 'Login expired' });
    await initial;
    const result = await refresh;
    assert.equal(result?.status, update === 'edit' ? 'ready' : update === 'disable' ? 'disabled' : undefined);
    assert.deepEqual(probedPaths, update === 'edit' ? [config.configPath, '/updated/credentials'] : [config.configPath]);
  }
});

test('returns CLI and runtime errors, treats empty output as failure, and permits a fresh check', async () => {
  const outcomes = [
    async () => ({ success: false, response: '', error: 'Login expired' }),
    async () => { throw new Error('Docker execution timed out'); },
    async () => ({ success: true, response: '' }),
    async () => ({ success: true, response: 'OK' }),
  ];
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    createAgent: () => ({ analyze: outcomes.shift()! }),
  });
  assert.equal((await check('codex'))?.error, 'Login expired');
  assert.match((await check('codex'))?.error ?? '', /timed out/);
  assert.equal((await check('codex'))?.status, 'error');
  assert.equal((await check('codex'))?.status, 'ready');
});

test('redacts credentials from provider errors before returning them to the card', async () => {
  const token = 'test-only-token-12345678901234567890';
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    createAgent: () => ({ analyze: async () => ({ success: false, response: '', error: `Request rejected: Bearer ${token}` }) }),
  });
  const result = await check('codex');
  assert.equal(result?.status, 'error');
  assert.ok(!result?.error?.includes(token));
  assert.match(result?.error ?? '', /REDACTED/);
});

test('distinguishes authentication, quota, HTTP 429, and unrelated failures for card actions', async () => {
  for (const [error, expected] of [
    ['Your login session has expired. Please log in again.', 'auth_required'],
    ['Provider rate limit reached. Try again later.', 'rate_limit'],
    ['HTTP 429: Too many requests. Please log in again.', 'rate_limit'],
    ['RESOURCE_EXHAUSTED', 'rate_limit'],
    ['Quota exhausted', 'rate_limit'],
    ['Docker execution timed out', 'unknown'],
  ] as const) {
    const check = createAgentHealthCheck({
      loadAgents: async () => [config],
      createAgent: () => ({ analyze: async () => ({ success: false, response: '', error }) }),
    });
    assert.equal((await check(config.id))?.errorCode, expected, error);
  }
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    createAgent: () => ({ analyze: async () => { throw Object.assign(new Error('Request failed'), { status: 429 }); } }),
  });
  assert.equal((await check(config.id))?.errorCode, 'rate_limit');
});

test('Pi checks the default model provider without running a prompt', async () => {
  const pi: AgentConfig = {
    id: 'pi', type: 'pi', alias: 'pi', enabled: true, configPath: '~/.pi/agent', dockerImage: 'propr/agent:test',
    supportedModels: ['pi-openrouter/mistralai/devstral-2512', 'pi-anthropic/claude-sonnet-5-5'], defaultModel: 'pi-openrouter/mistralai/devstral-2512',
  };
  const outcomes = [
    { status: 'ready', provider: 'openrouter', authType: 'api_key' },
    { status: 'not_ready', provider: 'openrouter', reason: 'credentials_not_configured', message: 'Pi has no credentials for openrouter.' },
    { status: 'invalid', provider: 'openrouter', reason: 'invalid_state', message: 'Pi\'s openrouter credentials are invalid (invalid_state).' },
    { status: 'not_ready', provider: 'openrouter', reason: 'provider_not_found', message: 'Pi does not know the provider "openrouter".' },
  ] as const;
  const checkedModels: string[] = [];
  const check = createAgentHealthCheck({
    loadAgents: async () => [pi],
    createAgent: () => ({
      analyze: async () => { throw new Error('A credential check must not run a prompt'); },
      checkCredentials: async (model: string) => { checkedModels.push(model); return outcomes[checkedModels.length - 1]; },
    }),
  });
  // The response is what the route serializes: assert it after a JSON round trip.
  const response = async (fresh: boolean) => JSON.parse(JSON.stringify(await check('pi', fresh)));
  assert.deepEqual(await response(false), {
    agentId: 'pi', model: pi.defaultModel, status: 'ready', credentials: { status: 'ready', provider: 'openrouter' },
  });
  const notReady = await response(true);
  assert.equal(notReady.status, 'error', 'the generic health status is unchanged');
  assert.equal(notReady.errorCode, 'auth_required');
  assert.deepEqual(notReady.credentials, { status: 'not_ready', provider: 'openrouter', reason: 'credentials_not_configured' });
  assert.match(notReady.error ?? '', /no credentials for openrouter/);
  const invalid = await response(true);
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.errorCode, 'auth_required');
  assert.deepEqual(invalid.credentials, { status: 'invalid', provider: 'openrouter', reason: 'invalid_state' }, 'an unusable login is told apart from a missing one');
  assert.match(invalid.error ?? '', /invalid/);
  const unknownProvider = await response(true);
  assert.equal(unknownProvider.errorCode, 'unknown', 'an unknown provider is not a login problem');
  assert.deepEqual(unknownProvider.credentials, { status: 'not_ready', provider: 'openrouter', reason: 'provider_not_found' });
  assert.deepEqual(checkedModels, Array(4).fill(pi.defaultModel));
  assert.equal(agentHealthModel({ ...pi, defaultModel: undefined }), pi.supportedModels[0]);
  assert.equal(agentHealthModel({ ...pi, defaultModel: undefined, supportedModels: [] }), undefined);
});

test('Pi rechecks readiness when the default provider changes during the credential probe', async () => {
  const anthropic = 'pi-anthropic/claude-sonnet-5-5';
  const openrouter = 'pi-openrouter/mistralai/devstral-2512';
  let pi: AgentConfig = { ...config, id: 'pi', type: 'pi', supportedModels: [anthropic, openrouter], defaultModel: anthropic };
  const checkedModels: string[] = [];
  let finish!: () => void;
  const check = createAgentHealthCheck({
    loadAgents: async () => [pi],
    createAgent: () => ({
      analyze: async () => { throw new Error('A credential check must not run a prompt'); },
      checkCredentials: async model => {
        checkedModels.push(model);
        if (model === anthropic) {
          await new Promise<void>(resolve => { finish = resolve; });
          return { status: 'ready', provider: 'anthropic' };
        }
        return { status: 'not_ready', provider: 'openrouter' };
      },
    }),
  });
  const pending = check(pi.id);
  await new Promise(resolve => setImmediate(resolve));
  pi = { ...pi, defaultModel: openrouter };
  finish();
  assert.deepEqual(await pending, {
    agentId: 'pi', model: openrouter, status: 'error', errorCode: 'auth_required', error: 'Credentials are not configured.',
    credentials: { status: 'not_ready', provider: 'openrouter' },
  });
  assert.deepEqual(checkedModels, [anthropic, openrouter]);
});

test('an unreadable login is not ready with its actionable reason, without a provider call', async () => {
  const reason = "agy stores its login in the OS keyring on desktops, which ProPR containers can't read. Sign in once with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy`, or use ProPR's managed login.";
  const antigravity: AgentConfig = { ...config, id: 'agy', type: 'antigravity', alias: 'antigravity', configPath: '~/.gemini', supportedModels: ['antigravity-gemini-3.8-flash'], defaultModel: 'antigravity-gemini-3.8-flash' };
  let analyses = 0;
  let problem: string | undefined = reason;
  const check = createAgentHealthCheck({
    loadAgents: async () => [antigravity],
    createAgent: () => ({
      credentialProblem: () => problem,
      analyze: async () => { analyses++; return { success: true, response: 'OK' }; },
    }),
  });
  assert.deepEqual(await check('agy'), { agentId: 'agy', model: 'antigravity-gemini-3.8-flash', status: 'error', errorCode: 'auth_required', error: reason });
  assert.equal(analyses, 0);
  problem = undefined;
  assert.equal((await check('agy', true))?.status, 'ready');
  assert.equal(analyses, 1);
});

test('an API-key Antigravity agent without an OAuth file token reaches the provider probe', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agy-apikey-'));
  const gemini = path.join(home, '.gemini');
  fs.mkdirSync(path.join(gemini, 'antigravity-cli'), { recursive: true });
  const previousConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  delete process.env.ANTIGRAVITY_CONFIG_PATH;
  try {
    const base: AgentConfig = { ...config, id: 'agy', type: 'antigravity', alias: 'antigravity', configPath: gemini, supportedModels: ['antigravity-gemini-3.8-flash'], defaultModel: 'antigravity-gemini-3.8-flash' };
    let analyses = 0;
    const checkWith = (agentConfig: AgentConfig) => createAgentHealthCheck({
      loadAgents: async () => [agentConfig],
      createAgent: resolved => {
        const real = new AntigravityAgent(resolved);
        return { credentialProblem: () => real.credentialProblem(), analyze: async () => { analyses++; return { success: true, response: 'OK' }; } };
      },
    });
    assert.equal((await checkWith(base)('agy'))?.errorCode, 'auth_required');
    assert.equal(analyses, 0);
    assert.equal((await checkWith({ ...base, envVars: { GEMINI_API_KEY: 'key' } })('agy', true))?.status, 'ready');
    assert.equal(analyses, 1);
  } finally {
    if (previousConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = previousConfigPath;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
