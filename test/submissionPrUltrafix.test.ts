import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/**
 * A directly submitted task (MCP `create_task`) opts into Ultrafix through the
 * same shared issue label planned work uses; its bounds come from the stored
 * submission instead of Planner settings.
 */
const comments: Array<{ route: string; body: Record<string, unknown> }> = [];
const autoMerges: number[] = [];
let submission: { payload: string } | undefined;
// The labels as they stand when the pull request opens, which is what a user
// changes while the agent runs; `undefined` makes the re-read fail.
let liveLabels: string[] | undefined;

const findIssueSubmission = mock.fn(async () => submission);
type GateResult = { arm: boolean; reason: string; mergeMethod?: string };
let gateResult: GateResult = { arm: true, reason: 'armed', mergeMethod: 'SQUASH' };
const gateAutoMergeArming = mock.fn(async (_input: Record<string, unknown>) => gateResult);
const armedMethods: Array<string | undefined> = [];
const processCommentEvent = mock.fn(async () => undefined);

await mock.module('@propr/core', {
    namedExports: {
        getEpicExecutionQueue: mock.fn(async () => null),
        findIssueSubmission,
        findPlanIssueByRepoAndNumber: mock.fn(async () => undefined),
        gateAutoMergeArming,
        generateCompletionComment: mock.fn(async () => 'Completed.'),
        getAuthenticatedOctokit: mock.fn(async () => ({
            request: async (route: string, body: Record<string, unknown>) => {
                if (route.startsWith('GET ')) {
                    if (!liveLabels) throw new Error('issue read failed');
                    return { data: { labels: liveLabels.map(name => ({ name })) } };
                }
                comments.push({ route, body });
                return { data: { id: 7, user: { login: 'propr-dev[bot]' } } };
            },
        })),
        getPrimaryProcessingLabels: mock.fn(() => ['AI']),
        linkPRToPlanIssue: mock.fn(async () => undefined),
        processCommentEvent,
        safeUpdateLabels: mock.fn(async () => ({ success: true, removed: [], added: [], errors: [] })),
        updatePlanIssueStatus: mock.fn(async () => undefined),
        PlanIssueStatus: { MERGED: 'merged' },
        getPlanIssuesByDraft: mock.fn(async () => []),
        db: mock.fn(() => { throw new Error('No plan lookup expected'); }),
    },
});
await mock.module('../src/github/autoMergeOperations.js', {
    namedExports: {
        enableAutoMerge: mock.fn(async ({ prNumber, mergeMethod }: { prNumber: number; mergeMethod?: string }) => {
            autoMerges.push(prNumber);
            armedMethods.push(mergeMethod);
            return { success: true, autoMergeEnabled: true };
        }),
    },
});
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });

const { handleCreatedPlanIssuePR } = await import('../src/jobs/issueJobPostProcessingHelpers.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;
const issueRef = { repoOwner: 'owner', repoName: 'repo', number: 42 } as never;

async function runWithSubmission(
    payload: Record<string, unknown> | undefined,
    labels: string[],
    options: { liveLabels?: string[] | undefined } = {},
) {
    comments.length = 0;
    autoMerges.length = 0;
    submission = payload ? { payload: JSON.stringify(payload) } : undefined;
    liveLabels = 'liveLabels' in options ? options.liveLabels : labels;
    processCommentEvent.mock.resetCalls();
    await handleCreatedPlanIssuePR({
        issueRef,
        currentIssueData: { data: { labels: labels.map(name => ({ name })) } },
        prNumber: 101,
        correlatedLogger: logger,
        taskId: 'task-7',
    });
    return comments.filter(call => call.route.endsWith('/comments')).map(call => String(call.body.body));
}

test('a submitted task without an ultrafix opt-in starts no ultrafix loop', async () => {
    assert.deepEqual(await runWithSubmission({ instruction: 'Fix dates' }, ['AI']), []);
    assert.deepEqual(await runWithSubmission(undefined, ['AI']), []);
    assert.equal(processCommentEvent.mock.callCount(), 0);
});

test('a submitted task carries its own ultrafix bounds onto the new pull request', async () => {
    const bounded = await runWithSubmission(
        { instruction: 'Fix dates', runUltrafix: true, ultrafixGoal: 6, ultrafixMaxCycles: 2 },
        ['AI', 'ultrafix'],
    );
    assert.equal(bounded.length, 1);
    assert.match(bounded[0], /^\/ultrafix goal=6 max=2\n/);
    // Ultrafix owns the readiness of the pull request, so auto-merge is not enabled yet.
    assert.deepEqual(autoMerges, []);

    const unbounded = await runWithSubmission({ instruction: 'Fix dates', runUltrafix: true }, ['AI', 'ultrafix']);
    assert.deepEqual(unbounded, ['/ultrafix\nTriggered automatically by the requested execution settings.']);

    const rejected = await runWithSubmission(
        { instruction: 'Fix dates', runUltrafix: true, ultrafixGoal: 44, ultrafixMaxCycles: 0 },
        ['AI', 'ultrafix'],
    );
    assert.deepEqual(rejected, ['/ultrafix\nTriggered automatically by the requested execution settings.']);
});

test('a submitted auto-merge task without ultrafix enables auto-merge on the new pull request', async () => {
    assert.deepEqual(await runWithSubmission({ instruction: 'Fix dates', autoMerge: true }, ['AI', 'auto-merge']), []);
    assert.deepEqual(autoMerges, [101]);
});

test('the repository auto-merge policy decides before auto-merge is armed', async () => {
    gateAutoMergeArming.mock.resetCalls();
    armedMethods.length = 0;
    gateResult = { arm: true, reason: 'armed', mergeMethod: 'REBASE' };
    await runWithSubmission({ instruction: 'Fix dates', autoMerge: true }, ['AI', 'auto-merge']);
    assert.deepEqual(armedMethods, ['REBASE']);
    assert.deepEqual(
        { ...gateAutoMergeArming.mock.calls[0].arguments[0], log: undefined },
        { owner: 'owner', repo: 'repo', prNumber: 101, opportunity: 'initial_pr', taskId: 'task-7', issueNumber: 42, log: undefined },
    );

    gateResult = { arm: false, reason: 'skipped_protected_path' };
    await runWithSubmission({ instruction: 'Fix dates', autoMerge: true }, ['AI', 'auto-merge']);
    assert.deepEqual(autoMerges, [], 'a skipped decision never arms auto-merge');
    gateResult = { arm: true, reason: 'armed', mergeMethod: 'SQUASH' };
});

test('removing the ultrafix label before the pull request withdraws a submitted opt-in', async () => {
    const withdrawn = await runWithSubmission(
        { instruction: 'Fix dates', runUltrafix: true, ultrafixGoal: 6, ultrafixMaxCycles: 2 },
        ['AI', 'ultrafix'],
        { liveLabels: ['AI'] },
    );

    assert.deepEqual(withdrawn, []);
    assert.equal(processCommentEvent.mock.callCount(), 0);
    assert.deepEqual(autoMerges, []);
});

test('withdrawing ultrafix leaves a still-labelled auto-merge opt-in in place', async () => {
    assert.deepEqual(
        await runWithSubmission(
            { instruction: 'Fix dates', runUltrafix: true, autoMerge: true },
            ['AI', 'ultrafix', 'auto-merge'],
            { liveLabels: ['AI', 'auto-merge'] },
        ),
        [],
    );
    assert.equal(processCommentEvent.mock.callCount(), 0);
    assert.deepEqual(autoMerges, [101]);
});

test('an unreadable source issue keeps the opt-in stated when the run began', async () => {
    const bounded = await runWithSubmission(
        { instruction: 'Fix dates', runUltrafix: true, ultrafixGoal: 6, ultrafixMaxCycles: 2 },
        ['AI', 'ultrafix'],
        { liveLabels: undefined },
    );

    assert.deepEqual(bounded, ['/ultrafix goal=6 max=2\nTriggered automatically by the requested execution settings.']);
});
