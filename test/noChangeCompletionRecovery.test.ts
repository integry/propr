import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';
import { createNoChangeCompletionStoreDouble } from './fixtures/noChangeCompletionStoreDouble.js';

/**
 * Retained no-change completions expire, post their comment at most once
 * across concurrent settlers, and are replayed by the recovery sweep without
 * another job for the issue having to arrive.
 */
const redisClient = createNoChangeCompletionStoreDouble();
const owedCount = () => redisClient.records().length;

let liveLabels: string[] = [];
let commentGate: Promise<void> | undefined;
let failComment = false;
let failStatusWrite = false;
const comments: string[] = [];
/** Comments GitHub accepted, even when the POST's response was lost. */
const delivered: string[] = [];
let loseCommentResponse = false;
const statusWrites: Array<[string, number, string]> = [];
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { labels: liveLabels.map(name => ({ name })) } };
        if (route.endsWith('/labels')) { for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label); return { data: {} }; }
        if (route.startsWith('DELETE ')) { liveLabels = liveLabels.filter(label => label !== body.name); return { data: {} }; }
        if (route.startsWith('GET ') && route.endsWith('/comments')) return { data: delivered.map(text => ({ body: text })) };
        if (route.endsWith('/comments')) {
            await commentGate;
            if (failComment) throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
            delivered.push(String(body.body));
            if (loseCommentResponse) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            comments.push(String(body.body).replace(/\n\n<!-- propr-no-change-completion:[^>]+ -->$/u, ''));
            return { data: {} };
        }
        throw new Error(`Unexpected route ${route}`);
    },
};

await mock.module('@propr/core', {
    namedExports: {
        getEpicExecutionQueue: mock.fn(async () => ({ status: 'active', issues: [10, 20] })),
        findPlanIssueByRepoAndNumber: mock.fn(async () => ({ draft_id: 'draft', issue_number: 10, status: 'processing' })),
        getAuthenticatedOctokit: mock.fn(async () => octokit),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        safeUpdateLabels,
        updatePlanIssueStatus: mock.fn(async (repository: string, issueNumber: number, status: string) => {
            if (failStatusWrite) throw new Error('database unavailable');
            statusWrites.push([repository, issueNumber, status]);
        }),
        PlanIssueStatus: { MERGED: 'merged' },
    },
});
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient } });

const obligations = await import('../src/jobs/noChangeCompletionObligation.js');
const { completeNoChangeIssue, replayNoChangeCompletion } = await import('../src/jobs/noChangeCompletion.js');
const { recoverNoChangeCompletions } = await import('../src/jobs/noChangeCompletionRecovery.js');
const issue = { repoOwner: 'acme', repoName: 'repo', number: 10 } as never;
const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
const key = 'issue:no-change-completions:acme/repo#10';
const owed = async () => obligations.readNoChangeCompletions(issue, redisClient as never);

beforeEach(() => {
    redisClient.clear(); comments.length = 0; delivered.length = 0; statusWrites.length = 0;
    liveLabels = ['AI', 'AI-processing']; commentGate = undefined; failComment = false; failStatusWrite = false; loseCommentResponse = false;
});

function retainPublished(retainedAt = 0, extra: { requestId?: string; comment?: string } = {}) {
    liveLabels = ['AI-done'];
    return obligations.retainNoChangeCompletion(issue, {
        retainedAt, triggeringLabel: 'AI', processingTag: 'AI-processing', doneTag: 'AI-done', labels: ['AI', 'auto-merge'],
        comment: 'No code changes needed', ...extra,
    });
}
const replay = (held: Awaited<ReturnType<typeof retainPublished>>, now?: () => number) =>
    replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log, now });

test('retained records and every rewrite of them carry an expiry', async () => {
    failStatusWrite = true;
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: issue, labels: ['AI', 'auto-merge'], comment: 'done',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.equal(owedCount(), 1, 'the status write is still owed');
    assert.equal(redisClient.ttls.get(key), obligations.NO_CHANGE_COMPLETION_TTL_SECONDS);
    assert.ok(obligations.NO_CHANGE_COMPLETION_TTL_SECONDS > 0);
});

test('two settlers holding the same record post the completion comment once', async () => {
    const held = await retainPublished();
    let release!: () => void;
    commentGate = new Promise(resolve => { release = resolve; });
    const first = replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log });
    const second = replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(comments, ['No code changes needed']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(owedCount(), 0);
});

test('a failed comment post hands the comment back for a later replay', async () => {
    const held = await retainPublished();
    failComment = true;
    await assert.rejects(replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log }), /GitHub unavailable/);
    const [kept] = await owed();
    assert.equal(kept?.record.comment, 'No code changes needed');
    assert.equal(kept?.record.commentClaim, undefined, 'the failed claimant released its claim');
    assert.deepEqual(statusWrites, []);

    failComment = false;
    await replay(kept!);
    assert.deepEqual(comments, ['No code changes needed']);
    assert.equal(owedCount(), 0);
});

test('recovery replays an owed status write with no further job for the issue', async () => {
    failStatusWrite = true;
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: issue, labels: ['AI', 'auto-merge'], comment: 'done',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.deepEqual(liveLabels, ['AI-done'], 'the original job succeeded and released its trigger');
    assert.deepEqual(comments, ['done']);
    assert.equal(owedCount(), 1);

    failStatusWrite = false;
    const retainedAt = redisClient.records()[0].retainedAt as number;
    // A fresh record still belongs to its run.
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => retainedAt + 1000, log }), 0);
    assert.deepEqual(statusWrites, []);

    const later = () => retainedAt + 60 * 60 * 1000;
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: later, log }), 1);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.deepEqual(comments, ['done'], 'the posted comment is not repeated');
    assert.equal(owedCount(), 0);
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: later, log }), 0);
});

test('recovery finishes trigger cleanup and the comment, but leaves unpublished records alone', async () => {
    await retainPublished();
    liveLabels = ['AI', 'AI-done'];
    await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now(), log });
    assert.deepEqual(liveLabels, ['AI-done']);
    assert.deepEqual(comments, ['No code changes needed']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);

    await obligations.retainNoChangeCompletion(issue, { retainedAt: 0, processingTag: 'AI-processing', doneTag: 'AI-done', labels: [], comment: 'x' });
    liveLabels = ['AI', 'AI-processing'];
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, log }), 0);
    assert.equal(owedCount(), 1, 'never published, so its own run or the expiry owns it');
    assert.deepEqual(comments, ['No code changes needed']);
});

test('completion keys map back to their issue', () => {
    assert.deepEqual(obligations.issueForCompletionKey('issue:no-change-completions:my-org/repo.name#42'),
        { repoOwner: 'my-org', repoName: 'repo.name', number: 42 });
    assert.equal(obligations.issueForCompletionKey('issue:other:acme/repo#1'), null);
});

test('a settler reading the record while another posts its comment neither finalizes it nor loses the comment', async () => {
    await retainPublished();
    let release!: () => void;
    commentGate = new Promise(resolve => { release = resolve; });
    failComment = true;
    const [original] = await owed();
    const first = replay(original);
    // Wait until the first settler's claim is in Redis, then read the record as a fresh retry would.
    while (!(await owed())[0]?.record.commentClaim) await new Promise(resolve => setImmediate(resolve));
    const [claimed] = await owed();
    assert.equal(claimed.record.comment, 'No code changes needed', 'the claimed comment stays in the record');
    await replay(claimed);
    assert.deepEqual(statusWrites, [], 'a live claim keeps another settler from finalizing');
    assert.equal(owedCount(), 1);

    release();
    await assert.rejects(first, /GitHub unavailable/);
    assert.equal(owedCount(), 1, 'the failed post leaves the comment owed');
    failComment = false;
    await replay((await owed())[0]);
    assert.deepEqual(comments, ['No code changes needed']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(owedCount(), 0);
});

test('a claimant that dies mid-post is taken over after its claim expires, reconciling by marker', async () => {
    const held = await retainPublished();
    // The post reaches GitHub, but the claimant never learns it (lost response, then a crash).
    loseCommentResponse = true;
    await assert.rejects(replay(held), /socket hang up/);
    loseCommentResponse = false;
    assert.equal(delivered.length, 1);
    const [afterLoss] = await owed();
    assert.equal(afterLoss.record.comment, 'No code changes needed');
    assert.equal(afterLoss.record.commentAttempted, true);
    // Simulate the crash variant too: a claim left behind that nobody released.
    const stranded = await obligations.replaceNoChangeCompletion(afterLoss,
        { ...afterLoss.record, commentClaim: { token: 'dead', expiresAt: Date.now() + 60_000 } }, redisClient as never);
    assert.ok(stranded);

    // While the claim is live, recovery leaves it alone.
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now(), graceMs: 0, log }), 1);
    assert.deepEqual(statusWrites, []);
    assert.equal(owedCount(), 1);

    // After expiry the next settler finds the marked comment and finishes without reposting.
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now() + 10 * 60_000, graceMs: 0, log }), 1);
    assert.equal(delivered.length, 1, 'the comment is not posted twice');
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(owedCount(), 0);
});

test('an expired claim whose post never reached GitHub is posted by the next settler', async () => {
    const held = await retainPublished();
    const stranded = await obligations.replaceNoChangeCompletion(held,
        { ...held.record, commentClaim: { token: 'dead', expiresAt: 1 }, commentAttempted: true }, redisClient as never);
    await replay(stranded!);
    assert.deepEqual(comments, ['No code changes needed']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(owedCount(), 0);
});

test('two independently retained no-change completions of one issue both deliver their comments', async () => {
    const produce = (comment: string) => completeNoChangeIssue({
        octokit: octokit as never, issueRef: { ...(issue as object), correlationId: 'request-1' } as never, labels: ['AI', 'auto-merge'], comment,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log,
    });
    let release!: () => void;
    commentGate = new Promise(resolve => { release = resolve; });
    const first = produce('model A report');
    const second = produce('model B report');
    await new Promise(resolve => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    assert.deepEqual(comments.sort(), ['model A report', 'model B report']);
    assert.equal(owedCount(), 0);
});

test('a completion superseded by renewed work never finishes the newer request', async () => {
    failStatusWrite = true;
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: { ...(issue as object), correlationId: 'old-request' } as never,
        labels: ['AI', 'auto-merge'], comment: 'old report', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    failStatusWrite = false;
    assert.equal(owedCount(), 1, 'the old status write is owed');

    // The user removes AI-done and reapplies AI; the worker admits the new request.
    liveLabels = ['AI', 'auto-merge'];
    assert.equal(await obligations.admitNoChangeRequest(issue, 'new-request', redisClient as never), 1);
    assert.equal(owedCount(), 0, 'admission drops the superseded completion');

    // The new run opens a PR and publishes AI-done; recovery has nothing old to replay.
    liveLabels = ['AI-done', 'auto-merge'];
    await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now() + 60 * 60_000, log });
    assert.deepEqual(statusWrites, []);
});

test('replay re-checks the request generation before writing status', async () => {
    // A record read before admission: its request was superseded after the read.
    const held = await retainPublished(0, { requestId: 'old-request', comment: undefined });
    await redisClient.set('issue:no-change-request:acme/repo#10', 'new-request');
    liveLabels = ['AI', 'AI-done'];
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now(), log }), 1);
    assert.deepEqual(statusWrites, [], 'the old completion must not mark the newer work merged');
    assert.deepEqual(liveLabels, ['AI', 'AI-done'], 'nor touch the newer run\'s labels');
    assert.equal(owedCount(), 0);
    void held;

    // The current request's own completion still settles.
    const current = await retainPublished(0, { requestId: 'new-request' });
    await replay(current);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
});
