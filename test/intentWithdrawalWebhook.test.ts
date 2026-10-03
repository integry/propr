import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
process.env.PROPR_DEMO_MODE = 'true';
process.env.MERGED_PR_CANCELLATION_WAIT_MS = '20';
let cancellationError: Error | undefined;
let cancellationWait: Promise<void> | undefined;
let cancellationFinished = false;
const restore = mock.fn(async () => ['AI']);
const handlers: string[] = [];
beforeEach(() => { currentLabels = ['AI']; currentState = 'open'; timeline = []; timelinePages = undefined; timelinePagesRead.length = 0; cancellationError = undefined; cancellationWait = undefined; cancellationFinished = false; handlers.length = 0; restore.mock.resetCalls(); processed.length = 0; });
const cancellations: Array<{ target: any; reason: string }> = [];
await mock.module('../packages/core/src/services/taskIntent.js', { namedExports: {
    restoreIssueTrigger: restore,
    settleWithdrawalCleanups: async () => false,
    cancelWithdrawnIntent: async (target: any, reason: string) => { cancellations.push({ target, reason }); await cancellationWait; cancellationFinished = true; if (cancellationError) throw cancellationError; },
} });
await mock.module('../packages/core/src/webhook/planIssueTracking.js', { namedExports: {
    handlePlanIssueStatusUpdate: async () => { handlers.push('plan-issue'); }, handlePlanPRUpdate: async () => { handlers.push('plan-pr'); }, handlePlanPRCommentTracking: async () => {},
} });
await mock.module('../packages/core/src/webhook/epicPRHandler.js', { namedExports: {
    handleEpicPRCreationOnMerge: async () => { handlers.push('epic-merge'); }, handleEpicPRLabelCleanup: async () => { handlers.push('epic-cleanup'); },
} });
await mock.module('../packages/core/src/webhook/closedPullRequestCi.js', { namedExports: {
    getClosedPullRequestCiRedis: () => ({}), recordClosedPullRequestForCiCancellation: async () => { handlers.push('closed-pr-ci'); },
} });
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', { namedExports: {
    handlePullRequestConflictDetection: async () => {}, handlePushConflictDetection: async () => {},
} });
// Fresh tracker state read by trigger webhooks; delayed payloads can be stale.
let currentLabels: string[] = ['AI'];
let currentState = 'open';
let timeline: any[] = [];
// Multi-page timeline; when set, it replaces `timeline`.
let timelinePages: any[][] | undefined;
const timelinePagesRead: number[] = [];
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: {
    getGitHubInstallationToken: async () => { throw new Error('GitHub auth not configured'); },
    getAuthenticatedOctokit: async () => ({ request: async (endpoint: string, params: any) => {
        if (endpoint.endsWith('/timeline') && timelinePages) {
            timelinePagesRead.push(params.page);
            return { headers: { link: `<https://api.github.com/x?page=${timelinePages.length}>; rel="last"` }, data: timelinePages[params.page - 1] };
        }
        if (endpoint.endsWith('/timeline')) return { headers: {}, data: timeline };
        if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { state: currentState, labels: currentLabels.map(name => ({ name })) } };
        throw new Error('GitHub auth not configured');
    } }),
} });
const { initializeWebhookHandler, processWebhookEvent } = await import('../packages/core/src/webhook/webhookHandler.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(closeConnection);
const processed: any[] = [];
await initializeWebhookHandler({
    issueProcessor: async issue => { processed.push(issue); }, commentProcessor: async () => {},
    commentDeletedHandler: async () => {}, commentEditedHandler: async () => {}, redisClient: {} as never,
    pullRequestProcessor: async () => { handlers.push('standard-pr'); },
    repositoryFilter: repo => repo === 'acme/widgets',
});
const repository = { full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' } };
function labeled(name: string, login: string, createdAt = '2026-10-01T00:00:00Z') {
    return { event: 'labeled', label: { name }, actor: { id: login.length, login }, created_at: createdAt };
}

test('a single issue closed or trigger unlabeled event cancels work; model removal never does', async () => {
    await processWebhookEvent({ repository, action: 'closed', issue: { number: 42 } }, 'issues', 'close');
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_issue_closed');
    await processWebhookEvent({ repository, action: 'unlabeled', label: { name: 'AI' }, issue: { number: 42 } }, 'issues', 'unlabel');
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_label_removed');
    const count = cancellations.length;
    await processWebhookEvent({ repository, action: 'unlabeled', label: { name: 'llm-codex-astra' }, issue: { number: 42 } }, 'issues', 'model');
    assert.equal(cancellations.length, count);
    await processWebhookEvent({ repository, action: 'labeled', issue: { number: 42, state: 'closed' } }, 'issues', 'late-label');
    assert.equal(processed.length, 0);
});

test('unmerged PR closure cancels PR work without treating it as an issue or changing merge handling', async () => {
    const count = cancellations.length;
    await processWebhookEvent({ repository, action: 'closed', pull_request: { number: 87, merged: false } }, 'pull_request', 'pr-close');
    assert.equal(cancellations.length, count + 1);
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_pr_closed');
    assert.equal(cancellations.at(-1)?.target.kind, 'pr');
    await processWebhookEvent({ repository, action: 'closed', pull_request: { number: 87, merged: true } }, 'pull_request', 'pr-merge');
    await processWebhookEvent({ repository, action: 'closed', issue: { number: 87, pull_request: {} } }, 'issues', 'pr-issue');
    assert.equal(cancellations.length, count + 1);
});

test('repository filtering happens before cancellation', async () => {
    const count = cancellations.length;
    await processWebhookEvent({ repository: { full_name: 'other/widgets' }, action: 'closed', issue: { number: 42 } }, 'issues', 'unmonitored');
    assert.equal(cancellations.length, count);
});


for (const message of ['Redis unavailable', 'Could not record 1 intent cancellation(s)']) {
    test(`withdrawal failure (${message}) preserves closed PR handlers`, async () => {
        cancellationError = new Error(message);
        const result = await processWebhookEvent({ repository, action: 'closed', pull_request: { number: 87, merged: false } }, 'pull_request', 'failed-pr-withdrawal');
        assert.equal(result.status, 'accepted');
        assert.deepEqual(handlers, ['plan-pr', 'epic-merge', 'epic-cleanup', 'closed-pr-ci', 'standard-pr']);
    });
}

test('withdrawal failure preserves closed issue plan tracking and standard disposition', async () => {
    cancellationError = new Error('Redis unavailable');
    const result = await processWebhookEvent({ repository, action: 'closed', issue: { number: 42 } }, 'issues', 'failed-issue-withdrawal');
    assert.deepEqual(handlers, ['plan-issue']);
    assert.deepEqual(result, { status: 'ignored', reason: 'unsupported_issue_action' });
});

for (const event of ['issues', 'pull_request'] as const) {
    for (const fails of [false, true]) {
        test(`${event} slow withdrawal finishes in the background (failure: ${fails})`, { timeout: 1000 }, async () => {
            let finish!: () => void;
            cancellationWait = new Promise<void>(resolve => { finish = resolve; });
            if (fails) cancellationError = new Error('late cancellation failure');
            const delivery = processWebhookEvent({ repository, action: 'closed',
                ...(event === 'issues' ? { issue: { number: 42 } } : { pull_request: { number: 87, merged: false } }),
            }, event, 'slow-withdrawal');
            await delivery;
            assert.equal(cancellationFinished, false);
            assert.ok(handlers.includes(event === 'issues' ? 'plan-issue' : 'standard-pr'));
            finish();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(cancellationFinished, true);
        });
    }
}

test('trigger payloads without stale status skip restoration and reach admission', async () => {
    for (const labels of [['AI'], ['AI', 'unrelated-processing'], ['AI', 'AI-done']]) {
        await processWebhookEvent({ repository, action: 'labeled', label: { name: 'AI' },
            sender: { login: 'alice' }, issue: { number: 42, state: 'open', labels },
        }, 'issues', 'ordinary-label');
    }
    assert.equal(restore.mock.callCount(), 0);
    assert.equal(processed.length, 3);
});

for (const actor of ['alice', 'mallory', undefined, 'propr-dev[bot]']) {
    for (const stale of ['AI-processing', 'AI-cancelled', 'build-cancelled']) {
        test(`restoration authorizes ${actor ?? 'missing actor'} before clearing ${stale}`, async () => {
            const oldWhitelist = process.env.GITHUB_USER_WHITELIST;
            const oldTriggers = process.env.PRIMARY_PROCESSING_LABELS;
            process.env.GITHUB_USER_WHITELIST = 'alice';
            process.env.PRIMARY_PROCESSING_LABELS = 'AI,build';
            currentLabels = ['AI', stale];
            timeline = [labeled(stale, 'propr-dev[bot]'), labeled('AI', 'alice')];
            try {
                const result = await processWebhookEvent({ repository, action: 'labeled', label: { name: 'AI' },
                    sender: actor ? { login: actor } : undefined,
                    issue: { number: 42, state: 'open', labels: ['AI', stale] },
                }, 'issues', 'restore-label');
                const allowed = actor === 'alice' || actor === 'propr-dev[bot]';
                assert.equal(restore.mock.callCount(), allowed ? 1 : 0);
                assert.equal(processed.length, allowed ? 1 : 0);
                if (!allowed) assert.deepEqual(result, { status: 'ignored', reason: 'user_not_allowed' });
            } finally {
                if (oldWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST;
                else process.env.GITHUB_USER_WHITELIST = oldWhitelist;
                if (oldTriggers === undefined) delete process.env.PRIMARY_PROCESSING_LABELS;
                else process.env.PRIMARY_PROCESSING_LABELS = oldTriggers;
            }
        });
    }
}

async function withTriggers<T>(run: () => Promise<T>): Promise<T> {
    const oldWhitelist = process.env.GITHUB_USER_WHITELIST;
    const oldTriggers = process.env.PRIMARY_PROCESSING_LABELS;
    process.env.GITHUB_USER_WHITELIST = 'alice';
    process.env.PRIMARY_PROCESSING_LABELS = 'AI,build';
    try { return await run(); } finally {
        if (oldWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST;
        else process.env.GITHUB_USER_WHITELIST = oldWhitelist;
        if (oldTriggers === undefined) delete process.env.PRIMARY_PROCESSING_LABELS;
        else process.env.PRIMARY_PROCESSING_LABELS = oldTriggers;
    }
}

const deliverAI = (updatedAt: string, labels = ['AI']) => processWebhookEvent({ repository, action: 'labeled', label: { name: 'AI' },
    sender: { login: 'alice' }, issue: { number: 42, state: 'open', labels, updated_at: updatedAt },
}, 'issues', 'delayed-label');

test('a delayed original trigger delivery cannot restart an issue cancelled after it', () => withTriggers(async () => {
    // Polling started the original application; the issue was then closed,
    // cancelled and reopened with AI still present.
    currentLabels = ['AI', 'AI-cancelled'];
    timeline = [labeled('AI', 'alice', '2026-10-01T00:00:00Z'), labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z')];
    const result = await deliverAI('2026-10-01T00:00:00Z');
    assert.deepEqual(result, { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 0);
    assert.equal(processed.length, 0);
}));

test('a delayed delivery cannot restart work whose processing marker postdates it', () => withTriggers(async () => {
    currentLabels = ['AI', 'AI-processing'];
    timeline = [labeled('AI', 'alice', '2026-10-01T00:00:00Z'), labeled('AI-processing', 'propr-dev[bot]', '2026-10-01T00:01:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T00:00:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 0);
}));

test('a reapplication newer than the cancellation restores even before the timeline shows it', () => withTriggers(async () => {
    currentLabels = ['AI', 'AI-cancelled'];
    timeline = [labeled('AI', 'alice', '2026-10-01T00:00:00Z'), labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z')];
    await deliverAI('2026-10-01T02:00:00Z', ['AI', 'AI-cancelled']);
    assert.equal(restore.mock.callCount(), 1);
    assert.equal(processed.length, 1);
}));

test('a stale delivery is admitted when the timeline shows an authorized reapplication', () => withTriggers(async () => {
    currentLabels = ['AI', 'AI-cancelled'];
    timeline = [labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z'), labeled('AI', 'alice', '2026-10-01T02:00:00Z')];
    await deliverAI('2026-10-01T00:00:00Z');
    assert.equal(restore.mock.callCount(), 1);
    timeline = [labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z'), labeled('AI', 'mallory', '2026-10-01T02:00:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T00:00:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 1);
}));

test('a delayed original delivery cannot restart work whose applied cancellation is not yet in the timeline', () => withTriggers(async () => {
    // The current issue has AI-cancelled, but the timeline lags and shows only
    // the original authorized application.
    currentLabels = ['AI', 'AI-cancelled'];
    timeline = [labeled('AI', 'alice', '2026-10-01T00:00:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T00:00:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    // A visible older marker does not stand in for the unseen applied one.
    timeline = [labeled('AI', 'alice', '2026-10-01T00:00:00Z'), labeled('AI-processing', 'propr-dev[bot]', '2026-10-01T00:01:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T00:30:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 0);
    assert.equal(processed.length, 0);
}));

test('a delayed delivery cannot restart work when the timeline last shows the applied marker removed', () => withTriggers(async () => {
    // Restored once, then cancelled again; the new AI-cancelled is not visible yet.
    currentLabels = ['AI', 'AI-cancelled'];
    timeline = [labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z'), labeled('AI', 'alice', '2026-10-01T02:00:00Z'),
        { event: 'unlabeled', label: { name: 'AI-cancelled' }, actor: { id: 1, login: 'propr-dev[bot]' }, created_at: '2026-10-01T02:01:00Z' }];
    assert.deepEqual(await deliverAI('2026-10-01T02:00:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 0);
}));

test('a trigger removed again before delivery is not restored', () => withTriggers(async () => {
    currentLabels = ['AI-cancelled'];
    timeline = [labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z'), labeled('AI', 'alice', '2026-10-01T02:00:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T02:00:00Z', ['AI', 'AI-cancelled']), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(restore.mock.callCount(), 0);
}));

test('an original trigger found only across an unscanned timeline gap cannot restart cancelled work', () => withTriggers(async () => {
    // AI on page 1, cancellation on page 2; the default five-page budget scans
    // pages 8–4 and then page 1, never seeing the cancellation.
    currentLabels = ['AI', 'AI-cancelled'];
    timelinePages = Array.from({ length: 8 }, () => [{ event: 'commented' }]);
    timelinePages[0] = [labeled('AI', 'alice', '2026-10-01T00:00:00Z')];
    timelinePages[1] = [labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z')];
    assert.deepEqual(await deliverAI('2026-10-01T00:00:00Z'), { status: 'ignored', reason: 'intent_not_current' });
    assert.ok(!timelinePagesRead.includes(2));
    assert.equal(restore.mock.callCount(), 0);
    assert.equal(processed.length, 0);
}));

test('an original trigger on page 1 of a contiguously scanned timeline is still checked for ordering', () => withTriggers(async () => {
    currentLabels = ['AI', 'AI-cancelled'];
    timelinePages = [[labeled('AI-cancelled', 'propr-dev[bot]', '2026-10-01T01:00:00Z'), labeled('AI', 'alice', '2026-10-01T02:00:00Z')], [{ event: 'commented' }], [{ event: 'commented' }]];
    await deliverAI('2026-10-01T00:00:00Z');
    assert.equal(restore.mock.callCount(), 1);
}));

const deliverModelLabel = (labels = ['AI', 'llm-codex-astra']) => processWebhookEvent({ repository, action: 'labeled', label: { name: 'llm-codex-astra' },
    sender: { login: 'alice' }, issue: { number: 42, state: 'open', labels, updated_at: '2026-10-01T00:00:00Z' },
}, 'issues', 'delayed-model-label');

test('a delayed unrelated-label delivery cannot restart an issue cancelled after it', () => withTriggers(async () => {
    // The model label payload predates the closure, cancellation and reopening
    // with AI still present; it carries no cancellation marker.
    currentLabels = ['AI', 'llm-codex-astra', 'AI-cancelled'];
    await deliverModelLabel();
    assert.equal(restore.mock.callCount(), 0);
    assert.equal(processed.length, 1);
    assert.deepEqual(processed[0].labels, currentLabels);
    assert.equal(processed[0].triggerReapplied, undefined);
    const { processDetectedIssue } = await import('../packages/core/src/daemon/issueDetection.js');
    const redis = { set: async () => { throw new Error('admission must stop before deduplication'); } };
    assert.deepEqual(await processDetectedIssue(processed[0], 'delayed-model-label', redis as never),
        { status: 'ignored', reason: 'issue_has_terminal_label' });
}));

test('a delayed unrelated-label delivery for an issue closed since is not admitted', () => withTriggers(async () => {
    currentState = 'closed';
    assert.deepEqual(await deliverModelLabel(), { status: 'ignored', reason: 'intent_not_current' });
    assert.equal(processed.length, 0);
}));

test('an unrelated-label delivery for a live request reaches admission with current labels', () => withTriggers(async () => {
    currentLabels = ['AI', 'llm-codex-astra', 'bug'];
    await deliverModelLabel();
    assert.equal(processed.length, 1);
    assert.deepEqual(processed[0].labels, currentLabels);
}));
