import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { AgentRegistry, NoDefaultModelConfiguredError, closeConnection, resolveConfiguredModel } from '@propr/core';

after(async () => {
  await closeConnection();
});

describe('resolveConfiguredModel', () => {
  test('returns a configured model without consulting the default agent', async (t) => {
    const registry = AgentRegistry.getInstance();
    const initialize = t.mock.method(registry, 'ensureInitialized', async () => undefined);

    assert.strictEqual(await resolveConfiguredModel('  codex:gpt-test  '), 'codex:gpt-test');
    assert.strictEqual(initialize.mock.callCount(), 0);
  });

  test('routes an omitted model through the configured default agent', async (t) => {
    const registry = AgentRegistry.getInstance();
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    t.mock.method(registry, 'getDefaultAgent', () => ({
      config: {
        alias: 'test-agent',
        defaultModel: 'test-model',
      },
    }) as never);

    assert.strictEqual(await resolveConfiguredModel(''), 'test-agent:test-model');
  });

  test('converts an unprefixed configured model to agent:model routing', async (t) => {
    const registry = AgentRegistry.getInstance();
    const agent = {
      config: {
        alias: 'test-agent',
        enabled: true,
        supportedModels: ['test-model'],
        defaultModel: 'test-model',
      },
    };
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    t.mock.method(registry, 'getAllAgents', () => [agent] as never);

    assert.strictEqual(await resolveConfiguredModel('test-model'), 'test-agent:test-model');
  });

  test('fails clearly when no default agent model is configured', async (t) => {
    const registry = AgentRegistry.getInstance();
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    t.mock.method(registry, 'getDefaultAgent', () => undefined);

    await assert.rejects(() => resolveConfiguredModel(undefined), NoDefaultModelConfiguredError);
  });
});
