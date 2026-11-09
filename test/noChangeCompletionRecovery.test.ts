import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';

/**
 * Retained no-change completions expire, post their comment at most once
 * across concurrent settlers, and are replayed by the recovery sweep without
 * another job for the issue having to arrive.
 */
const store = new Map<string, string>();
const ttls = new Map<string, number>();
const redisClient = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, mode?: string, seconds?: number) => {
        store.set(key, value);
        if (mode === 'EX') ttls.set(key, Number(seconds)); else ttls.delete(key);
        return 'OK';
    },
    eval: async (_script: string, _keys: number, key: string, expected: string, next: string, seconds: number) => {
        if (store.get(key) !== expected) return 0;
        if (next === '') { store.delete(key); ttls.delete(key); } else { store.set(key, next); ttls.set(key, Number(seconds)); }
        return 1;
    },
    scan: async (cursor: string, _match: string, pattern: string) => {
        assert.equal(cursor, '0');
        const prefix = pattern.replace(/\*$/u, '');
        return ['0', [...store.keys()].filter(key => key.startsWith(prefix))] as [string, string[]];
    },
};

let liveLabels: string[] = [];
let commentGate: Promise<void> | undefined;
let failComment = false;
let failStatusWrite = false;
const comments: string[] = [];
const statusWrites: Array<[string, number, string]> = [];
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { labels: liveLabels.map(name => ({ name })) } };
        if (route.endsWith('/labels')) { for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label); return { data: {} }; }
        if (route.startsWith('DELETE ')) { liveLabels = liveLabels.filter(label => label !== body.name); return { data: {} }; }
        if (route.endsWith('/comments')) {
            await commentGate;
            if (failComment) throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
            comments.push(String(body.body));
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
const key = 'issue:no-change-completion:acme/repo#10';

beforeEach(() => {
    store.clear(); ttls.clear(); comments.length = 0; statusWrites.length = 0;
    liveLabels = ['AI', 'AI-processing']; commentGate = undefined; failComment = false; failStatusWrite = false;
});

function retainPublished(retainedAt = 0) {
    liveLabels = ['AI-done'];
    return obligations.retainNoChangeCompletion(issue, {
        retainedAt, triggeringLabel: 'AI', processingTag: 'AI-processing', doneTag: 'AI-done', labels: ['AI', 'auto-merge'], comment: 'No code changes needed',
    });
}

test('retained records and every rewrite of them carry an expiry', async () => {
    failStatusWrite = true;
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: issue, labels: ['AI', 'auto-merge'], comment: 'done',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.ok(store.has(key), 'the status write is still owed');
    assert.equal(ttls.get(key), obligations.NO_CHANGE_COMPLETION_TTL_SECONDS);
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
    assert.equal(store.size, 0);
});

test('a failed comment post hands the comment back for a later replay', async () => {
    const held = await retainPublished();
    failComment = true;
    await assert.rejects(replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log }), /GitHub unavailable/);
    const owed = await obligations.readNoChangeCompletion(issue);
    assert.equal(owed?.record.comment, 'No code changes needed');
    assert.deepEqual(statusWrites, []);

    failComment = false;
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held: owed!, correlatedLogger: log });
    assert.deepEqual(comments, ['No code changes needed']);
    assert.equal(store.size, 0);
});

test('recovery replays an owed status write with no further job for the issue', async () => {
    failStatusWrite = true;
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: issue, labels: ['AI', 'auto-merge'], comment: 'done',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.deepEqual(liveLabels, ['AI-done'], 'the original job succeeded and released its trigger');
    assert.deepEqual(comments, ['done']);
    assert.ok(store.has(key));

    failStatusWrite = false;
    const retainedAt = JSON.parse(store.get(key)!).retainedAt as number;
    // A fresh record still belongs to its run.
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => retainedAt + 1000, log }), 0);
    assert.deepEqual(statusWrites, []);

    const later = () => retainedAt + 60 * 60 * 1000;
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: later, log }), 1);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.deepEqual(comments, ['done'], 'the posted comment is not repeated');
    assert.equal(store.size, 0);
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
    assert.ok(store.has(key), 'never published, so its own run or the expiry owns it');
    assert.deepEqual(comments, ['No code changes needed']);
});

test('completion keys map back to their issue', () => {
    assert.deepEqual(obligations.issueForCompletionKey('issue:no-change-completion:my-org/repo.name#42'),
        { repoOwner: 'my-org', repoName: 'repo.name', number: 42 });
    assert.equal(obligations.issueForCompletionKey('issue:other:acme/repo#1'), null);
});
