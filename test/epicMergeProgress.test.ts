import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { PlanIssueStatus, type PlanIssue } from '../packages/core/src/config/planIssueManager.js';
import {
    EPIC_COMPLETE_MARKER,
    EPIC_PROGRESS_MARKER,
    buildEpicProgressComment,
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

function createOctokit(pulls: unknown[], initialComments: FakeComment[] = []) {
    const comments = [...initialComments];
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    let nextId = 1000;
    const octokit = {
        calls,
        comments,
        async paginate(route: string, parameters: Record<string, unknown>) {
            calls.push({ route, parameters });
            if (route === 'GET /repos/{owner}/{repo}/pulls') return pulls;
            if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return comments.map(c => ({ ...c }));
            throw new Error(`Unexpected paginate ${route}`);
        },
        async request(route: string, parameters: Record<string, unknown>) {
            calls.push({ route, parameters });
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
        assert.match(body, /\*\*2 of 4 PRs merged\*\*/);
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
        assert.match(octokit.comments[0].body, /1 of 2 PRs merged/);
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
        assert.match(tracking[0].body, /2 of 2 PRs merged/);
        const completion = octokit.comments.filter(c => c.body.includes(EPIC_COMPLETE_MARKER));
        assert.strictEqual(completion.length, 1);
        assert.match(completion[0].body, /Epic fully merged: Big Plan/);
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
        assert.match(octokit.comments[0].body, /1 of 2 PRs merged/);
        assert.ok(!octokit.comments.some(c => c.body.includes(EPIC_COMPLETE_MARKER)));
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
