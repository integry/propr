import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { PlanIssueStatus, type PlanIssue } from '../packages/core/src/config/planIssueManager.js';
import {
    EPIC_COMPLETE_MARKER,
    EPIC_FINAL_MERGE_MARKER,
    EPIC_PROGRESS_MARKER,
    buildEpicProgressComment,
    buildEpicCompleteComment,
    buildEpicFinalMergeComment,
    computeEpicMergeProgress,
    isEpicMergeComplete,
    updateEpicMergeProgress,
    type EpicMergeProgressRequest,
} from '../packages/core/src/webhook/epicMergeProgress.js';

after(async () => {
    await closeConnection();
});

function planIssue(issueNumber: number, status: PlanIssueStatus, prNumber: number | null = null): PlanIssue {
    return {
        id: issueNumber,
        draft_id: 'draft-1',
        repository: 'integry/propr',
        issue_number: issueNumber,
        pr_number: prNumber,
        status,
        agent_alias: null,
        model_name: null,
        followup_count: 0,
        task_id: null,
        run_ultrafix: null,
        ultrafix_goal: null,
        ultrafix_max_cycles: null,
        created_at: '',
        updated_at: '',
    };
}

interface FakeComment { id: number; body: string; user: { login: string } }

type FakePull = Record<string, unknown> & { number: number };

/**
 * One epic PR as GitHub reports it. The epic's GET only carries a merge
 * boundary once `epicMerged` is set, as a real unmerged PR has `merged_at: null`;
 * individual child reads answer from the child list unless `childReads`
 * overrides them, which models a list that lags the merge.
 */
function createOctokit(pulls: FakePull[], initialComments: FakeComment[] = []) {
    const comments = [...initialComments];
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    let nextId = 1000;
    const octokit = {
        epicMerged: false,
        mergedAt: '2026-10-10T20:00:00Z',
        /** The epic's merge commit; squash and rebase merges make it unrelated to the branch history. */
        mergeCommitSha: null as string | null,
        /** The epic PR's head as preserved after its merge. */
        headSha: null as string | null,
        base: 'main' as string | undefined,
        history: [] as unknown[],
        childReads: {} as Record<number, Record<string, unknown>>,
        /** `ahead_by` per compared `{epic head}...{child merge commit}` pair. */
        containment: {} as Record<string, number>,
        calls,
        comments,
        async paginate(route: string, parameters: Record<string, unknown>) {
            calls.push({ route, parameters });
            if (route === 'GET /repos/{owner}/{repo}/pulls') return parameters.head ? octokit.history : pulls;
            if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return comments.map(c => ({ ...c }));
            throw new Error(`Unexpected paginate ${route}`);
        },
        async request(route: string, parameters: Record<string, unknown>) {
            calls.push({ route, parameters });
            if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                const number = parameters.pull_number as number;
                const child = octokit.childReads[number] ?? pulls.find(pr => pr.number === number);
                if (child) return { data: { base: { ref: baseRequest.epicBranch }, ...child } };
                return { data: {
                    merged: octokit.epicMerged, merged_at: octokit.epicMerged ? octokit.mergedAt : null,
                    merge_commit_sha: octokit.mergeCommitSha, head: { sha: octokit.headSha }, base: { ref: octokit.base },
                } };
            }
            if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
                const aheadBy = octokit.containment[parameters.basehead as string];
                if (aheadBy === undefined) throw new Error(`Unexpected compare ${parameters.basehead}`);
                return { data: { ahead_by: aheadBy } };
            }
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
                comments.push({ id: nextId++, body: parameters.body as string, user: { login: 'propr-dev[bot]' } });
                return { data: {} };
            }
            if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
                const comment = comments.find(c => c.id === parameters.comment_id);
                assert.ok(comment, 'patched comment must exist');
                comment.body = parameters.body as string;
                return { data: {} };
            }
            throw new Error(`Unexpected request ${route}`);
        },
    };
    return octokit;
}

const childReadsOf = (octokit: { calls: Array<{ route: string; parameters: Record<string, unknown> }> }, number: number) =>
    octokit.calls.filter(c => c.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && c.parameters.pull_number === number).length;

const baseRequest: EpicMergeProgressRequest = {
    owner: 'integry',
    repo: 'propr',
    epicBranch: '100-epic-big-plan-abc',
    epicPrNumber: 500,
    mergedChildPrNumber: 201,
    planName: 'Big Plan',
};

describe('computeEpicMergeProgress', () => {
    test('uses plan issues as the expected total', () => {
        const progress = computeEpicMergeProgress(
            [{ number: 201, merged: true, abandoned: false }],
            201,
            [
                planIssue(100, PlanIssueStatus.MERGED, 201),
                planIssue(101, PlanIssueStatus.UNDER_REVIEW, 202),
                planIssue(102, PlanIssueStatus.PENDING),
            ],
        );
        assert.deepStrictEqual(progress, { merged: 1, total: 3, excluded: 0, mergedPullRequests: [201] });
        assert.strictEqual(isEpicMergeComplete(progress), false);
    });

    test('counts the triggering PR as merged even when plan status lags', () => {
        const progress = computeEpicMergeProgress([], 202, [
            planIssue(100, PlanIssueStatus.MERGED, 201),
            planIssue(101, PlanIssueStatus.UNDER_REVIEW, 202),
        ]);
        assert.strictEqual(progress.merged, 2);
        assert.strictEqual(isEpicMergeComplete(progress), true);
    });

    test('excludes plan issues closed without a merge from the total', () => {
        const progress = computeEpicMergeProgress([], 201, [
            planIssue(100, PlanIssueStatus.MERGED, 201),
            planIssue(101, PlanIssueStatus.CLOSED, 202),
        ]);
        assert.deepStrictEqual({ merged: progress.merged, total: progress.total, excluded: progress.excluded }, { merged: 1, total: 1, excluded: 1 });
        assert.strictEqual(isEpicMergeComplete(progress), true);
    });

    test('counts child PRs outside the plan alongside planned issues', () => {
        const progress = computeEpicMergeProgress([
            { number: 201, merged: true, abandoned: false },
            { number: 202, merged: false, abandoned: false },
        ], 201, [planIssue(100, PlanIssueStatus.MERGED, 201)]);
        assert.deepStrictEqual(progress, { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] });
        assert.strictEqual(isEpicMergeComplete(progress), false);
    });

    test('counts a planned issue once when its PR is also a listed child', () => {
        const progress = computeEpicMergeProgress([
            { number: 201, merged: true, abandoned: false },
            { number: 202, merged: false, abandoned: false },
            { number: 203, merged: false, abandoned: true },
        ], 201, [
            planIssue(100, PlanIssueStatus.MERGED, 201),
            planIssue(101, PlanIssueStatus.UNDER_REVIEW, 202),
            planIssue(102, PlanIssueStatus.PROCESSING, 203),
        ]);
        // #203 was abandoned, but its planned issue is still open work.
        assert.deepStrictEqual({ merged: progress.merged, total: progress.total }, { merged: 1, total: 3 });
    });

    test('falls back to child PRs without plan details, ignoring abandoned ones', () => {
        const progress = computeEpicMergeProgress([
            { number: 201, merged: true, abandoned: false },
            { number: 202, merged: false, abandoned: false },
            { number: 203, merged: false, abandoned: true },
        ], 201);
        assert.deepStrictEqual(progress, { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] });
    });
});

describe('buildEpicProgressComment', () => {
    test('renders the x of y status with the tracking marker', () => {
        const body = buildEpicProgressComment({ merged: 2, total: 4, excluded: 0, mergedPullRequests: [201, 202] }, 'Big Plan');
        assert.match(body, /\*\*2 out of 4 PRs merged\*\*/);
        assert.match(body, /50%/);
        assert.match(body, /#201, #202/);
        assert.ok(body.includes(EPIC_PROGRESS_MARKER));
    });
});

describe('updateEpicMergeProgress', () => {
    test('creates the tracking comment on the first child merge', async () => {
        const octokit = createOctokit([
            { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
            { number: 202, state: 'open', merged_at: null },
        ]);
        const result = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });

        assert.strictEqual(result.trackingComment, 'created');
        assert.strictEqual(result.completionPosted, false);
        assert.strictEqual(octokit.comments.length, 1);
        assert.match(octokit.comments[0].body, /1 out of 2 PRs merged/);
        const listPulls = octokit.calls.find(call => call.route === 'GET /repos/{owner}/{repo}/pulls');
        assert.strictEqual(listPulls?.parameters.base, baseRequest.epicBranch);
        assert.strictEqual(listPulls?.parameters.state, 'all');
    });

    test('updates the tracking comment in place and confirms when the final child merges', async () => {
        const pulls = [
            { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
            { number: 202, state: 'open', merged_at: null },
        ];
        const octokit = createOctokit(pulls, [
            { id: 1, body: 'unrelated human comment', user: { login: 'someone' } },
        ]);
        await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });

        pulls[1] = { number: 202, state: 'closed', merged_at: '2026-10-09T01:00:00Z' };
        const result = await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: 202 }, 'test', { getOctokit: async () => octokit });

        assert.strictEqual(result.trackingComment, 'updated');
        assert.strictEqual(result.completionPosted, true);
        const tracking = octokit.comments.filter(c => c.body.includes(EPIC_PROGRESS_MARKER));
        assert.strictEqual(tracking.length, 1);
        assert.match(tracking[0].body, /2 out of 2 PRs merged/);
        const completion = octokit.comments.filter(c => c.body.includes(EPIC_COMPLETE_MARKER));
        assert.strictEqual(completion.length, 1);
        assert.match(completion[0].body, /Epic ready for final merge: Big Plan/);
        assert.match(completion[0].body, /All 2 child PRs have been merged/);
    });

    test('does not repost the confirmation or edit an unchanged tracking comment on redelivery', async () => {
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
        const first = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
        const second = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });

        assert.strictEqual(first.completionPosted, true);
        assert.strictEqual(second.trackingComment, 'unchanged');
        assert.strictEqual(second.completionPosted, false);
        assert.strictEqual(octokit.comments.length, 2);
    });

    test('does not confirm completion while a child PR outside the plan is open', async () => {
        const octokit = createOctokit([
            { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
            { number: 202, state: 'open', merged_at: null },
        ]);
        const result = await updateEpicMergeProgress(
            { ...baseRequest, planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201)] },
            'test',
            { getOctokit: async () => octokit },
        );
        assert.strictEqual(result.completionPosted, false);
        assert.match(octokit.comments[0].body, /1 out of 2 PRs merged/);
        assert.ok(!octokit.comments.some(c => c.body.includes(EPIC_COMPLETE_MARKER)));
    });

    test('writes nothing once ownership of the epic is lost after the reads', async () => {
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
        let checks = 0;
        await assert.rejects(updateEpicMergeProgress(baseRequest, 'test', {
            getOctokit: async () => octokit,
            assertOwned: async () => {
                checks++;
                // All reads have completed before ownership is checked.
                assert.strictEqual(octokit.calls.length, 4);
                throw new Error('lease lost');
            },
        }), /lease lost/);
        assert.strictEqual(checks, 1);
        assert.strictEqual(octokit.comments.length, 0);
    });

    test('checks ownership before each comment write', async () => {
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
        let checks = 0;
        await assert.rejects(updateEpicMergeProgress(baseRequest, 'test', {
            getOctokit: async () => octokit,
            assertOwned: async () => {
                if (++checks === 2) throw new Error('lease lost');
            },
        }), /lease lost/);
        // The tracking comment was written; the completion notice was not.
        assert.strictEqual(octokit.comments.length, 1);
        assert.ok(octokit.comments[0].body.includes(EPIC_PROGRESS_MARKER));
    });

    test('ignores marker comments not authored by the bot', async () => {
        const octokit = createOctokit(
            [{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }, { number: 202, state: 'open', merged_at: null }],
            [{ id: 7, body: `copied ${EPIC_PROGRESS_MARKER}`, user: { login: 'someone' } }],
        );
        const result = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
        assert.strictEqual(result.trackingComment, 'created');
        assert.strictEqual(octokit.comments.find(c => c.id === 7)?.body, `copied ${EPIC_PROGRESS_MARKER}`);
    });
});

test('confirms the aggregate merge once, independently of the child readiness notice', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
    const dependencies = { getOctokit: async () => octokit };
    await updateEpicMergeProgress(baseRequest, 'test', dependencies);
    assert.ok(!octokit.comments.some(c => c.body.includes(EPIC_FINAL_MERGE_MARKER)));
    octokit.epicMerged = true;
    const finalRequest = { ...baseRequest, mergedChildPrNumber: null };
    const result = await updateEpicMergeProgress(finalRequest, 'test', dependencies);
    assert.strictEqual(result.completionPosted, true);
    assert.strictEqual(result.progress.total, 1, 'the aggregate PR is not a child');
    const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
    assert.match(final.body, /Epic PR #500 has been merged into main/);
    assert.match(final.body, /All planned epic work is now merged/);
    assert.strictEqual((await updateEpicMergeProgress(finalRequest, 'test', dependencies)).completionPosted, false);
    // An older child delivery must not regress the final tracking state.
    assert.strictEqual((await updateEpicMergeProgress(baseRequest, 'test', dependencies)).trackingComment, 'unchanged');
    assert.strictEqual(octokit.comments.filter(c => c.body.includes(EPIC_FINAL_MERGE_MARKER)).length, 1);
});

test('a delayed child update discovers the aggregate merge and posts final confirmation', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
    octokit.epicMerged = true;
    await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
    assert.ok(octokit.comments.some(c => c.body.includes(EPIC_FINAL_MERGE_MARKER)));
    assert.ok(!octokit.comments.some(c => c.body.includes(EPIC_COMPLETE_MARKER)));
});

test('an early aggregate merge does not claim unfinished planned work is complete', async () => {
    const octokit = createOctokit([]);
    octokit.epicMerged = true;
    await updateEpicMergeProgress({
        ...baseRequest, mergedChildPrNumber: null,
        planIssues: [planIssue(100, PlanIssueStatus.PENDING)],
    }, 'test', { getOctokit: async () => octokit });
    const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
    assert.match(final.body, /0 out of 1 PRs merged/);
    assert.ok(!final.body.includes('All planned epic work is now merged'));
});

test('final merge builder preserves counts, optional plan title and completion wording', () => {
    for (const total of [0, 1, 2]) {
        const progress = { merged: total, total, excluded: 0, mergedPullRequests: [] };
        const body = buildEpicFinalMergeComment(progress, { epicPrNumber: 501, baseBranch: 'trunk' });
        assert.match(body, /### ✅ Epic merged\n/);
        assert.match(body, /Epic PR #501 has been merged into trunk/);
        if (total > 0) assert.ok(body.includes(`**${total} out of ${total} PRs merged**`));
        else {
            assert.ok(body.includes('No child PRs or planned issues were tracked for this epic.'));
            assert.ok(!body.includes('out of'));
        }
        assert.equal(body.includes('All planned epic work is now merged.'), total > 0);
        assert.ok(body.includes(EPIC_FINAL_MERGE_MARKER));
        if (total > 0) assert.ok(buildEpicCompleteComment(progress).includes(
            total === 1 ? '1 child PR has' : '2 child PRs have'));
    }
    const incomplete = buildEpicFinalMergeComment(
        { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] },
        { epicPrNumber: 501, baseBranch: 'main', planName: 'Big Plan' },
    );
    assert.match(incomplete, /Epic merged: Big Plan/);
    assert.ok(!incomplete.includes('All planned epic work'));
});

test('final marker still reads the aggregate membership boundary', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
    octokit.epicMerged = true;
    await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit });
    octokit.calls.length = 0;
    const result = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
    assert.equal(result.trackingComment, 'unchanged');
    assert.ok(octokit.calls.some(c => c.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'));
});

test('a human final marker cannot suppress the PR read or readiness', async () => {
    const octokit = createOctokit([], [{
        id: 1, user: { login: 'someone' },
        body: 'Epic PR #500 has been merged into main.\n' + EPIC_FINAL_MERGE_MARKER,
    }]);
    octokit.childReads[201] = { merged_at: '2026-10-09T00:00:00Z' };
    await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
    assert.ok(octokit.calls.some(c => c.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'));
    assert.ok(octokit.comments.some(c => c.body.includes(EPIC_COMPLETE_MARKER)));
});

for (const mergedChildPrNumber of [201, 202, null]) {
    test(`successor excludes shipped children and plan placeholders (trigger ${mergedChildPrNumber})`, async () => {
        const octokit = createOctokit([
            { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
            { number: 202, state: 'closed', merged_at: '2026-10-09T02:00:00Z' },
            { number: 203, state: 'open', merged_at: null },
        ]);
        octokit.history = [
            { number: 500, merged_at: '2026-10-09T01:00:00Z' },
            { number: 499, merged_at: 'invalid' },
            { number: 501, merged_at: '2026-10-09T03:00:00Z' },
            { number: 502, merged_at: '2026-10-09T04:00:00Z' },
        ];
        octokit.epicMerged = mergedChildPrNumber === null;
        const result = await updateEpicMergeProgress({
            ...baseRequest, epicPrNumber: 501, mergedChildPrNumber,
            planIssues: [
                planIssue(100, PlanIssueStatus.MERGED, 201),
                planIssue(101, PlanIssueStatus.MERGED, 202),
                planIssue(102, PlanIssueStatus.UNDER_REVIEW, 203),
                planIssue(103, PlanIssueStatus.PENDING),
            ],
        }, 'test', { getOctokit: async () => octokit });
        assert.deepEqual(result.progress, { merged: 1, total: 3, excluded: 0, mergedPullRequests: [202] });
        assert.ok(!octokit.comments.some(c => c.body.includes(EPIC_COMPLETE_MARKER)));
        assert.ok(!octokit.comments.some(c => c.body.includes('All planned epic work')));
    });
}

test('successor readiness counts only its children, retaining a same-second child the predecessor head excludes', async () => {
    const octokit = createOctokit([
        { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
        { number: 202, state: 'closed', merged_at: '2026-10-09T01:00:00Z', merge_commit_sha: 'c2' },
    ]);
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z', head: { sha: 'p1' } }];
    octokit.containment['p1...c2'] = 1;
    await updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501, mergedChildPrNumber: 202 },
        'test', { getOctokit: async () => octokit });
    assert.ok(octokit.comments.some(c => c.body.includes('All 1 child PR has been merged')));
});

test('a same-second predecessor child without inclusion evidence keeps the obligation instead of being counted', async () => {
    const octokit = createOctokit([{ number: 202, state: 'closed', merged_at: '2026-10-09T01:00:00Z' }]);
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z', head: { sha: 'p1' } }];
    await assert.rejects(updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501, mergedChildPrNumber: 202 },
        'test', { getOctokit: async () => octokit }), /could not be resolved/);
    assert.equal(octokit.comments.length, 0);
});

test('failed predecessor reads write no comments and propagate for durable retry', async () => {
    const octokit = createOctokit([]);
    octokit.childReads[201] = { merged_at: '2026-10-09T00:00:00Z' };
    const paginate = octokit.paginate;
    octokit.paginate = async (route, parameters) => {
        if (parameters.head) throw new Error('history unavailable');
        return paginate(route, parameters);
    };
    await assert.rejects(updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit }), /history unavailable/);
    assert.equal(octokit.comments.length, 0);
});

for (const trigger of [null, 201]) {
    test(`final counts stay within the aggregate boundary (trigger ${trigger})`, async () => {
        const octokit = createOctokit([
            { number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' },
            { number: 202, state: 'closed', merged_at: '2026-10-10T21:00:00Z' },
            { number: 203, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: 'c3' },
        ]);
        octokit.epicMerged = true;
        octokit.headSha = 'h1';
        // #203 merged into the epic branch after the epic's head was merged.
        octokit.containment['h1...c3'] = 1;
        const result = await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: trigger,
            planIssues: [201, 202, 203, 204].map(n => planIssue(n, PlanIssueStatus.MERGED, n)),
        }, 'test', { getOctokit: async () => octokit });
        assert.deepEqual(result.progress, { merged: 1, total: 4, excluded: 0, mergedPullRequests: [201] });
        const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
        assert.match(final.body, /1 out of 4 PRs merged/);
        assert.ok(!final.body.includes('All planned epic work'));
    });
}

test('late child evidence edits the final confirmation in place and leaves identical redelivery alone', async () => {
    const pulls = [{ number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' }];
    const octokit = createOctokit(pulls);
    octokit.epicMerged = true;
    const request = { ...baseRequest, mergedChildPrNumber: null,
        planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201), planIssue(101, PlanIssueStatus.MERGED, 202)] };
    // #202 is recorded as merged, but GitHub does not confirm its merge yet.
    octokit.childReads[202] = { state: 'open', merged_at: null };
    const dependencies = { getOctokit: async () => octokit };
    await updateEpicMergeProgress(request, 'test', dependencies);
    const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
    assert.match(final.body, /1 out of 2/);
    delete octokit.childReads[202];
    pulls.push({ number: 202, state: 'closed', merged_at: '2026-10-10T19:30:00Z' });
    const late = { ...request, mergedChildPrNumber: 202 };
    const result = await updateEpicMergeProgress(late, 'test', dependencies);
    assert.equal(result.completionPosted, false);
    assert.match(final.body, /2 out of 2/);
    assert.match(final.body, /All planned epic work/);
    assert.equal(octokit.comments.filter(c => c.body.includes(EPIC_FINAL_MERGE_MARKER)).length, 1);
    octokit.calls.length = 0;
    await updateEpicMergeProgress(late, 'test', dependencies);
    assert.ok(!octokit.calls.some(c => /^(PATCH|POST)/.test(c.route)));
});

test('final confirmation edits check ownership separately from tracking edits', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' }], [
        { id: 1, body: `old final\n${EPIC_FINAL_MERGE_MARKER}`, user: { login: 'propr-dev[bot]' } },
    ]);
    octokit.epicMerged = true;
    let writes = 0;
    await assert.rejects(updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', {
        getOctokit: async () => octokit,
        assertOwned: async () => { if (++writes === 2) throw new Error('lease lost'); },
    }), /lease lost/);
    assert.equal(octokit.comments[0].body, `old final\n${EPIC_FINAL_MERGE_MARKER}`);
});

test('unknown aggregate base skips history instead of querying the display fallback', async () => {
    const octokit = createOctokit([]);
    octokit.epicMerged = true;
    octokit.base = undefined;
    await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit });
    assert.ok(!octokit.calls.some(c => c.parameters.head));
    assert.ok(octokit.comments.some(c => c.body.includes('merged into the target branch')));
});

test('missing aggregate boundary retains the obligation by failing before writes', async () => {
    const octokit = createOctokit([]);
    octokit.epicMerged = true;
    octokit.mergedAt = 'invalid';
    await assert.rejects(updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', {
        getOctokit: async () => octokit,
    }), /boundary unavailable/);
    assert.equal(octokit.comments.length, 0);
});

test('a merged destination changed since handler validation cannot post completion', async () => {
    const octokit = createOctokit([]);
    octokit.epicMerged = true;
    octokit.base = 'release/next';
    await assert.rejects(updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit }), /default branch/);
    assert.equal(octokit.comments.length, 0);
});

test('merged candidate order follows merge time and reads the child only once', async () => {
    const { findEpicPRNumber } = await import('../packages/core/src/webhook/epicMergeEvidence.js');
    let childReads = 0;
    const octokit = {
        async paginate() { return [
            { number: 502, state: 'closed', merged_at: '2026-10-10T22:00:00Z', base: { ref: 'trunk' } },
            { number: 501, state: 'closed', merged_at: '2026-10-10T21:00:00Z', base: { ref: 'trunk' } },
            { number: 499, state: 'closed', merged_at: '2026-10-10T18:00:00Z', base: { ref: 'trunk' } },
            { number: 498, state: 'closed', merged_at: '2026-10-10T19:30:00Z', base: { ref: 'release/next' } },
            { number: 500, state: 'closed', merged_at: '2026-10-10T20:00:00Z', base: { ref: 'trunk' } },
        ]; },
        async request(route: string) {
            if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'trunk' } };
            childReads++;
            return { data: { merged_at: '2026-10-10T19:00:00Z' } };
        },
    };
    assert.equal(await findEpicPRNumber(octokit as never, baseRequest), 500);
    assert.equal(childReads, 1);
});

test('an older-numbered aggregate merged later cannot erase outstanding work from a final report', async () => {
    const octokit = createOctokit([
        { number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' },
        { number: 202, state: 'closed', merged_at: '2026-10-10T21:00:00Z' },
    ]);
    octokit.history = [{ number: 499, merged_at: '2026-10-10T22:00:00Z' }];
    octokit.epicMerged = true;
    const result = await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', {
        getOctokit: async () => octokit,
    });
    assert.deepEqual(result.progress, { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] });
});

test('a delayed child missing from the list uses its timestamp for final counts', async () => {
    const octokit = createOctokit([]);
    octokit.epicMerged = true;
    octokit.childReads[201] = { merged_at: '2026-10-10T19:00:00Z' };
    const result = await updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit });
    assert.deepEqual(result.progress, { merged: 1, total: 1, excluded: 0, mergedPullRequests: [201] });
});

for (const trigger of [null, 201]) {
    test(`a stale unmerged child row is reconciled before the final count (trigger ${trigger})`, async () => {
        // The list still shows #201's pre-merge row after it merged; the plan
        // (and, for a delayed delivery, the webhook) already know it merged.
        const octokit = createOctokit([{ number: 201, state: 'open', merged_at: null }]);
        octokit.epicMerged = true;
        octokit.childReads[201] = { state: 'closed', merged_at: '2026-10-10T19:00:00Z' };
        const result = await updateEpicMergeProgress({
            ...baseRequest, mergedChildPrNumber: trigger, planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201)],
        }, 'test', { getOctokit: async () => octokit });
        assert.deepEqual(result.progress, { merged: 1, total: 1, excluded: 0, mergedPullRequests: [201] });
        assert.equal(childReadsOf(octokit, 201), 1);
        const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
        assert.match(final.body, /1 out of 1 PRs merged/);
        assert.match(final.body, /All planned epic work is now merged/);
    });
}

test('an aggregate delivery reads a merged plan PR missing from the list and applies the boundary', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' }]);
    octokit.epicMerged = true;
    octokit.childReads[202] = { state: 'closed', merged_at: '2026-10-10T19:30:00Z' };
    octokit.childReads[203] = { state: 'closed', merged_at: '2026-10-10T21:00:00Z' };
    const result = await updateEpicMergeProgress({
        ...baseRequest, mergedChildPrNumber: null,
        planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201), planIssue(101, PlanIssueStatus.MERGED, 202), planIssue(102, PlanIssueStatus.MERGED, 203)],
    }, 'test', { getOctokit: async () => octokit });
    // #203 merged after the epic and stays outstanding; a fresh row needs no read.
    assert.deepEqual(result.progress, { merged: 2, total: 3, excluded: 0, mergedPullRequests: [201, 202] });
    assert.equal(childReadsOf(octokit, 201), 0);
    assert.match(octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!.body, /2 out of 3 PRs merged/);
});

test('a merged plan PR targeting another base stays outstanding in the final report', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T19:00:00Z' }]);
    octokit.epicMerged = true;
    octokit.childReads[202] = { state: 'closed', merged_at: '2026-10-10T19:30:00Z', base: { ref: 'main' } };
    const result = await updateEpicMergeProgress({
        ...baseRequest, mergedChildPrNumber: null,
        planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201), planIssue(101, PlanIssueStatus.MERGED, 202)],
    }, 'test', { getOctokit: async () => octokit });
    assert.deepEqual(result.progress, { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] });
    assert.ok(!octokit.comments.some(c => c.body.includes('All planned epic work')));
});

for (const trigger of [null, 201]) {
    test(`unreadable child evidence writes nothing and propagates for retry (trigger ${trigger})`, async () => {
        const octokit = createOctokit([{ number: 201, state: 'open', merged_at: null }]);
        octokit.epicMerged = true;
        const request = octokit.request;
        octokit.request = async (route, parameters) => {
            if (parameters.pull_number === 201) throw new Error('child unavailable');
            return request(route, parameters);
        };
        await assert.rejects(updateEpicMergeProgress({
            ...baseRequest, mergedChildPrNumber: trigger, planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201)],
        }, 'test', { getOctokit: async () => octokit }), /child unavailable/);
        assert.equal(octokit.comments.length, 0);
    });
}

for (const epicMerged of [false, true]) {
    test(`a triggering child whose merge GitHub cannot confirm keeps the obligation (epic merged: ${epicMerged})`, async () => {
        const octokit = createOctokit([{ number: 201, state: 'open', merged_at: null }]);
        octokit.epicMerged = epicMerged;
        await assert.rejects(updateEpicMergeProgress(baseRequest, 'test', { getOctokit: async () => octokit }), /#201 could not be confirmed/);
        assert.equal(octokit.comments.length, 0);
    });
}

test('a stale triggering row on an open epic recovers its timestamp for the shipped check', async () => {
    // #201 merged before predecessor #500 merged, so the successor must not count it.
    const octokit = createOctokit([{ number: 201, state: 'open', merged_at: null }, { number: 202, state: 'closed', merged_at: '2026-10-09T02:00:00Z' }]);
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z' }];
    octokit.childReads[201] = { state: 'closed', merged_at: '2026-10-09T00:00:00Z' };
    const result = await updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501 }, 'test', { getOctokit: async () => octokit });
    assert.deepEqual(result.progress, { merged: 1, total: 1, excluded: 0, mergedPullRequests: [202] });
});

// The epic's merge commit per merge method: only a merge commit keeps the child's commit as an ancestor.
const EPIC_MERGE_COMMITS = { merge: 'e1', squash: 'squashed-e1', rebase: 'rebased-e1' } as const;

for (const [method, mergeCommitSha] of Object.entries(EPIC_MERGE_COMMITS)) {
    test(`a child merged in the epic's second is included when the epic's pre-merge head contains it (${method} merge)`, async () => {
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: 'c1' }]);
        octokit.epicMerged = true;
        octokit.mergeCommitSha = mergeCommitSha;
        octokit.headSha = 'h1';
        octokit.containment['h1...c1'] = 0;
        const result = await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit });
        assert.deepEqual(result.progress, { merged: 1, total: 1, excluded: 0, mergedPullRequests: [201] });
        const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
        assert.match(final.body, /1 out of 1 PRs merged/);
        assert.match(final.body, /All planned epic work is now merged/);
        const compares = octokit.calls.filter(c => c.route === 'GET /repos/{owner}/{repo}/compare/{basehead}');
        assert.ok(compares.length > 0);
        assert.ok(compares.every(c => c.parameters.basehead === 'h1...c1'), 'the rewritten merge commit is never the comparison base');
    });

    test(`a child merged into the epic branch in the epic's second after its head is excluded (${method} merge)`, async () => {
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: 'c1' }]);
        octokit.epicMerged = true;
        octokit.mergeCommitSha = mergeCommitSha;
        octokit.headSha = 'h1';
        octokit.containment['h1...c1'] = 1;
        const result = await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit });
        assert.deepEqual(result.progress, { merged: 0, total: 1, excluded: 0, mergedPullRequests: [] });
        const final = octokit.comments.find(c => c.body.includes(EPIC_FINAL_MERGE_MARKER))!;
        assert.match(final.body, /0 out of 1 PRs merged/);
        assert.ok(!final.body.includes('All planned epic work'));
    });
}

test('a same-second plan issue proven included keeps its merged status in the final report', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: 'c1' }]);
    octokit.epicMerged = true;
    octokit.mergeCommitSha = 'squashed-e1';
    octokit.headSha = 'h1';
    octokit.containment['h1...c1'] = 0;
    const result = await updateEpicMergeProgress({
        ...baseRequest, mergedChildPrNumber: 201,
        planIssues: [planIssue(100, PlanIssueStatus.MERGED, 201), planIssue(101, PlanIssueStatus.MERGED, 202)],
    }, 'test', { getOctokit: async () => octokit });
    assert.deepEqual(result.progress, { merged: 1, total: 2, excluded: 0, mergedPullRequests: [201] });
});

for (const detail of ['the comparison returns 404', 'the epic head is unknown', 'the child merge commit is unknown'] as const) {
    test(`same-second inclusion is unresolved, not exclusion, when ${detail}`, async () => {
        const childMergeCommitSha = detail === 'the child merge commit is unknown' ? null : 'c1';
        const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: childMergeCommitSha }]);
        octokit.epicMerged = true;
        octokit.headSha = detail === 'the epic head is unknown' ? null : 'h1';
        if (detail === 'the comparison returns 404') {
            const request = octokit.request;
            octokit.request = async (route, parameters) => {
                if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') throw Object.assign(new Error('compare failed'), { status: 404 });
                return request(route, parameters);
            };
        }
        await assert.rejects(updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit }), /could not be resolved/);
        assert.equal(octokit.comments.length, 0);
    });
}

test('same-second containment propagates other comparison failures', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-10T20:00:00Z', merge_commit_sha: 'c1' }]);
    octokit.epicMerged = true;
    octokit.headSha = 'h1';
    const request = octokit.request;
    octokit.request = async (route, parameters) => {
        if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') throw Object.assign(new Error('compare failed'), { status: 500 });
        return request(route, parameters);
    };
    await assert.rejects(updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit }), /compare failed/);
    assert.equal(octokit.comments.length, 0);
});

test('a child merged in the predecessor\'s second is shipped once the predecessor head contains it, with no empty tracking comment', async () => {
    const octokit = createOctokit([
        { number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' },
        { number: 202, state: 'closed', merged_at: '2026-10-09T01:00:00Z', merge_commit_sha: 'c2' },
    ]);
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z', merge_commit_sha: 'squashed-p1', head: { sha: 'p1' } }];
    octokit.containment['p1...c2'] = 0;
    const result = await updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501, mergedChildPrNumber: 202 },
        'test', { getOctokit: async () => octokit });
    assert.deepEqual(result.progress, { merged: 0, total: 0, excluded: 0, mergedPullRequests: [] });
    assert.equal(result.trackingComment, 'skipped');
    assert.deepEqual(octokit.comments, []);
});

test('an existing tracking comment is still updated when nothing remains to track', async () => {
    const octokit = createOctokit([], [{ id: 1, body: `stale\n${EPIC_PROGRESS_MARKER}`, user: { login: 'propr-dev[bot]' } }]);
    octokit.childReads[201] = { merged_at: '2026-10-09T00:00:00Z' };
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z' }];
    const result = await updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501 }, 'test', { getOctokit: async () => octokit });
    assert.equal(result.trackingComment, 'updated');
    assert.match(octokit.comments[0].body, /0 out of 0 PRs merged/);
});

test('planned issues closed without a merge are still reported when no PR is counted', async () => {
    const octokit = createOctokit([]);
    octokit.childReads[201] = { merged_at: '2026-10-09T00:00:00Z' };
    octokit.history = [{ number: 500, merged_at: '2026-10-09T01:00:00Z' }];
    const result = await updateEpicMergeProgress({ ...baseRequest, epicPrNumber: 501, planIssues: [planIssue(100, PlanIssueStatus.CLOSED, 202)] },
        'test', { getOctokit: async () => octokit });
    assert.equal(result.trackingComment, 'created');
    assert.match(octokit.comments[0].body, /1 planned issue was closed without a merge/);
});

test('the merged-into line of the tracking comment precedes its marker', async () => {
    const octokit = createOctokit([{ number: 201, state: 'closed', merged_at: '2026-10-09T00:00:00Z' }]);
    octokit.epicMerged = true;
    await updateEpicMergeProgress({ ...baseRequest, mergedChildPrNumber: null }, 'test', { getOctokit: async () => octokit });
    const tracking = octokit.comments.find(c => c.body.includes(EPIC_PROGRESS_MARKER))!;
    assert.ok(tracking.body.endsWith(EPIC_PROGRESS_MARKER));
    assert.match(tracking.body, /✅ This epic PR has been merged into main\.\n\n---/);
    assert.equal(tracking.body, buildEpicProgressComment(
        { merged: 1, total: 1, excluded: 0, mergedPullRequests: [201] }, 'Big Plan', 'main'));
});

test('canCarryChild settles equal merge timestamps against the epic head and reuses given evidence', async () => {
    const { canCarryChild } = await import('../packages/core/src/webhook/epicMergeEvidence.js');
    const routes: string[] = [];
    const octokit = {
        async request(route: string, parameters: Record<string, unknown>) {
            routes.push(route);
            if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { ahead_by: parameters.basehead === 'h1...c1' ? 0 : 1 } };
            throw new Error(`Unexpected ${route}`);
        },
    } as never;
    const epic = { state: 'closed', merged_at: '2026-10-10T20:00:00Z', base: { ref: 'main' }, merge_commit_sha: 'squashed-e1', head: { sha: 'h1' } };
    const evidence = { defaultBranch: 'main', childMergedAt: '2026-10-10T20:00:00Z', childMergeCommitSha: 'c1' };
    assert.equal(await canCarryChild(octokit, baseRequest, epic, evidence), true);
    assert.equal(await canCarryChild(octokit, baseRequest, epic, async () => ({ ...evidence, childMergeCommitSha: 'c2' })), false);
    await assert.rejects(canCarryChild(octokit, baseRequest, epic, { ...evidence, childMergeCommitSha: null }), /could not be resolved/);
    await assert.rejects(canCarryChild(octokit, baseRequest, { ...epic, head: null }, evidence), /could not be resolved/);
    assert.deepEqual(routes, ['GET /repos/{owner}/{repo}/compare/{basehead}', 'GET /repos/{owner}/{repo}/compare/{basehead}']);
});
