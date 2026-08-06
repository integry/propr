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

const { buildReviewPrompt } = await import('../src/jobs/reviewPromptBuilder.js');

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
            prompt.includes('Review only behavior added or changed by this pull request'),
            'default guidance sentence should be present when no override is set',
        );
    });

    test('empty / whitespace-only override falls back to default guidance', () => {
        for (const value of ['', '   ', '\n\t  \n']) {
            const prompt = buildReviewPrompt(baseOptions({ reviewPromptOverride: value }));
            assert.ok(
                prompt.includes('Review only behavior added or changed by this pull request'),
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
            !prompt.includes('Review only behavior added or changed by this pull request'),
            'default guidance should be replaced when an override is active',
        );
        // ...and the mandatory contract is still appended.
        for (const section of MANDATORY_SECTIONS) {
            assert.ok(prompt.includes(section), `override prompt missing ${section}`);
        }
        assert.ok(/Score: N\/10/.test(prompt), 'override prompt missing the Score: N/10 instruction');
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
        assert.ok(prompt.includes('### S1: Concise description of the optional follow-up'));
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
});
