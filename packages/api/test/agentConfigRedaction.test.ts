import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, type AgentConfig } from '@propr/core';
import {
  REDACTED_AGENT_ENV_VALUE,
  redactAgentConfigSecrets,
  restoreRedactedAgentEnvVars,
} from '@propr/shared';
import { createAgentsRoutes } from '../routes/configRoutesAgents.js';

after(async () => closeConnection());

// Unmistakably synthetic sentinels; none of these is a real credential.
const SENTINEL_API_KEY = 'SENTINEL-NOT-A-REAL-SECRET-api-key-0000';
const SENTINEL_TOKEN = 'SENTINEL-NOT-A-REAL-SECRET-token-1111';
const SENTINEL_REPLACEMENT = 'SENTINEL-NOT-A-REAL-SECRET-replacement-2222';
const SENTINELS = [SENTINEL_API_KEY, SENTINEL_TOKEN, SENTINEL_REPLACEMENT];

function assertNoSentinel(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `serialized output leaked ${sentinel}`);
    assert.equal(serialized.includes(sentinel.slice(0, 12)), false, 'serialized output leaked a secret prefix');
    assert.equal(serialized.includes(Buffer.from(sentinel).toString('base64')), false, 'serialized output leaked an encoded secret');
  }
}

function storedAgent(): AgentConfig {
  return {
    id: 'vibe-agent-id',
    type: 'vibe',
    alias: 'vibe-primary',
    enabled: false,
    dockerImage: 'propr/agent:test',
    configPath: '~/.vibe',
    supportedModels: ['devstral-2'],
    defaultModel: 'devstral-2',
    envVars: { MISTRAL_API_KEY: SENTINEL_API_KEY, EXTRA_PROVIDER_TOKEN: SENTINEL_TOKEN },
  };
}

async function createConfigDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('system_configs', table => {
    table.string('key').primary();
    table.text('value');
    table.timestamp('created_at');
    table.timestamp('updated_at');
  });
  return database;
}

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  } as unknown as Response;
  return { response, record };
}

function createRoutes(database: Knex, stored: AgentConfig[]) {
  return createAgentsRoutes({
    redisClient: { set: async () => 'OK', eval: async () => 1 } as never,
    publishConfigUpdate: async () => undefined,
    logActivityHelper: async () => undefined,
    configStore: {
      loadAgents: async () => structuredClone(stored),
      loadSyntheticAgents: async () => [],
      loadSettings: async () => ({ default_agent_alias: 'vibe-primary' }),
      handleSettingsSaveSideEffects: async () => undefined,
    } as never,
    database,
    registry: { refresh: async () => undefined, setDefaultAgentAlias: () => undefined },
  });
}

async function persistedAgents(database: Knex): Promise<AgentConfig[]> {
  const row = await database('system_configs').where({ key: 'agents' }).first();
  return JSON.parse(row.value);
}

describe('agent configuration output redaction', () => {
  test('GET /api/config/agents exposes env var names but never their values', async () => {
    const database = await createConfigDatabase();
    try {
      const { response, record } = responseRecorder();
      await createRoutes(database, [storedAgent()]).getAgents({} as Request, response);

      assert.equal(record.status, 200);
      assertNoSentinel(record.body);
      const [agent] = (record.body as { agents: AgentConfig[] }).agents;
      assert.deepEqual(agent.envVars, {
        MISTRAL_API_KEY: REDACTED_AGENT_ENV_VALUE,
        EXTRA_PROVIDER_TOKEN: REDACTED_AGENT_ENV_VALUE,
      });
      assert.equal(agent.alias, 'vibe-primary');
    } finally {
      await database.destroy();
    }
  });

  test('POST round-trip of the redacted list keeps stored secrets and returns a redacted body', async () => {
    const database = await createConfigDatabase();
    try {
      const stored = [storedAgent()];
      const routes = createRoutes(database, stored);
      const read = responseRecorder();
      await routes.getAgents({} as Request, read.response);
      const redacted = (read.record.body as { agents: AgentConfig[] }).agents;

      const write = responseRecorder();
      await routes.postAgents({ body: { agents: [{ ...redacted[0], enabled: true }] } } as Request, write.response);

      assert.equal(write.record.status, 200, JSON.stringify(write.record.body));
      assertNoSentinel(write.record.body);
      const [persisted] = await persistedAgents(database);
      assert.equal(persisted.enabled, true);
      // Runtime configuration still holds the real values.
      assert.deepEqual(persisted.envVars, storedAgent().envVars);
    } finally {
      await database.destroy();
    }
  });

  test('POST applies replaced and removed values without echoing them', async () => {
    const database = await createConfigDatabase();
    try {
      const write = responseRecorder();
      await createRoutes(database, [storedAgent()]).postAgents({
        body: { agents: [{ ...storedAgent(), envVars: { MISTRAL_API_KEY: SENTINEL_REPLACEMENT } }] },
      } as Request, write.response);

      assert.equal(write.record.status, 200, JSON.stringify(write.record.body));
      assertNoSentinel(write.record.body);
      const [persisted] = await persistedAgents(database);
      assert.deepEqual(persisted.envVars, { MISTRAL_API_KEY: SENTINEL_REPLACEMENT });
    } finally {
      await database.destroy();
    }
  });

  test('POST rejects a redaction marker with no stored value instead of persisting it', async () => {
    const database = await createConfigDatabase();
    try {
      const write = responseRecorder();
      await createRoutes(database, [storedAgent()]).postAgents({
        body: { agents: [{ ...storedAgent(), envVars: { UNKNOWN_KEY: REDACTED_AGENT_ENV_VALUE } }] },
      } as Request, write.response);

      assert.equal(write.record.status, 400);
      assertNoSentinel(write.record.body);
      assert.match((write.record.body as { error: string }).error, /UNKNOWN_KEY/);
      assert.equal(await database('system_configs').where({ key: 'agents' }).first(), undefined);
    } finally {
      await database.destroy();
    }
  });

  test('redaction helpers never carry values across agents and tolerate malformed env vars', () => {
    assert.deepEqual(redactAgentConfigSecrets({ id: 'a', envVars: 'not-an-object' }).envVars, {});
    assert.deepEqual(redactAgentConfigSecrets({ id: 'a' }), { id: 'a' });
    const restored = restoreRedactedAgentEnvVars(
      [{ id: 'other-agent', envVars: { MISTRAL_API_KEY: REDACTED_AGENT_ENV_VALUE } }],
      [storedAgent()],
    );
    assert.ok(restored.error);
    assertNoSentinel(restored);
  });
});
