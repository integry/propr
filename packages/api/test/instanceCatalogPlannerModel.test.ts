import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection, type AgentConfig } from '@propr/core';
import { createInstanceCatalogRoutes } from '../routes/instanceCatalogRoutes.js';

// Importing @propr/core opens the shared database connection, which would keep the runner alive.
after(async () => closeConnection());

const directAgent: AgentConfig = {
  id: 'direct-agent-id',
  type: 'codex',
  alias: 'codex-primary',
  enabled: true,
  dockerImage: 'propr/agent:test',
  configPath: '/tmp/codex-primary',
  supportedModels: ['gpt-5.6-sol'],
  defaultModel: 'gpt-5.6-sol',
};

async function catalogFor(
  settings: Record<string, unknown>,
  loadUltrafixDefaults: () => Promise<{ ratingGoal: number; maxCycles: number }> = async () => ({ ratingGoal: 7, maxCycles: 5 }),
): Promise<Record<string, unknown>> {
  const routes = createInstanceCatalogRoutes({
    services: {
      loadAgents: async () => [directAgent],
      loadSyntheticAgents: async () => [],
      loadRepositories: async () => [],
      loadSettings: async () => settings,
      loadUltrafixDefaults,
    },
  });
  let body: unknown;
  const response = {
    status() { return response; },
    json(value: unknown) { body = value; return response; },
  } as unknown as Response;
  await routes.getCatalog({} as Request, response);
  return body as Record<string, unknown>;
}

describe('instance catalog planner model', () => {
  test('exposes the trimmed planner generation model override', async () => {
    const body = await catalogFor({ default_agent_alias: 'codex-primary', planner_generation_model: ' codex-primary:gpt-5.6-sol ' });
    assert.equal(body.plannerGenerationModel, 'codex-primary:gpt-5.6-sol');
    assert.equal(body.defaultAgentAlias, 'codex-primary');
  });

  test('omits the field when no override is configured', async () => {
    assert.equal('plannerGenerationModel' in await catalogFor({ planner_generation_model: '' }), false);
    assert.equal('plannerGenerationModel' in await catalogFor({}), false);
  });

  test('exposes the instance ultrafix defaults so forms can preselect them', async () => {
    const body = await catalogFor({}, async () => ({ ratingGoal: 9, maxCycles: 3 }));
    assert.deepEqual(body.ultrafixDefaults, { ratingGoal: 9, maxCycles: 3 });
  });

  test('omits the ultrafix defaults when they cannot be loaded', async () => {
    const body = await catalogFor({}, async () => { throw new Error('config store unavailable'); });
    assert.equal('ultrafixDefaults' in body, false);
    assert.ok(Array.isArray(body.agents));
  });
});
