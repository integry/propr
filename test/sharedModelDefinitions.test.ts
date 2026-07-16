import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS, AGENT_MODELS, MODEL_INFO_MAP, OPENCODE_MODELS } from '@propr/shared';
import type { AgentType } from '@propr/shared';

describe('shared model definitions', () => {
    test('exposes OpenCode in shared agent models and defaults', () => {
        assert.strictEqual(AGENT_MODELS.opencode, OPENCODE_MODELS);
        assert.ok(AGENT_MODELS.opencode.length > 0, 'AGENT_MODELS.opencode should not be empty');
        assert.deepStrictEqual(
            AGENT_DEFAULTS.opencode.defaultModels,
            OPENCODE_MODELS.map(model => model.id)
        );
        assert.strictEqual(AGENT_DEFAULTS.opencode.defaultAlias, 'opencode');
        assert.strictEqual(AGENT_DEFAULTS.opencode.dockerImage, 'propr/agent:latest');
        assert.strictEqual(AGENT_DEFAULTS.opencode.configPath, '~/.config/opencode');
        assert.strictEqual(AGENT_DEFAULTS.opencode.npmPackage, 'opencode-ai');
        assert.strictEqual(AGENT_DEFAULTS.opencode.defaultCliVersion, '1.18.2');
    });

    test('every default agent model is present in the shared model catalog', () => {
        for (const [agentType, defaults] of Object.entries(AGENT_DEFAULTS) as Array<[AgentType, typeof AGENT_DEFAULTS[AgentType]]>) {
            const supportedIds = new Set(AGENT_MODELS[agentType].map(model => model.id));
            assert.ok(defaults.defaultModels.length > 0, `${agentType} should have default models`);
            for (const modelId of defaults.defaultModels) {
                assert.ok(MODEL_INFO_MAP[modelId], `${modelId} should exist in MODEL_INFO_MAP`);
                assert.ok(supportedIds.has(modelId), `${modelId} should be listed under ${agentType}`);
            }
        }
    });

    test('OpenCode defaults use namespaced unauthenticated OpenCode free model ids', () => {
        const modelIds = new Set(OPENCODE_MODELS.map(model => model.id));
        assert.ok(modelIds.has('opencode-minimax-m3-free'));
        for (const modelId of AGENT_DEFAULTS.opencode.defaultModels) {
            assert.ok(modelId.startsWith('opencode-'), `${modelId} should use the ProPR OpenCode prefix`);
            assert.ok(modelId.includes('free') || modelId === 'opencode-big-pickle', `${modelId} should be usable without provider login`);
            assert.ok(modelIds.has(modelId), `${modelId} should exist in OPENCODE_MODELS`);
        }
    });
});
