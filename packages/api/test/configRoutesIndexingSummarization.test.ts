import { test } from 'node:test';
import assert from 'node:assert/strict';

test('postSummarizationSettings trims model-specific aliases before saving', async () => {
  process.env.NODE_ENV = 'test';
  process.env.PROPR_DEMO_MODE = 'true';
  const configManager = await import('@propr/core');
  const { createIndexingRoutes } = await import('../routes/configRoutesIndexing.js');
  await configManager.runMigrations();
  await configManager.db('system_configs').whereIn('key', ['agents', 'summarization', 'summarization_runtime_state']).delete();
  await configManager.db('system_configs').insert({
    key: 'agents',
    value: JSON.stringify([
      {
        id: 'codex',
        alias: 'codex',
        type: 'codex',
        enabled: true,
        dockerImage: '',
        configPath: '',
        supportedModels: ['gpt-5.5'],
        defaultModel: 'gpt-5.5',
      },
      {
        id: 'fallback',
        alias: 'fallback',
        type: 'codex',
        enabled: true,
        dockerImage: '',
        configPath: '',
        supportedModels: ['gpt-5.4'],
        defaultModel: 'gpt-5.4',
      },
    ]),
    created_at: configManager.db.fn.now(),
    updated_at: configManager.db.fn.now(),
  });
  const published: string[] = [];
  const routes = createIndexingRoutes({
    redisClient: {} as never,
    publishConfigUpdate: async subtype => { published.push(subtype); },
    logActivityHelper: async () => {},
  });
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };

  try {
    await routes.postSummarizationSettings({
      body: {
        enabled: true,
        agent_alias: ' codex:gpt-5.5 ',
        fallback_agent_alias: ' fallback:gpt-5.4 ',
        custom_prompt: '',
      },
    } as never, res as never);

    assert.equal(res.statusCode, 200);
    const savedSettings = await configManager.loadSummarizationSettings();
    assert.deepEqual(savedSettings, {
      enabled: true,
      agent_alias: 'codex:gpt-5.5',
      fallback_agent_alias: 'fallback:gpt-5.4',
      custom_prompt: '',
    });
    assert.equal(res.body?.agent_alias, 'codex:gpt-5.5');
    assert.equal(res.body?.fallback_agent_alias, 'fallback:gpt-5.4');
    assert.deepEqual(published, ['summarization_settings_update']);
  } finally {
    await configManager.closeConnection();
  }
});

test('postSummarizationSettings rejects enabled summarization without a primary alias', async () => {
  process.env.NODE_ENV = 'test';
  process.env.PROPR_DEMO_MODE = 'true';
  const { createIndexingRoutes } = await import('../routes/configRoutesIndexing.js');
  const routes = createIndexingRoutes({
    redisClient: {} as never,
    publishConfigUpdate: async () => {},
    logActivityHelper: async () => {},
  });
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };

  await routes.postSummarizationSettings({
    body: {
      enabled: true,
      agent_alias: ' ',
      fallback_agent_alias: '',
      custom_prompt: '',
    },
  } as never, res as never);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'agent_alias is required when summarization is enabled' });
});
