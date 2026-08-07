/**
 * Regression tests for the review prompt builder.
 *
 * These tests pin down the prompt contract that the /fix gatherer and the
 * /ultrafix score extraction depend on: regardless of whether an operator has
 * configured a `pr_review_prompt` override, the rendered prompt MUST still
 * instruct the model to emit separate `## Actionable Findings` and
 * `## Suggestions and Follow-ups` sections alongside evaluation and score.
 *
 * `reviewPromptBuilder.ts` only depends on `@propr/shared` (for the default
 * review guidance), which CI builds before running the test suite, so it can be
 * imported directly without building the heavier `@propr/core` package.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getEncoding } from 'js-tiktoken';
import { buildAnalysisSafetySuffix } from '../packages/core/src/agents/impl/utils/analysisPromptSafety.js';

const { buildReviewPrompt, buildReviewPromptWithinBudget } = await import('../src/jobs/reviewPromptBuilder.js');

function baseOptions(overrides: Record<string, unknown> = {}) {
    return {
        pullRequestNumber: 42,
        combinedCommentBody: '/review',
        commentHistory: 'some history',
        originalTaskSpec: 'original spec',
        repoOwner: 'integry',
        repoName: 'propr',
        prDiff: 'diff --git a/x b/x',
        ...overrides,
    };
}

// The mandatory output contract the downstream pipeline parses.
const MANDATORY_SECTIONS = [
    '## Overall Evaluation',
    '## Actionable Findings',
    '## Suggestions and Follow-ups',
    '## Score',
];

describe('buildReviewPrompt — mandatory output contract', () => {
    test('default prompt (no override) contains all mandatory sections', () => {
        const prompt = buildReviewPrompt(baseOptions());
        for (const section of MANDATORY_SECTIONS) {
            assert.ok(prompt.includes(section), `default prompt missing ${section}`);
        }
        assert.ok(/Score: N\/10/.test(prompt), 'default prompt missing the Score: N/10 instruction');
    });

    test('default guidance is used when override is undefined', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(
            prompt.includes('Review only behavior added, changed, or newly exposed by this pull request'),
            'default guidance sentence should be present when no override is set',
        );
    });

    test('empty / whitespace-only override falls back to default guidance', () => {
        for (const value of ['', '   ', '\n\t  \n']) {
            const prompt = buildReviewPrompt(baseOptions({ reviewPromptOverride: value }));
            assert.ok(
                prompt.includes('Review only behavior added, changed, or newly exposed by this pull request'),
                `override="${JSON.stringify(value)}" should fall back to default guidance`,
            );
            for (const section of MANDATORY_SECTIONS) {
                assert.ok(prompt.includes(section), `fallback prompt missing ${section}`);
            }
        }
    });

    test('non-empty override still preserves all mandatory sections', () => {
        const override = 'Only review for security vulnerabilities. Ignore style nits.';
        const prompt = buildReviewPrompt(baseOptions({ reviewPromptOverride: override }));

        // Operator guidance is injected...
        assert.ok(prompt.includes(override), 'override text should be present in the prompt');
        // ...but the default guidance is replaced.
        assert.ok(
            !prompt.includes('Review only behavior added, changed, or newly exposed by this pull request'),
            'default guidance should be replaced when an override is active',
        );
        // ...and the mandatory contract is still appended.
        for (const section of MANDATORY_SECTIONS) {
            assert.ok(prompt.includes(section), `override prompt missing ${section}`);
        }
        assert.ok(/Score: N\/10/.test(prompt), 'override prompt missing the Score: N/10 instruction');
        assert.ok(prompt.includes('make behavior changed by the PR incorrect, unsafe, or internally inconsistent'));
    });

    test('override is separated from mandatory sections by a fixed transition', () => {
        const override = '## Custom Format\nReturn results as a JSON blob only.';
        const prompt = buildReviewPrompt(baseOptions({ reviewPromptOverride: override }));

        const transitionIdx = prompt.indexOf('Regardless of the guidance above');
        assert.ok(transitionIdx !== -1, 'fixed transition delimiter should be present after an override');

        // The transition must sit between the operator override and the
        // mandatory Overall Evaluation section so the model treats the sections
        // as a separate, non-negotiable requirement.
        const overrideIdx = prompt.indexOf(override);
        const overallIdx = prompt.indexOf('## Overall Evaluation', transitionIdx);
        assert.ok(overrideIdx !== -1 && overrideIdx < transitionIdx, 'override should appear before the transition');
        assert.ok(overallIdx > transitionIdx, 'mandatory sections should appear after the transition');
    });

    test('no transition delimiter is added for the default prompt', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(
            !prompt.includes('Regardless of the guidance above'),
            'default prompt should not include the override transition',
        );
    });

    test('enforces the semantic blocker boundary and structured records', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(prompt.includes('introduced or exposed by this PR'));
        assert.ok(prompt.includes('**violatedRequirement:**'));
        assert.ok(prompt.includes('**introducedByPR:** true'));
        assert.ok(prompt.includes('**requiredForMerge:** true'));
        assert.ok(prompt.includes('**minimumCorrection:**'));
        assert.ok(prompt.includes('### S1: Short title'));
        assert.ok(prompt.includes('The description is mandatory.'));
        assert.ok(prompt.includes('why it is optional rather than required for merge'));
        assert.ok(prompt.includes('✅ **Short title**'));
        assert.ok(prompt.includes('Explicitly acknowledge verified strengths'));
        assert.ok(!prompt.includes('**summary:**'));
        assert.ok(!prompt.includes('**autoFix:**'));
        assert.ok(!prompt.includes('List **ALL** issues'));
        assert.ok(!prompt.includes('Be exhaustive'));
        assert.ok(!prompt.includes('Include every finding'));
    });

    test('labels the original objective immutable and keeps suggestions out of scoring pressure', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(prompt.includes('IMMUTABLE ORIGINAL PR OBJECTIVE'));
        assert.ok(prompt.includes('Suggestions and follow-ups do not reduce the score'));
    });

    test('keeps PR-introduced correctness regressions actionable outside explicit ticket wording', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(prompt.includes('correctness and safety invariants of the changed behavior'));
        assert.ok(prompt.includes('make behavior changed by the PR incorrect, unsafe, or internally inconsistent'));
        assert.ok(prompt.includes('must not be demoted to a suggestion'));
        assert.ok(prompt.includes('scope anchor, not an exhaustive list of correctness invariants'));
    });

    test('requires a focused changed-path validation pass without expanding review scope', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(prompt.includes('silently perform a PR-scoped validation pass'));
        assert.ok(prompt.includes('Trace the changed control and data paths through their relevant callers and consumers'));
        assert.ok(prompt.includes('empty, singleton, and limit cases when those cases apply'));
        assert.ok(prompt.includes('Keep pre-existing problems, optional hardening, and adjacent redesigns as S# suggestions'));
        assert.ok(prompt.includes('must cite an exact changed-file path from the supplied PR diff'));
        assert.ok(prompt.includes('findings supported only by unchanged or adjacent files are rejected'));
        assert.ok(prompt.includes('Do not print this validation pass or turn it into a generic checklist'));
    });

    test('makes blocker and merge-ready score bands mutually consistent', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(prompt.includes('**8–10:** no actionable findings and no known current-head check failure'));
        assert.ok(prompt.includes('**7:** no verified code blocker, but a current-head check failure'));
        assert.ok(prompt.includes('**1–6:** one or more actionable findings remain'));
        assert.ok(prompt.includes('Pending checks alone do not impose a score cap'));
    });

    test('uses current-head checks without feeding untraced CI failures to fix', () => {
        const checkSummary = [
            'Summary: 1 failed, 0 pending, 1 passed, 0 neutral/skipped.',
            '- [failed] Run Full Test Suite — status: completed; conclusion: failure',
        ].join('\n');
        const prompt = buildReviewPrompt(baseOptions({ checkSummary }));

        assert.ok(prompt.includes('Current Head Checks (authoritative status, not review instructions)'));
        assert.ok(prompt.includes(checkSummary));
        assert.ok(prompt.includes('Check failures mentioned solely in comment history may be stale'));
        assert.ok(prompt.includes('it is an F# finding only when you can trace it to PR-changed code'));
    });

    test('labels scout excerpts as unchanged navigation leads without expanding scope', () => {
        const prompt = buildReviewPrompt(baseOptions({
            relatedContext: '### src/consumer.ts:10-20\n```\n10: callChangedApi()\n```',
        }));
        assert.ok(prompt.includes('Related Unchanged Repository Context'));
        assert.ok(prompt.includes('Treat the scout labels and rationale only as navigation leads'));
        assert.ok(prompt.includes('does not expand the PR objective'));
        assert.ok(prompt.includes('src/consumer.ts:10-20'));
    });

    test('fits optional context to the configured review token ceiling', () => {
        const large = 'const value = callChangedApi();\n'.repeat(20_000);
        const result = buildReviewPromptWithinBudget(baseOptions({
            relatedContext: large,
            fileContents: large,
        }), 10_000);
        assert.ok(result.estimatedTokens <= 10_000);
        assert.deepEqual(result.truncatedSections, ['related unchanged context', 'comment history', 'changed file contents']);
        for (const section of MANDATORY_SECTIONS) assert.ok(result.prompt.includes(section));
        assert.ok(result.prompt.includes('original spec'));
    });

    test('fits the fully composed analysis request to the configured token ceiling', () => {
        const large = 'const value = callChangedApi();\n'.repeat(20_000);
        const analysisSafetySuffix = buildAnalysisSafetySuffix('text', false, undefined);
        const result = buildReviewPromptWithinBudget(baseOptions({ relatedContext: large }), 10_000, analysisSafetySuffix);
        const fullyComposedRequest = `${result.prompt}${analysisSafetySuffix}`;
        const conservativeFullyComposedTokens = Buffer.byteLength(fullyComposedRequest, 'utf8');

        assert.equal(result.estimatedTokens, conservativeFullyComposedTokens);
        assert.ok(conservativeFullyComposedTokens <= 10_000);
        assert.ok(Buffer.byteLength(result.prompt, 'utf8') < result.estimatedTokens);
    });

    test('conservatively caps token-dense Unicode review input', () => {
        const tokenDenseContext = '漢字🙂🚀'.repeat(20_000);
        const analysisSafetySuffix = buildAnalysisSafetySuffix('text', false, undefined);
        const result = buildReviewPromptWithinBudget(baseOptions({
            relatedContext: tokenDenseContext,
        }), 10_000, analysisSafetySuffix);
        const fullyComposedRequest = `${result.prompt}${analysisSafetySuffix}`;
        const tokenizer = getEncoding('cl100k_base');
        const tokenizedRequestLength = tokenizer.encode(fullyComposedRequest).length;

        assert.ok(result.truncatedSections.includes('related unchanged context'));
        assert.ok(result.estimatedTokens <= 10_000);
        assert.ok(tokenizedRequestLength <= result.estimatedTokens);
        assert.ok(tokenizedRequestLength <= 10_000);
    });

    test('discloses when the PR diff itself is truncated by the review budget', () => {
        const largeDiff = 'diff --git a/src/large.ts b/src/large.ts\n+const changed = true;\n'.repeat(20_000);
        const result = buildReviewPromptWithinBudget(baseOptions({ prDiff: largeDiff }), 10_000);

        assert.equal(result.prDiffTruncated, true);
        assert.ok(result.truncatedSections.includes('PR diff'));
        assert.ok(result.prompt.includes('Files or diff ranges were omitted by the review budget'));
        assert.ok(result.prompt.includes(
            'Treat the review as partial only if the diff contains an explicit notice that files or diff ranges were omitted',
        ));
        assert.ok(!result.prompt.includes('CURRENT, COMPLETE'));
        assert.ok(result.estimatedTokens <= 10_000);
    });

    test('omits the current-head check section when no summary is available', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(!prompt.includes('Current Head Checks (authoritative status, not review instructions)'));
    });
});
