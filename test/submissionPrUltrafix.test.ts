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

const findIssueSubmission = mock.fn(async () => submission);
const processCommentEvent = mock.fn(async () => undefined);

await mock.module('@propr/core', {
    namedExports: {
        findIssueSubmission,
        findPlanIssueByRepoAndNumber: mock.fn(async () => undefined),
        generateCompletionComment: mock.fn(async () => 'Completed.'),
        getAuthenticatedOctokit: mock.fn(async () => ({
            request: async (route: string, body: Record<string, unknown>) => {
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
        enableAutoMerge: mock.fn(async ({ prNumber }: { prNumber: number }) => {
            autoMerges.push(prNumber);
            return { success: true, autoMergeEnabled: true };
        }),
    },
});
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });

const { handleCreatedPlanIssuePR } = await import('../src/jobs/issueJobPostProcessingHelpers.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;
const issueRef = { repoOwner: 'owner', repoName: 'repo', number: 42 } as never;

async function runWithSubmission(payload: Record<string, unknown> | undefined, labels: string[]) {
    comments.length = 0;
    autoMerges.length = 0;
    submission = payload ? { payload: JSON.stringify(payload) } : undefined;
    await handleCreatedPlanIssuePR({
        issueRef,
        currentIssueData: { data: { labels: labels.map(name => ({ name })) } },
        prNumber: 101,
        correlatedLogger: logger,
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
