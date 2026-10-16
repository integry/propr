import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { runResyncGeneration } from './helpers/resumeResyncHarness.js';

// Strict PR-comment catch-up: a newly discovered gap comment counts only once
// a durable job carries it. Queue, tracking and assignment-gate failures, and
// an in-flight job that lacks the comment, fail the family; ordinary polling
// keeps its tolerant behavior.

after(async () => {
    await closeConnection();
});

type FakeJob = { id?: string; name: string; data: Record<string, unknown> };
const delayed: FakeJob[] = [];
/** Jobs the worker already finished; BullMQ keeps them, but not in the lists the enqueue scans. */
const completed: FakeJob[] = [];
const added: FakeJob[] = [];
const tracked = new Map<string, string>();
let addError: Error | null = null;
let trackingError: Error | null = null;
let gateDecision: { allowed: boolean; reason: string } = { allowed: true, reason: 'gate_disabled' };
let rememberError: Error | null = null;

const queue = {
    getActive: async () => [],
    getWaiting: async () => [],
    getDelayed: async () => delayed,
    getJob: async (id: string) => [...delayed, ...completed].find(job => job.id === id),
    add: async (name: string, data: Record<string, unknown>, opts: { jobId: string }) => {
        if (addError) throw addError;
        added.push({ id: opts.jobId, name, data });
        delayed.push({ id: opts.jobId, name, data });
    },
};

const real = await import('@propr/core') as Record<string, unknown>;
await mock.module('@propr/core', { namedExports: {
    ...real,
    getIssueQueue: async () => queue,
    filterCommentByAuthor: () => ({ shouldFilter: false }),
    checkCommentTrigger: () => ({ isTriggered: true }),
    hasValidTriggerLabel: async () => false,
    wasRefused: async () => false,
    extractLlmFromLabels: () => null,
    getSystemBotUsernames: () => [],
    isSystemFollowupComment: () => false,
    createFollowupGateEvaluator: async () => ({ decide: async () => gateDecision }),
    rememberRefusedComment: async () => { if (rememberError) throw rememberError; },
    refuseGatedComment: async () => undefined,
} });

const { pollForPullRequestComments } = await import('../src/polling/prCommentPolling.js');

/** Admission records (comment → job ID) the strict enqueue writes before adding a job. */
const admissions = new Map<string, string>();
const redisClient = {
    get: async (key: string) => tracked.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map(key => admissions.get(key) ?? null),
    pipeline: () => {
        const entries: Array<[string, string]> = [];
        return {
            setex: (key: string, _ttl: number, value: string) => { entries.push([key, value]); },
            exec: async () => entries.map(([key, value]) => {
                if (key.startsWith('pr-comment-admitted:')) {
                    admissions.set(key, value);
                    return [null, 'OK'];
                }
                if (trackingError) return [trackingError, null];
                tracked.set(key, '1');
                return [null, 'OK'];
            }),
        };
    },
} as never;

/** The worker finishes every queued job. */
function completeQueuedJobs(): void {
    completed.push(...delayed.splice(0));
}

const octokit = {
    paginate: async (endpoint: string) => {
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls') return [{ number: 5, title: 'Feature', labels: [], head: { ref: 'feature', sha: 'abc' } }];
        if (endpoint.includes('/issues/{issue_number}/comments')) {
            return [{ id: 101, body: '@propr please fix', user: { id: 9, login: 'alice' }, created_at: '2026-10-11T00:00:00Z' }];
        }
        return [];
    },
};

function poll(strict: boolean) {
    return pollForPullRequestComments(octokit as never, 'acme/widgets', 'resync', {
        redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: [], MODEL_LABEL_PATTERN: '^llm-(.+)$',
        throwOnError: strict, skipUltrafixReconcile: true, createdSince: '2026-10-10T00:00:00.000Z',
    });
}

const trackingKey = 'pr-comment-processed:acme:widgets:5:101';

beforeEach(() => {
    delayed.length = 0; completed.length = 0; added.length = 0; tracked.clear(); admissions.clear();
    addError = null; trackingError = null; rememberError = null;
    gateDecision = { allowed: true, reason: 'gate_disabled' };
});

test('a strict poll queues the gap comment, then marks it processed', async () => {
    await poll(true);
    assert.deepEqual(added.map(job => (job.data.comments as Array<{ id: number }>).map(comment => comment.id)), [[101]]);
    assert.ok(tracked.has(trackingKey));
});

test('an enqueue failure propagates in strict mode and never marks the comment processed', async () => {
    addError = new Error('redis queue unavailable');
    await poll(false); // ordinary polling logs and retries next poll
    await assert.rejects(poll(true), /redis queue unavailable/);
    assert.equal(tracked.has(trackingKey), false);
});

test('an in-flight job that does not carry the new comment leaves the family partial', async () => {
    delayed.push({ name: 'processPullRequestComment', data: { pullRequestNumber: 5, repoOwner: 'acme', repoName: 'widgets', comments: [{ id: 77 }] } });
    await poll(false);
    assert.deepEqual(added, [], 'ordinary polling waits for the in-flight job');
    await assert.rejects(poll(true), /does not carry 1 newly discovered comment/);
    assert.equal(tracked.has(trackingKey), false);

    // Once the in-flight job carries it, the comment is durably covered.
    delayed[0].data.comments = [{ id: 77 }, { id: 101 }];
    await poll(true);
    assert.deepEqual(added, []);
    assert.ok(tracked.has(trackingKey));
});

test('a tracking-write failure propagates; the retry finds the queued job and completes', async () => {
    trackingError = new Error('OOM command not allowed');
    await assert.rejects(poll(true), /Failed to record 1 processed PR comment marker/);
    assert.equal(added.length, 1, 'the job obligation was durable before tracking');
    trackingError = null;
    await poll(true);
    assert.equal(added.length, 1, 'no duplicate job');
    assert.ok(tracked.has(trackingKey));
});

test('a job the worker completes after a tracking-write failure is not admitted twice on retry', async () => {
    trackingError = new Error('OOM command not allowed');
    await assert.rejects(poll(true), /Failed to record 1 processed PR comment marker/);
    completeQueuedJobs();
    trackingError = null;
    await poll(true);
    assert.equal(added.length, 1, 'the completed first admission still covers the comment');
    assert.ok(tracked.has(trackingKey));
});

test('a recorded admission whose job never reached the queue is admitted again', async () => {
    addError = new Error('redis queue unavailable');
    await assert.rejects(poll(true), /redis queue unavailable/);
    assert.ok(admissions.has('pr-comment-admitted:acme:widgets:5:101'), 'recorded before the add');
    addError = null;
    await poll(true);
    assert.deepEqual(added.map(job => (job.data.comments as Array<{ id: number }>).map(comment => comment.id)), [[101]]);
    assert.ok(tracked.has(trackingKey));
});

test('an unreadable assignment gate or unrecorded refusal fails a strict poll', async () => {
    gateDecision = { allowed: false, reason: 'assignment_unavailable' };
    await poll(false);
    await assert.rejects(poll(true), /assignment for PR #5 is unavailable/);
    gateDecision = { allowed: false, reason: 'author_not_assigned' };
    rememberError = new Error('redis write failed');
    await poll(false);
    await assert.rejects(poll(true), /redis write failed/);
    assert.deepEqual(added, []);
});

test('a lossy pull_request_comments family never emits resync_complete', async () => {
    for (const fault of [
        () => { addError = new Error('redis queue unavailable'); },
        () => { delayed.push({ name: 'processPullRequestComment', data: { pullRequestNumber: 5, repoOwner: 'acme', repoName: 'widgets', comments: [] } }); },
        () => { trackingError = new Error('OOM command not allowed'); },
    ]) {
        delayed.length = 0; addError = null; trackingError = null;
        fault();
        const result = await runResyncGeneration({ steps: { pull_request_comments: async () => { await poll(true); } } });
        assert.equal(result.state, 'failed');
        assert.deepEqual(result.completions, []);
    }
});
