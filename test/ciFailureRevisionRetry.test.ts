/**
 * A CI-failure comment stays work until a run of its current revision ends
 * it. The worker's validation (validatePRAndComments) reads the comment and
 * the pull request's receipts, asks which CI-failure comments the receipts
 * must not decide, filters, and records the revisions it takes; `validate`
 * below is that sequence.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { filterUnprocessedComments, validateAndFilterComments } from '../src/jobs/prCommentJobHelpers.js';
import { consumedCiFailureRevisionKey, recordConsumedCiFailureRevisions, unconsumedCiFailureRevisions } from '../src/jobs/ciFailureCommentPickup.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

const BOT = 'propr-dev[bot]';
const CI_COMMENT_ID = 7001;
const pr = { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 42 };
const log = { info() {}, warn() {}, debug() {}, error() {} } as never;
const marker = `<!-- propr:ci-failure-followup key="${'c'.repeat(64)}" -->`;

interface GitHubComment { id: number; body: string; updated_at: string; user: { login: string } }

function ciComment(checks: string[], updatedAt: string): GitHubComment {
    return { id: CI_COMMENT_ID, body: `CI failed: ${checks.map(check => `**${check}**`).join(', ')}\n\n${marker}`, updated_at: updatedAt, user: { login: BOT } };
}

/** The starting comment of a run; a usage-limit retry leaves it as it is. */
function startingReceipt(id: number): GitHubComment {
    return {
        id, user: { login: BOT }, updated_at: '2026-11-17T09:00:00Z',
        body: `🔨 Working on it\n\n---\nComment ID: ${CI_COMMENT_ID}✓\n<!-- propr:work-evidence phase=started trigger-comment-ids=${CI_COMMENT_ID} -->`,
    };
}

/** The same comment once its run ended. */
function endedReceipt(id: number, phase: 'completed' | 'failed'): GitHubComment {
    return {
        id, user: { login: BOT }, updated_at: '2026-11-17T09:30:00Z',
        body: `${phase === 'completed' ? '✅ Fixed' : '❌ Failed'}\n\n---\nComment ID: ${CI_COMMENT_ID}✓\n<!-- propr:work-evidence phase=${phase} trigger-comment-ids=${CI_COMMENT_ID} -->`,
    };
}

function memoryRedis() {
    const store = new Map<string, string>();
    return {
        store,
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    };
}

type Redis = ReturnType<typeof memoryRedis>;

/** The worker's validation of a queued job naming the CI comment, against GitHub as it is now. */
async function validate(redis: Redis, queuedBody: string, gitHub: readonly GitHubComment[]): Promise<string[]> {
    const queued = [{ id: CI_COMMENT_ID, author: BOT, body: queuedBody, type: 'issue' as const }];
    const validated = await validateAndFilterComments(queued, [...gitHub], pr.pullRequestNumber, log);
    const revisions = { current: gitHub, receipts: { comments: gitHub, botUsername: BOT } };
    const unconsumedRevisionIds = await unconsumedCiFailureRevisions(redis, pr, { ...revisions, comments: queued, correlatedLogger: log });
    const toRun = filterUnprocessedComments(validated, gitHub as never, BOT, { pullRequestNumber: pr.pullRequestNumber, correlatedLogger: log, unconsumedRevisionIds });
    if (toRun.length > 0) await recordConsumedCiFailureRevisions(redis, pr, { ...revisions, comments: toRun });
    return toRun.map(comment => comment.body);
}

describe('CI-failure revision retry (F11)', () => {
    test('a usage-limit retry of a later revision runs it, though an earlier revision has a completion receipt', async () => {
        const redis = memoryRedis();
        const revisionA = ciComment(['Lint'], '2026-11-17T08:00:00Z');
        const queuedA = 'CI failed: **Lint**';

        // A run takes revision A and completes it.
        assert.deepStrictEqual(await validate(redis, queuedA, [revisionA]), [queuedA]);
        const completionA = endedReceipt(9001, 'completed');

        // Another failure edits the comment into revision B; the next job runs it.
        const revisionB = ciComment(['Lint', 'Typecheck'], '2026-11-17T08:30:00Z');
        const [runB] = await validate(redis, queuedA, [revisionB, completionA]);
        assert.match(runB, /Lint.*Typecheck/);

        // That run reaches a usage limit: its starting comment stays, and a retry is scheduled.
        const startedB = startingReceipt(9002);
        const retry = await validate(redis, queuedA, [revisionB, completionA, startedB]);
        assert.strictEqual(retry.length, 1, 'the retry runs revision B; A\'s completion receipt does not end it');
        assert.match(retry[0], /Lint.*Typecheck/);

        // The retry's own run completes B: another job for B is handled work.
        const completedB = endedReceipt(9002, 'completed');
        assert.deepStrictEqual(await validate(redis, queuedA, [revisionB, completionA, completedB]), []);
    });

    test('a run that took a later revision and stopped before any receipt (deferral, lost worker) leaves it to run', async () => {
        const redis = memoryRedis();
        const revisionA = ciComment(['Lint'], '2026-11-17T08:00:00Z');
        await validate(redis, 'CI failed: **Lint**', [revisionA]);
        const completionA = endedReceipt(9001, 'completed');
        const revisionB = ciComment(['Lint', 'Typecheck'], '2026-11-17T08:30:00Z');

        // Taken, then deferred for capacity before the starting comment was posted.
        assert.strictEqual((await validate(redis, revisionB.body, [revisionB, completionA])).length, 1);
        assert.strictEqual((await validate(redis, revisionB.body, [revisionB, completionA])).length, 1, 'the deferred job still runs B');
    });

    test('a failure notice of the run that took the revision ends it, as for any request', async () => {
        const redis = memoryRedis();
        const revisionA = ciComment(['Lint'], '2026-11-17T08:00:00Z');
        await validate(redis, 'CI failed: **Lint**', [revisionA]);
        const completionA = endedReceipt(9001, 'completed');
        const revisionB = ciComment(['Lint', 'Typecheck'], '2026-11-17T08:30:00Z');
        await validate(redis, revisionB.body, [revisionB, completionA]);

        const failedB = endedReceipt(9002, 'failed');
        assert.deepStrictEqual(await validate(redis, revisionB.body, [revisionB, completionA, failedB]), []);
    });

    test('a revision taken with no earlier receipt keeps the receipt-only behaviour once its run ends', async () => {
        const redis = memoryRedis();
        const revisionA = ciComment(['Lint'], '2026-11-17T08:00:00Z');
        // Taken, interrupted by a usage limit, retried: still runs.
        await validate(redis, 'CI failed: **Lint**', [revisionA]);
        assert.strictEqual((await validate(redis, 'CI failed: **Lint**', [revisionA, startingReceipt(9001)])).length, 1);
        // Completed: done.
        assert.deepStrictEqual(await validate(redis, 'CI failed: **Lint**', [revisionA, endedReceipt(9001, 'completed')]), []);
    });

    test('a record of another shape names no revision, so the receipts do not hide the comment', async () => {
        const redis = memoryRedis();
        const revisionB = ciComment(['Lint', 'Typecheck'], '2026-11-17T08:30:00Z');
        redis.store.set(consumedCiFailureRevisionKey(pr, CI_COMMENT_ID), 'not-json');
        assert.strictEqual((await validate(redis, revisionB.body, [revisionB, endedReceipt(9001, 'completed')])).length, 1);
    });
});

describe('CI-failure revision lookup failure (F12)', () => {
    test('a failed read of the revision record fails validation instead of treating the revision as handled', async () => {
        const redis = memoryRedis();
        const revisionA = ciComment(['Lint'], '2026-11-17T08:00:00Z');
        await validate(redis, 'CI failed: **Lint**', [revisionA]);
        const completionA = endedReceipt(9001, 'completed');
        const revisionB = ciComment(['Lint', 'Typecheck'], '2026-11-17T08:30:00Z');

        const failing = { ...redis, get: async () => { throw new Error('Connection is closed.'); } };
        await assert.rejects(validate(failing, 'CI failed: **Lint**', [revisionB, completionA]), /Connection is closed/,
            'the job errors, so the queue retries validation');
        // The record is untouched, and once Redis answers the retry runs B.
        const [runB] = await validate(redis, 'CI failed: **Lint**', [revisionB, completionA]);
        assert.match(runB, /Lint.*Typecheck/);
    });
});
