import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { isBookkeepingCancellation } from '../packages/core/src/utils/workerStateManager.types.js';
import { formatRetryTime, hoursUntil } from '../packages/core/src/utils/scheduling.js';

type Comment = { id: number; body: string; user: { type: string; login: string }; updated_at: string };

/** A thread on one issue, served through the routes the notice helper uses. */
function fakeThread(initial: Comment[] = []) {
    const comments = [...initial];
    const routes: string[] = [];
    let nextId = 1000;
    const request = async (route: string, params: Record<string, unknown>) => {
        routes.push(route);
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            const page = Number(params.page ?? 1);
            const perPage = Number(params.per_page ?? 30);
            const since = params.since === undefined ? -Infinity : Date.parse(String(params.since));
            const visible = comments.filter(comment => Date.parse(comment.updated_at) >= since);
            return { data: visible.slice((page - 1) * perPage, page * perPage).map(comment => ({ ...comment })) };
        }
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            const comment = { id: nextId++, body: String(params.body), user: { type: 'Bot', login: 'propr-dev[bot]' }, updated_at: new Date().toISOString() };
            comments.push(comment);
            return { data: comment };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            const comment = comments.find(item => item.id === params.comment_id);
            if (!comment) throw Object.assign(new Error('Not Found'), { status: 404 });
            comment.body = String(params.body);
            comment.updated_at = new Date().toISOString();
            return { data: comment };
        }
        if (route === 'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            comments.splice(comments.findIndex(item => item.id === params.comment_id), 1);
            return { data: {} };
        }
        throw new Error(`unexpected route ${route}`);
    };
    return { comments, routes, octokit: { request: request as never } };
}

const jobs = new Map<string, any>();
await mock.module('@propr/core', { namedExports: {
    isBookkeepingCancellation,
    issueQueue: {
        add: async (name: string, data: any, opts: any) => {
            const job = jobs.get(opts.jobId) ?? { id: opts.jobId, name, data, getState: async () => 'delayed', remove: async () => { jobs.delete(opts.jobId); } };
            jobs.set(job.id, job);
            return job;
        },
        getJob: async (id: string) => jobs.get(id),
    },
    safeRemoveLabel: async () => {}, safeAddLabel: async () => {},
    formatRetryTime, hoursUntil, recordLLMMetrics: async () => {},
    updateWithdrawnIssueLabels: async () => {},
    TaskStates: { CANCELLED: 'cancelled', COMPLETED: 'completed', FAILED: 'failed' },
} });
const { publishRepeatedNotice, buildRepeatedNoticeBody, normalizeNoticeText } = await import('../src/jobs/repeatedNoticeComment.js');
const { handleGenericError, handleUsageLimitError, postCancellationNotice, rateLimitNoticeFingerprint } = await import('../src/jobs/errorHandlers.js');

const target = { owner: 'acme', repo: 'widgets', issueNumber: 42 };
const log = { info() {}, warn() {}, error() {} };
const issue = { repoOwner: 'acme', repoName: 'widgets', number: 42, agentAlias: 'claude', modelName: 'opus', correlationId: 'corr', isChildJob: true };
let state: any;
const stateManager = { getTaskState: async () => state, updateTaskState: async () => {} };
beforeEach(() => { jobs.clear(); state = { state: 'processing' }; });

test('a repeated notice updates the earlier comment with a count and the latest time', async () => {
    const thread = fakeThread();
    const notice = { kind: 'cancelled', scope: 'task-1', body: '🛑 **Execution Cancelled**' };
    const first = await publishRepeatedNotice(thread.octokit, target, notice, { now: new Date('2026-11-16T17:00:00Z') });
    const second = await publishRepeatedNotice(thread.octokit, target, notice, { now: new Date('2026-11-16T17:00:04Z') });
    const third = await publishRepeatedNotice(thread.octokit, target, notice, { now: new Date('2026-11-16T17:00:05Z') });
    assert.deepEqual([first.repeated, second.repeated, third.repeated], [false, true, true]);
    assert.equal(thread.comments.length, 1);
    assert.match(thread.comments[0].body, /^🛑 \*\*Execution Cancelled\*\*\n\n_Reported 3 times; last at 2026-11-16 17:00 UTC\._\n\n<!-- propr:notice kind="cancelled" key="[0-9a-f]{16}" count="3" -->$/);
});

test('notice text differing only in timestamps is the same notice; other text is not', async () => {
    assert.equal(normalizeNoticeText('failed at 2026-11-16T17:00:00Z (5:02 PM UTC)'), normalizeNoticeText('failed at 2026-11-16T17:16:09.120Z (5:18 PM UTC)'));
    const thread = fakeThread();
    await publishRepeatedNotice(thread.octokit, target, { kind: 'merge-conflict-failed', scope: 'sha-1', body: 'Failed at 2026-11-16T17:00:00Z' });
    await publishRepeatedNotice(thread.octokit, target, { kind: 'merge-conflict-failed', scope: 'sha-1', body: 'Failed at 2026-11-16T17:16:00Z' });
    assert.equal(thread.comments.length, 1);
    await publishRepeatedNotice(thread.octokit, target, { kind: 'merge-conflict-failed', scope: 'sha-1', body: 'A different error' });
    await publishRepeatedNotice(thread.octokit, target, { kind: 'merge-conflict-failed', scope: 'sha-2', body: 'Failed at 2026-11-16T17:00:00Z' });
    await publishRepeatedNotice(thread.octokit, target, { kind: 'cancelled', scope: 'sha-1', body: 'Failed at 2026-11-16T17:00:00Z' });
    assert.equal(thread.comments.length, 4, 'other text, another head or another kind is a new notice');
});

test('a person quoting the marker is never edited, and an old notice outside the window is left alone', async () => {
    const notice = { kind: 'rate-limit', scope: 'issue', body: 'limit', fingerprint: 'limit' };
    const marked = buildRepeatedNoticeBody(notice, 1);
    const thread = fakeThread([
        { id: 1, body: marked, user: { type: 'User', login: 'someone' }, updated_at: new Date().toISOString() },
        { id: 2, body: marked, user: { type: 'Bot', login: 'propr-dev[bot]' }, updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    ]);
    await publishRepeatedNotice(thread.octokit, target, notice, { withinMs: 60 * 60 * 1000 });
    assert.equal(thread.comments.length, 3);
    assert.deepEqual(thread.comments.slice(0, 2).map(comment => comment.body), [marked, marked]);
});

test('another bot quoting the marker is never edited; the earlier ProPR notice is updated', async () => {
    const notice = { kind: 'merge-conflict-failed', scope: 'sha-1', body: '❌ failed' };
    const marked = buildRepeatedNoticeBody(notice, 1);
    const quoted = `> ${marked}\n\nSee above.`;
    const now = new Date().toISOString();
    const thread = fakeThread([
        { id: 1, body: marked, user: { type: 'Bot', login: 'propr-dev[bot]' }, updated_at: now },
        { id: 2, body: quoted, user: { type: 'Bot', login: 'other-app[bot]' }, updated_at: now },
    ]);
    const result = await publishRepeatedNotice(thread.octokit, target, notice);
    assert.deepEqual(result, { commentId: 1, repeated: true, count: 2 });
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[1].body, quoted, 'the other bot comment is untouched');
    assert.match(thread.comments[0].body, /count="2" -->$/);
});

test('a notice after the first 1,000 comments is still found and updated on a repeat', async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const history = Array.from({ length: 1050 }, (_, index) => ({
        id: 100_000 + index, body: `comment ${index}`, user: { type: 'User', login: 'someone' }, updated_at: old,
    }));
    for (const withinMs of [undefined, 60 * 60 * 1000]) {
        const thread = fakeThread(history);
        const notice = { kind: 'started', scope: 'task-1', body: 'AI processing has started' };
        const first = await publishRepeatedNotice(thread.octokit, target, notice, { withinMs });
        const second = await publishRepeatedNotice(thread.octokit, target, notice, { withinMs });
        const third = await publishRepeatedNotice(thread.octokit, target, notice, { withinMs });
        assert.equal(first.repeated, false);
        assert.deepEqual([second, third], [
            { commentId: first.commentId, repeated: true, count: 2 },
            { commentId: first.commentId, repeated: true, count: 3 },
        ], `withinMs=${withinMs}`);
        assert.equal(thread.comments.length, 1051);
    }
});

test('an attempt comment is removed when an earlier identical notice is updated instead', async () => {
    const thread = fakeThread();
    const notice = { kind: 'merge-conflict-failed', scope: 'sha-1', body: '❌ failed' };
    const firstStart = await thread.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { body: 'starting' }) as { data: Comment };
    await publishRepeatedNotice(thread.octokit, target, notice, { ownCommentId: firstStart.data.id });
    const secondStart = await thread.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { body: 'starting' }) as { data: Comment };
    const result = await publishRepeatedNotice(thread.octokit, target, notice, { ownCommentId: secondStart.data.id });
    assert.deepEqual(result, { commentId: firstStart.data.id, repeated: true, count: 2 });
    assert.deepEqual(thread.comments.map(comment => comment.id), [firstStart.data.id]);
});

test('a failed read or edit falls back to posting, so no notice is dropped', async () => {
    const thread = fakeThread();
    const notice = { kind: 'cancelled', scope: 'task-1', body: 'stopped' };
    await publishRepeatedNotice(thread.octokit, target, notice);
    const failingRead = { request: (async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('GET')) throw new Error('secondary rate limit');
        return thread.octokit.request(route as never, params as never);
    }) as never };
    await publishRepeatedNotice(failingRead, target, notice, { log });
    const failingEdit = { request: (async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('PATCH')) throw new Error('edit refused');
        return thread.octokit.request(route as never, params as never);
    }) as never };
    await publishRepeatedNotice(failingEdit, target, notice, { log });
    assert.equal(thread.comments.length, 3);
});

test('repeated usage limits of one issue leave one rate-limit notice with the latest reset', async () => {
    const thread = fakeThread();
    const options = { octokit: thread.octokit, correlatedLogger: log, stateManager, taskId: 'issue-task' } as any;
    const firstReset = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
    const laterReset = firstReset + 60 * 60;
    const limit = (resetTimestamp: number) => Object.assign(new Error('usage limit'), { resetTimestamp, rawErrorMessage: `You've hit your limit · resets ${resetTimestamp % 12}pm (UTC)` });
    await handleUsageLimitError(limit(firstReset), { id: 'job-1', name: 'processGitHubIssue', data: issue } as any, issue as any, options);
    await handleUsageLimitError(limit(laterReset), { id: 'job-2', name: 'processGitHubIssue', data: issue } as any, issue as any, options);
    // A sibling run of the same request hits the same limit.
    await handleUsageLimitError(limit(laterReset), { id: 'job-3', name: 'processGitHubIssue', data: issue } as any, issue as any, { ...options, taskId: 'sibling-task' });
    assert.equal(thread.comments.length, 1);
    const body = thread.comments[0].body;
    assert.match(body, /⌛ \*\*Rate Limit Reached\*\*/);
    assert.ok(body.includes(`**Reset time:** ${formatRetryTime(laterReset)}`), body);
    assert.match(body, /Reported 3 times/);
});

test('a new reset time in another meridiem or with minutes still updates the one rate-limit notice', async () => {
    const thread = fakeThread();
    const options = { octokit: thread.octokit, correlatedLogger: log, stateManager, taskId: 'issue-task' } as any;
    const reset = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
    const messages = [
        "You've hit your limit · resets 11am (UTC)",
        "You've hit your limit · resets 1pm (UTC)",
        "You've hit your limit · resets 1:30pm (UTC)",
        "You've hit your limit · resets Nov 20, 1am (Europe/Riga)",
    ];
    for (const [index, rawErrorMessage] of messages.entries()) {
        const error = Object.assign(new Error('usage limit'), { resetTimestamp: reset + index * 60, rawErrorMessage });
        await handleUsageLimitError(error, { id: `job-${index}`, name: 'processGitHubIssue', data: issue } as any, issue as any, options);
    }
    assert.equal(thread.comments.length, 1);
    assert.ok(thread.comments[0].body.includes('resets Nov 20, 1am (Europe/Riga)'), 'the newest reset text is shown');
    assert.match(thread.comments[0].body, /Reported 4 times/);
});

test('the rate-limit fingerprint drops the reset clause but keeps which limit was hit', () => {
    assert.equal(rateLimitNoticeFingerprint("You've hit your limit · resets 11am (UTC)"), rateLimitNoticeFingerprint("You've hit your limit · resets 1:30pm (UTC)"));
    assert.equal(rateLimitNoticeFingerprint('Weekly limit reached · resets Nov 20 at 10am'), rateLimitNoticeFingerprint('Weekly limit reached · resets Nov 21, 1am (UTC)'));
    assert.notEqual(rateLimitNoticeFingerprint("You've hit your weekly limit · resets Nov 20, 1am (UTC)"), rateLimitNoticeFingerprint("You've hit your session limit · resets 1am (UTC)"));
});

test('a weekly limit notice shows the weekly reset date, not a time later today', async () => {
    const thread = fakeThread();
    const weeklyReset = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    const error = Object.assign(new Error('usage limit'), { resetTimestamp: weeklyReset, rawErrorMessage: "You've hit your weekly limit" });
    await handleUsageLimitError(error, { id: 'job-1', name: 'processGitHubIssue', data: issue } as any, issue as any,
        { octokit: thread.octokit, correlatedLogger: log, stateManager, taskId: 'issue-task' } as any);
    const day = new Date(weeklyReset * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    assert.match(thread.comments[0].body, new RegExp(`\\*\\*Reset time:\\*\\* ${day}, .* UTC \\(in approximately 7[12] hours\\)`));
});

test('no rate-limit notice when the retry starts immediately', async () => {
    const thread = fakeThread();
    // The limit already reset (the next attempt runs on an account with headroom): the retry is due now.
    const error = Object.assign(new Error('usage limit'), { resetTimestamp: Math.floor(Date.now() / 1000) - 5, rawErrorMessage: 'limit' });
    await handleUsageLimitError(error, { id: 'job-1', name: 'processGitHubIssue', data: issue } as any, issue as any,
        { octokit: thread.octokit, correlatedLogger: log, stateManager, taskId: 'issue-task' } as any);
    assert.equal(jobs.size, 1, 'the retry is still scheduled');
    assert.deepEqual(thread.comments, []);
});

test('cancellation notices reported by several handlers for one stop are one comment', async () => {
    const thread = fakeThread();
    const options = { octokit: thread.octokit, correlatedLogger: log, stateManager, taskId: 'issue-task', claudeResult: null, worktreeInfo: undefined, AI_PROCESSING_TAG: 'AI-processing' } as any;
    await postCancellationNotice(issue as any, options);
    await postCancellationNotice(issue as any, options);
    await postCancellationNotice(issue as any, { ...options, taskId: 'sibling-task' });
    assert.equal(thread.comments.length, 1);
    assert.match(thread.comments[0].body, /🛑 \*\*Execution Cancelled\*\*/);
    assert.match(thread.comments[0].body, /Reported 3 times/);
});

/**
 * The thread as `callers` concurrent callers see it: each caller's first read
 * of the comments is held until every caller has read, so all of them see the
 * thread without the notice and all of them post (#3689 review F2).
 */
function readBarrier(thread: ReturnType<typeof fakeThread>, callers: number) {
    let arrived = 0;
    let release!: () => void;
    const allRead = new Promise<void>(resolve => { release = resolve; });
    const heldReads = { count: 0 };
    const octokitFor = () => {
        let firstRead = true;
        return { request: (async (route: string, params: Record<string, unknown>) => {
            const response = await thread.octokit.request(route as never, params as never);
            if (route.startsWith('GET') && firstRead) {
                firstRead = false;
                heldReads.count++;
                if (++arrived === callers) release();
                await allRead;
            }
            return response;
        }) as never };
    };
    return { octokitFor, heldReads };
}

test('identical notices published concurrently, both reading before either posts, leave one notice', async () => {
    const thread = fakeThread();
    const barrier = readBarrier(thread, 3);
    const notice = { kind: 'cancelled', scope: 'issue', body: '🛑 **Execution Cancelled**' };
    const results = await Promise.all([1, 2, 3].map(() => publishRepeatedNotice(barrier.octokitFor(), target, notice, { log })));
    assert.equal(barrier.heldReads.count, 3, 'every caller read the thread before any posted');
    assert.equal(thread.routes.filter(route => route.startsWith('POST')).length, 3, 'all three posted');
    assert.equal(thread.comments.length, 1, 'the later duplicates folded into the earliest');
    assert.deepEqual(new Set(results.map(result => result.commentId)), new Set([thread.comments[0].id]));
    assert.match(thread.comments[0].body, /Reported \d times/);
});

test('concurrent attempt comments turned into the same notice leave one comment', async () => {
    const thread = fakeThread();
    const barrier = readBarrier(thread, 2);
    const notice = { kind: 'merge-conflict-failed', scope: 'sha-1', body: '❌ failed' };
    const starts = await Promise.all([1, 2].map(() =>
        thread.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { body: 'starting' }) as Promise<{ data: Comment }>));
    await Promise.all(starts.map(start => publishRepeatedNotice(barrier.octokitFor(), target, notice, { ownCommentId: start.data.id, log })));
    assert.deepEqual(thread.comments.map(comment => comment.id), [starts[0].data.id], 'the newer attempt comment was removed');
    assert.match(thread.comments[0].body, /Reported 2 times/);
    assert.doesNotMatch(thread.comments[0].body, /starting/);
});

test('a concurrent duplicate is kept when the earlier notice cannot be updated, so no notice is dropped', async () => {
    const thread = fakeThread();
    const barrier = readBarrier(thread, 2);
    const notice = { kind: 'cancelled', scope: 'issue', body: 'stopped' };
    const refusingEdits = barrier.octokitFor();
    const failing = { request: (async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('PATCH')) throw new Error('edit refused');
        return (refusingEdits as { request: (r: string, p: Record<string, unknown>) => Promise<unknown> }).request(route, params);
    }) as never };
    // The caller whose edits are refused posts second, so its comment is the newer one that would fold.
    await Promise.all([publishRepeatedNotice(barrier.octokitFor(), target, notice, { log }), publishRepeatedNotice(failing, target, notice, { log })]);
    assert.equal(thread.comments.length, 2, 'the refused fold keeps its own notice rather than deleting it');
    assert.ok(thread.comments.every(comment => comment.body.includes('stopped')));
    assert.ok(!thread.routes.includes('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}'));
});

test('sibling runs reporting one cancellation at the same time leave one notice', async () => {
    const thread = fakeThread();
    const barrier = readBarrier(thread, 2);
    const options = { correlatedLogger: log, stateManager, claudeResult: null, worktreeInfo: undefined, AI_PROCESSING_TAG: 'AI-processing' } as any;
    await Promise.all([
        postCancellationNotice(issue as any, { ...options, octokit: barrier.octokitFor(), taskId: 'issue-task' }),
        postCancellationNotice(issue as any, { ...options, octokit: barrier.octokitFor(), taskId: 'sibling-task' }),
    ]);
    assert.equal(barrier.heldReads.count, 2);
    assert.equal(thread.comments.length, 1);
    assert.match(thread.comments[0].body, /🛑 \*\*Execution Cancelled\*\*/);
    assert.match(thread.comments[0].body, /Reported 2 times/);
});

test('sibling runs hitting one usage limit at the same time leave one rate-limit notice', async () => {
    const thread = fakeThread();
    const barrier = readBarrier(thread, 2);
    const reset = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
    const limit = () => Object.assign(new Error('usage limit'), { resetTimestamp: reset, rawErrorMessage: `You've hit your limit · resets ${reset % 12}pm (UTC)` });
    await Promise.all(['issue-task', 'sibling-task'].map((taskId, index) => handleUsageLimitError(limit(),
        { id: `job-${index}`, name: 'processGitHubIssue', data: issue } as any, issue as any,
        { octokit: barrier.octokitFor(), correlatedLogger: log, stateManager, taskId } as any)));
    assert.equal(barrier.heldReads.count, 2);
    assert.equal(thread.comments.length, 1);
    assert.match(thread.comments[0].body, /⌛ \*\*Rate Limit Reached\*\*/);
    assert.match(thread.comments[0].body, /Reported 2 times/);
});


test('repository repair failures group notices and never promise automatic retry', async () => {
    const thread = fakeThread();
    let failures = 0;
    const error = Object.assign(new Error('Repository object repair required at /cache/repo: missing tree'), {
        name: 'RepositoryRepairRequiredError',
    });
    const options = {
        octokit: thread.octokit, claudeResult: null, worktreeInfo: undefined,
        correlatedLogger: log, taskId: 'repair-task', AI_PROCESSING_TAG: 'AI-processing',
        stateManager: { getTaskState: async () => ({ state: 'processing' }), markTaskFailed: async () => { failures++; } },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        await handleGenericError(error, { id: 'job' } as never, issue as never, options as never);
    }
    assert.equal(failures, 2);
    assert.equal(thread.comments.length, 1);
    assert.match(thread.comments[0].body, /Automatic retries stopped/);
    assert.doesNotMatch(thread.comments[0].body, /will automatically retry/);
});
