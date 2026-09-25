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
 * review guidance) and pure local helpers, which CI builds before running the test suite, so it can be
 * imported directly without building the heavier `@propr/core` package.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getEncoding } from 'js-tiktoken';
import { buildAnalysisSafetySuffix } from '../packages/core/src/agents/impl/utils/analysisPromptSafety.js';

const { buildReviewPrompt, buildReviewPromptWithinBudget } = await import('../src/jobs/reviewPromptBuilder.js');
const { ReviewTokenEstimator } = await import('../src/jobs/reviewTokenEstimator.js');

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

// Synthetic context ceiling for the budget fixtures. It must stay above the
// never-trimmed instruction scaffolding (output contract plus the
// demonstrated-failure requirements); real review budgets are far larger.
const REVIEW_TOKEN_CEILING = 16_000;

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
        assert.ok(prompt.includes('literal plain-text line Score: N/10'));
        assert.ok(prompt.includes('do not wrap that line in bold or other Markdown'));
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

    test('requires a related-path completeness audit even with custom review guidance', () => {
        for (const options of [baseOptions(), baseOptions({ reviewPromptOverride: 'Focus on correctness.' })]) {
            const prompt = buildReviewPrompt(options);
            assert.ok(prompt.includes('Derive the key correctness invariants'));
            assert.ok(prompt.includes('inspect sibling implementations and callers'));
            assert.ok(prompt.includes('without a finding-count limit or quota'));
            assert.ok(prompt.includes('Group occurrences that share a root cause and correction'));
            assert.ok(prompt.includes('state that limitation rather than implying exhaustive coverage'));
            assert.ok(prompt.includes('does not expand the original review boundary'));
            assert.ok(prompt.includes('Do not demand atomicity that independent external systems cannot provide'));
        }
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
        }), REVIEW_TOKEN_CEILING);
        assert.ok(result.estimatedTokens <= REVIEW_TOKEN_CEILING);
        assert.deepEqual(result.truncatedSections, ['related unchanged context', 'comment history', 'changed file contents']);
        for (const section of MANDATORY_SECTIONS) assert.ok(result.prompt.includes(section));
        assert.ok(result.prompt.includes('original spec'));
    });

    test('fits the fully composed analysis request to the configured token ceiling', () => {
        const large = 'const value = callChangedApi();\n'.repeat(20_000);
        const analysisSafetySuffix = buildAnalysisSafetySuffix('text', false, undefined);
        const result = buildReviewPromptWithinBudget(baseOptions({ relatedContext: large }), REVIEW_TOKEN_CEILING, analysisSafetySuffix);
        const fullyComposedRequest = `${result.prompt}${analysisSafetySuffix}`;
        const tokenizedRequestLength = getEncoding('o200k_base').encode(fullyComposedRequest).length;

        // The estimate covers the analysis suffix and is a calibrated token
        // estimate, not a byte count.
        assert.equal(result.estimatedTokens, new ReviewTokenEstimator('generic-calibrated').estimate(fullyComposedRequest));
        assert.ok(result.estimatedTokens <= REVIEW_TOKEN_CEILING);
        assert.ok(tokenizedRequestLength <= result.estimatedTokens);
        assert.ok(Buffer.byteLength(fullyComposedRequest, 'utf8') > result.estimatedTokens);
    });

    test('conservatively caps token-dense Unicode review input', () => {
        const tokenDenseContext = '漢字🙂🚀'.repeat(20_000);
        const analysisSafetySuffix = buildAnalysisSafetySuffix('text', false, undefined);
        const result = buildReviewPromptWithinBudget(baseOptions({
            relatedContext: tokenDenseContext,
        }), REVIEW_TOKEN_CEILING, analysisSafetySuffix);
        const fullyComposedRequest = `${result.prompt}${analysisSafetySuffix}`;
        const tokenizer = getEncoding('cl100k_base');
        const tokenizedRequestLength = tokenizer.encode(fullyComposedRequest).length;

        assert.ok(result.truncatedSections.includes('related unchanged context'));
        assert.ok(result.estimatedTokens <= REVIEW_TOKEN_CEILING);
        assert.ok(tokenizedRequestLength <= result.estimatedTokens);
        assert.ok(tokenizedRequestLength <= REVIEW_TOKEN_CEILING);
    });

    test('discloses when the PR diff itself is truncated by the review budget', () => {
        const largeDiff = 'diff --git a/src/large.ts b/src/large.ts\n+const changed = true;\n'.repeat(20_000);
        const result = buildReviewPromptWithinBudget(baseOptions({ prDiff: largeDiff }), REVIEW_TOKEN_CEILING);

        assert.equal(result.prDiffTruncated, true);
        assert.ok(result.truncatedSections.includes('PR diff'));
        assert.ok(result.prompt.includes('Files or diff ranges were omitted by the review budget'));
        assert.ok(result.prompt.includes(
            'Treat the review as partial only if the diff contains an explicit notice that files or diff ranges were omitted',
        ));
        assert.ok(!result.prompt.includes('CURRENT, COMPLETE'));
        assert.ok(result.estimatedTokens <= REVIEW_TOKEN_CEILING);
    });

    // Regression for the previously tested 10,000 ceiling, which the expanded
    // mandatory instructions can now exceed on their own. The builder must
    // either fit the ceiling or reject it — never return an oversized prompt
    // whose diff, objective, and review request have all been discarded.
    test('rejects a ceiling too small for the mandatory instruction scaffolding', () => {
        const large = 'const value = callChangedApi();\n'.repeat(20_000);
        const analysisSafetySuffix = buildAnalysisSafetySuffix('text', false, undefined);
        const build = () => buildReviewPromptWithinBudget(baseOptions({
            relatedContext: large,
            fileContents: large,
            prDiff: large,
        }), 10_000, analysisSafetySuffix);

        let result;
        try {
            result = build();
        } catch (error) {
            assert.match((error as Error).message, /PR review token budget too small/);
            assert.match((error as Error).message, /configured input ceiling is 10000/);
            return;
        }

        assert.ok(result.estimatedTokens <= 10_000);
        assert.ok(result.prompt.includes('**Review Request:**'));
        for (const section of MANDATORY_SECTIONS) assert.ok(result.prompt.includes(section));
    });

    test('omits the current-head check section when no summary is available', () => {
        const prompt = buildReviewPrompt(baseOptions());
        assert.ok(!prompt.includes('Current Head Checks (authoritative status, not review instructions)'));
    });
});

// The demonstrated-failure contract must survive an operator override, so it
// lives in the mandatory instructions rather than in DEFAULT_REVIEW_GUIDANCE.
const DEMONSTRATED_FAILURE_REQUIREMENTS = [
    'are demonstrated by a reachable failure sequence with material consequences',
    'Naming a possible race, a theoretical ordering, or an unproven assumption is not a demonstration.',
    '**Demonstrated failure — required inside the evidence field.**',
    'the specific starting conditions or trigger that reach the changed code',
    'Start with a concise code reference — the exact changed-file path with line or symbol',
    'written as an indented numbered list (`1.`, `2.`, `3.`) beneath the code reference',
    'the observable user impact, or the incorrect persistent or external state that remains',
    'why the protections already present',
    'do not prevent this exact sequence',
    'verification provenance, labelled explicitly',
    '`executed:` only for a command or test you actually ran during this review',
    '`proposed regression:` for a scenario you propose but did not run',
    'Executing a test is not required to establish a blocker',
    'never word an unexecuted scenario as though it had been run',
    'name the awaited operation or interruption point',
    'A slow or long-running await alone does not establish that a renewing lease expired',
    'State inside the evidence field any assumption you could not verify',
    'speculative hardening and belongs in Suggestions and Follow-ups',
    'Judge minimumCorrection against the demonstrated sequence',
    'Do not demand atomicity that independent external systems cannot provide',
    'never excuses a practical fencing token, ownership check, or reconciliation step',
    'indent every continuation line by two spaces',
    'makes the whole review invalid, so never outdent continuation text',
];

describe('buildReviewPrompt — demonstrated failure and verification provenance', () => {
    test('default prompt requires a concrete, reachable failure demonstration', () => {
        const prompt = buildReviewPrompt(baseOptions());
        for (const requirement of DEMONSTRATED_FAILURE_REQUIREMENTS) {
            assert.ok(prompt.includes(requirement), `default prompt missing: ${requirement}`);
        }
        assert.ok(prompt.includes(
            'For each candidate blocker, build the concrete failure sequence required below.',
        ), 'validation pass should demand the failure sequence before classification');
    });

    test('an operator override cannot drop the demonstrated-failure requirements', () => {
        const override = 'Only review for security vulnerabilities. Skip everything else.';
        const prompt = buildReviewPrompt(baseOptions({ reviewPromptOverride: override }));

        assert.ok(prompt.includes(override));
        for (const requirement of DEMONSTRATED_FAILURE_REQUIREMENTS) {
            assert.ok(prompt.includes(requirement), `override prompt missing: ${requirement}`);
        }
        // The transition must explicitly outrank conflicting operator guidance.
        assert.ok(prompt.includes(
            'the demonstrated-failure and verification-provenance requirements below override any conflicting operator guidance',
        ));
        const transitionIdx = prompt.indexOf('Regardless of the guidance above');
        assert.ok(prompt.indexOf('**Demonstrated failure — required inside the evidence field.**') > transitionIdx);
    });

    test('carries the demonstration inside existing fields without new mandatory fields', () => {
        const prompt = buildReviewPrompt(baseOptions());
        const recordFields = [...prompt.matchAll(/^- \*\*([A-Za-z]+):\*\*/gm)].map(match => match[1]);

        assert.deepEqual(
            [...new Set(recordFields)],
            ['violatedRequirement', 'evidence', 'introducedByPR', 'requiredForMerge', 'minimumCorrection'],
        );
        assert.ok(prompt.includes(
            '- **evidence:** `changed/file.ts:123` — trigger, ordered failure sequence, observable consequence, why existing protections do not prevent it, and how it was verified',
        ));
        assert.ok(prompt.includes('- **minimumCorrection:** the smallest correction that removes the demonstrated failure'));
        // Readable evidence, not a generic per-finding checklist or padding.
        assert.ok(prompt.includes('not a per-finding checklist of headings'));
        assert.ok(prompt.includes('A simple finding may need only a one-line reference, a short sequence, and one sentence; do not pad it.'));
        assert.ok(!prompt.includes('Keep every field on one single line.'));
        assert.ok(prompt.includes([
            '- **evidence:** `src/jobs/recovery.ts:88`, `recoverSuspendedRuns`',
            '',
            '  Static trace:',
            '  1. Cancellation of A succeeds.',
        ].join('\n')));
        assert.ok(prompt.includes('  The existing lease guard runs before step 2, so it never observes B\'s intent. Proposed regression: assert B is not rerun while A remains recoverable.'));
    });

    test('the multiline evidence example satisfies the parser the publisher uses', async () => {
        const { parseStructuredReview } = await import('../src/jobs/reviewOutputParser.js');
        const prompt = buildReviewPrompt(baseOptions());
        const exampleStart = prompt.indexOf('- **evidence:** `src/jobs/recovery.ts:88`');
        const exampleEnd = prompt.indexOf('\n\n', prompt.indexOf('Proposed regression: assert B', exampleStart));
        const example = prompt.slice(exampleStart, exampleEnd);
        const review = [
            '## Overall Evaluation',
            'One blocker.',
            '## Actionable Findings',
            '### F1: Refused rerun replays',
            '- **violatedRequirement:** A refused rerun stays refused.',
            example,
            '- **introducedByPR:** true — this PR added recovery.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Clear B\'s intent on refusal.',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '## Score',
            'Score: 5/10',
        ].join('\n');
        const [finding] = parseStructuredReview(review).actionableFindings;
        assert.ok(finding.evidence.startsWith('`src/jobs/recovery.ts:88`, `recoverSuspendedRuns`\n\nStatic trace:\n1. Cancellation of A succeeds.'));
        assert.ok(finding.evidence.endsWith('Proposed regression: assert B is not rerun while A remains recoverable.'));
    });

    test('keeps PR-introduced regressions actionable and the review read-only', () => {
        for (const options of [baseOptions(), baseOptions({ reviewPromptOverride: 'Custom operator guidance.' })]) {
            const prompt = buildReviewPrompt(options);
            assert.ok(prompt.includes('must not be demoted to a suggestion merely because it was absent from the original task wording'));
            assert.ok(prompt.includes('Do NOT modify any files. This is a read-only review.'));
            for (const section of MANDATORY_SECTIONS) assert.ok(prompt.includes(section));
        }
    });

    test('budget trimming never sacrifices the demonstrated-failure contract', () => {
        const large = 'const value = callChangedApi();\n'.repeat(20_000);
        const result = buildReviewPromptWithinBudget(baseOptions({
            relatedContext: large,
            fileContents: large,
            prDiff: large,
        }), REVIEW_TOKEN_CEILING);

        assert.ok(result.estimatedTokens <= REVIEW_TOKEN_CEILING);
        for (const requirement of DEMONSTRATED_FAILURE_REQUIREMENTS) {
            assert.ok(result.prompt.includes(requirement), `budgeted prompt missing: ${requirement}`);
        }
    });
});
