import { after, test, describe } from 'node:test';
import assert from 'node:assert';

const { buildReviewComment, getNextAuthenticatedReviewRecordNumbers } = await import('../src/jobs/reviewCommentFormatter.js');
const {
    getNextActionableFindingNumber, getNextReviewSuggestionNumber, parseStructuredReview,
} = await import('../src/jobs/reviewOutputParser.js');
const { closeConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
});

describe('buildReviewComment', () => {
    test('explains that explicit finding IDs are permanent within the PR', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: '## Actionable Findings\nNo actionable findings.\n\n## Score\nScore: 10/10',
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(comment.includes('F# and S# IDs increment across review comments and remain permanent'));
        assert.ok(comment.includes('`/fix F3 F5`'));
        // Suggestions are selectable now, and the hint must say they stay optional.
        assert.ok(comment.includes('`/fix F3 S5`'));
        assert.ok(comment.includes('implemented only when you name them'));
        assert.ok(comment.includes('never relax a merge blocker'));
        assert.ok(!comment.includes('/fix include S'));
    });

    test('publishes short suggestion headings with reasoning and normalizes legacy metadata', () => {
        const response = [
            '## Overall Evaluation',
            'Ready.',
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            '### S1: Add an outbox',
            '- **summary:** Optional hardening',
            '- **autoFix:** true',
            '### S2: Add a benchmark',
            '- **summary:** Optional performance coverage',
            '## Score',
            'Score: 9/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );
        assert.ok(formatted.includes('### S1: 🟢 Add an outbox'));
        assert.ok(formatted.includes('### S2: 🟢 Add a benchmark'));
        assert.ok(formatted.includes('Optional hardening'));
        assert.ok(formatted.includes('Optional performance coverage'));
        assert.ok(!formatted.includes('summary:'));
        assert.ok(!formatted.includes('autoFix:'));
        const reparsed = parseStructuredReview(formatted);
        assert.strictEqual(reparsed.status, 'valid_clean');
        assert.strictEqual(reparsed.suggestions[0].description, 'Optional hardening');
    });

    test('publishes validated blockers with reader-facing sections and labels', () => {
        const response = [
            '## Overall Evaluation',
            'Cancellation needs one correction before merge.',
            '',
            '## Actionable Findings',
            '### F1: Retry transitions can overwrite cancellation',
            '- **violatedRequirement:** Cancellation must not be overwritten by another state writer.',
            '- **evidence:** workerStateManager.ts:130 — retry metadata bypasses terminal-state protection.',
            '- **introducedByPR:** true — this PR added the retry exception.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Keep cancelled tasks immutable and add a cancellation-versus-retry test.',
            '',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '',
            '## Score',
            'Score: 6/10',
            'The cancellation race blocks merging.',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(formatted.includes('## Merge blockers'));
        assert.ok(formatted.includes('### F1: 🔴 Retry transitions can overwrite cancellation'));
        assert.ok(formatted.includes('Every finding below was introduced by this PR and must be resolved before merging.'));
        assert.ok(formatted.includes('- **Required behavior:** Cancellation must not be overwritten'));
        assert.ok(formatted.includes('- **Evidence:** workerStateManager.ts:130'));
        assert.ok(formatted.includes('- **Minimum fix:** Keep cancelled tasks immutable'));
        assert.ok(formatted.includes('## Suggestions\n\nThese are optional follow-ups and are not sent to `/fix`.'));
        assert.ok(!formatted.includes('## Actionable Findings'));
        assert.ok(!formatted.includes('Suggestions and Follow-ups'));
        assert.doesNotMatch(formatted, /violatedRequirement|introducedByPR|requiredForMerge|minimumCorrection/);

        const reparsed = parseStructuredReview(formatted);
        assert.strictEqual(reparsed.status, 'valid_with_blockers');
        assert.strictEqual(reparsed.actionableFindings[0].id, 'F1');
        assert.strictEqual(reparsed.actionableFindings[0].introducedByPR, true);
        assert.strictEqual(reparsed.actionableFindings[0].requiredForMerge, true);
    });

    test('assigns consecutive PR-wide finding IDs and parses them back', () => {
        const response = [
            '## Overall Evaluation',
            'Two corrections remain.',
            '## Actionable Findings',
            '### F1: First local finding',
            '- **violatedRequirement:** First changed behavior must remain correct.',
            '- **evidence:** src/first.ts:10 — the changed branch returns the wrong value.',
            '- **introducedByPR:** true — the PR added the branch.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Return the expected value.',
            '### F2: Second local finding',
            '- **violatedRequirement:** Second changed behavior must remain safe.',
            '- **evidence:** src/second.ts:20 — the changed guard is bypassed.',
            '- **introducedByPR:** true — the PR added the bypass.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Preserve the guard.',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '## Score',
            'Score: 5/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            {
                firstFindingNumber: 3,
                changedFilePaths: ['src/first.ts', 'src/second.ts'],
            },
        );

        assert.ok(formatted.includes('### F3: 🔴 First local finding'));
        assert.ok(formatted.includes('### F4: 🔴 Second local finding'));
        const parsed = parseStructuredReview(formatted);
        assert.deepStrictEqual(parsed.actionableFindings.map(finding => finding.id), ['F3', 'F4']);
        assert.strictEqual(getNextActionableFindingNumber([formatted]), 5);
    });

    test('assigns consecutive PR-wide suggestion IDs on a sequence of their own', () => {
        const response = [
            '## Overall Evaluation',
            'One correction and two optional follow-ups remain.',
            '## Actionable Findings',
            '### F1: Local finding',
            '- **violatedRequirement:** The changed behavior must remain correct.',
            '- **evidence:** src/first.ts:10 — the changed branch returns the wrong value.',
            '- **introducedByPR:** true — the PR added the branch.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Return the expected value.',
            '## Suggestions and Follow-ups',
            '### S1: First local suggestion',
            'Optional hardening of the new boundary.',
            '### S2: Second local suggestion',
            'Optional performance coverage.',
            '## Score',
            'Score: 5/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            {
                firstFindingNumber: 9,
                firstSuggestionNumber: 4,
                changedFilePaths: ['src/first.ts'],
            },
        );

        assert.ok(formatted.includes('### F9: 🔴 Local finding'));
        assert.ok(formatted.includes('### S4: 🟢 First local suggestion'));
        assert.ok(formatted.includes('### S5: 🟢 Second local suggestion'));
        assert.ok(!formatted.includes('### S1:'));
        const parsed = parseStructuredReview(formatted);
        assert.strictEqual(parsed.status, 'valid_with_blockers');
        assert.deepStrictEqual(parsed.suggestions.map(suggestion => suggestion.id), ['S4', 'S5']);
        assert.strictEqual(parsed.suggestions[0].description, 'Optional hardening of the new boundary.');
        // Each kind continues its own sequence: one blocker does not consume an S#.
        assert.strictEqual(getNextActionableFindingNumber([formatted]), 10);
        assert.strictEqual(getNextReviewSuggestionNumber([formatted]), 6);
    });

    test('continues the suggestion sequence on a review with no merge blocker', () => {
        const response = [
            '## Overall Evaluation',
            'Ready to merge, with one optional follow-up.',
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            '### S1: Cover the fallback path',
            'Optional integration coverage.',
            '## Score',
            'Score: 9/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            { firstSuggestionNumber: 8 },
        );

        assert.ok(formatted.includes('### S8: 🟢 Cover the fallback path'));
        const parsed = parseStructuredReview(formatted);
        assert.strictEqual(parsed.status, 'valid_clean');
        assert.deepStrictEqual(parsed.suggestions.map(suggestion => suggestion.id), ['S8']);
        // A clean review leaves the F# sequence alone and advances only S#.
        assert.strictEqual(getNextActionableFindingNumber([formatted]), 1);
        assert.strictEqual(getNextReviewSuggestionNumber([formatted]), 9);
    });

    test('seeds the next F# and S# from published ProPR reviews only', () => {
        const publish = (firstFindingNumber: number, firstSuggestionNumber: number): string => buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: [
                    '## Overall Evaluation',
                    'One optional follow-up remains.',
                    '## Actionable Findings',
                    '### F1: Local finding',
                    '- **violatedRequirement:** The changed behavior must remain correct.',
                    '- **evidence:** src/first.ts:10 — the changed branch returns the wrong value.',
                    '- **introducedByPR:** true — the PR added the branch.',
                    '- **requiredForMerge:** true',
                    '- **minimumCorrection:** Return the expected value.',
                    '## Suggestions and Follow-ups',
                    '### S1: Local suggestion',
                    'Optional hardening of the new boundary.',
                    '## Score',
                    'Score: 5/10',
                ].join('\n'),
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
            undefined,
            { firstFindingNumber, firstSuggestionNumber, changedFilePaths: ['src/first.ts'] },
        );

        const comments = [
            { body: publish(1, 1), user: { login: 'propr-dev[bot]' } },
            { body: publish(2, 2), user: { login: 'PROPR-DEV[bot]' } },
            // A quoted review from another author must not advance either sequence.
            { body: publish(50, 50), user: { login: 'someone-else' } },
            { body: 'An ordinary human comment mentioning F80 and S80.', user: { login: 'propr-dev[bot]' } },
        ];

        assert.deepStrictEqual(
            getNextAuthenticatedReviewRecordNumbers(comments, 'ProPR-Dev[bot]'),
            { firstFindingNumber: 3, firstSuggestionNumber: 3 },
        );
        // Without a verified identity no published ID may seed either sequence.
        assert.deepStrictEqual(
            getNextAuthenticatedReviewRecordNumbers(comments, undefined),
            { firstFindingNumber: 1, firstSuggestionNumber: 1 },
        );
    });

    test('rejects blocker output whose evidence cites only unchanged files', () => {
        const response = [
            '## Overall Evaluation',
            'One claimed correction remains.',
            '## Actionable Findings',
            '### F1: Adjacent issue',
            '- **violatedRequirement:** The adjacent helper should be hardened.',
            '- **evidence:** src/unchanged.ts:10 — this existing helper accepts the input.',
            '- **introducedByPR:** true — claimed to be exposed by the PR.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Rewrite the adjacent helper.',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '## Score',
            'Score: 5/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            { firstFindingNumber: 3, changedFilePaths: ['src/changed.ts'] },
        );

        assert.ok(formatted.includes('Review output was invalid and could not be displayed safely.'));
        assert.strictEqual(parseStructuredReview(formatted).status, 'invalid');
        assert.strictEqual(getNextActionableFindingNumber([formatted]), 1);
    });

    test('caps an inconsistent blocker score at the merge-blocker ceiling', () => {
        const response = [
            '## Overall Evaluation',
            'One correctness regression blocks merge.',
            '## Actionable Findings',
            '### F1: Singleton input is rejected',
            '- **violatedRequirement:** Changed selection behavior must preserve a valid singleton.',
            '- **evidence:** optimizer.ts:42 — all candidates are removed before measurement.',
            '- **introducedByPR:** true — the new truncation planner added this removal path.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Measure the highest-priority singleton before rejecting it.',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '## Score',
            'The implementation is otherwise strong.',
            '**Score: 9/10**',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
        );

        assert.ok(formatted.includes('**Score: 6/10**'));
        assert.ok(formatted.includes('Score capped at 6 because merge blockers remain.'));
        assert.equal(parseStructuredReview(formatted).score, 6);
    });

    test('caps a clean review when a current-head check is failing without creating a fix finding', () => {
        const response = [
            '## Overall Evaluation',
            'The changed code is correct, but CI must be resolved before merge.',
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '## Score',
            'Score: 9/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            { hasCurrentCheckFailure: true },
        );

        assert.ok(formatted.includes('No merge blockers.'));
        assert.ok(!formatted.includes('Every finding below was introduced by this PR'));
        assert.ok(formatted.includes('Score: 7/10'));
        assert.ok(formatted.includes('Score capped at 7 because a current-head check is failing.'));
        assert.equal(parseStructuredReview(formatted).status, 'valid_clean');
    });

    test('publishes suggestion titles separately from their reasoning', () => {
        const response = [
            '## Overall Evaluation',
            'Ready to merge.\n\n✅ **Focused implementation** — The change stays within the review-context boundary.',
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            '### S1: Cover pagination fallbacks',
            'Integration coverage would verify pagination, head-SHA selection, and API-failure fallback through the real GitHub boundary; this is optional because the changed behavior is already unit-tested.',
            '## Score',
            'Score: 9/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
        );

        assert.ok(formatted.includes('## Merge blockers\n\nNo merge blockers.'));
        assert.ok(formatted.includes('✅ **Focused implementation**'));
        assert.ok(formatted.includes('### S1: 🟢 Cover pagination fallbacks\n\nIntegration coverage would verify'));
        assert.strictEqual(parseStructuredReview(formatted).suggestions[0].description.startsWith('Integration coverage'), true);
    });

    test('does not publish internal blocker metadata from an invalid review', () => {
        const response = [
            '## Overall Evaluation',
            'Cancellation needs one correction before merge.',
            '',
            '## Actionable Findings',
            '### F1: Retry transitions can overwrite cancellation',
            '- **violatedRequirement:** Cancellation must not be overwritten by another state writer.',
            '- **introducedByPR:** true — this PR added the retry exception.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Keep cancelled tasks immutable.',
            '',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '',
            '## Score',
            'Score: 6/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(formatted.includes('Review output was invalid and could not be displayed safely.'));
        assert.doesNotMatch(formatted, /violatedRequirement|introducedByPR|requiredForMerge|minimumCorrection/);
        assert.strictEqual(parseStructuredReview(formatted).status, 'invalid');
    });

    test('marks review partial when initial diff formatting omits files', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: '## Overall Evaluation\nLooks focused.\n\n## Findings\n✅ **Positive** — Fine.\n\n## Score\n**Score: 8/10**',
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1200,
                success: true,
            },
            'https://gitfix.dev/tasks/task-1',
            { omittedDiffFiles: ['package-lock.json', 'assets/logo.png'] },
        );

        assert.ok(comment.includes('<summary>Files omitted from review diff</summary>'));
        assert.ok(comment.includes('`package-lock.json`'));
        assert.ok(comment.includes('`assets/logo.png`'));
        assert.ok(comment.includes('**Review scope:** Partial'));
        assert.ok(comment.includes('patch content was unavailable from GitHub or did not fit'));
        assert.ok(comment.includes('<!-- propr:ai-review model="claude-sonnet" partial="true" -->'));
    });

    test('marks review metadata partial when the prompt budget truncates the PR diff', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: '## Overall Evaluation\nPartial review.\n\n## Actionable Findings\nNo actionable findings.\n\n## Suggestions and Follow-ups\nNo suggestions.\n\n## Score\nScore: 7/10',
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1200,
                success: true,
            },
            undefined,
            { prDiffTruncated: true },
        );

        assert.ok(comment.includes('**Review scope:** Partial'));
        assert.ok(comment.includes('PR diff ranges were omitted by the review context budget'));
        assert.ok(comment.includes('<!-- propr:ai-review model="claude-sonnet" partial="true" -->'));
    });

    test('explains missing GitHub patches separately from budget omissions', () => {
        const comment = buildReviewComment(
            { agentAlias: 'codex', model: 'gpt-6-astra', label: 'Astra' },
            {
                response: '## Overall Evaluation\nPartial review.\n\n## Actionable Findings\nNo actionable findings.\n\n## Suggestions and Follow-ups\nNo suggestions.\n\n## Score\nScore: 7/10',
                modelUsed: 'gpt-6-astra',
                executionTimeMs: 1200,
                success: true,
            },
            undefined,
            {
                omittedDiffFiles: ['src/huge.ts', 'src/budget.ts'],
                missingPatchFiles: ['src/huge.ts'],
                budgetOmittedFiles: ['src/budget.ts'],
                prDiffTruncated: true,
            },
        );

        assert.ok(comment.includes('1 changed file has no patch content from GitHub, which a larger review budget cannot recover'));
        assert.ok(comment.includes('1 file was omitted by the review context budget'));
        assert.ok(comment.includes('**No patch content from GitHub (a larger review budget cannot recover these)**'));
        assert.ok(comment.includes('**Did not fit the review context budget**'));
        assert.ok(comment.includes('<!-- propr:ai-review model="gpt-6-astra" partial="true" -->'));
    });

    test('keeps a review with only missing GitHub patches partial without blaming the budget', () => {
        const comment = buildReviewComment(
            { agentAlias: 'codex', model: 'gpt-6-astra', label: 'Astra' },
            {
                response: '## Overall Evaluation\nPartial review.\n\n## Actionable Findings\nNo actionable findings.\n\n## Suggestions and Follow-ups\nNo suggestions.\n\n## Score\nScore: 7/10',
                modelUsed: 'gpt-6-astra',
                executionTimeMs: 1200,
                success: true,
            },
            undefined,
            { omittedDiffFiles: ['src/huge.ts'], missingPatchFiles: ['src/huge.ts'], budgetOmittedFiles: [] },
        );

        assert.ok(comment.includes('**Review scope:** Partial — 1 changed file has no patch content from GitHub'));
        assert.ok(!comment.includes('omitted by the review context budget'));
        assert.ok(comment.includes('partial="true"'));
    });

    test('counts cache tokens as input tokens and includes cost', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            {
                response: '## Overall Evaluation\nLooks focused.\n\n## Findings\n✅ **Positive** — Fine.\n\n## Score\n**Score: 8/10**',
                modelUsed: 'claude-opus-4-8',
                executionTimeMs: 153000,
                success: true,
                tokenUsage: {
                    input_tokens: 2,
                    cache_creation_input_tokens: 97116,
                    cache_read_input_tokens: 3669,
                    output_tokens: 12229,
                },
            },
            undefined,
            { costUsd: 0.8037945 },
        );

        assert.ok(comment.includes('* **Model:** Claude Opus 4.8\n'));
        assert.ok(comment.includes('<!-- propr:ai-review model="claude-opus-4-8" -->'));
        assert.ok(comment.includes('**Tokens:** 113,016 (100,787 in / 12,229 out)'));
        assert.ok(comment.includes('**Cost:** $0.80'));
    });
    test('publishes a demonstrated-failure evidence line and correction without truncation', () => {
        const scenarioEvidence = "src/jobs/suspensionRecovery.ts:88 \u2014 trigger: two suspended runs A and B are recoverable; static trace: 1) ProPR cancels A successfully -> 2) the cancel call for B returns an explicit 403 -> 3) B's queued rerun intent still persists -> 4) an operator cancels B independently -> 5) recovery reruns B even though ProPR refused it, so the user sees a rerun they were told would not happen and the stored recovery row keeps pointing at B; the lease guard added at line 61 runs before step 2, so it never observes B's intent. Proposed regression (not executed): assert B is not rerun while A remains recoverable.";
        const scenarioCorrection = 'Clear the persisted rerun intent for B when its cancel call fails, before returning from the recovery pass.';
        const response = [
            '## Overall Evaluation',
            'One demonstrated recovery failure blocks merge.',
            '',
            '## Actionable Findings',
            '### F1: Refused rerun still replays after an independent cancel',
            '- **violatedRequirement:** A run ProPR refused to rerun must not be rerun by recovery.',
            `- **evidence:** ${scenarioEvidence}`,
            '- **introducedByPR:** true \u2014 this PR added the recovery pass that replays persisted intents.',
            '- **requiredForMerge:** true',
            `- **minimumCorrection:** ${scenarioCorrection}`,
            '',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '',
            '## Score',
            'Score: 5/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true },
            undefined,
            { changedFilePaths: ['src/jobs/suspensionRecovery.ts'] },
        );

        // The whole scenario must reach readers of the public comment verbatim.
        assert.ok(formatted.includes(`- **Evidence:** ${scenarioEvidence}`));
        assert.ok(formatted.includes(`- **Minimum fix:** ${scenarioCorrection}`));
        assert.ok(formatted.includes('Proposed regression (not executed)'));

        const reparsed = parseStructuredReview(formatted);
        assert.strictEqual(reparsed.status, 'valid_with_blockers');
        assert.strictEqual(reparsed.actionableFindings.length, 1);
        assert.strictEqual(reparsed.actionableFindings[0].evidence, scenarioEvidence);
        assert.strictEqual(reparsed.actionableFindings[0].minimumCorrection, scenarioCorrection);
    });
});
