import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS, ANTIGRAVITY_MODELS, CLAUDE_MODELS, CODEX_MODELS, MODEL_INFO_MAP, OPENCODE_MODELS, VIBE_MODELS } from '../packages/shared/src/modelDefinitions.ts';
import { getReasoningLevelsForAgentType } from '../packages/shared/src/reasoningLevels.ts';
import { buildAgentModelLlmLabel } from '../packages/shared/src/labelUtils.ts';
import { AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.ts';

test('Mistral Medium uses the OpenRouter pricing model ID', () => {
    assert.strictEqual(
        MODEL_INFO_MAP['mistral-medium-3.5']?.openRouterId,
        'mistralai/mistral-medium-3-5'
    );
});

test('Vibe catalog matches the current hosted model set', () => {
    assert.deepStrictEqual(VIBE_MODELS.map(model => model.id), ['mistral-medium-3.5', 'zai-glm-5-3', 'zai-glm-5-2']);
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

test('current GPT-6 Codex models are in the catalog with runtime requirements', () => {
    const expectedModels = [
        ['gpt-6.1-sol', 'llm-codex-gpt61-sol', '0.153.0'],
        ['gpt-6-sol', 'llm-codex-gpt6-sol', '0.155.0'],
        ['gpt-6-luna', 'llm-codex-gpt6-luna', '0.155.0'],
    ] as const;

    for (const [modelId, githubLabel, minAgentVersion] of expectedModels) {
        assert.ok(CODEX_MODELS.some(model => model.id === modelId));
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.openRouterId, `openai/${modelId}`);
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.githubLabel, githubLabel);
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.minAgentVersion, minAgentVersion);
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.contextWindow, '1.05M');
        assert.strictEqual(MODEL_INFO_MAP[modelId]?.maxTokens, 1050000);
    }
});

test('Claude Opus 5.5 leads the Claude catalog as the default Claude model', () => {
    assert.strictEqual(CLAUDE_MODELS[0]?.id, 'claude-opus-5-5');
    assert.strictEqual(AGENT_DEFAULTS.claude.defaultModels[0], 'claude-opus-5-5');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.githubLabel, 'llm-claude-opus55');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.shortAlias, 'opus55');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.openRouterId, 'anthropic/claude-opus-5.5');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.contextWindow, '1M');
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.maxTokens, 1000000);
    // Opus 5.5 shipped in Claude Code 2.1.280, so the pinned CLI must support it
    assert.strictEqual(MODEL_INFO_MAP['claude-opus-5-5']?.minAgentVersion, '2.1.280');
    assert.strictEqual(AGENT_DEFAULTS.claude.defaultCliVersion, '2.1.284');
});

test('Claude Sonnet 5.5 is the current canonical Sonnet model', () => {
    assert.ok(CLAUDE_MODELS.some(model => model.id === 'claude-sonnet-5-5'));
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.githubLabel, 'llm-claude-sonnet55');
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.shortAlias, 'sonnet55');
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.openRouterId, 'anthropic/claude-sonnet-5.5');
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.contextWindow, '1M');
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.maxTokens, 1000000);
    assert.strictEqual(MODEL_INFO_MAP['claude-sonnet-5-5']?.minAgentVersion, '2.1.284');
});

test('Claude Fable 5.1, Opus 5, and Sonnet 5 remain supported Claude Code models', () => {
    assert.ok(CLAUDE_MODELS.some(model => model.id === 'claude-fable-5-1'));
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

test('GPT-6 Astra is the preferred Codex default', () => {
    assert.strictEqual(CODEX_MODELS[0]?.id, 'gpt-6-astra');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultModels[0], 'gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.githubLabel, 'llm-codex-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.openRouterId, 'openai/gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.minAgentVersion, '0.153.1');
});

test('Codex CLI defaults agree and support every catalog model', () => {
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultCliVersion, AGENT_DEFAULT_VERSIONS.codex);
    for (const { id, minAgentVersion } of CODEX_MODELS) {
        if (!minAgentVersion) continue;
        assert.ok(
            AGENT_DEFAULT_VERSIONS.codex.localeCompare(minAgentVersion, undefined, { numeric: true }) >= 0,
            `Codex CLI default ${AGENT_DEFAULT_VERSIONS.codex} must be >= ${minAgentVersion} for ${id}`
        );
    }
});

test('Gemini 3.8 Flash is one namespaced Antigravity model with 1M limits', () => {
    const modelId = 'antigravity-gemini-3.8-flash';
    const model = MODEL_INFO_MAP[modelId];
    assert.ok(ANTIGRAVITY_MODELS.some(candidate => candidate.id === modelId));
    assert.strictEqual(model?.githubLabel, 'llm-antigravity-flash38');
    assert.strictEqual(model?.shortAlias, 'flash38');
    assert.strictEqual(model?.openRouterId, 'google/gemini-3.8-flash');
    assert.strictEqual(model?.minAgentVersion, '1.1.25');
    assert.strictEqual(model?.contextWindow, '1M');
    assert.strictEqual(model?.maxTokens, 1_000_000);
    assert.strictEqual(AGENT_DEFAULTS.antigravity.defaultCliVersion, AGENT_DEFAULT_VERSIONS.antigravity);
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


test('Vibe GLM models share defaults, names, labels, limits, and runtime version', () => {
    for (const minor of ['3', '2']) {
        const id = `zai-glm-5-${minor}`;
        assert.ok(AGENT_DEFAULTS.vibe.defaultModels.includes(id));
        assert.strictEqual(MODEL_INFO_MAP[id].name, `GLM 5.${minor}`);
        assert.strictEqual(MODEL_INFO_MAP[id].githubLabel, `llm-vibe-glm5${minor}`);
        assert.strictEqual(MODEL_INFO_MAP[id].maxTokens, 1000000);
        assert.strictEqual(MODEL_INFO_MAP[id].minAgentVersion, '2.25.8');
    }
    assert.strictEqual(AGENT_DEFAULTS.vibe.defaultModels[0], 'mistral-medium-3.5');
    assert.strictEqual(AGENT_DEFAULTS.vibe.defaultCliVersion, '2.25.8');
    assert.strictEqual(AGENT_DEFAULT_VERSIONS.vibe, '2.25.8');
});

test('Antigravity offers one model entry with separate supported reasoning choices', () => {
    for (const family of ['opus', 'sonnet']) {
        const model = MODEL_INFO_MAP[`antigravity-claude-${family}-5.5`];
        assert.ok(model);
        assert.strictEqual(model.shortAlias, `${family}55`);
        assert.strictEqual(model.githubLabel, `llm-antigravity-${family}55`);
        assert.strictEqual(model.openRouterId, `anthropic/claude-${family}-5.5`);
        assert.ok(AGENT_DEFAULTS.antigravity.defaultModels.includes(model.id));
        assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', model.id), ['low', 'medium', 'high']);
    }
    const expected = [
        ['antigravity-gemini-3.8-flash', 'flash38'],
        ['antigravity-gemini-3.1-pro', 'pro'],
        ['antigravity-claude-sonnet-5.5', 'sonnet55'],
        ['antigravity-claude-opus-5.5', 'opus55'],
        ['antigravity-gpt-oss-120b', 'gpt-oss-120b'],
    ];
    assert.deepStrictEqual(ANTIGRAVITY_MODELS.map(model => [model.id, model.shortAlias]), expected);
    assert.deepStrictEqual(AGENT_DEFAULTS.antigravity.defaultModels, expected.map(([id]) => id));
    for (const model of ANTIGRAVITY_MODELS) {
        assert.equal(model.githubLabel, `llm-antigravity-${model.shortAlias}`);
    }
    assert.ok(!ANTIGRAVITY_MODELS.some(model => model.id.includes('4.6-thinking')));
    assert.ok(!ANTIGRAVITY_MODELS.some(model => /-(low|medium|high)$/.test(model.id)));
    for (const version of ['3.8']) {
        const modelId = `antigravity-gemini-${version}-flash`;
        assert.ok(ANTIGRAVITY_MODELS.some(model => model.id === modelId));
        assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', modelId), ['low', 'medium', 'high']);
    }
    for (const [modelId, levels] of [
        ['antigravity-gemini-3.1-pro', ['low', 'high']],
        ['antigravity-gpt-oss-120b', ['medium']],
    ] as const) {
        assert.ok(ANTIGRAVITY_MODELS.some(model => model.id === modelId));
        assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', modelId), levels);
    }
});


test('documented Antigravity model labels agree with the selectable catalog', () => {
    const text = readFileSync(new URL('../docs/docs/features/agents-and-models.md', import.meta.url), 'utf8');
    const section = text.split('## Antigravity Models')[1].split('## OpenCode Models')[0];
    const labels = [...section.matchAll(/`(llm-antigravity-[^`]+)`/g)].map(match => match[1]);
    assert.deepStrictEqual(labels, ANTIGRAVITY_MODELS.map(model => model.githubLabel));
    for (const name of ['daemon', 'worker-runtime']) {
        const examples = readFileSync(new URL(`../docs/docs/architecture/${name}.md`, import.meta.url), 'utf8');
        for (const match of examples.matchAll(/llm-antigravity-[a-z0-9.-]+/g)) {
            assert.ok(ANTIGRAVITY_MODELS.some(model => model.githubLabel === match[0]), `${name}: ${match[0]}`);
        }
    }
});
