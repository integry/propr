import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import {
  closeConnection,
  loadSyntheticAgents,
  saveSyntheticAgents,
  type AgentConfig,
} from '@propr/core';
import {
  parseSyntheticAgentConfigs,
  type SyntheticAgentConfig,
} from '@propr/shared';
import { applyAgentsUpdate } from '../routes/configRoutesAgents.js';
import { createConfigRoutes } from '../routes/configRoutes.js';
import { createSyntheticAgentConfigRoutes } from '../routes/configRoutesSyntheticAgents.js';
import { createInstanceCatalogRoutes } from '../routes/instanceCatalogRoutes.js';

after(async () => closeConnection());

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';

function directAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'direct-agent-id',
    type: 'codex',
    alias: 'codex-primary',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/tmp/codex-primary',
    supportedModels: ['gpt-5.6-sol'],
    defaultModel: 'gpt-5.6-sol',
    ...overrides,
  };
}

function syntheticAgent(): SyntheticAgentConfig {
  return {
    id: AGENT_ID,
    alias: 'balanced-pool',
    enabled: true,
    defaultModel: 'balanced',
    models: [{
      id: 'balanced',
      displayName: 'Balanced',
      enabled: true,
      strategy: 'round_robin',
      members: [{
        id: MEMBER_ID,
        directAgentAlias: 'codex-primary',
        model: 'gpt-5.6-sol',
        enabled: true,
        priority: 100,
        usageLimits: { sessionMaxPercent: 80, weeklyMaxPercent: 90 },
      }],
    }],
  };
}

function cloneConfig(): SyntheticAgentConfig[] {
  return structuredClone([syntheticAgent()]);
}

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  } as unknown as Response;
  return { response, record };
}

function redisLockClient() {
  return {
    set: async () => 'OK',
    eval: async () => 1,
  } as never;
}

async function createConfigDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await database.schema.createTable('system_configs', table => {
    table.string('key').primary();
    table.text('value');
    table.timestamp('created_at');
    table.timestamp('updated_at');
  });
  return database;
}

describe('synthetic agent persistence and API', () => {
  test('persists in its own config document and round-trips unchanged', async () => {
    const database = await createConfigDatabase();
    try {
      const original = [syntheticAgent()];
      await saveSyntheticAgents(original, database);
      const saved = await loadSyntheticAgents(database);
      const row = await database('system_configs').where({ key: 'synthetic_agents' }).first();

      assert.deepEqual(saved, original);
      assert.ok(row);
      assert.equal(await database('system_configs').where({ key: 'agents' }).first(), undefined);
    } finally {
      await database.destroy();
    }
  });

  test('configuration handlers round-trip valid input and return actionable 400 errors', async () => {
    let stored: SyntheticAgentConfig[] = [];
    const routes = createSyntheticAgentConfigRoutes({
      redisClient: redisLockClient(),
      configStore: {
        loadAgents: async () => [directAgent()],
        loadSettings: async () => ({}),
        loadSyntheticAgents: async () => stored,
        saveSyntheticAgents: async value => {
          stored = parseSyntheticAgentConfigs(value);
          return stored;
        },
      },
      publishConfigUpdate: async () => undefined,
      logActivityHelper: async () => undefined,
    });
    const post = responseRecorder();

    await routes.postSyntheticAgents({
      body: { synthetic_agents: [syntheticAgent()] },
      user: { username: 'admin' },
    } as Request, post.response);
    assert.equal(post.record.status, 200);
    assert.deepEqual((post.record.body as { synthetic_agents: unknown }).synthetic_agents, [syntheticAgent()]);

    const get = responseRecorder();
    await routes.getSyntheticAgents({} as Request, get.response);
    assert.deepEqual(get.record.body, { synthetic_agents: [syntheticAgent()] });

    const invalid = cloneConfig();
    invalid[0].models[0].members[0].priority = -1;
    const bad = responseRecorder();
    await routes.postSyntheticAgents({ body: { synthetic_agents: invalid } } as Request, bad.response);
    assert.equal(bad.record.status, 400);
    assert.match((bad.record.body as { error: string }).error, /synthetic_agents\.0\.models\.0\.members\.0\.priority/);

    const unknown = cloneConfig();
    unknown[0].models[0].members[0].model = 'unknown-model';
    const unknownResponse = responseRecorder();
    await routes.postSyntheticAgents({ body: { synthetic_agents: unknown } } as Request, unknownResponse.response);
    assert.equal(unknownResponse.record.status, 400);
    assert.match((unknownResponse.record.body as { error: string }).error, /unsupported model/);
  });

  test('rejects replacements when the configured default is in the previous or proposed synthetic set', async () => {
    const noEnabledMembers = syntheticAgent();
    noEnabledMembers.models[0].members[0].enabled = false;
    const replacements: Array<[string, SyntheticAgentConfig[], SyntheticAgentConfig[]]> = [
      ['unchanged', [syntheticAgent()], [syntheticAgent()]],
      ['newly introduced', [], [syntheticAgent()]],
      ['removed', [syntheticAgent()], []],
      ['disabled', [syntheticAgent()], [{ ...syntheticAgent(), enabled: false }]],
      ['without an executable default model', [syntheticAgent()], [noEnabledMembers]],
    ];

    for (const [name, previous, replacement] of replacements) {
      let saved = false;
      let published = false;
      const routes = createSyntheticAgentConfigRoutes({
        redisClient: redisLockClient(),
        configStore: {
          loadAgents: async () => [directAgent()],
          loadSettings: async () => ({ default_agent_alias: 'balanced-pool' }),
          loadSyntheticAgents: async () => previous,
          saveSyntheticAgents: async value => {
            saved = true;
            return parseSyntheticAgentConfigs(value);
          },
        },
        publishConfigUpdate: async () => { published = true; },
        logActivityHelper: async () => undefined,
      });
      const response = responseRecorder();

      await routes.postSyntheticAgents({
        body: { synthetic_agents: replacement },
      } as Request, response.response);

      assert.equal(response.record.status, 409, name);
      assert.match((response.record.body as { error: string }).error, /Select a direct default agent first/, name);
      assert.equal(saved, false, name);
      assert.equal(published, false, name);
    }
  });

  test('rejects settings updates that select a synthetic default alias', async () => {
    const database = await createConfigDatabase();
    let published = false;
    try {
      const routes = createConfigRoutes({
        redisClient: {
          set: async () => 'OK',
          eval: async () => 1,
          publish: async () => { published = true; return 1; },
          lPush: async () => 1,
          lTrim: async () => 1,
        } as never,
        configStore: {
          loadSyntheticAgents: async () => [syntheticAgent()],
        },
        database,
      });
      const response = responseRecorder();

      await routes.postSettings({
        body: { settings: { default_agent_alias: ' balanced-pool ' } },
      } as Request, response.response);

      assert.equal(response.record.status, 409);
      assert.match((response.record.body as { error: string }).error, /cannot execute at runtime/i);
      assert.equal(
        await database('system_configs').where({ key: 'settings' }).first(),
        undefined,
      );
      assert.equal(published, false);
    } finally {
      await database.destroy();
    }
  });
});

describe('synthetic direct-agent integrity and catalog', () => {
  test('replaces a synthetic default with an executable direct default during a direct-agent update', async () => {
    const database = await createConfigDatabase();
    const previous = directAgent();
    const updated = { ...previous, configPath: '/tmp/codex-primary-updated' };
    const publishedUpdates: string[] = [];
    let appliedDefault: string | null | undefined;
    try {
      const result = await applyAgentsUpdate({
        agents: [updated],
        processedAgents: [updated],
        username: 'admin',
        publishConfigUpdate: async subtype => { publishedUpdates.push(subtype); },
        logActivityHelper: async () => undefined,
        configStore: {
          loadAgents: async () => [previous],
          loadSyntheticAgents: async () => [syntheticAgent()],
          loadSettings: async () => ({ default_agent_alias: 'balanced-pool' }),
          handleSettingsSaveSideEffects: async () => undefined,
        },
        database,
        registry: {
          refresh: async () => undefined,
          setDefaultAgentAlias: alias => { appliedDefault = alias; },
        },
      });

      assert.equal(result.status, 200);
      assert.equal(appliedDefault, 'codex-primary');
      assert.deepEqual(publishedUpdates, ['agents_update', 'settings_update']);
      const settingsRow = await database('system_configs').where({ key: 'settings' }).first();
      assert.ok(settingsRow);
      assert.deepEqual(JSON.parse(settingsRow.value), { default_agent_alias: 'codex-primary' });
    } finally {
      await database.destroy();
    }
  });

  test('blocks deletion of a referenced direct alias but permits disabling it', async () => {
    const database = await createConfigDatabase();
    const previous = directAgent();
    const configStore = {
      loadAgents: async () => [previous],
      loadSyntheticAgents: async () => [syntheticAgent()],
      loadSettings: async () => ({}),
      handleSettingsSaveSideEffects: async () => undefined,
    };
    const common = {
      username: 'admin',
      publishConfigUpdate: async () => undefined,
      logActivityHelper: async () => undefined,
      configStore,
      database,
      registry: {
        refresh: async () => undefined,
        setDefaultAgentAlias: () => undefined,
      },
    };
    try {
      const deletion = await applyAgentsUpdate({
        agents: [],
        processedAgents: [],
        ...common,
      });
      assert.equal(deletion.status, 409);
      assert.match((deletion.body as { error: string }).error, /balanced-pool:balanced/);

      const disabled = { ...previous, enabled: false };
      const disable = await applyAgentsUpdate({
        agents: [disabled],
        processedAgents: [disabled],
        ...common,
      });
      assert.equal(disable.status, 200);
    } finally {
      await database.destroy();
    }
  });

  test('projects enabled synthetic agents and models only in the instance catalog', async () => {
    const config = syntheticAgent();
    config.models.push({
      ...structuredClone(config.models[0]),
      id: 'disabled-model',
      enabled: false,
    });
    let syntheticLoads = 0;
    const routes = createInstanceCatalogRoutes({
      services: {
        loadAgents: async () => [
          directAgent(),
          directAgent({ id: 'disabled', alias: 'codex-disabled', enabled: false }),
        ],
        loadSyntheticAgents: async () => {
          syntheticLoads += 1;
          return [
            config,
            { ...syntheticAgent(), id: '44444444-4444-4444-8444-444444444444', alias: 'disabled-pool', enabled: false },
          ];
        },
        loadRepositories: async () => [],
        loadSettings: async () => ({ default_agent_alias: 'balanced-pool' }),
      },
    });
    const { response, record } = responseRecorder();

    await routes.getCatalog({} as Request, response);

    assert.deepEqual(record.body, {
      agents: [
        {
          id: 'direct-agent-id',
          kind: 'direct',
          alias: 'codex-primary',
          enabled: true,
          supportedModels: ['gpt-5.6-sol'],
          defaultModel: 'gpt-5.6-sol',
        },
        {
          id: AGENT_ID,
          kind: 'synthetic',
          alias: 'balanced-pool',
          enabled: true,
          supportedModels: ['balanced'],
          defaultModel: 'balanced',
        },
      ],
      repositories: [],
      defaultAgentAlias: 'balanced-pool',
    });

    const legacy = responseRecorder();
    await routes.getLegacyCatalog({} as Request, legacy.response);

    assert.deepEqual(legacy.record.body, {
      agents: [
        {
          id: 'direct-agent-id',
          kind: 'direct',
          alias: 'codex-primary',
          enabled: true,
          supportedModels: ['gpt-5.6-sol'],
          defaultModel: 'gpt-5.6-sol',
        },
      ],
      repositories: [],
    });
    assert.equal(syntheticLoads, 1);
  });
});
