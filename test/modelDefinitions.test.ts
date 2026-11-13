import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';
import { claudeModelRetirement, currentClaudeModel, isClaudeModelRetired } from '../packages/shared/src/claudeCompatibility.ts';
import { OPENCODE_RETIRED_MODEL_ALIASES, OPENCODE_RETIRED_MODEL_ROUTES, currentOpenCodeModel } from '../packages/shared/src/openCodeCompatibility.ts';
import { AGENT_DEFAULTS, AGENT_MODELS, ALL_MODELS, ANTIGRAVITY_MODELS, CLAUDE_MODELS, CODEX_MODELS, MODEL_INFO_MAP, OPENCODE_MODELS, VIBE_MODELS } from '../packages/shared/src/modelDefinitions.ts';
import { ANTIGRAVITY_COMPATIBILITY_ALIASES, ANTIGRAVITY_COMPATIBILITY_ROUTES, agentSupportsSavedModel, currentAntigravityModel, getModelInfoWithAntigravityCompatibility } from '../packages/shared/src/antigravityCompatibility.ts';
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
        // GPT-6.1 Terra first ships in the models.json bundled with Codex 0.165.0
        ['gpt-6.1-terra', 'llm-codex-gpt61-terra', '0.165.0'],
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
    assert.strictEqual(AGENT_DEFAULTS.claude.defaultCliVersion, '2.1.323');
    assert.strictEqual(AGENT_DEFAULTS.claude.defaultCliVersion, AGENT_DEFAULT_VERSIONS.claude);
});

test('Claude Fable 5.2 is the current canonical Fable model', () => {
    assert.ok(CLAUDE_MODELS.some(model => model.id === 'claude-fable-5-2'));
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.githubLabel, 'llm-claude-fable52');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.shortAlias, 'fable52');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.openRouterId, 'anthropic/claude-fable-5.2');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.contextWindow, '1M');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.maxTokens, 1000000);
    // Fable 5.2 needs Claude Code 2.1.321, so the pinned CLI must be at least that
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5-2']?.minAgentVersion, '2.1.321');
    // It sits in the current tier, ahead of the legacy Fable 5.1
    const ids = CLAUDE_MODELS.map(model => model.id);
    assert.ok(ids.indexOf('claude-fable-5-2') < ids.indexOf('claude-haiku-5-5'));
    assert.ok(ids.indexOf('claude-fable-5-1') > ids.indexOf('claude-haiku-5-5'));
    assert.ok(ids.indexOf('claude-fable-5-1') < ids.indexOf('claude-fable-5'));
});

test('Claude Sonnet 4.5 stays selectable until its retirement, then runs on Sonnet 5.5', () => {
    const sonnet45 = 'claude-sonnet-4-5-20250929';
    assert.ok(CLAUDE_MODELS.some(model => model.id === sonnet45), 'kept in the catalog before retirement');
    assert.deepStrictEqual(claudeModelRetirement(sonnet45), { id: sonnet45, retiresOn: '2026-11-30', successor: 'claude-sonnet-5-5' });
    assert.ok(CLAUDE_MODELS.some(model => model.id === claudeModelRetirement(sonnet45)!.successor));

    const before = new Date('2026-11-29T23:59:59Z');
    const on = new Date('2026-11-30T00:00:00Z');
    assert.strictEqual(isClaudeModelRetired(sonnet45, before), false);
    assert.strictEqual(currentClaudeModel(sonnet45, before), sonnet45);
    assert.strictEqual(isClaudeModelRetired(sonnet45, on), true);
    assert.strictEqual(currentClaudeModel(sonnet45, on), 'claude-sonnet-5-5');
    // Undated, agent-prefixed and mixed-case forms name the same snapshot
    assert.strictEqual(currentClaudeModel('claude-sonnet-4-5', on), 'claude-sonnet-5-5');
    assert.strictEqual(currentClaudeModel('claude:Claude-Sonnet-4-5-20250929', on), 'claude-sonnet-5-5');

    // Opus 4.5, Haiku 4.5 and Fable 5.1 are still active
    for (const active of ['claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-sonnet-5-5']) {
        assert.strictEqual(claudeModelRetirement(active), undefined, active);
        assert.strictEqual(currentClaudeModel(active, new Date('2030-01-01T00:00:00Z')), active);
    }
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

test('Claude Haiku 5.5 is the current canonical Haiku model', () => {
    assert.ok(CLAUDE_MODELS.some(model => model.id === 'claude-haiku-5-5'));
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.githubLabel, 'llm-claude-haiku55');
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.shortAlias, 'haiku55');
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.openRouterId, 'anthropic/claude-haiku-5.5');
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.contextWindow, '1M');
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.maxTokens, 1000000);
    // Haiku 5.5 shipped in Claude Code 2.1.293, so the pinned CLI must support it
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-5-5']?.minAgentVersion, '2.1.293');
    // Haiku 4.5 keeps an explicit, versioned alias and label
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-4-5-20251001']?.shortAlias, 'haiku45');
    assert.strictEqual(MODEL_INFO_MAP['claude-haiku-4-5-20251001']?.githubLabel, 'llm-claude-haiku45');
});

test('only the canonical Claude models own the bare tier aliases', () => {
    for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
        assert.ok(!CLAUDE_MODELS.some(model => model.shortAlias === tier), `${tier} short alias`);
        assert.ok(!CLAUDE_MODELS.some(model => model.githubLabel === `llm-claude-${tier}`), `llm-claude-${tier} label`);
    }
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5']?.shortAlias, 'fable5');
    assert.strictEqual(MODEL_INFO_MAP['claude-fable-5']?.githubLabel, 'llm-claude-fable5');
});

test('legacy Claude Fable 5.1, Opus 5, and Sonnet 5 remain supported Claude Code models', () => {
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
        'opencode-beam-free',
        'opencode-deepseek-v4.1-flash-free',
        'opencode-flint-40b-free',
        'opencode-glm-5.3-flash-free',
        'opencode-mimo-v2.6-flash-free',
        'opencode-nemotron-3.5-lightning-free',
        'opencode-nemotron-3.5-super-vl-free',
    ]);
    assert.strictEqual(AGENT_DEFAULTS.opencode.defaultModels[0], 'opencode-big-pickle');
});

test('retired OpenCode free models route to a current catalog model', () => {
    const current = new Set(OPENCODE_MODELS.map(model => model.id));
    for (const [retired, successor] of Object.entries(OPENCODE_RETIRED_MODEL_ROUTES)) {
        assert.ok(!current.has(retired), `${retired} must not stay selectable`);
        assert.ok(current.has(successor), `${retired} must route to a current model, not ${successor}`);
    }
    for (const [alias, successor] of Object.entries(OPENCODE_RETIRED_MODEL_ALIASES)) {
        assert.ok(current.has(successor), alias);
        assert.ok(!OPENCODE_MODELS.some(model => `opencode-${model.shortAlias}` === alias), `${alias} must not shadow a current label`);
    }
    assert.strictEqual(currentOpenCodeModel('opencode-ling-3.0-flash-fin-free'), 'opencode-deepseek-v4.1-flash-free');
    assert.strictEqual(currentOpenCodeModel('opencode/mimo-v2.5-free'), 'opencode-mimo-v2.6-flash-free');
    assert.strictEqual(currentOpenCodeModel('opencode:opencode-nemotron-3-ultra-free'), 'opencode-nemotron-3.5-super-vl-free');
    assert.strictEqual(currentOpenCodeModel('opencode-muse-spark-1.3-contributor-free'), 'opencode-big-pickle');
    assert.strictEqual(currentOpenCodeModel('opencode-big-pickle'), 'opencode-big-pickle');
    assert.strictEqual(currentOpenCodeModel('opencode-openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
    const agent = { type: 'opencode', supportedModels: ['opencode-deepseek-v4.1-flash-free'] };
    assert.ok(agentSupportsSavedModel(agent, 'opencode-ling-3.0-flash-fin-free'));
    assert.ok(!agentSupportsSavedModel(agent, 'opencode-mimo-v2.5-free'));
    assert.ok(!agentSupportsSavedModel({ type: 'claude', supportedModels: agent.supportedModels }, 'opencode-ling-3.0-flash-fin-free'));
});

test('GPT-6 Astra is the preferred Codex default', () => {
    assert.strictEqual(CODEX_MODELS[0]?.id, 'gpt-6-astra');
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultModels[0], 'gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.githubLabel, 'llm-codex-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.openRouterId, 'openai/gpt-6-astra');
    assert.strictEqual(MODEL_INFO_MAP['gpt-6-astra']?.minAgentVersion, '0.153.1');
});

test('Claude Code CLI default supports every catalog model', () => {
    for (const { id, minAgentVersion } of CLAUDE_MODELS) {
        if (!minAgentVersion) continue;
        assert.ok(
            AGENT_DEFAULT_VERSIONS.claude.localeCompare(minAgentVersion, undefined, { numeric: true }) >= 0,
            `Claude Code default ${AGENT_DEFAULT_VERSIONS.claude} must be >= ${minAgentVersion} for ${id}`
        );
    }
});

test('Codex CLI defaults agree and support every catalog model', () => {
    assert.strictEqual(AGENT_DEFAULTS.codex.defaultCliVersion, '0.168.0');
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

test('Gemini 4 Argon is one namespaced Antigravity model with 1M limits', () => {
    const modelId = 'antigravity-gemini-4-argon';
    const model = MODEL_INFO_MAP[modelId];
    assert.ok(ANTIGRAVITY_MODELS.some(candidate => candidate.id === modelId));
    assert.ok(AGENT_DEFAULTS.antigravity.defaultModels.includes(modelId));
    assert.strictEqual(model?.name, 'Antigravity Gemini 4 Argon');
    assert.strictEqual(model?.shortName, 'Gemini 4 Argon');
    assert.strictEqual(model?.githubLabel, 'llm-antigravity-argon');
    assert.strictEqual(model?.shortAlias, 'argon');
    assert.strictEqual(model?.openRouterId, 'google/gemini-4-argon');
    assert.strictEqual(model?.minAgentVersion, '1.4.0');
    assert.strictEqual(AGENT_DEFAULTS.antigravity.defaultCliVersion, '1.5.8');
    assert.strictEqual(model?.contextWindow, '1M');
    assert.strictEqual(model?.maxTokens, 1_000_000);
    assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', modelId), ['low', 'medium', 'high']);
});

test('Gemini 4 Hydrogen is a new Antigravity model with 1M limits and XHigh effort', () => {
    const modelId = 'antigravity-gemini-4-hydrogen';
    const model = MODEL_INFO_MAP[modelId];
    assert.ok(ANTIGRAVITY_MODELS.some(candidate => candidate.id === modelId));
    assert.ok(AGENT_DEFAULTS.antigravity.defaultModels.includes(modelId));
    assert.strictEqual(model?.name, 'Antigravity Gemini 4 Hydrogen');
    assert.strictEqual(model?.shortName, 'Gemini 4 Hydrogen');
    assert.strictEqual(model?.githubLabel, 'llm-antigravity-hydrogen');
    assert.strictEqual(model?.shortAlias, 'hydrogen');
    assert.strictEqual(model?.openRouterId, 'google/gemini-4-hydrogen');
    // agy 1.5.8 is the first pinned CLI that lists gemini-4-hydrogen-*.
    assert.strictEqual(model?.minAgentVersion, '1.5.8');
    assert.strictEqual(model?.contextWindow, '1M');
    assert.strictEqual(model?.maxTokens, 1_000_000);
    assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', modelId), ['low', 'medium', 'high', 'xhigh']);
    assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', `antigravity:${modelId}`), ['low', 'medium', 'high', 'xhigh']);
    // Hydrogen supersedes nothing: the other Antigravity models keep their levels.
    for (const other of ANTIGRAVITY_MODELS.filter(candidate => candidate.id !== modelId && !candidate.id.includes('gpt-oss'))) {
        assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', other.id), ['low', 'medium', 'high'], other.id);
    }
    // Labels and aliases stay unique across the whole catalog.
    assert.strictEqual(ALL_MODELS.filter(candidate => candidate.githubLabel === model?.githubLabel).length, 1);
    assert.strictEqual(ALL_MODELS.filter(candidate => candidate.shortAlias === model?.shortAlias).length, 1);
});

test('Antigravity compatibility routes give Gemini 4 Hydrogen, and only Hydrogen, an XHigh route', () => {
    const hydrogen = 'antigravity-gemini-4-hydrogen';
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
        assert.deepStrictEqual(ANTIGRAVITY_COMPATIBILITY_ROUTES[`${hydrogen}-${effort}`], { model: hydrogen, effort });
        assert.strictEqual(ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-hydrogen-${effort}`], `${hydrogen}-${effort}`);
        assert.strictEqual(getModelInfoWithAntigravityCompatibility(`${hydrogen}-${effort}`), MODEL_INFO_MAP[hydrogen]);
    }
    assert.strictEqual(currentAntigravityModel(`${hydrogen}-xhigh`), `${hydrogen}-xhigh`);
    assert.strictEqual(currentAntigravityModel(hydrogen), hydrogen);
    for (const model of ANTIGRAVITY_MODELS.filter(candidate => candidate.id !== hydrogen)) {
        assert.strictEqual(ANTIGRAVITY_COMPATIBILITY_ROUTES[`${model.id}-xhigh`], undefined, model.id);
    }
    // A new model: no saved selection of another model is routed to Hydrogen.
    assert.ok(!Object.entries(ANTIGRAVITY_COMPATIBILITY_ROUTES).some(([id, route]) =>
        route.model === hydrogen && !id.startsWith(`${hydrogen}-`)));
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
        ['antigravity-gemini-4-argon', 'argon'],
        ['antigravity-gemini-4-hydrogen', 'hydrogen'],
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
        ['antigravity-gpt-oss-120b', ['medium']],
    ] as const) {
        assert.ok(ANTIGRAVITY_MODELS.some(model => model.id === modelId));
        assert.deepStrictEqual(getReasoningLevelsForAgentType('antigravity', modelId), levels);
    }
    // Antigravity CLI 1.4.0 retired Gemini 3.1 Pro.
    assert.ok(!ANTIGRAVITY_MODELS.some(model => model.id === 'antigravity-gemini-3.1-pro'));
});


test('retired Gemini 3.6/3.7 Flash stay out of the catalog and route to Gemini 3.8 Flash', () => {
    const flash = MODEL_INFO_MAP['antigravity-gemini-3.8-flash'];
    for (const version of ['3.6', '3.7']) {
        const base = `antigravity-gemini-${version}-flash`;
        for (const models of [ANTIGRAVITY_MODELS, AGENT_MODELS.antigravity, ALL_MODELS]) {
            assert.ok(!models.some(model => model.id === base));
        }
        assert.ok(!AGENT_DEFAULTS.antigravity.defaultModels.includes(base));
        assert.equal(MODEL_INFO_MAP[base], undefined);
        assert.equal(getModelInfoWithAntigravityCompatibility(base), flash);
        for (const effort of ['low', 'medium', 'high']) {
            assert.equal(getModelInfoWithAntigravityCompatibility(`${base}-${effort}`), flash);
        }
    }
    assert.equal(getModelInfoWithAntigravityCompatibility('antigravity-gemini-3.5-flash'), undefined);
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
