import { test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS, CODEX_MODELS, MODEL_INFO_MAP } from '../packages/shared/src/modelDefinitions.ts';
import { AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.ts';

test('Mistral Medium uses the OpenRouter pricing model ID', () => {
    assert.strictEqual(
        MODEL_INFO_MAP['mistral-medium-3.5']?.openRouterId,
        'mistralai/mistral-medium-3-5'
    );
});

test('Devstral Small uses the OpenRouter pricing model ID', () => {
    assert.strictEqual(
        MODEL_INFO_MAP['devstral-small']?.openRouterId,
        'mistralai/devstral-2512'
    );
});

test('GPT-5.6 Codex models are in the catalog with labels and OpenRouter IDs', () => {
    const expectedModels = [
        ['gpt-5.6-sol', 'llm-codex-gpt56-sol'],
        ['gpt-5.6-terra', 'llm-codex-gpt56-terra'],
        ['gpt-5.6-luna', 'llm-codex-gpt56-luna'],
    ] as const;

    for (const [modelId, githubLabel] of expectedModels) {
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.openRouterId, `openai/${modelId}`);
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.githubLabel, githubLabel);
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.minAgentVersion, '0.144.0');
    }
});

test('GPT-5.6 Sol is the preferred Codex default and Codex CLI pin supports it', () => {
    assert.strictEqual(CODEX_MODELS[0]?.id, 'gpt-5.6-sol');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultModels[0], 'gpt-5.6-sol');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultCliVersion, AGENT_DEFAULT_VERSIONS.codex);
    assert.ok(
        AGENT_DEFAULT_VERSIONS.codex.localeCompare('0.144.0', undefined, { numeric: true }) >= 0,
        `Codex CLI default ${AGENT_DEFAULT_VERSIONS.codex} should be >= 0.144.0`
    );
});
