import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    EPIC_PROGRESS_RETRY_KEY, EPIC_PROGRESS_RETRY_MAX_AGE_MS, epicProgressRetryField, runEpicProgressUpdate, sweepEpicProgressRetries,
    type EpicProgressTarget,
} from '../packages/core/src/webhook/epicMergeProgressRetry.js';

after(async () => { await closeConnection(); });

const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
const target: EpicProgressTarget = { owner: 'integry', repo: 'propr', epicBranch: '100-epic-big-plan-abc', epicPrNumber: 500, mergedChildPrNumber: 203 };
const field = epicProgressRetryField(target.owner, target.repo, target.epicBranch);

function fakeRedis() {
    const hash = new Map<string, string>();
    const keys = new Map<string, string>();
    return {
        hash,
        keys,
        async hget(_key: string, f: string) { return hash.get(f) ?? null; },
        async hset(_key: string, f: string, value: string) { hash.set(f, value); return 1; },
        async hgetall(key: string) { assert.equal(key, EPIC_PROGRESS_RETRY_KEY); return Object.fromEntries(hash); },
        async set(key: string, value: string) {
            if (keys.has(key)) return null;
            keys.set(key, value);
            return 'OK';
        },
        async eval(script: string, _n: number, key: string, ...args: string[]) {
            if (script.includes('HGET')) {
                if (hash.get(args[0]) !== args[1]) return 0;
                return Number(hash.delete(args[0]));
            }
            if (keys.get(key) !== args[0]) return 0;
            return Number(keys.delete(key));
        },
    };
}

describe('runEpicProgressUpdate', () => {
    test('defers to a retry while another update holds the epic lease', async () => {
        const redis = fakeRedis();
        let concurrentOutcome: string | undefined;
        let updates = 0;
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 1_000,
            update: async () => {
                updates++;
                concurrentOutcome = await runEpicProgressUpdate(target, {
                    redis: redis as never, log, now: () => 1_000, update: async () => { updates++; return true; },
                });
                return true;
            },
        });
        assert.equal(outcome, 'updated');
        assert.equal(concurrentOutcome, 'retry_scheduled');
        assert.equal(updates, 1);
        // The deferred update was recorded after this one started, so it is kept.
        assert.equal(JSON.parse(redis.hash.get(field)!).attempts, 1);
        assert.equal(redis.keys.size, 0);
    });

    test('keeps a retry recorded by a later failure while an earlier update succeeds', async () => {
        const redis = fakeRedis();
        redis.hash.set(field, JSON.stringify({ ...target, attempts: 1, firstFailedAt: 0, nextAttemptAt: 0 }));
        const outcome = await runEpicProgressUpdate(target, {
            redis: redis as never, log, now: () => 5_000,
            update: async () => {
                redis.hash.set(field, JSON.stringify({ ...target, mergedChildPrNumber: 204, attempts: 1, firstFailedAt: 4_000, nextAttemptAt: 0 }));
                return true;
            },
        });
        assert.equal(outcome, 'updated');
        assert.equal(JSON.parse(redis.hash.get(field)!).mergedChildPrNumber, 204);
    });
});

describe('sweepEpicProgressRetries', () => {
    test('drops a retry that has failed beyond the maximum age', async () => {
        const redis = fakeRedis();
        redis.hash.set(field, JSON.stringify({ ...target, attempts: 40, firstFailedAt: 0, nextAttemptAt: 0 }));
        let retries = 0;
        await sweepEpicProgressRetries({
            redis: redis as never, log, now: () => EPIC_PROGRESS_RETRY_MAX_AGE_MS + 1,
            retry: async () => { retries++; return 'updated'; },
        });
        assert.equal(retries, 0);
        assert.equal(redis.hash.size, 0);
    });
});
