/**
 * Model-aware PR review context budgeting: runtime capacity resolution, the
 * percentage setting and legacy caps, calibrated token estimation, and
 * per-reviewer diff selection against a realistic large code diff.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEncoding } from 'js-tiktoken';
import {
    DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT,
    REVIEW_OUTPUT_TOKEN_RESERVE,
    isValidLegacyReviewMaxContextTokens,
    isValidReviewContextBudgetPercent,
    normalizeReviewContextBudgetPercent,
    resolveReviewInputCapacity,
    resolveReviewInputCeiling,
} from '@propr/shared';
import { buildAnalysisSafetySuffix } from '../packages/core/src/agents/impl/utils/analysisPromptSafety.js';
import { buildReviewPromptWithinBudget } from '../src/jobs/reviewPromptBuilder.js';
import { ReviewTokenEstimator, ReviewTokenStatsCache } from '../src/jobs/reviewTokenEstimator.js';
import { formatPRDiffWithMetadata, preparePRDiff, type PRFile } from '../src/jobs/prDiffFormatting.js';

const o200k = getEncoding('o200k_base');
const cl100k = getEncoding('cl100k_base');
const ANALYSIS_SUFFIX = buildAnalysisSafetySuffix('text', false, undefined);
const MANDATORY_SECTIONS = ['## Overall Evaluation', '## Actionable Findings', '## Suggestions and Follow-ups', '## Score'];

// Deterministic generator for realistic TypeScript change hunks.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const WORDS = ['review', 'context', 'budget', 'token', 'reviewer', 'capacity', 'runtime', 'session', 'request', 'result',
    'config', 'agent', 'model', 'route', 'server', 'client', 'handler', 'payload', 'schema', 'state', 'queue', 'task',
    'comment', 'finding', 'diff', 'patch', 'file', 'repository', 'branch', 'commit', 'status', 'error', 'options'];

function codeLine(random: () => number): string {
    const word = () => WORDS[Math.floor(random() * WORDS.length)];
    const camel = () => `${word()}${word().replace(/^./, c => c.toUpperCase())}`;
    switch (Math.floor(random() * 8)) {
        case 0: return `import { ${camel()}, type ${camel().replace(/^./, c => c.toUpperCase())} } from './${word()}/${camel()}.js';`;
        case 1: return `    const ${camel()} = await ${camel()}(${camel()}, { ${word()}: ${camel()}.${word()}, timeoutMs: ${Math.floor(random() * 90000)} });`;
        case 2: return `    if (!${camel()} || ${camel()}.length === 0) throw new Error(\`Missing ${word()} for \${${camel()}}\`);`;
        case 3: return `export function ${camel()}(${camel()}: string, ${camel()}: number): Promise<${camel().replace(/^./, c => c.toUpperCase())}> {`;
        case 4: return `    // ${word()} the ${word()} before the ${word()} is ${word()}ed so the ${word()} stays consistent.`;
        case 5: return `    logger.info({ ${camel()}, ${camel()}: ${camel()}.${word()} }, '${word()} ${word()} ${word()}');`;
        case 6: return `    return { ...${camel()}, ${word()}: ${camel()} ?? ${Math.floor(random() * 1000)} };`;
        default: return '    }';
    }
}

function buildFixtureFile(index: number, lines: number): PRFile {
    const random = createRandom(index + 1);
    const body: string[] = [`@@ -${index * 10 + 1},6 +${index * 10 + 1},${lines} @@`];
    for (let line = 0; line < lines; line += 1) body.push(`${random() < 0.85 ? '+' : ' '}${codeLine(random)}`);
    return {
        filename: `packages/api/mcp/module${String(index).padStart(2, '0')}.ts`,
        status: 'modified',
        additions: lines,
        deletions: 0,
        patch: body.join('\n'),
    };
}

// 56 changed files like the production PR #2494 review: ordinary TypeScript
// source (~560K characters) plus one file GitHub returned without a patch.
function buildLargeDiffFixture(fileCount = 56, linesPerFile = 90): PRFile[] {
    const files = Array.from({ length: fileCount - 1 }, (_, index) => buildFixtureFile(index, linesPerFile + (index % 7) * 20));
    files.push({ filename: 'packages/api/mcp/generatedSchema.ts', status: 'modified', additions: 30000, deletions: 0 });
    return files;
}

function reviewOptions(overrides: Record<string, unknown> = {}) {
    return {
        pullRequestNumber: 2494,
        combinedCommentBody: '/review please check the MCP implementation',
        commentHistory: 'Earlier discussion about the MCP adapter.\n'.repeat(200),
        originalTaskSpec: 'IMPLEMENT authenticated MCP tools for ProPR chat control.',
        repoOwner: 'integry',
        repoName: 'propr',
        ...overrides,
    };
}

describe('review input capacity resolution', () => {
    test('uses verified Claude Code runtime windows, not the catalog maximum', () => {
        const opus55 = resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-opus-5-5' });
        assert.equal(opus55.source, 'runtime-verified');
        assert.equal(opus55.contextWindow, 1000000);
        assert.equal(opus55.safeInputTokens, 1000000 - REVIEW_OUTPUT_TOKEN_RESERVE - opus55.runtimeOverheadReserve);
        assert.equal(opus55.tokenizerProfile, 'anthropic-calibrated');

        // The ProPR catalog lists 1M for Opus 4.6, but the runtime only grants it with the [1m] suffix.
        assert.equal(resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-opus-4-6' }).contextWindow, 200000);
        assert.equal(resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-opus-4-6[1m]' }).contextWindow, 1000000);
        assert.equal(resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-haiku-4-5-20251001' }).source, 'runtime-verified');
        assert.equal(resolveReviewInputCapacity({
            agentType: 'claude', model: 'claude-opus-5-5', runtimeEnv: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
        }).contextWindow, 200000);
    });

    test('uses the verified Codex runtime window instead of the 1.05M catalog value', () => {
        const astra = resolveReviewInputCapacity({ agentType: 'codex', model: 'gpt-6-astra' });
        assert.equal(astra.source, 'runtime-verified');
        assert.equal(astra.contextWindow, 272000);
        assert.equal(astra.outputReserve, REVIEW_OUTPUT_TOKEN_RESERVE);
        assert.equal(astra.runtimeOverheadReserve, 12000 + 27200);
        assert.equal(astra.safeInputTokens, 200800);
        assert.equal(astra.tokenizerProfile, 'openai-o200k');
    });

    test('keeps documented conservative fallbacks for unknown models and runtimes', () => {
        const unknownCodex = resolveReviewInputCapacity({ agentType: 'codex', model: 'gpt-9-preview' });
        assert.equal(unknownCodex.source, 'fallback');
        assert.equal(unknownCodex.contextWindow, 272000);

        const unknownClaude = resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-future-9' });
        assert.equal(unknownClaude.source, 'fallback');
        assert.equal(unknownClaude.contextWindow, 200000);

        const unknown = resolveReviewInputCapacity({ model: 'mystery-model' });
        assert.equal(unknown.source, 'fallback');
        assert.equal(unknown.contextWindow, 200000);
        assert.equal(unknown.tokenizerProfile, 'generic-calibrated');
    });

    test('applies a larger runtime reserve to catalog windows of unverified runtimes', () => {
        const gemini = resolveReviewInputCapacity({ agentType: 'antigravity', model: 'antigravity-gemini-3.8-flash-high' });
        assert.equal(gemini.source, 'catalog');
        assert.equal(gemini.contextWindow, 1000000);
        assert.equal(gemini.runtimeOverheadReserve, 100000);
        assert.equal(gemini.safeInputTokens, 1000000 - 32000 - 100000);
    });

    test('never reports a safe capacity that consumes the output or runtime reserves', () => {
        for (const route of [
            { agentType: 'claude', model: 'claude-opus-5-5' },
            { agentType: 'claude', model: 'claude-sonnet-4-5-20250929' },
            { agentType: 'codex', model: 'gpt-5.4-mini' },
            { agentType: 'opencode', model: 'opencode-big-pickle' },
            { agentType: 'vibe', model: 'mistral-medium-3.5' },
        ]) {
            const capacity = resolveReviewInputCapacity(route);
            assert.equal(capacity.safeInputTokens + capacity.outputReserve + capacity.runtimeOverheadReserve, capacity.contextWindow);
            assert.equal(resolveReviewInputCeiling(capacity.safeInputTokens, { percent: 100 }).ceiling, capacity.safeInputTokens);
        }
    });
});

describe('review context budget percentage', () => {
    test('accepts only 10% increments from 10 through 100', () => {
        for (let percent = 10; percent <= 100; percent += 10) assert.ok(isValidReviewContextBudgetPercent(percent));
        for (const invalid of [0, 5, 15, 105, 110, 50.5, '50', null, undefined]) assert.equal(isValidReviewContextBudgetPercent(invalid), false);
    });

    test('treats missing, legacy 0 and unreadable values as automatic 100%', () => {
        for (const value of [undefined, 0, 15, 'abc', null]) {
            assert.equal(normalizeReviewContextBudgetPercent(value), DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT);
        }
        assert.equal(normalizeReviewContextBudgetPercent(40), 40);
    });

    test('scales the safe capacity at the 10% and 100% boundaries', () => {
        assert.equal(resolveReviewInputCeiling(200800, { percent: 100 }).ceiling, 200800);
        assert.equal(resolveReviewInputCeiling(200800, { percent: 10 }).ceiling, 20080);
    });

    test('applies the lower of the percentage allowance and a retained legacy cap', () => {
        const capped = resolveReviewInputCeiling(948000, { percent: 100, legacyMaxContextTokens: 120000 });
        assert.deepEqual({ ceiling: capped.ceiling, limitedBy: capped.limitedBy }, { ceiling: 120000, limitedBy: 'legacy-cap' });
        const narrowed = resolveReviewInputCeiling(948000, { percent: 10, legacyMaxContextTokens: 120000 });
        assert.deepEqual({ ceiling: narrowed.ceiling, limitedBy: narrowed.limitedBy }, { ceiling: 94800, limitedBy: 'percentage' });
        assert.equal(resolveReviewInputCeiling(948000, { percent: 100, legacyMaxContextTokens: 0 }).ceiling, 948000);
    });

    test('keeps legacy cap validation for old clients', () => {
        assert.ok(isValidLegacyReviewMaxContextTokens(0));
        assert.ok(isValidLegacyReviewMaxContextTokens(120000));
        assert.equal(isValidLegacyReviewMaxContextTokens(9999), false);
        assert.equal(isValidLegacyReviewMaxContextTokens(2000001), false);
    });
});

describe('review token estimation', () => {
    const code = buildLargeDiffFixture(6).flatMap(file => file.patch ? [file.patch] : []).join('\n');

    test('never under-counts code relative to the o200k or cl100k tokenizers', () => {
        const openai = new ReviewTokenEstimator('openai-o200k').estimate(code);
        const claude = new ReviewTokenEstimator('anthropic-calibrated').estimate(code);
        assert.ok(openai >= o200k.encode(code).length);
        assert.ok(claude >= Math.ceil(cl100k.encode(code).length * 1.36));
        // It is a token estimate, not the UTF-8 byte bound previously used.
        assert.ok(openai < Buffer.byteLength(code, 'utf8') / 2);
    });

    test('keeps Unicode-dense text safely over-estimated', () => {
        const unicode = '漢字の差分🙂🚀 Ünïcödé — ✓\n'.repeat(2000);
        for (const profile of ['openai-o200k', 'anthropic-calibrated', 'generic-calibrated'] as const) {
            const estimate = new ReviewTokenEstimator(profile).estimate(unicode);
            assert.ok(estimate >= o200k.encode(unicode).length, profile);
            assert.ok(estimate >= cl100k.encode(unicode).length, profile);
        }
        assert.ok(new ReviewTokenEstimator('anthropic-calibrated').estimate(unicode) >= [...unicode].filter(c => c.charCodeAt(0) >= 0x80).length * 2);
    });

    test('treats special-token text in review input as ordinary text', () => {
        assert.ok(new ReviewTokenEstimator('openai-o200k').estimate('+ const marker = "<|endoftext|>";') > 0);
    });

    test('fits prefixes within the requested token allowance', () => {
        const estimator = new ReviewTokenEstimator('generic-calibrated');
        const length = estimator.fitPrefixLength(code, 5000);
        assert.ok(length > 0 && length < code.length);
        assert.ok(estimator.estimate(code.slice(0, length)) <= 5000);
    });
});

describe('budgeting a realistic large code diff', () => {
    const files = buildLargeDiffFixture();
    const prepared = preparePRDiff(files, 4000000);
    const stats = new ReviewTokenStatsCache();
    const astra = resolveReviewInputCapacity({ agentType: 'codex', model: 'gpt-6-astra' });
    const astraEstimator = () => new ReviewTokenEstimator(astra.tokenizerProfile, stats);

    test('fits files the byte-as-token budget omitted when their estimated cost fits', () => {
        // Previous behavior for this route: 0.98 × 272000 − 24000 = 242,560
        // "tokens" counted as UTF-8 bytes, with the diff pre-capped at
        // 2 characters × 70% of that budget = 339,584 characters.
        const previous = formatPRDiffWithMetadata(files, Math.floor(242560 * 0.7) * 2);
        const previouslyOmitted = previous.omittedFiles.filter(filename => filename !== 'packages/api/mcp/generatedSchema.ts');
        assert.ok(previouslyOmitted.length >= 10, `expected the old cap to omit source files, got ${previouslyOmitted.length}`);

        // The new ceiling is lower than the old number, so any gain comes from
        // counting tokens, not from raising the limit.
        const ceiling = resolveReviewInputCeiling(astra.safeInputTokens, { percent: 100 }).ceiling;
        assert.ok(ceiling < 242560);
        const result = buildReviewPromptWithinBudget(reviewOptions(), ceiling, ANALYSIS_SUFFIX, {
            preparedDiff: prepared,
            estimator: astraEstimator(),
        });

        assert.deepEqual(result.budgetOmittedFiles, []);
        for (const filename of previouslyOmitted) assert.ok(result.prompt.includes(`## ${filename} (`), filename);
        assert.ok(result.estimatedTokens <= ceiling);
        assert.ok(o200k.encode(`${result.prompt}${ANALYSIS_SUFFIX}`).length <= ceiling);
        assert.ok(result.prompt.length > 400000, 'far more review input than the old 242,560-character ceiling');
        // GitHub never supplied this patch; no budget can recover it.
        assert.deepEqual(result.missingPatchFiles, ['packages/api/mcp/generatedSchema.ts']);
        assert.ok(result.prompt.includes('GitHub supplied no patch content; a larger review budget cannot recover these (1):'));
    });

    test('trims an over-budget diff deterministically and discloses the omission', () => {
        const ceiling = resolveReviewInputCeiling(astra.safeInputTokens, { percent: 30 }).ceiling;
        const build = () => buildReviewPromptWithinBudget(reviewOptions({
            fileContents: 'export const unchanged = true;\n'.repeat(5000),
            instructions: 'Focus on authorization boundaries.',
        }), ceiling, ANALYSIS_SUFFIX, { preparedDiff: prepared, estimator: astraEstimator() });
        const first = build();
        const second = build();

        assert.equal(first.prompt, second.prompt);
        assert.ok(first.estimatedTokens <= ceiling);
        assert.ok(first.budgetOmittedFiles.length > 0);
        assert.ok(first.prDiffTruncated);
        assert.deepEqual(first.truncatedSections, ['comment history', 'changed file contents', 'PR diff']);
        assert.ok(first.prompt.includes('Did not fit the review context budget'));
        assert.ok(!first.budgetOmittedFiles.includes('packages/api/mcp/generatedSchema.ts'));
        assert.deepEqual(first.missingPatchFiles, ['packages/api/mcp/generatedSchema.ts']);
        // Objective, request, operator instructions and the output contract survive.
        assert.ok(first.prompt.includes('IMPLEMENT authenticated MCP tools for ProPR chat control.'));
        assert.ok(first.prompt.includes('/review please check the MCP implementation'));
        assert.ok(first.prompt.includes('Focus on authorization boundaries.'));
        for (const section of MANDATORY_SECTIONS) assert.ok(first.prompt.includes(section));
    });

    test('lets each mixed reviewer use its own capacity from the same untrimmed diff', () => {
        const larger = preparePRDiff(buildLargeDiffFixture(56, 260), 4000000);
        const opus = resolveReviewInputCapacity({ agentType: 'claude', model: 'claude-opus-5-5' });
        const small = buildReviewPromptWithinBudget(reviewOptions(), astra.safeInputTokens, ANALYSIS_SUFFIX, {
            preparedDiff: larger, estimator: astraEstimator(),
        });
        const large = buildReviewPromptWithinBudget(reviewOptions(), opus.safeInputTokens, ANALYSIS_SUFFIX, {
            preparedDiff: larger, estimator: new ReviewTokenEstimator(opus.tokenizerProfile, stats),
        });

        assert.ok(small.budgetOmittedFiles.length > 0, 'the smaller reviewer trims its own prompt');
        assert.deepEqual(large.budgetOmittedFiles, [], 'the larger reviewer is not limited by the smaller one');
        assert.ok(small.estimatedTokens <= astra.safeInputTokens);
        assert.ok(large.estimatedTokens <= opus.safeInputTokens);
    });

    test('counts the analysis runtime suffix inside the ceiling', () => {
        const withoutSuffix = buildReviewPromptWithinBudget(reviewOptions(), 50000, '', { preparedDiff: prepared, estimator: astraEstimator() });
        const withSuffix = buildReviewPromptWithinBudget(reviewOptions(), 50000, ANALYSIS_SUFFIX, { preparedDiff: prepared, estimator: astraEstimator() });
        assert.ok(withSuffix.estimatedTokens <= 50000);
        assert.ok(withSuffix.budgetOmittedFiles.length >= withoutSuffix.budgetOmittedFiles.length);
        assert.ok(withSuffix.sectionTokens.scaffold > withoutSuffix.sectionTokens.scaffold);
    });
});
