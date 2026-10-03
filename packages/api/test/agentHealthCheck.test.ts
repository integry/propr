import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, shutdownQueue, type AgentConfig, type AnalysisResult } from '@propr/core';
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
    ['claude', ['claude-opus-5-5', 'claude-sonnet-5-5'], 'claude-sonnet-5-5'],
    ['antigravity', ['antigravity-gemini-3.1-pro', 'antigravity-gemini-3.8-flash'], 'antigravity-gemini-3.8-flash'],
    ['antigravity', ['antigravity-gemini-3.1-pro', 'antigravity-gemini-3.7-flash'], 'antigravity-gemini-3.7-flash'],
    ['opencode', ['opencode-big-pickle', 'opencode-ling-3.0-flash-fin-free'], 'opencode-ling-3.0-flash-fin-free'],
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
