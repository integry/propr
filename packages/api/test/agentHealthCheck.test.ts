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
    ['antigravity', ['antigravity-gemini-3.8-pro-high', 'antigravity-gemini-3.8-flash-low'], 'antigravity-gemini-3.8-flash-low'],
    ['antigravity', ['antigravity-gemini-3.8-pro-high', 'antigravity-gemini-3.8-flash-high'], 'antigravity-gemini-3.8-flash-high'],
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
