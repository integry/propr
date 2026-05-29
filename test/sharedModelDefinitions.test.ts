import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS, AGENT_MODELS, MODEL_INFO_MAP, OPENCODE_MODELS } from '@propr/shared';
import type { AgentType } from '@propr/shared';

describe('shared model definitions', () => {
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

    test('OpenCode defaults use OpenCode provider model ids', () => {
        const modelIds = new Set(OPENCODE_MODELS.map(model => model.id));
        assert.ok(modelIds.has('opencode-go/kimi-k2.6'));
        for (const modelId of AGENT_DEFAULTS.opencode.defaultModels) {
            assert.ok(modelId.startsWith('opencode-go/'), `${modelId} should use the OpenCode provider prefix`);
            assert.ok(modelIds.has(modelId), `${modelId} should exist in OPENCODE_MODELS`);
        }
    });
});
