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
    const primaryAgent = createAgent('primary', 'primary-model', async () => {
      primaryCalls++;
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

  test('records primary quota failure and stops after fallback failure', async () => {
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
      error: 'temporary fallback failure'
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
    assert.equal(state.warning?.mode, 'cooldown');
  });
});
