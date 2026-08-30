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
const { SyntheticRoutingService } = await import('../packages/core/src/services/syntheticRoutingService.js');

function createAgent(alias: string, defaultModel: string, analyze: (prompt: string, options?: { model?: string; suppressLlmLog?: boolean }) => Promise<unknown>) {
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
    assert.notEqual(state.warning?.mode, 'cooldown');
  });

  test('uses fallback when the primary returns unusable output', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => {
      primaryCalls++;
      return {
        success: true,
        response: '',
        modelUsed: 'primary-model',
        executionTimeMs: 1
      };
    });
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => {
      fallbackCalls++;
      return {
        success: true,
        response: JSON.stringify({
          summaries: [{ path: 'src/a.ts', summary: 'Exports the A helper after fallback parsing succeeds.' }]
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
    assert.equal(primaryCalls, 3);
    assert.equal(fallbackCalls, 1);

    const saved = await db('file_summaries')
      .where({ path: 'integry/propr/src/a.ts', branch: 'main' })
      .first();
    assert.equal(saved.summary, 'Exports the A helper after fallback parsing succeeds.');
    assert.equal(saved.model_used, 'fallback-model');

    const state = await loadSummarizationRuntimeState();
    assert.equal(Object.keys(state.cooldowns).length, 0);
    assert.equal(state.primary_quota_failures, 0);
    assert.equal(state.warning?.mode, 'fallback_degraded');
  });

  test('records cooldown after unusable file output when no fallback is configured', async () => {
    let primaryCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => {
      primaryCalls++;
      return {
        success: true,
        response: '',
        modelUsed: 'primary-model',
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
      branch: 'main'
    });

    assert.equal(result.success, false);
    assert.equal(result.stopProcessing, true);
    assert.equal(primaryCalls, 3);

    const state = await loadSummarizationRuntimeState();
    assert.equal(Object.keys(state.cooldowns).length, 1);
    assert.equal(state.warning?.mode, 'cooldown');
    assert.match(state.warning?.message || '', /unusable output/);
  });

  test('logs the last physical route when all synthetic summarization members fail', async () => {
    const firstAgent = createAgent('route-large', 'claude-opus-4-6', async (_prompt, options) => {
      assert.equal(options?.model, 'claude-opus-4-6');
      assert.equal(options?.suppressLlmLog, true);
      return {
        success: false,
        response: '',
        modelUsed: 'claude-opus-4-6',
        executionTimeMs: 1,
        error: 'primary provider unavailable'
      };
    });
    const secondAgent = createAgent('route-small', 'gpt-5-mini', async (_prompt, options) => {
      assert.equal(options?.model, 'gpt-5-mini');
      assert.equal(options?.suppressLlmLog, true);
      return {
        success: false,
        response: '',
        modelUsed: 'gpt-5-mini',
        executionTimeMs: 1,
        error: 'secondary provider unavailable'
      };
    });
    const agents = new Map([
      [firstAgent.config.alias, firstAgent],
      [secondAgent.config.alias, secondAgent]
    ]);
    const router = new SyntheticRoutingService({
      database: db,
      loadSyntheticConfigs: async () => [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        alias: 'summary-pool',
        enabled: true,
        defaultModel: 'smart',
        models: [{
          id: 'smart',
          enabled: true,
          strategy: 'round_robin',
          members: [
            { id: '33333333-3333-4333-8333-333333333333', directAgentAlias: 'route-large', model: 'claude-opus-4-6', enabled: true, priority: 100 },
            { id: '44444444-4444-4444-8444-444444444444', directAgentAlias: 'route-small', model: 'gpt-5-mini', enabled: true, priority: 0 }
          ]
        }]
      }],
      getDirectAgent: alias => agents.get(alias) as never,
      usageSnapshotProvider: { getSnapshot: async () => null }
    });
    const virtualAgent = createAgent('summary-pool', 'smart', async () => {
      throw new Error('synthetic facade should not be invoked directly');
    });

    const result = await processSingleBatch({
      fullName: 'integry/propr',
      batch: [{ path: 'src/a.ts', content: 'export const a = 1;', blobHash: 'abc123' }],
      agent: virtualAgent as never,
      log: log as never,
      modelUsed: 'smart',
      primaryAgentAliasSetting: 'summary-pool',
      branch: 'main',
      routingSession: router.begin({ requestedAgentAlias: 'summary-pool', requestedModel: 'smart' })
    });

    assert.equal(result.success, false);
    const llmLog = await db('llm_logs').orderBy('log_id', 'desc').first();
    assert.equal(llmLog.agent_alias, 'route-small');
    assert.equal(llmLog.model_name, 'gpt-5-mini');
    const metadata = JSON.parse(llmLog.metadata);
    assert.equal(metadata.syntheticRouting.virtualAgentAlias, 'summary-pool');
    assert.equal(metadata.syntheticRouting.virtualModel, 'smart');
    assert.equal(metadata.syntheticRouting.physicalAgentAlias, 'route-small');
    assert.equal(metadata.syntheticRouting.physicalModel, 'gpt-5-mini');
    assert.equal(metadata.syntheticRouting.attemptNumber, 2);
  });

  test('caps the fallback model to a single attempt on transient failure', async () => {
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'primary-model',
      executionTimeMs: 1,
      error: 'insufficient quota'
    }));
    // A transient (retryable) failure would loop multiple times under the
    // default retry config; the fallback must be tried exactly once.
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => {
      fallbackCalls++;
      return {
        success: false,
        response: '',
        modelUsed: 'fallback-model',
        executionTimeMs: 1,
        error: 'service temporarily unavailable, try again'
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

    assert.equal(result.success, false);
    assert.equal(result.stopProcessing, true);
    assert.equal(fallbackCalls, 1);
  });

  test('directory batch caps the fallback model to a single attempt on transient failure', async () => {
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => ({
      success: false,
      response: '',
      modelUsed: 'primary-model',
      executionTimeMs: 1,
      error: 'insufficient quota'
    }));
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => {
      fallbackCalls++;
      return {
        success: false,
        response: '',
        modelUsed: 'fallback-model',
        executionTimeMs: 1,
        error: 'service temporarily unavailable, try again'
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
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback',
      fullName: 'integry/propr',
      branch: 'main'
    });

    assert.equal(result.stopProcessing, true);
    assert.equal(fallbackCalls, 1);
  });

  test('directory batch uses fallback when the primary returns unusable output', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => {
      primaryCalls++;
      return {
        success: true,
        response: '',
        modelUsed: 'primary-model',
        executionTimeMs: 1
      };
    });
    const fallbackAgent = createAgent('fallback', 'fallback-model', async () => {
      fallbackCalls++;
      return {
        success: true,
        response: JSON.stringify({
          summaries: [{ path: 'integry/propr/src', summary: 'Contains source modules and shared helpers.' }]
        }),
        modelUsed: 'fallback-model',
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
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fallbackAgent: fallbackAgent as never,
      fallbackModelUsed: 'fallback-model',
      fallbackAgentAliasSetting: 'fallback',
      fullName: 'integry/propr',
      branch: 'main'
    });

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.stopProcessing, false);
    assert.equal(result[0].summary, 'Contains source modules and shared helpers.');
    assert.equal(primaryCalls, 3);
    assert.equal(fallbackCalls, 1);

    const state = await loadSummarizationRuntimeState();
    assert.equal(Object.keys(state.cooldowns).length, 0);
    assert.equal(state.primary_quota_failures, 0);
    assert.equal(state.warning?.mode, 'fallback_degraded');
  });

  test('records cooldown after unusable directory output when no fallback is configured', async () => {
    let primaryCalls = 0;
    const primaryAgent = createAgent('primary', 'primary-model', async () => {
      primaryCalls++;
      return {
        success: true,
        response: '',
        modelUsed: 'primary-model',
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
      modelUsed: 'primary-model',
      primaryAgentAliasSetting: 'primary',
      fullName: 'integry/propr',
      branch: 'main'
    });

    assert.equal(result.fallbackUsed, false);
    assert.equal(result.stopProcessing, true);
    assert.equal(primaryCalls, 3);

    const state = await loadSummarizationRuntimeState();
    assert.equal(Object.keys(state.cooldowns).length, 1);
    assert.equal(state.warning?.mode, 'cooldown');
    assert.match(state.warning?.message || '', /unusable output/);
  });

  test('passes custom prompt into file batch prompt', async () => {
    let receivedPrompt = '';
    const customPrompt = 'Use security-focused summaries for every file.';
    const primaryAgent = createAgent('primary', 'primary-model', async (prompt, options) => {
      receivedPrompt = prompt;
      assert.equal(options?.model, 'primary-model');
      return {
        success: true,
        response: JSON.stringify({
          summaries: [{ path: 'src/a.ts', summary: 'Exports a security-sensitive helper.' }]
        }),
        modelUsed: 'primary-model',
        executionTimeMs: 1
      };
    });

    const result = await processSingleBatch({
      fullName: 'integry/propr',
      batch: [{ path: 'src/a.ts', content: 'export const a = 1;', blobHash: 'abc123' }],
      agent: primaryAgent as never,
      log: log as never,
      modelUsed: 'primary-model',
      customPrompt,
      primaryAgentAliasSetting: 'primary',
      branch: 'main'
    });

    assert.equal(result.success, true);
    assert.match(receivedPrompt, new RegExp(customPrompt));
    assert.doesNotMatch(receivedPrompt, /Your task is to create concise/);
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
