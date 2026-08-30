import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentConfig } from '@propr/core';
import {
  findSyntheticReferencesToDirectAgent,
  parseSyntheticAgentConfigs,
  syntheticAgentConfigsSchema,
  validateSyntheticAgentReferences,
  type SyntheticAgentConfig,
} from '@propr/shared';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_MEMBER_ID = '33333333-3333-4333-8333-333333333333';

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

function schemaError(value: unknown): string {
  const result = syntheticAgentConfigsSchema.safeParse(value);
  assert.equal(result.success, false);
  return result.success ? '' : result.error.issues.map(issue => issue.message).join('; ');
}

describe('synthetic agent contracts', () => {
  test('parses defaults while preserving model and member order', () => {
    const raw = cloneConfig() as Array<Record<string, unknown>>;
    const agent = raw[0];
    delete agent.enabled;
    const models = agent.models as Array<Record<string, unknown>>;
    delete models[0].enabled;
    delete models[0].strategy;
    const firstMember = (models[0].members as Array<Record<string, unknown>>)[0];
    delete firstMember.enabled;
    delete firstMember.priority;
    models[0].members = [
      firstMember,
      {
        id: SECOND_MEMBER_ID,
        directAgentAlias: 'codex-secondary',
        model: 'gpt-5.6-sol',
      },
    ];

    const parsed = parseSyntheticAgentConfigs(raw);

    assert.equal(parsed[0].enabled, true);
    assert.equal(parsed[0].models[0].strategy, 'round_robin');
    assert.deepEqual(parsed[0].models[0].members.map(member => member.id), [MEMBER_ID, SECOND_MEMBER_ID]);
    assert.deepEqual(parsed[0].models[0].members.map(member => member.priority), [100, 100]);
  });

  test('rejects malformed aliases, model IDs, defaults, priorities, percentages, and duplicates', () => {
    const cases: Array<[string, (value: SyntheticAgentConfig[]) => void, RegExp]> = [
      ['alias', value => { value[0].alias = 'Bad Alias'; }, /lowercase letters/],
      ['model ID', value => { value[0].models[0].id = 'bad/model'; }, /Synthetic model IDs/],
      ['default', value => { value[0].defaultModel = 'missing'; }, /missing or disabled/],
      ['priority', value => { value[0].models[0].members[0].priority = 101; }, /Too big/],
      ['percentage', value => { value[0].models[0].members[0].usageLimits.sessionMaxPercent = 0; }, /Too small/],
      ['member ID', value => {
        value[0].models[0].members.push({
          ...value[0].models[0].members[0],
          directAgentAlias: 'codex-secondary',
        });
      }, /Duplicate synthetic member ID/],
      ['physical pair', value => {
        value[0].models[0].members.push({
          ...value[0].models[0].members[0],
          id: SECOND_MEMBER_ID,
        });
      }, /Duplicate direct member/],
      ['model IDs', value => { value[0].models.push(structuredClone(value[0].models[0])); }, /Duplicate synthetic model ID/],
      ['aliases', value => { value.push(structuredClone(value[0])); }, /Duplicate synthetic alias/],
    ];

    for (const [name, mutate, expected] of cases) {
      const value = cloneConfig();
      mutate(value);
      assert.match(schemaError(value), expected, name);
    }
  });

  test('rejects duplicate top-level agent IDs at the duplicate index', () => {
    const value = cloneConfig();
    value.push({ ...structuredClone(value[0]), alias: 'another-pool' });

    const result = syntheticAgentConfigsSchema.safeParse(value);

    assert.equal(result.success, false);
    if (result.success) return;
    const duplicateIdIssue = result.error.issues.find(issue =>
      issue.message === `Duplicate synthetic agent ID '${AGENT_ID}'`,
    );
    assert.deepEqual(duplicateIdIssue?.path, [1, 'id']);
  });

  test('validates the shared direct namespace and physical model references', () => {
    const config = [syntheticAgent()];
    assert.deepEqual(validateSyntheticAgentReferences(config, [directAgent()]), {
      errors: [],
      warnings: [],
    });

    const collision = validateSyntheticAgentReferences(config, [
      directAgent({ alias: 'balanced-pool' }),
    ]);
    assert.match(collision.errors.join('; '), /conflicts with a direct agent alias/);
    assert.match(collision.errors.join('; '), /unknown direct agent 'codex-primary'/);

    const idCollision = validateSyntheticAgentReferences(config, [
      directAgent({ id: AGENT_ID }),
    ]);
    assert.match(idCollision.errors.join('; '), /conflicts with a direct agent ID/);

    const unsupported = validateSyntheticAgentReferences(config, [
      directAgent({ supportedModels: ['gpt-other'] }),
    ]);
    assert.match(unsupported.errors.join('; '), /unsupported model 'codex-primary:gpt-5\.6-sol'/);

    const disabled = validateSyntheticAgentReferences(config, [directAgent({ enabled: false })]);
    assert.deepEqual(disabled.errors, []);
    assert.match(disabled.warnings[0], /no enabled direct members/);
    assert.deepEqual(findSyntheticReferencesToDirectAgent(config, 'codex-primary'), ['balanced-pool:balanced']);
  });
});
