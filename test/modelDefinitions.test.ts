import { test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS, ANTIGRAVITY_MODELS, CLAUDE_MODELS, CODEX_MODELS, MODEL_INFO_MAP, MUSE_MODELS, OPENCODE_MODELS, VIBE_MODELS } from '../packages/shared/src/modelDefinitions.ts';
import { buildAgentModelLlmLabel } from '../packages/shared/src/labelUtils.ts';
import { AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.ts';

test('Mistral Medium uses the OpenRouter pricing model ID', () => {
    assert.strictEqual(
        MODEL_INFO_MAP['mistral-medium-3.5']?.openRouterId,
        'mistralai/mistral-medium-3-5'
    );
});

test('Vibe catalog matches the current hosted model set', () => {
    assert.deepStrictEqual(VIBE_MODELS.map(model => model.id), ['mistral-medium-3.5']);
    assert.strictEqual(MODEL_INFO_MAP['devstral-small'], undefined);
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
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.contextWindow, '1.05M');
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.maxTokens, 1050000);
    }
});

test('Claude Fable 5.1, Opus 5, and Sonnet 5 are current Claude Code models', () => {
    assert.strictEqual(CLAUDE_MODELS[0]?.id, 'claude-fable-5-1');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-1']?.githubLabel, 'llm-claude-fable51');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-1']?.minAgentVersion, '2.1.257');
    assert.ok(CLAUDE_MODELS.some(model => model.id === 'claude-opus-5'));
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5']?.githubLabel, 'llm-claude-opus5');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5']?.minAgentVersion, '2.1.219');
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5']?.githubLabel, 'llm-claude-sonnet5');
});

test('OpenCode catalog matches the current built-in free model set', () => {
    assert.deepStrictEqual(OPENCODE_MODELS.map(model => model.id), [
        'opencode-big-pickle',
        'opencode-ling-3.0-flash-fin-free',
        'opencode-mimo-v2.5-free',
        'opencode-muse-spark-1.2-contributor-free',
        'opencode-muse-spark-1.3-contributor-free',
        'opencode-nemotron-3-ultra-free',
        'opencode-nemotron-3.5-lightning-free',
    ]);
});

test('GPT-6 Astra is the preferred Codex default and Codex CLI pin supports it', () => {
    assert.strictEqual(CODEX_MODELS[0]?.id, 'gpt-6-astra');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultModels[0], 'gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.githubLabel, 'llm-codex-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.openRouterId, 'openai/gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.minAgentVersion, '0.153.1');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultCliVersion, AGENT_DEFAULT_VERSIONS.codex);
    assert.ok(
        AGENT_DEFAULT_VERSIONS.codex.localeCompare('0.153.1', undefined, { numeric: true }) >= 0,
        `Codex CLI default ${AGENT_DEFAULT_VERSIONS.codex} should be >= 0.153.1`
    );
});

test('Gemini 3.8 Flash tiers are namespaced Antigravity models with 1M limits', () => {
    const expectedModels = [
        ['medium', 'llm-antigravity-flash38-medium'],
        ['high', 'llm-antigravity-flash38-high'],
        ['low', 'llm-antigravity-flash38-low'],
    ] as const;

    for (const [tier, githubLabel] of expectedModels) {
        const modelId = `antigravity-gemini-3.8-flash-${tier}`;
        const model = MODEL_INFO_MAP[modelId];
        assert.ok(ANTIGRAVITY_MODELS.some(candidate => candidate.id === modelId));
        assert.strictEqual(model?.githubLabel, githubLabel);
        assert.strictEqual(model?.shortAlias, `flash38-${tier}`);
        assert.strictEqual(model?.openRouterId, 'google/gemini-3.8-flash');
        assert.strictEqual(model?.minAgentVersion, '1.1.25');
        assert.strictEqual(model?.contextWindow, '1M');
        assert.strictEqual(model?.maxTokens, 1_000_000);
    }
    assert.strictEqual(AGENT_DEFAULTS.antigravity.defaultCliVersion, AGENT_DEFAULT_VERSIONS.antigravity);
});

test('Muse Code catalog uses llm-muse labels and the mounted CLI login', () => {
    assert.deepStrictEqual(MUSE_MODELS.map(model => model.id), [
        'muse-spark-1.3',
        'muse-spark-1.3-contributor',
        'muse-spark-1.2',
        'muse-spark-1.2-contributor',
    ]);
    assert.strictEqual(MODEL_INFO_MAP['muse-spark-1.3']?.githubLabel, 'llm-muse-spark13');
    assert.strictEqual(MODEL_INFO_MAP['muse-spark-1.3']?.openRouterId, 'meta/muse-spark-1.3');
    assert.strictEqual(MODEL_INFO_MAP['muse-spark-1.3']?.minAgentVersion, '1.1.1');
    assert.strictEqual(AGENT_DEFAULTS.muse.defaultAlias, 'muse');
    assert.strictEqual(AGENT_DEFAULTS.muse.configPath, '~/.config/muse');
    assert.strictEqual(AGENT_DEFAULTS.muse.defaultCliVersion, AGENT_DEFAULT_VERSIONS.muse);
});

test('long model labels use the configured agent alias', () => {
    const codexModel = MODEL_INFO_MAP['gpt-5.6-sol'];
    assert.ok(codexModel);
    assert.strictEqual(
        buildAgentModelLlmLabel('codex', 'codex2', codexModel),
        'llm-codex2-gpt56-sol'
    );

    assert.strictEqual(
        buildAgentModelLlmLabel('opencode', 'opencode2', {
            id: 'opencode-openai/gpt-5.5',
            githubLabel: 'llm-opencode~opencode-openai/gpt-5.5',
        }),
        'llm-opencode2~opencode-openai/gpt-5.5'
    );

    const longAliasLabel = buildAgentModelLlmLabel(
        'codex',
        'codex-account-with-an-alias-that-exceeds-githubs-label-limit',
        codexModel
    );
    assert.ok(longAliasLabel.length <= 50);
    assert.match(longAliasLabel, /^llm-codex-account.*~/);
});
