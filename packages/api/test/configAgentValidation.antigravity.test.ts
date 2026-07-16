import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AgentConfig } from '@propr/core';

after(async () => {
  const { db } = await import('@propr/core');
  await db.destroy();
});

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'antigravity-test',
    type: 'antigravity',
    alias: 'antigravity',
    enabled: true,
    dockerImage: 'propr/agent:latest',
    configPath: '~/.gemini',
    supportedModels: ['antigravity-gemini-3.5-flash-medium'],
    defaultModel: 'antigravity-gemini-3.5-flash-medium',
    ...overrides
  };
}

test('agent config validation accepts antigravity and rejects gemini for new configs', async () => {
  process.env.NODE_ENV = 'test';
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.GH_APP_ID = process.env.GH_APP_ID || '1';
  process.env.GH_PRIVATE_KEY_PATH = process.env.GH_PRIVATE_KEY_PATH || '/tmp/missing-key.pem';
  process.env.GH_INSTALLATION_ID = process.env.GH_INSTALLATION_ID || '1';
  const { validateAgentsConfig } = await import('../routes/configAgentValidation.js');

  assert.equal(validateAgentsConfig([createAgentConfig()]), null);

  const error = validateAgentsConfig([
    createAgentConfig({
      id: 'legacy-agent',
      type: 'gemini' as AgentConfig['type']
    })
  ]);

  assert.match(error || '', /invalid type/);
  assert.match(error || '', /antigravity/);
  assert.doesNotMatch(error || '', /gemini/);
});
