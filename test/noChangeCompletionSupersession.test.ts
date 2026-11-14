import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';
import { createNoChangeCompletionStoreDouble } from './fixtures/noChangeCompletionStoreDouble.js';

/**
 * Renewed work admitted while an older no-change completion is mid-flight owns
 * the issue from then on: an overtaken admission never deletes its record, and
 * an older settlement never removes its trigger labels.
 */
const redisClient = createNoChangeCompletionStoreDouble();
const requestKey = 'issue:no-change-request:acme/repo#10:AI';

let liveLabels: string[] = [];
/** Runs once GitHub has applied the matching label mutation, before its response resumes the caller. */
let afterLabelMutation: ((route: string, label: string) => Promise<void>) | undefined;
/** Runs while the status finalization awaits one of its plan lookups, including the writer's own. */
let duringPlanLookup: ((lookup: 'plan-issue' | 'queue' | 'status-writer') => Promise<void>) | undefined;
const comments: string[] = [];
const statusWrites: Array<[string, number, string]> = [];
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        if (route.endsWith('/labels')) {
            for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label);
            for (const label of body.labels as string[]) await afterLabelMutation?.(route, label);
            return { data: {} };
        }
        if (route.startsWith('DELETE ')) {
            liveLabels = liveLabels.filter(label => label !== body.name);
            await afterLabelMutation?.(route, String(body.name));
            return { data: {} };
        }
        if (route.startsWith('GET ') && route.endsWith('/comments')) return { data: [] };
        if (route.endsWith('/comments')) { comments.push(String(body.body)); return { data: {} }; }
        throw new Error(`Unexpected route ${route}`);
    },
};

await mock.module('@propr/core', {
    namedExports: {
        getEpicExecutionQueue: mock.fn(async () => {
            await duringPlanLookup?.('queue');
            return { status: 'active', issues: [10, 20], items: [{ issueNumber: 10, state: 'dispatched' }, { issueNumber: 20, state: 'pending' }] };
        }),
        findPlanIssueByRepoAndNumber: mock.fn(async () => {
            await duringPlanLookup?.('plan-issue');
            return { draft_id: 'draft', issue_number: 10, status: 'processing' };
        }),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        safeUpdateLabels,
        // Mirrors the real writer: it awaits its own lookup, then evaluates the caller's guard before updating.
        updatePlanIssueStatus: mock.fn(async (repository: string, issueNumber: number, status: string,
            { stillApplies }: { stillApplies?: () => Promise<boolean> } = {}) => {
            await duringPlanLookup?.('status-writer');
            if (stillApplies && !await stillApplies()) return false;
            statusWrites.push([repository, issueNumber, status]);
            return true;
        }),
        PlanIssueStatus: { MERGED: 'merged' },
    },
});
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient } });

const obligations = await import('../src/jobs/noChangeCompletionObligation.js');
const { completeNoChangeIssue, replayNoChangeCompletion } = await import('../src/jobs/noChangeCompletion.js');
const issue = { repoOwner: 'acme', repoName: 'repo', number: 10 } as never;
const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
const store = redisClient as never;

beforeEach(() => {
    redisClient.clear(); comments.length = 0; statusWrites.length = 0;
    liveLabels = ['AI', 'AI-processing']; afterLabelMutation = undefined; duringPlanLookup = undefined;
});

const retain = (requestId: string, comment: string | undefined = 'No code changes needed') => obligations.retainNoChangeCompletion(issue, {
    retainedAt: 0, requestId, triggeringLabel: 'AI', processingTag: 'AI-processing', doneTag: 'AI-done', labels: ['AI', 'auto-merge'], comment,
}, store);

/** The user removes the done marker and reapplies the trigger; the worker admits request B, which marks itself processing. */
async function renewAsRequestB() {
    liveLabels = [...liveLabels.filter(label => label !== 'AI-done' && label !== 'AI'), 'AI'];
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-b', triggeringLabel: 'AI' }, store);
    if (!liveLabels.includes('AI-processing')) liveLabels.push('AI-processing');
}

test('an admission overtaken while reading never deletes the newer request\'s completion', async () => {
    await retain('request-old');
    let interleaved = false;
    // Request A has written its request key and is awaiting the hash read when B is admitted, runs and retains its completion.
    const pausingStore = {
        ...redisClient,
        hgetall: async (key: string) => {
            if (!interleaved) {
                interleaved = true;
                await obligations.admitNoChangeRequest(issue, { requestId: 'request-b', triggeringLabel: 'AI' }, store);
                await retain('request-b');
            }
            return redisClient.hgetall(key);
        },
    };
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, pausingStore as never), 0);
    assert.equal(redisClient.strings.get(requestKey), 'request-b');
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-b'],
        'B\'s owed completion survives; the old one was dropped by B\'s own admission');
});

test('admission still drops completions of older requests while it owns the request key', async () => {
    await retain('request-old');
    await retain('request-a');
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, store), 1);
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-a']);
});

test('a replay superseded after publishing the done marker leaves the renewed trigger in place', async () => {
    await redisClient.set(requestKey, 'request-old');
    const held = await retain('request-old');
    liveLabels = ['AI', 'AI-processing', 'AI-done'];
    afterLabelMutation = async (route, label) => {
        if (route.endsWith('/labels') && label === 'AI-done') { afterLabelMutation = undefined; await renewAsRequestB(); }
    };
    const labels = await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI', 'AI-done'],
        held, correlatedLogger: log, store });
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-processing'], 'B keeps its trigger and processing labels');
    assert.deepEqual(labels, ['AI', 'AI-done'], 'the replay does not report the trigger released');
    assert.deepEqual(comments, []);
    assert.deepEqual(statusWrites, []);
});

test('a replay superseded between trigger removals stops before the next one', async () => {
    await redisClient.set(requestKey, 'request-old');
    const held = await retain('request-old');
    liveLabels = ['AI', 'AI-processing', 'AI-done'];
    afterLabelMutation = async (route, label) => {
        if (route.startsWith('DELETE ') && label === 'AI') { afterLabelMutation = undefined; await renewAsRequestB(); }
    };
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log, store });
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-processing']);
    assert.deepEqual(comments, []);
    assert.deepEqual(statusWrites, []);
});

test('a replay whose record admission dropped before the comment claim abandons settlement', async () => {
    await redisClient.set(requestKey, 'request-old');
    const held = await retain('request-old');
    liveLabels = ['AI', 'AI-processing', 'AI-done'];
    afterLabelMutation = async (route, label) => {
        if (route.startsWith('DELETE ') && label === 'AI-processing') { afterLabelMutation = undefined; await renewAsRequestB(); }
    };
    const labels = await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI', 'AI-done'],
        held, correlatedLogger: log, store });
    assert.deepEqual(labels, ['AI', 'AI-done'], 'a superseded settlement does not claim it released B\'s labels');
    assert.deepEqual(comments, []);
    assert.deepEqual(statusWrites, []);
    assert.equal(redisClient.records().length, 0);
});

test('an initial no-change settlement superseded after publishing keeps its hands off the renewed trigger', async () => {
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-old', triggeringLabel: 'AI' }, store);
    afterLabelMutation = async (route, label) => {
        if (route.endsWith('/labels') && label === 'AI-done') { afterLabelMutation = undefined; await renewAsRequestB(); }
    };
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: { ...(issue as object), correlationId: 'request-old' } as never,
        labels: ['AI', 'auto-merge'], comment: 'old report', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-processing']);
    assert.deepEqual(comments, []);
    assert.deepEqual(statusWrites, []);
    assert.equal(redisClient.records().length, 0);
});

test('an unsuperseded settlement still releases both trigger labels and finishes', async () => {
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-old', triggeringLabel: 'AI' }, store);
    await completeNoChangeIssue({ octokit: octokit as never, issueRef: { ...(issue as object), correlationId: 'request-old' } as never,
        labels: ['AI', 'auto-merge'], comment: 'old report', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log });
    assert.deepEqual(liveLabels, ['AI-done']);
    assert.equal(comments.length, 1);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(redisClient.records().length, 0);
});

for (const lookup of ['plan-issue', 'queue', 'status-writer'] as const) {
    test(`renewed work admitted during the ${lookup} lookup is never marked merged by the older completion`, async () => {
        await redisClient.set(requestKey, 'request-old');
        // The labels are already settled; the replay delivers the comment, then reaches the status write.
        const held = await retain('request-old');
        liveLabels = ['AI-done'];
        duringPlanLookup = async current => {
            if (current === lookup) { duringPlanLookup = undefined; await renewAsRequestB(); }
        };
        await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: log, store });
        assert.deepEqual(statusWrites, [], 'request B\'s implementation is not marked merged, so its successor is not released');
        assert.equal(redisClient.strings.get(requestKey), 'request-b');
        assert.equal(redisClient.records().length, 0, 'the superseded completion owes nothing further');
    });
}

test('queued work under another trigger keeps the interrupted completion of an independent trigger', async () => {
    // AI published AI-done and released its trigger, but its comment failed: the comment and status write stay owed.
    const owed = await retain('request-ai');
    liveLabels = ['AI-done', 'Assistant', 'auto-merge'];
    // The already-queued Assistant worker passes its own label check and is admitted under a different request.
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-assistant', triggeringLabel: 'Assistant' }, store), 0);
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-ai'], 'the AI completion survives');
    assert.equal(redisClient.strings.get(requestKey), undefined, 'the AI request generation is untouched');
    assert.equal(redisClient.strings.get('issue:no-change-request:acme/repo#10:Assistant'), 'request-assistant');

    // Recovery still delivers the AI report and settles its status obligation.
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: [...liveLabels], held: owed,
        correlatedLogger: log, store });
    assert.deepEqual(comments.map(body => body.split('\n')[0]), ['No code changes needed']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.deepEqual(liveLabels.sort(), ['AI-done', 'Assistant', 'auto-merge'], 'the Assistant trigger stays with its own work');
    assert.equal(redisClient.records().length, 0);
});

test('an independent trigger\'s completion keeps answering its own request after another trigger is admitted', async () => {
    await redisClient.set(requestKey, 'request-ai');
    const owed = await retain('request-ai');
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-assistant', triggeringLabel: 'Assistant' }, store);
    assert.equal(await obligations.isCurrentNoChangeRequest(issue, owed.record, store), true);
    assert.equal(await obligations.noChangeCompletionStillApplies(issue, owed, store), true);
});

test('a legacy completion without a trigger is superseded only by its fallback trigger\'s renewed work', async () => {
    // Jobs without triggeringLabel derive their tags from the configured fallback trigger.
    await obligations.retainNoChangeCompletion(issue, {
        retainedAt: 0, requestId: 'request-legacy', processingTag: 'AI-processing', doneTag: 'AI-done', labels: ['AI'], comment: 'x',
    }, store);
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-assistant', triggeringLabel: 'Assistant' }, store), 0);
    assert.equal(redisClient.records().length, 1);
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-renewed', triggeringLabel: 'AI' }, store), 1);
    assert.equal(redisClient.records().length, 0);
});

test('an older request admitted after a newer one keeps neither the generation nor the newer request\'s completion', async () => {
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, store);
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-b', triggeringLabel: 'AI' }, store);
    const owedByB = await retain('request-b');
    // A's delayed sibling, or a retry of it under the same correlation ID, is admitted again.
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, store), 0);
    assert.equal(redisClient.strings.get(requestKey), 'request-b');
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-b']);
    assert.equal(await obligations.noChangeCompletionStillApplies(issue, owedByB, store), true);
    // The newer request's own siblings are still admitted and still drop truly older completions.
    await retain('request-a');
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-b', triggeringLabel: 'AI' }, store), 1);
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-b']);
});

test('a request ordered at dispatch stays older even when all its jobs are admitted after a newer request', async () => {
    assert.equal(await obligations.registerNoChangeRequest(issue, 'request-a', store), 1);
    assert.equal(await obligations.registerNoChangeRequest(issue, 'request-b', store), 2);
    assert.equal(await obligations.registerNoChangeRequest(issue, 'request-a', store), 1, 'a retried dispatch keeps its place');
    await obligations.admitNoChangeRequest(issue, { requestId: 'request-b', triggeringLabel: 'AI' }, store);
    await retain('request-b');
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, store), 0);
    assert.equal(redisClient.strings.get(requestKey), 'request-b');
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-b']);
});

test('admission cleanup never drops a completion of a request ordered after the admitting one', async () => {
    // A legacy generation holder without an ordinal is replaced by A; B was dispatched later and already retained a record.
    await redisClient.set(requestKey, 'request-legacy');
    await obligations.registerNoChangeRequest(issue, 'request-a', store);
    await obligations.registerNoChangeRequest(issue, 'request-b', store);
    await retain('request-b');
    await retain('request-legacy');
    assert.equal(await obligations.admitNoChangeRequest(issue, { requestId: 'request-a', triggeringLabel: 'AI' }, store), 1);
    assert.deepEqual(redisClient.records().map(record => record.requestId), ['request-b'], 'only the unordered legacy record is dropped');
});
