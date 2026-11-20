import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, type Agent, type AgentConfig } from '@propr/core';
import { buildAgentsUpdateSuccessBody, loadAgentCliVersionStates } from '../routes/configRoutesAgentsCliVersions.js';
import type { AgentConfigStore, AgentRegistrySync } from '../routes/configRoutesAgentsTypes.js';

after(() => closeConnection());

const codex = (cliVersionResolved: string): AgentConfig => ({
  id: 'codex-1', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:bundle', configPath: '/tmp/codex',
  supportedModels: ['gpt-5.5'], cliVersionType: 'specific', cliVersion: cliVersionResolved, cliVersionResolved,
});

const pendingRegistry = (live: AgentConfig, inspect?: () => Promise<void>): AgentRegistrySync => ({
  refresh: async () => undefined,
  setDefaultAgentAlias: () => undefined,
  isInitialized: () => true,
  getAgentByAlias: alias => (alias === live.alias ? { config: live } as unknown as Agent : undefined),
  getOperationalStatus: () => ({ unifiedAgentImage: { status: 'unavailable', error: 'Unified agent image x has not been prepared by the worker', recordedAt: new Date().toISOString() } }),
  inspectAgentImageAvailability: inspect,
});

describe('agent configuration CLI version states', () => {
  test('a saved CLI version change returns a pending state and a warning', async () => {
    const body = await buildAgentsUpdateSuccessBody({} as AgentConfigStore, pendingRegistry(codex('0.171.0')), [codex('0.170.0')]);
    assert.ok('success' in body && body.success);
    assert.equal(body.cliVersionStates?.[0].status, 'preparing');
    assert.equal(body.cliVersionStates?.[0].effectiveVersion, '0.171.0');
    assert.match(body.warnings?.[0] ?? '', /preparing the image for codex CLI 0\.170\.0/);
  });

  test('registries without a live view report nothing', async () => {
    const body = await buildAgentsUpdateSuccessBody({} as AgentConfigStore, { refresh: async () => undefined, setDefaultAgentAlias: () => undefined }, [codex('0.170.0')]);
    assert.ok('success' in body && body.success);
    assert.equal(body.cliVersionStates, undefined);
    assert.equal(body.warnings, undefined);
  });

  test('a read does not wait on a worker build still in progress', async () => {
    const started = Date.now();
    const states = await loadAgentCliVersionStates(pendingRegistry(codex('0.171.0'), () => new Promise(() => undefined)), [codex('0.170.0')], true);
    assert.ok(Date.now() - started < 5000);
    assert.equal(states[0].status, 'preparing');
  });
});
