import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

// Every GitHub read must go through the injected client; the App default is never reached.
const actualGithubAuth = await import('../src/auth/githubAuth.js');
await mock.module('../src/auth/githubAuth.js', { namedExports: { ...actualGithubAuth, getAuthenticatedOctokit: async () => { throw new Error('use the injected client'); } } });

const { evaluatePullRequestReadiness, PullRequestReadinessUnavailableError } = await import('../src/webhook/pullRequestReadiness.js');
const { NO_CI_GRACE_MS } = await import('../src/webhook/checkRunHelpers.js');
const { closeConnection } = await import('../src/db/connection.js');
after(closeConnection);
type Deps = import('../src/webhook/pullRequestReadiness.js').PullRequestReadinessDeps;
type ScoreFact = import('../src/webhook/pullRequestReadiness.js').ReviewScoreFact;

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const NOW = Date.parse('2026-11-12T12:00:00.000Z');

interface Fixture {
    pr: Record<string, unknown>;
    checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
    status: { state: string; total_count: number; statuses: Array<{ context: string; state: string }> };
    checkRunsError?: boolean;
    reviews: Array<{ state: string; user: { login: string } }>;
    reviewsError?: boolean;
    reviewDecision: string | null;
    issueLabels: Record<number, string[]>;
    issueError?: boolean;
    /** PR fields every read after the first one returns, as if another actor pushed meanwhile. */
    prAfterFirstRead?: Record<string, unknown>;
    workflow?: string;
    files: Array<{ filename: string }>;
}

function fixture(overrides: Partial<Fixture> & { pr?: Record<string, unknown> } = {}): Fixture {
    const { pr, ...rest } = overrides;
    return {
        checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        status: { state: 'success', total_count: 0, statuses: [] },
        reviews: [{ state: 'APPROVED', user: { login: 'maintainer' } }],
        reviewDecision: 'APPROVED',
        issueLabels: {},
        files: [{ filename: 'src/app.ts' }],
        ...rest,
        pr: {
            number: 7, node_id: 'PR_7', state: 'open', merged: false, merged_at: null, draft: false, body: '',
            head: { sha: HEAD, ref: 'feature' }, base: { ref: 'main' }, labels: [], mergeable: true, mergeable_state: 'clean',
            changed_files: 1, auto_merge: null, ...pr,
        },
    };
}

/** A GitHub fake that answers only reads and records every call, so a write would be visible. */
function fakeGitHub(state: Fixture) {
    const calls: string[] = [];
    const octokit = {
        async request(route: string, params: Record<string, unknown> = {}) {
            const prReads = calls.filter(call => call === 'GET /repos/{owner}/{repo}/pulls/{pull_number}').length;
            calls.push(route);
            switch (route) {
                case 'GET /repos/{owner}/{repo}/pulls/{pull_number}':
                    return { data: prReads > 0 && state.prAfterFirstRead ? { ...state.pr, ...state.prAfterFirstRead } : state.pr };
                case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': {
                    if (state.reviewsError) throw Object.assign(new Error('reviews down'), { status: 502 });
                    const perPage = Number(params.per_page ?? 30);
                    const page = Number(params.page ?? 1);
                    return { data: state.reviews.slice((page - 1) * perPage, page * perPage) };
                }
                case 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs':
                    if (state.checkRunsError) throw Object.assign(new Error('checks down'), { status: 502 });
                    return { data: { check_runs: state.checkRuns } };
                case 'GET /repos/{owner}/{repo}/commits/{ref}/status': return { data: state.status };
                case 'GET /repos/{owner}/{repo}/issues/{issue_number}':
                    if (state.issueError) throw Object.assign(new Error('issues down'), { status: 502 });
                    return { data: { labels: (state.issueLabels[Number(params.issue_number)] ?? []).map(name => ({ name })) } };
                case 'GET /repos/{owner}/{repo}/contents/{path}':
                    if (state.workflow === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
                    return { data: { type: 'file', encoding: 'base64', size: state.workflow.length, content: Buffer.from(state.workflow).toString('base64') } };
                case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': return { data: Number(params.page) === 1 ? state.files : [] };
                default: throw new Error(`unexpected GitHub call ${route}`);
            }
        },
        async graphql<T>(query: string): Promise<T> {
            calls.push(`graphql ${query.trim().split(/[({]/)[0]}`);
            return { repository: { pullRequest: { reviewDecision: state.reviewDecision } } } as T;
        },
    };
    return { octokit, calls };
}

/** A Redis stand-in that refuses writes; the head-observation key is only ever read. */
function observationStore(values: Record<string, string> = {}) {
    const writes: string[] = [];
    const store = {
        async get(key: string) { return values[key] ?? null; },
        async set(key: string) { writes.push(`set ${key}`); return 'OK'; },
        async del(key: string) { writes.push(`del ${key}`); return 1; },
    };
    return { store, writes };
}

const score = (overrides: Partial<ScoreFact> = {}): ScoreFact => ({
    task_id: 'review-1', score: 9, goal: null, goal_reached: null, blocker_count: 0, head_sha: HEAD, ...overrides,
});

async function evaluate(state: Fixture, deps: Partial<Deps> = {}) {
    const github = fakeGitHub(state);
    const observations = observationStore();
    const result = await evaluatePullRequestReadiness('acme', 'app', 7, {
        octokit: github.octokit,
        observations: observations.store,
        loadReviewScores: async () => [score()],
        loadNonBlockingChecks: async () => [],
        loadUltrafixState: async () => null,
        loadActiveWork: async () => ({ activeTasks: [], queuedJobs: [] }),
        loadRatingGoal: async () => 8,
        now: () => NOW,
        ...deps,
    });
    return { result, github, observations };
}

const gateOf = (result: { gates: Array<{ gate: string; status: string; reason: string }> }, name: string) => {
    const found = result.gates.find(item => item.gate === name);
    assert.ok(found, `gate ${name} is reported`);
    return found;
};

test('a green, clean, approved PR reviewed at goal on its head with no active work is ready', async () => {
    const { result } = await evaluate(fixture());
    assert.equal(result.verdict, 'ready');
    assert.deepEqual(result.blockingReasons, []);
    assert.deepEqual(result.waitingReasons, []);
    assert.deepEqual(result.gates.map(item => item.gate),
        ['open', 'not_draft', 'checks', 'mergeable', 'human_review', 'ai_review', 'ultrafix', 'active_work', 'policy']);
    assert.deepEqual(result.review, { score: 9, goal: 8, goalReached: true, reviewedHead: HEAD, matchesCurrentHead: true });
    assert.deepEqual(result.checks, { reason: 'checks_passing', blockingFailed: [], blockingPending: [], nonBlockingCount: 0 });
    assert.deepEqual(result.ultrafix, { active: false, completionStatus: null, labelPresent: false });
    assert.deepEqual(result.autoMerge, { eligible: 'ineligible', reason: 'no_auto_merge_label', policy: null });
    assert.equal(gateOf(result, 'policy').status, 'not_applicable');
    assert.equal(gateOf(result, 'policy').reason, 'auto_merge_not_requested');
    assert.equal(gateOf(result, 'ultrafix').reason, 'ultrafix_not_requested');
    assert.equal(gateOf(result, 'human_review').reason, 'approved');
    assert.equal(result.evaluatedAt, new Date(NOW).toISOString());
    assert.equal(result.head, HEAD);
    assert.equal(result.base, 'main');
});

test('the read performs no GitHub write, no Redis write and never updates the branch or merges', async () => {
    // Auto-merge requested, so the policy (contents, files) is read too; no CI, so the observation key is consulted.
    const { result, github, observations } = await evaluate(fixture({
        pr: { labels: [{ name: 'auto-merge' }], mergeable_state: 'behind', auto_merge: { enabled_by: { login: 'propr[bot]' } } },
        checkRuns: [],
        workflow: 'auto_merge:\n  require_up_to_date: true\n',
    }));
    assert.equal(result.checks.reason, 'waiting_for_ci');
    assert.ok(github.calls.length > 0);
    for (const call of github.calls) assert.match(call, /^(GET |graphql query)/, `${call} is a read`);
    assert.ok(!github.calls.some(call => /merge|update-branch/.test(call) && !call.startsWith('GET ')), 'no merge or branch update');
    assert.ok(github.calls.includes('GET /repos/{owner}/{repo}/contents/{path}'), 'the policy was read');
    assert.deepEqual(observations.writes, [], 'the head-observation key is never written or cleared');
});

test('the read leaves the head-observation key alone even when the head has CI', async () => {
    const key = 'auto-merge:head-observed:acme:app:7';
    const { store, writes } = observationStore({ [key]: JSON.stringify({ sha: HEAD, observedAt: NOW - 1_000 }) });
    const { result } = await evaluate(fixture(), { observations: store });
    assert.equal(result.checks.reason, 'checks_passing');
    assert.deepEqual(writes, []);
});

test('open gate: merged and closed PRs take their verdict from the PR state', async () => {
    const merged = (await evaluate(fixture({ pr: { state: 'closed', merged: true } }))).result;
    assert.equal(merged.verdict, 'merged');
    assert.equal(merged.state, 'merged');
    assert.deepEqual(gateOf(merged, 'open'), { gate: 'open', status: 'fail', reason: 'pull_request_merged' });
    const closed = (await evaluate(fixture({ pr: { state: 'closed' } }))).result;
    assert.equal(closed.verdict, 'closed');
    assert.deepEqual(closed.blockingReasons, ['pull_request_closed']);
});

test('not_draft gate: a draft is blocked', async () => {
    const { result } = await evaluate(fixture({ pr: { draft: true, mergeable_state: 'draft' } }));
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.draft, true);
    assert.ok(result.blockingReasons.includes('draft'));
    assert.equal(gateOf(result, 'mergeable').reason, 'merge_state_unknown');
});

test('checks gate: failing, pending, no CI, CI not yet registered and unreadable CI', async () => {
    const failed = (await evaluate(fixture({ checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'flaky', status: 'completed', conclusion: 'failure' }] }), {
        loadNonBlockingChecks: async () => ['flaky'],
    })).result;
    assert.deepEqual(gateOf(failed, 'checks'), { gate: 'checks', status: 'fail', reason: 'checks_not_passing', detail: 'Failed: lint' });
    assert.deepEqual(failed.checks, { reason: 'checks_not_passing', blockingFailed: ['lint'], blockingPending: [], nonBlockingCount: 1 });
    assert.equal(failed.verdict, 'blocked');

    const pending = (await evaluate(fixture({ checkRuns: [{ name: 'test', status: 'in_progress', conclusion: null }], pr: { mergeable_state: 'blocked' } }))).result;
    assert.equal(gateOf(pending, 'checks').status, 'waiting');
    assert.equal(gateOf(pending, 'checks').reason, 'checks_not_passing');
    // Branch protection holds the merge only because CI is still running.
    assert.equal(gateOf(pending, 'mergeable').status, 'waiting');
    assert.equal(gateOf(pending, 'mergeable').reason, 'branch_protection_blocked');
    assert.equal(pending.verdict, 'waiting');

    const key = 'auto-merge:head-observed:acme:app:7';
    const observedLongAgo = observationStore({ [key]: JSON.stringify({ sha: HEAD, observedAt: NOW - NO_CI_GRACE_MS }) });
    const noCi = (await evaluate(fixture({ checkRuns: [] }), { observations: observedLongAgo.store })).result;
    assert.deepEqual(gateOf(noCi, 'checks'), { gate: 'checks', status: 'pass', reason: 'no_ci' });

    const otherHead = observationStore({ [key]: JSON.stringify({ sha: OLD_HEAD, observedAt: NOW - NO_CI_GRACE_MS }) });
    const waiting = (await evaluate(fixture({ checkRuns: [] }), { observations: otherHead.store })).result;
    assert.equal(gateOf(waiting, 'checks').reason, 'waiting_for_ci');
    assert.ok(waiting.waitingReasons.includes('waiting_for_ci'));

    const unavailable = (await evaluate(fixture({ checkRunsError: true }))).result;
    assert.equal(gateOf(unavailable, 'checks').status, 'unknown');
    assert.equal(unavailable.checks.reason, 'unavailable');
    assert.equal(unavailable.verdict, 'unknown');
});

test('mergeable gate: conflicts, behind, blocked and unknown merge state', async () => {
    const reason = async (pr: Record<string, unknown>) => gateOf((await evaluate(fixture({ pr }))).result, 'mergeable');
    assert.deepEqual(await reason({ mergeable: false, mergeable_state: 'dirty' }), { gate: 'mergeable', status: 'fail', reason: 'merge_conflict' });
    assert.deepEqual(await reason({ mergeable_state: 'behind' }), { gate: 'mergeable', status: 'fail', reason: 'branch_behind_base' });
    assert.deepEqual(await reason({ mergeable_state: 'blocked' }), { gate: 'mergeable', status: 'fail', reason: 'branch_protection_blocked' });
    const unknown = await reason({ mergeable: null, mergeable_state: 'unknown' });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.reason, 'merge_state_unknown');
    assert.equal((await reason({ mergeable_state: 'unstable' })).status, 'pass');
});

test('human_review gate: changes requested, review required and unreadable reviews', async () => {
    const changes = (await evaluate(fixture({ reviews: [{ state: 'APPROVED', user: { login: 'a' } }, { state: 'CHANGES_REQUESTED', user: { login: 'b' } }] }))).result;
    assert.deepEqual(gateOf(changes, 'human_review'), { gate: 'human_review', status: 'fail', reason: 'changes_requested', detail: 'By b' });
    // A later approval by the same reviewer replaces their request; a comment does not.
    const resolved = (await evaluate(fixture({ reviews: [{ state: 'CHANGES_REQUESTED', user: { login: 'b' } }, { state: 'APPROVED', user: { login: 'b' } }, { state: 'COMMENTED', user: { login: 'b' } }] }))).result;
    assert.equal(gateOf(resolved, 'human_review').status, 'pass');

    const required = (await evaluate(fixture({ reviews: [], reviewDecision: 'REVIEW_REQUIRED' }))).result;
    assert.deepEqual(gateOf(required, 'human_review'), { gate: 'human_review', status: 'waiting', reason: 'review_required' });
    assert.equal(required.verdict, 'waiting');

    const unreadable = (await evaluate(fixture({ reviewsError: true }))).result;
    assert.equal(gateOf(unreadable, 'human_review').reason, 'review_state_unavailable');
    assert.equal(gateOf(unreadable, 'human_review').status, 'unknown');
});

test('human_review gate: a change request on page one is superseded by the same reviewer\'s approval on page two', async () => {
    const filler = Array.from({ length: 99 }, (_, index) => ({ state: 'COMMENTED', user: { login: `c${index}` } }));
    const reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'b' } }, ...filler, { state: 'APPROVED', user: { login: 'b' } }];
    const { result, github } = await evaluate(fixture({ reviews }));
    assert.equal(github.calls.filter(call => call.endsWith('/reviews')).length, 2, 'both pages are read');
    assert.deepEqual(gateOf(result, 'human_review'), { gate: 'human_review', status: 'pass', reason: 'approved' });
    assert.equal(result.verdict, 'ready');

    // A history longer than the page bound is reported unavailable, never judged from a prefix.
    const { MAX_REVIEW_PAGES } = await import('../src/webhook/pullRequestReadiness.js');
    const endless = Array.from({ length: MAX_REVIEW_PAGES * 100 }, () => ({ state: 'COMMENTED', user: { login: 'c' } }));
    const truncated = (await evaluate(fixture({ reviews: endless }))).result;
    assert.deepEqual(gateOf(truncated, 'human_review'), { gate: 'human_review', status: 'unknown', reason: 'review_state_unavailable' });
    assert.notEqual(truncated.verdict, 'ready');
});

test('ai_review gate: no review, stale head, below goal and goal reached', async () => {
    const none = (await evaluate(fixture(), { loadReviewScores: async () => [] })).result;
    assert.deepEqual(gateOf(none, 'ai_review'), { gate: 'ai_review', status: 'not_applicable', reason: 'no_review' });
    assert.equal(none.review, null);
    assert.equal(none.verdict, 'ready', 'a PR ProPR is not reviewing is never held by ai_review');

    const awaited = (await evaluate(fixture({ pr: { labels: [{ name: 'ultrafix' }] } }), { loadReviewScores: async () => [] })).result;
    assert.equal(gateOf(awaited, 'ai_review').status, 'waiting');
    assert.equal(gateOf(awaited, 'ai_review').reason, 'no_review');

    const stale = (await evaluate(fixture(), { loadReviewScores: async () => [score({ head_sha: OLD_HEAD })] })).result;
    assert.equal(gateOf(stale, 'ai_review').reason, 'review_stale_head');
    assert.equal(stale.review?.matchesCurrentHead, false);

    const below = (await evaluate(fixture(), { loadReviewScores: async () => [score({ score: 9 }), score({ task_id: 'review-2', score: 6 })] })).result;
    assert.equal(gateOf(below, 'ai_review').reason, 'score_below_goal');
    assert.equal(below.verdict, 'blocked');

    // A plain review at the goal with a blocker from a sibling reviewer has not reached it.
    const blocker = (await evaluate(fixture(), { loadReviewScores: async () => [score({ blocker_count: 1, score: 6 }), score({ score: 9 })] })).result;
    assert.equal(gateOf(blocker, 'ai_review').reason, 'score_below_goal');

    // An Ultrafix cycle's recorded verdict and goal are authoritative.
    const cycle = (await evaluate(fixture(), { loadReviewScores: async () => [score({ score: 7, goal: 7, goal_reached: 1 })] })).result;
    assert.deepEqual(gateOf(cycle, 'ai_review'), { gate: 'ai_review', status: 'pass', reason: 'goal_reached', detail: 'Score 7/10, goal 7.' });
    assert.equal(cycle.review?.goal, 7);

    const unreadable = (await evaluate(fixture(), { loadReviewScores: async () => { throw new Error('db down'); } })).result;
    assert.equal(gateOf(unreadable, 'ai_review').reason, 'review_scores_unavailable');
});

test('ultrafix gate: active, failed, unavailable, pending and succeeded loops', async () => {
    const labelled = fixture({ pr: { labels: [{ name: 'ultrafix' }] } });
    const run = async (state: Awaited<ReturnType<NonNullable<Deps['loadUltrafixState']>>>, input = labelled) =>
        (await evaluate(input, { loadUltrafixState: async () => state })).result;

    const active = await run({ active: true, completionStatus: null });
    assert.deepEqual(gateOf(active, 'ultrafix'), { gate: 'ultrafix', status: 'waiting', reason: 'ultrafix_active' });
    assert.deepEqual(active.ultrafix, { active: true, completionStatus: null, labelPresent: true });
    assert.equal(active.autoMerge.eligible, 'transient');
    assert.equal(active.autoMerge.reason, 'ultrafix_active');

    const failed = await run({ active: false, completionStatus: 'failed' });
    assert.equal(gateOf(failed, 'ultrafix').reason, 'ultrafix_failed');
    assert.equal(failed.verdict, 'blocked');

    const unavailable = await run({ active: false, completionStatus: null, unavailable: true });
    assert.equal(gateOf(unavailable, 'ultrafix').reason, 'ultrafix_state_unavailable');
    assert.equal(gateOf(unavailable, 'ultrafix').status, 'unknown');
    assert.equal(unavailable.ultrafix, null);
    assert.equal(unavailable.autoMerge.reason, 'ultrafix_state_unavailable');

    const pending = await run(null);
    assert.equal(gateOf(pending, 'ultrafix').reason, 'ultrafix_pending');

    const succeeded = await run({ active: false, completionStatus: 'succeeded' });
    assert.deepEqual(gateOf(succeeded, 'ultrafix'), { gate: 'ultrafix', status: 'pass', reason: 'ultrafix_succeeded' });
    assert.equal(succeeded.verdict, 'ready');
});

test('active_work gate: running ProPR work waits and an unreadable queue is unknown, never idle', async () => {
    const busy = (await evaluate(fixture(), { loadActiveWork: async () => ({ activeTasks: [{ taskId: 't1', state: 'processing' }], queuedJobs: [] }) })).result;
    assert.equal(gateOf(busy, 'active_work').reason, 'propr_work_active');
    assert.equal(busy.verdict, 'waiting');
    assert.deepEqual(busy.waitingReasons, ['propr_work_active']);

    const unreadable = (await evaluate(fixture(), { loadActiveWork: async () => { throw new Error('redis down'); } })).result;
    assert.deepEqual(gateOf(unreadable, 'active_work'), { gate: 'active_work', status: 'unknown', reason: 'active_work_unavailable' });
    assert.equal(unreadable.verdict, 'unknown');
});

test('policy gate: reported with AutoMergeReason codes only when auto-merge is requested', async () => {
    const labelled = { labels: [{ name: 'auto-merge' }] };
    const armed = (await evaluate(fixture({ pr: labelled }))).result;
    assert.deepEqual(gateOf(armed, 'policy'), { gate: 'policy', status: 'pass', reason: 'armed' });
    assert.deepEqual(armed.autoMerge, { eligible: 'eligible', reason: 'pr_label', policy: 'armed' });

    const protectedPath = (await evaluate(fixture({ pr: labelled, workflow: 'auto_merge:\n  protected_paths:\n    - "src/**"\n' }))).result;
    assert.equal(gateOf(protectedPath, 'policy').reason, 'skipped_protected_path');
    assert.equal(gateOf(protectedPath, 'policy').status, 'fail');
    assert.equal(protectedPath.verdict, 'blocked');

    const invalid = (await evaluate(fixture({ pr: labelled, workflow: 'auto_merge: [' }))).result;
    assert.equal(gateOf(invalid, 'policy').reason, 'skipped_policy_invalid');
    assert.equal(gateOf(invalid, 'policy').status, 'unknown');

    // The linked issue's label requests auto-merge as well.
    const viaIssue = (await evaluate(fixture({ pr: { body: 'Fixes #12' }, issueLabels: { 12: ['auto-merge'] }, workflow: 'auto_merge:\n  enabled: false\n' }))).result;
    assert.equal(viaIssue.autoMerge.reason, 'linked_issue_label');
    assert.equal(gateOf(viaIssue, 'policy').reason, 'skipped_disabled');

    // Without a request, a policy that would refuse is never read and never changes the verdict.
    const unrequested = (await evaluate(fixture({ workflow: 'auto_merge:\n  enabled: false\n' }))).result;
    assert.equal(unrequested.verdict, 'ready');
    assert.equal(unrequested.autoMerge.policy, null);
});

test('policy gate: an unreadable linked issue leaves the auto-merge request unknown, never absent', async () => {
    const { result } = await evaluate(fixture({ pr: { body: 'Fixes #12' }, issueError: true, workflow: 'auto_merge:\n  enabled: false\n' }));
    assert.equal(result.autoMerge.reason, 'linked_issue_unavailable');
    assert.equal(gateOf(result, 'policy').status, 'unknown');
    assert.equal(gateOf(result, 'policy').reason, 'auto_merge_request_unavailable');
    assert.ok(result.waitingReasons.includes('auto_merge_request_unavailable'));
    assert.notEqual(result.verdict, 'ready');
});

test('policy gate: a policy decision for another head than the reported one is unknown', async () => {
    // H1 changes a protected path; H2, pushed while the signals are read, does not, so its policy would arm.
    const { result } = await evaluate(fixture({
        pr: { labels: [{ name: 'auto-merge' }] },
        prAfterFirstRead: { head: { sha: OLD_HEAD, ref: 'feature' } },
        workflow: 'auto_merge:\n  protected_paths:\n    - "src/**"\n',
        files: [{ filename: 'docs/readme.md' }],
    }));
    assert.equal(result.head, HEAD);
    assert.equal(gateOf(result, 'policy').status, 'unknown');
    assert.equal(gateOf(result, 'policy').reason, 'pull_request_changed');
    assert.equal(result.autoMerge.policy, null, 'another head\'s policy reason is not reported');
    assert.notEqual(result.verdict, 'ready');

    const rebased = (await evaluate(fixture({ pr: { labels: [{ name: 'auto-merge' }] }, prAfterFirstRead: { base: { ref: 'release' } } }))).result;
    assert.equal(gateOf(rebased, 'policy').reason, 'pull_request_changed');
});

test('an unreadable pull request throws instead of guessing a verdict', async () => {
    const octokit = { request: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } };
    await assert.rejects(
        evaluatePullRequestReadiness('acme', 'app', 7, { octokit, loadReviewScores: async () => [] }),
        (error: unknown) => error instanceof PullRequestReadinessUnavailableError && error.status === 404,
    );
});
