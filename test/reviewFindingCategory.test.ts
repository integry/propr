import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { DEFAULT_REVIEW_GUIDANCE } from '../packages/shared/src/reviewPrompt.js';
import { up as createPullRequestState } from '../packages/core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../packages/core/src/db/migrations/20261006000000_create_review_scores.js';
import { down, up } from '../packages/core/src/db/migrations/20261112000000_add_review_score_blocker_categories.js';

const { parseStructuredReview, renderPublicReview, extractActionableFindings } = await import('../src/jobs/reviewOutputParser.js');
const {
    countFindingsByCategory, hasOnlyStyleFindings, parseReviewFindingCategory, REVIEW_FINDING_CATEGORIES,
} = await import('../src/jobs/reviewFindingCategory.js');
const { createDefaultState, determineNextAction, hasReviewReachedGoal, ULTRAFIX_STYLE_FINDINGS_ONLY_REASON } =
    await import('../src/jobs/ultrafixOrchestrationService.js');
const { buildReviewScoreInputs } = await import('../src/jobs/reviewScorePersistence.js');
const { buildReviewPrompt, buildReviewPromptWithinBudget } = await import('../src/jobs/reviewPromptBuilder.js');
const { preparePRDiff } = await import('../src/jobs/prDiffFormatting.js');
const { closeConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
});

function machineBlocker(id: number, category?: string): string[] {
    return [
        `### F${id}: Blocker ${id}`,
        ...(category === undefined ? [] : [`- **category:** ${category}`]),
        `- **violatedRequirement:** Requirement ${id}.`,
        `- **evidence:** \`src/file.ts:${id}\` — static trace: the change adds an unrequested layer.`,
        '- **introducedByPR:** true — the PR added it.',
        '- **requiredForMerge:** true',
        `- **minimumCorrection:** Fix ${id}.`,
    ];
}

function machineReview(categories: (string | undefined)[], score = 6): string {
    return [
        '## Overall Evaluation',
        'Evaluation.',
        '## Actionable Findings',
        ...(categories.length ? categories.flatMap((category, index) => machineBlocker(index + 1, category)) : ['No actionable findings.']),
        '## Suggestions and Follow-ups',
        'No suggestions.',
        '## Score',
        `Score: ${score}/10`,
    ].join('\n');
}

describe('review finding categories', () => {
    test('the vocabulary is closed and a missing category means correctness', () => {
        assert.deepEqual([...REVIEW_FINDING_CATEGORIES], ['correctness', 'requirement', 'security', 'tests', 'complexity', 'style']);
        assert.equal(parseReviewFindingCategory(undefined), 'correctness');
        assert.equal(parseReviewFindingCategory('  '), 'correctness');
        assert.equal(parseReviewFindingCategory('`Style`'), 'style');
        assert.equal(parseReviewFindingCategory('COMPLEXITY'), 'complexity');
        assert.equal(parseReviewFindingCategory('performance'), null);
        assert.equal(parseReviewFindingCategory('style, complexity'), null);
    });

    test('machine reviews carry each category, and records without one parse as correctness', () => {
        const parsed = parseStructuredReview(machineReview(['complexity', undefined, 'Requirement', 'style']));
        assert.equal(parsed.status, 'valid_with_blockers');
        assert.deepEqual(parsed.actionableFindings.map(finding => finding.category), ['complexity', 'correctness', 'requirement', 'style']);
        assert.deepEqual(
            extractActionableFindings(machineReview(['security'])).map(finding => finding.category),
            ['security'],
        );
    });

    test('a category outside the vocabulary invalidates the review instead of being reclassified', () => {
        assert.equal(parseStructuredReview(machineReview(['nitpick'])).status, 'invalid');
        assert.equal(renderPublicReview(machineReview(['nitpick'])), null);
    });

    test('the public comment renders the category and parses back to it', () => {
        const published = renderPublicReview(machineReview(['complexity', undefined]), undefined, { firstFindingNumber: 4 });
        assert.ok(published);
        assert.ok(published.includes([
            '### F4: 🔴 Blocker 1',
            '- **Category:** complexity',
            '- **Required behavior:** Requirement 1.',
        ].join('\n')));
        assert.ok(published.includes('### F5: 🔴 Blocker 2\n- **Category:** correctness\n'));
        const reparsed = parseStructuredReview(published);
        assert.equal(reparsed.status, 'valid_with_blockers');
        assert.deepEqual(reparsed.actionableFindings.map(finding => [finding.id, finding.category]), [['F4', 'complexity'], ['F5', 'correctness']]);
    });

    test('public comments written before categories still parse, as correctness', () => {
        const legacy = [
            '## Overall Evaluation',
            'Needs work.',
            '## Merge blockers',
            'Every finding below was introduced by this PR and must be resolved before merging.',
            '',
            '### F3: 🔴 Old blocker',
            '- **Required behavior:** Keep state.',
            '- **Evidence:** src/a.ts:1 — static trace.',
            '- **Minimum fix:** Restore state.',
            '## Suggestions',
            'These are optional follow-ups and are not sent to `/fix`.',
            'No suggestions.',
            '## Score',
            'Score: 5/10',
        ].join('\n');
        const parsed = parseStructuredReview(legacy);
        assert.equal(parsed.status, 'valid_with_blockers');
        assert.deepEqual(parsed.actionableFindings.map(finding => [finding.id, finding.category]), [['F3', 'correctness']]);

        // The public field set is the old one plus an optional category, nothing else.
        assert.equal(parseStructuredReview(legacy.replace('- **Minimum fix:**', '- **Category:** tests\n- **Minimum fix:**'))
            .actionableFindings[0]?.category, 'tests');
        assert.equal(parseStructuredReview(legacy.replace('- **Minimum fix:**', '- **Category:** typo\n- **Minimum fix:**')).status, 'invalid');
        assert.equal(parseStructuredReview(legacy.replace('- **Minimum fix:**', '- **Severity:** high\n- **Minimum fix:**')).status, 'invalid');
    });

    test('per-category counts and the style-only predicate', () => {
        const findings = parseStructuredReview(machineReview(['style', undefined, 'style'])).actionableFindings;
        assert.deepEqual(countFindingsByCategory(findings), { correctness: 1, requirement: 0, security: 0, tests: 0, complexity: 0, style: 2 });
        assert.equal(hasOnlyStyleFindings(findings), false);
        assert.equal(hasOnlyStyleFindings(findings.filter(finding => finding.category === 'style')), true);
        assert.equal(hasOnlyStyleFindings([]), false);
    });
});

describe('Ultrafix stop rule for stylistic findings', () => {
    const afterReview = (overrides: Record<string, unknown> = {}) => ({
        ...createDefaultState({ owner: 'acme', repo: 'web', pr: 1, goal: 8, maxCycles: 3 }),
        lastAction: 'review' as const, reviewCount: 1, fixCount: 0, cycleCount: 0, ...overrides,
    });

    test('only stylistic blockers stop the loop with a distinct reason and no fix', () => {
        const decision = determineNextAction(afterReview(), 6, 'valid_with_blockers', { findingCategories: ['style', 'style'] });
        assert.deepEqual(decision, { action: null, reason: ULTRAFIX_STYLE_FINDINGS_ONLY_REASON, styleFindingsOnly: true });
        assert.match(decision.reason, /^Only stylistic findings remain/);
    });

    test('any non-stylistic blocker still schedules a fix', () => {
        for (const category of REVIEW_FINDING_CATEGORIES.filter(item => item !== 'style')) {
            const decision = determineNextAction(afterReview(), 6, 'valid_with_blockers', { findingCategories: ['style', category] });
            assert.equal(decision.action, 'fix', category);
            assert.equal(decision.styleFindingsOnly, undefined);
        }
        // Callers that pass no categories keep the previous behavior.
        assert.equal(determineNextAction(afterReview(), 6, 'valid_with_blockers', false).action, 'fix');
        assert.equal(determineNextAction(afterReview(), 6, 'valid_with_blockers', { isPartial: false }).action, 'fix');
    });

    test('the rule applies only to valid reviews with blockers', () => {
        assert.equal(determineNextAction(afterReview(), null, 'invalid', { findingCategories: ['style'] }).action, 'review');
        const clean = determineNextAction(afterReview(), 9, 'valid_clean', { findingCategories: [] });
        assert.equal(clean.action, null);
        assert.equal(clean.styleFindingsOnly, undefined);
        assert.equal(determineNextAction(afterReview({ lastAction: 'fix' }), 6, 'valid_with_blockers', { findingCategories: ['style'] }).action, 'review');
    });

    test('score rules are unchanged: a style-only review never reaches the goal, in the loop or in stored scores', () => {
        const response = machineReview(['style'], 10);
        const parsed = parseStructuredReview(response);
        // The blocker cap still applies to stylistic blockers.
        assert.equal(parsed.score, 6);
        assert.equal(hasReviewReachedGoal(parsed.status, parsed.score, 6), false);

        const results = [{
            assignment: { agentAlias: 'codex', model: 'gpt-5.6' },
            analysisResult: { success: true, response, modelUsed: 'gpt-5.6' },
            commentId: 10,
        }];
        const [input] = buildReviewScoreInputs(results, {
            repository: 'acme/web', pullRequestNumber: 1, taskId: 'review-1', ultrafix: { ultrafixCycle: 1, ultrafixGoal: 6 },
        });
        assert.equal(input.goalReached, false);
        assert.equal(input.blockerCount, 1);
        assert.deepEqual(input.blockerCategoryCounts, { correctness: 0, requirement: 0, security: 0, tests: 0, complexity: 0, style: 1 });
    });
});

describe('review prompt categories and change size', () => {
    const options = {
        pullRequestNumber: 7, combinedCommentBody: '/review', commentHistory: 'history', repoOwner: 'acme', repoName: 'web',
        originalTaskSpec: 'Add a retry button to the upload dialog', authorizedFollowups: 'Also log the retry',
        prDiff: 'diff --git a/x b/x',
    };

    test('the default guidance covers unrequested complexity, placeholder delivery and stylistic points', () => {
        assert.match(DEFAULT_REVIEW_GUIDANCE, /unrequested complexity as a blocker with category `complexity`/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /generic retry, validation, or configuration layers, and options nobody asked for/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /platforms, databases, or environments the product does not target/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /a diff much larger than the effective objective implies/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /category `requirement` a change that delivers a reduced or placeholder version/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /stubbed code, skipped or deleted tests/);
        assert.match(DEFAULT_REVIEW_GUIDANCE, /Purely stylistic points belong in Suggestions; a blocker may use category `style` only when it violates an explicit repository rule/);
    });

    test('the prompt lists the category vocabulary and the change size', () => {
        const prompt = buildReviewPrompt({ ...options, diffStats: { filesChanged: 12, additions: 840, deletions: 31 } });
        assert.ok(prompt.includes('- **category:** one of `correctness`, `requirement`, `security`, `tests`, `complexity`, `style`'));
        for (const category of REVIEW_FINDING_CATEGORIES) assert.ok(prompt.includes(`- \`${category}\` — `), category);
        assert.ok(prompt.includes('- Diff: 12 files changed, +840/-31 lines'));
        assert.ok(prompt.includes('- Effective objective: 12 words (original objective plus authorized follow-up requests)'));
        // The size context precedes the task guidance that refers to it.
        assert.ok(prompt.indexOf('**Change size') < prompt.indexOf('**YOUR TASK:**'));
        assert.doesNotMatch(prompt, /slop/i);
    });

    test('the budgeted prompt reports the whole diff and the untrimmed objective', () => {
        const files = [
            { filename: 'src/a.ts', status: 'modified', additions: 300, deletions: 2, changes: 302, patch: '@@ -1 +1 @@\n-a\n+b' },
            { filename: 'src/b.ts', status: 'added', additions: 5, deletions: 0, changes: 5, patch: '@@ -0,0 +1 @@\n+c' },
        ];
        const preparedDiff = preparePRDiff(files as never, 1_000_000);
        assert.deepEqual(preparedDiff.stats, { filesChanged: 2, additions: 305, deletions: 2 });
        const longObjective = Array.from({ length: 4000 }, (_, index) => `word${index}`).join(' ');
        const result = buildReviewPromptWithinBudget(
            { ...options, originalTaskSpec: longObjective, authorizedFollowups: '' }, 9_000, '', { preparedDiff },
        );
        assert.ok(result.truncatedSections.includes('original PR objective'));
        assert.ok(result.prompt.includes('- Diff: 2 files changed, +305/-2 lines'));
        assert.ok(result.prompt.includes('- Effective objective: 4000 words'));
    });
});

test('blocker category migration adds a nullable JSON column, leaves existing rows null, and reverts', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await createPullRequestState(database);
        await createReviewScores(database);
        await database('review_scores').insert({
            repository_id: 'acme/web', pr_number: 3, task_id: 'review-1', score: 6, blocker_count: 2, source: 'review',
            created_at: '2026-11-11T10:00:00.000Z',
        });

        await up(database);
        await up(database);
        assert.deepEqual(await database('review_scores').select('task_id', 'blocker_count', 'blocker_categories'),
            [{ task_id: 'review-1', blocker_count: 2, blocker_categories: null }]);
        const counts = { correctness: 0, requirement: 0, security: 0, tests: 0, complexity: 1, style: 1 };
        await database('review_scores').insert({
            repository_id: 'acme/web', pr_number: 3, task_id: 'review-2', score: 6, blocker_count: 2, source: 'ultrafix',
            blocker_categories: JSON.stringify(counts), created_at: '2026-11-12T10:00:00.000Z',
        });
        const [row] = await database('review_scores').where({ task_id: 'review-2' })
            .select(database.raw("json_extract(blocker_categories, '$.complexity') as complexity"));
        assert.equal(row.complexity, 1);

        await down(database);
        await down(database);
        assert.equal(await database.schema.hasColumn('review_scores', 'blocker_categories'), false);
        assert.equal((await database('review_scores').select('id')).length, 2);
        await up(database);
        assert.equal(await database.schema.hasColumn('review_scores', 'blocker_categories'), true);
    } finally {
        await database.destroy();
    }
});

test('blocker category migration tolerates a database without review scores', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await up(database);
        await down(database);
        assert.equal(await database.schema.hasTable('review_scores'), false);
    } finally {
        await database.destroy();
    }
});
