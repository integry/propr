import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SUMMARIZATION_FALLBACK_PROMOTE_THRESHOLD = '2';
process.env.SUMMARIZATION_QUOTA_COOLDOWN_MS = '60000';

const {
  db,
  runMigrations,
  closeConnection,
  saveSummarizationSettings,
  loadSummarizationSettings,
  loadSummarizationRuntimeState,
  recordPrimarySummarizationQuotaFailure,
  recordSummarizationCooldown,
  getSummarizationCooldown,
  clearSummarizationCooldown,
  clearSummarizationPrimaryQuotaFailures,
  recordPrimarySummarizationResponseFailure
} = await import('../packages/core/src/index.js');

describe('summarization fallback runtime state', () => {
  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db('system_configs').whereIn('key', ['summarization', 'summarization_runtime_state']).delete();
  });

  after(async () => {
    await closeConnection();
  });

  test('promotes fallback after repeated primary quota failures and preserves old primary as fallback', async () => {
    await saveSummarizationSettings({
      enabled: true,
      agent_alias: 'primary:gpt-expensive',
      fallback_agent_alias: 'fallback:gpt-cheap',
      custom_prompt: 'Summarize carefully'
    });

    const first = await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary:gpt-expensive',
      fallbackAgentAlias: 'fallback:gpt-cheap'
    });
    assert.equal(first.promoted, false);
    assert.equal(first.failureCount, 1);

    const second = await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary:gpt-expensive',
      fallbackAgentAlias: 'fallback:gpt-cheap'
    });
    assert.equal(second.promoted, true);
    assert.equal(second.failureCount, 0);
    assert.equal(second.warning.mode, 'fallback_promoted');

    const settings = await loadSummarizationSettings();
    assert.equal(settings.agent_alias, 'fallback:gpt-cheap');
    assert.equal(settings.fallback_agent_alias, 'primary:gpt-expensive');
    assert.equal(settings.custom_prompt, 'Summarize carefully');

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 0);
    assert.deepEqual(state.primary_quota_failures_by_alias, {});
    assert.equal(state.warning?.mode, 'fallback_promoted');
  });

  test('normalizes whitespace-padded aliases before persistence and promotion', async () => {
    await saveSummarizationSettings({
      enabled: true,
      agent_alias: ' primary:gpt-expensive ',
      fallback_agent_alias: ' fallback:gpt-cheap ',
      custom_prompt: ''
    });

    let settings = await loadSummarizationSettings();
    assert.equal(settings.agent_alias, 'primary:gpt-expensive');
    assert.equal(settings.fallback_agent_alias, 'fallback:gpt-cheap');

    await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary:gpt-expensive',
      fallbackAgentAlias: 'fallback:gpt-cheap'
    });
    const result = await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary:gpt-expensive',
      fallbackAgentAlias: 'fallback:gpt-cheap'
    });

    assert.equal(result.promoted, true);
    settings = await loadSummarizationSettings();
    assert.equal(settings.agent_alias, 'fallback:gpt-cheap');
    assert.equal(settings.fallback_agent_alias, 'primary:gpt-expensive');
  });

  test('promotes fallback after primary returns unusable summarization output', async () => {
    await saveSummarizationSettings({
      enabled: true,
      agent_alias: 'antigravity:antigravity-gpt-oss-120b-medium',
      fallback_agent_alias: 'claude:claude-haiku-4-5-20251001',
      custom_prompt: 'Summarize carefully'
    });

    const result = await recordPrimarySummarizationResponseFailure({
      primaryAgentAlias: 'antigravity:antigravity-gpt-oss-120b-medium',
      fallbackAgentAlias: 'claude:claude-haiku-4-5-20251001',
      reason: 'No valid summaries parsed for batch of 5 files'
    });

    assert.equal(result.promoted, true);
    assert.equal(result.warning.mode, 'fallback_promoted');

    const settings = await loadSummarizationSettings();
    assert.equal(settings.agent_alias, 'claude:claude-haiku-4-5-20251001');
    assert.equal(settings.fallback_agent_alias, 'antigravity:antigravity-gpt-oss-120b-medium');
    assert.equal(settings.custom_prompt, 'Summarize carefully');
  });

  test('promotion clears stale alias failure counters', async () => {
    await saveSummarizationSettings({
      enabled: true,
      agent_alias: 'primary',
      fallback_agent_alias: 'fallback',
      custom_prompt: ''
    });
    await db('system_configs').insert({
      key: 'summarization_runtime_state',
      value: JSON.stringify({
        primary_quota_failures: 1,
        primary_quota_failures_by_alias: { stale: 4, primary: 1 },
        cooldowns: {}
      }),
      created_at: db.fn.now(),
      updated_at: db.fn.now()
    });

    const result = await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary',
      fallbackAgentAlias: 'fallback'
    });

    assert.equal(result.promoted, true);
    const state = await loadSummarizationRuntimeState();
    assert.deepEqual(state.primary_quota_failures_by_alias, {});
  });

  test('records and returns repository branch cooldown', async () => {
    const cooldown = await recordSummarizationCooldown({
      repository: 'integry/propr',
      branch: 'main',
      primaryAgentAlias: 'primary',
      fallbackAgentAlias: 'fallback'
    });

    assert.equal(cooldown.repository, 'integry/propr');
    assert.equal(cooldown.branch, 'main');
    assert.ok(Date.parse(cooldown.until) > Date.now());

    const loaded = await getSummarizationCooldown('integry/propr', 'main');
    assert.equal(loaded?.repository, 'integry/propr');
    assert.equal(loaded?.fallback_agent_alias, 'fallback');

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.warning?.mode, 'cooldown');
    assert.equal(Object.keys(state.cooldowns).length, 1);

    const persisted = await db('system_configs').where({ key: 'summarization_runtime_state' }).first();
    assert.ok(!String(persisted.value).includes('\\u0000'));
  });

  test('runtime state reads normalize expired cooldowns without writing persisted state', async () => {
    const persistedState = {
      primary_quota_failures: 0,
      primary_quota_failures_by_alias: {},
      warning: {
        mode: 'cooldown',
        message: 'expired',
        recorded_at: new Date(Date.now() - 120000).toISOString(),
        repository: 'integry/propr',
        branch: 'main'
      },
      cooldowns: {
        expired: {
          repository: 'integry/propr',
          branch: 'main',
          until: new Date(Date.now() - 60000).toISOString(),
          reason: 'expired'
        }
      }
    };
    await db('system_configs').insert({
      key: 'summarization_runtime_state',
      value: JSON.stringify(persistedState),
      created_at: db.fn.now(),
      updated_at: db.fn.now()
    });

    const loaded = await loadSummarizationRuntimeState();
    assert.deepEqual(loaded.cooldowns, {});
    assert.equal(loaded.warning, undefined);

    const persisted = await db('system_configs').where({ key: 'summarization_runtime_state' }).first();
    assert.equal(persisted.value, JSON.stringify(persistedState));
  });

  test('clears quota warning after primary summarization success', async () => {
    await recordPrimarySummarizationQuotaFailure({
      primaryAgentAlias: 'primary',
      fallbackAgentAlias: 'fallback'
    });

    let state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 1);
    assert.equal(state.warning?.mode, 'fallback_degraded');

    await clearSummarizationPrimaryQuotaFailures();

    state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 0);
    assert.equal(state.warning, undefined);
  });

  test('primary success clears counters without deleting cooldown warning', async () => {
    await recordSummarizationCooldown({
      repository: 'integry/propr',
      branch: 'main',
      primaryAgentAlias: 'primary',
      fallbackAgentAlias: 'fallback'
    });

    await clearSummarizationPrimaryQuotaFailures();

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.primary_quota_failures, 0);
    assert.equal(state.warning?.mode, 'cooldown');
    assert.equal(Object.keys(state.cooldowns).length, 1);
  });

  test('explicit cooldown clear removes matching repository warning', async () => {
    await recordSummarizationCooldown({
      repository: 'integry/propr',
      branch: 'main',
      primaryAgentAlias: 'primary',
      fallbackAgentAlias: 'fallback'
    });

    await clearSummarizationCooldown('integry/propr', 'main');

    const state = await loadSummarizationRuntimeState();
    assert.equal(state.warning, undefined);
    assert.deepEqual(state.cooldowns, {});
  });

  test('cooldown clear preserves newer cooldown with different model aliases', async () => {
    await recordSummarizationCooldown({
      repository: 'integry/propr',
      branch: 'main',
      primaryAgentAlias: 'primary-new',
      fallbackAgentAlias: 'fallback-new'
    });

    await clearSummarizationCooldown('integry/propr', 'main', {
      primaryAgentAlias: 'primary-old',
      fallbackAgentAlias: 'fallback-old',
      clearDegradationWarning: true
    });

    const state = await loadSummarizationRuntimeState();
    assert.equal(Object.keys(state.cooldowns).length, 1);
    assert.equal(state.warning?.mode, 'cooldown');
    const cooldown = await getSummarizationCooldown('integry/propr', 'main');
    assert.equal(cooldown?.primary_agent_alias, 'primary-new');
    assert.equal(cooldown?.fallback_agent_alias, 'fallback-new');
  });
});
