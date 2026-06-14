import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SUMMARIZATION_FALLBACK_PROMOTE_THRESHOLD = '3';

const {
  db,
  runMigrations,
  closeConnection,
  loadSummarizationRuntimeState
} = await import('../packages/core/src/index.js');
const { processSingleBatch } = await import('../packages/core/src/services/relevance/summaryMinerBatch.js');
const { processDirectoryBatch } = await import('../packages/core/src/services/relevance/summaryMinerDirectoryBatch.js');

function createAgent(alias: string, defaultModel: string, analyze: (prompt: string, options?: { model?: string }) => Promise<unknown>) {
  return {
    config: {
      id: alias,
      type: 'codex',
      alias,
      enabled: true,
      dockerImage: '',
      configPath: '',
      supportedModels: [defaultModel],
      defaultModel
    },
    analyze,
    executeTask: async () => ({ success: true, logs: '' }),
    healthCheck: async () => true
  };
}

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('summary miner batch fallback', () => {
  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db('file_summaries').delete();
    await db('llm_logs').delete();
    await db('system_configs').where({ key: 'summarization_runtime_state' }).delete();
  });

  after(async () => {
    await closeConnection();
  });

  test('tries primary once, saves successful fallback summaries with fallback model', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async (_prompt, options) => {
      primaryCalls++;
      assert.equal(options?.model, 'primary-model');
      return {
        success: false,
        response: '',
        modelUsed: 'primary-model',
        executionTimeMs: 1,
        error: 'insufficient quota. Try again after upgrading.'
      };
    });
    const fallbackAgent = createAgent('fallback', 'fallback-model', async (_prompt, options) => {
      fallbackCalls++;
      assert.equal(options?.model, 'fallback-model');
      return {
        success: true,
        response: JSON.stringify({
          summaries: [{ path: 'src/a.ts', summary: 'Exports the A helper and supports the feature.' }]
        }),
        modelUsed: 'fallback-model',
        executionTimeMs: 1
      };
    });

    const result = await processSingleBatch({
      fullName: 'integry/propr',
      batch: [{ path: 'src/a.ts', content: 'export const a = 1;', blobHash: 'abc123' }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fallbackAgent: fallbackAgent as never,
      fallbackModelOverride: 'fallback-model',
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback',
      branch: 'main'
    });

    assert.equal(result.success, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.stopProcessing, false);
    assert.equal(result.primaryAgentAlias, 'primary');
    assert.equal(result.fallbackAgentAlias, 'fallback');
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);

    const saved = await db('file_summaries')
      .where({ path: 'integry/propr/src/a.ts', branch: 'main' })
      .first();
    assert.equal(saved.summary, 'Exports the A helper and supports the feature.');
    assert.equal(saved.model_used, 'fallback-model');

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 1);
    assert.equal(state.primary_quota_failures_by_alias.primary, 1);
  });

  test('records cooldown and stops after non-quota fallback failure', async () => {
    const primaryAgent = createAgent('primary', 'primary-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'primary-model',
      executionTimeMs: 1,
      error: 'insufficient quota'
    }));
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => ({
      success: true,
      response: 'not json',
      modelUsed: 'fallback-model',
      executionTimeMs: 1
    }));

    const result = await processSingleBatch({
      fullName: 'integry/propr',
      batch: [{ path: 'src/a.ts', content: 'export const a = 1;', blobHash: 'abc123' }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback',
      branch: 'main'
    });

    assert.equal(result.success, false);
    assert.equal(result.stopProcessing, true);

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 1);
    assert.equal(state.primary_quota_failures_by_alias.primary, 1);
    assert.equal(Object.keys(state.cooldowns).length, 1);
    assert.equal(state.warning?.mode, 'cooldown');
    assert.match(state.warning?.message || '', /fallback summarization failed/);
  });

  test('records cooldown and stops after fallback quota failure', async () => {
    const primaryAgent = createAgent('primary', 'primary-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'primary-model',
      executionTimeMs: 1,
      error: 'insufficient quota'
    }));
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'fallback-model',
      executionTimeMs: 1,
      error: 'fallback quota exceeded'
    }));

    const result = await processSingleBatch({
      fullName: 'integry/propr',
      batch: [{ path: 'src/a.ts', content: 'export const a = 1;', blobHash: 'abc123' }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback',
      branch: 'main'
    });

    assert.equal(result.success, false);
    assert.equal(result.stopProcessing, true);

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.warning?.mode, 'cooldown');
    assert.equal(Object.keys(state.cooldowns).length, 1);
  });

  test('directory batch fallback tracks model-specific primary and fallback aliases', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-default', async (_prompt, options) => {
      primaryCalls++;
      assert.equal(options?.model, 'gpt-expensive');
      return {
        success: false,
        response: '',
        modelUsed: 'gpt-expensive',
        executionTimeMs: 1,
        error: 'insufficient quota'
      };
    });
    const fallbackAgent = createAgent('fallback', 'fallback-default', async (_prompt, options) => {
      fallbackCalls++;
      assert.equal(options?.model, 'gpt-cheap');
      return {
        success: true,
        response: JSON.stringify({
          summaries: [{ path: 'integry/propr/src', summary: 'Contains source modules and shared helpers.' }]
        }),
        modelUsed: 'gpt-cheap',
        executionTimeMs: 1
      };
    });

    const result = await processDirectoryBatch({
      directories: [{
        dirPath: 'integry/propr/src',
        childFiles: [{ path: 'integry/propr/src/a.ts', summary: 'Exports A.' }],
        childDirs: [],
        newHash: 'hash-a'
      }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'gpt-expensive',
      primaryAgentAliasSetting: 'primary:gpt-expensive',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'gpt-cheap',
      fallbackAgentAliasSetting: 'fallback:gpt-cheap',
      fullName: 'integry/propr',
      branch: 'main'
    });

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.stopProcessing, false);
    assert.equal(result.primaryAgentAlias, 'primary:gpt-expensive');
    assert.equal(result.fallbackAgentAlias, 'fallback:gpt-cheap');
    assert.equal(result[0].summary, 'Contains source modules and shared helpers.');
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures_by_alias['primary:gpt-expensive'], 1);
  });

  test('directory batch records cooldown and stops after fallback quota failure', async () => {
    const primaryAgent = createAgent('primary', 'primary-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'primary-model',
      executionTimeMs: 1,
      error: 'primary quota exceeded'
    }));
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'fallback-model',
      executionTimeMs: 1,
      error: 'fallback quota exceeded'
    }));

    const result = await processDirectoryBatch({
      directories: [{
        dirPath: 'integry/propr/src',
        childFiles: [{ path: 'integry/propr/src/a.ts', summary: 'Exports A.' }],
        childDirs: [],
        newHash: 'hash-a'
      }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary:model-a',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback:model-b',
      fullName: 'integry/propr',
      branch: 'main'
    });

    assert.equal(result.fallbackUsed, false);
    assert.equal(result.stopProcessing, true);

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.warning?.mode, 'cooldown');
    assert.equal(state.warning?.primary_agent_alias, 'primary:model-a');
    assert.equal(state.warning?.fallback_agent_alias, 'fallback:model-b');
    assert.equal(Object.keys(state.cooldowns).length, 1);
  });
});
