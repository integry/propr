import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getUltrafixTransitionLeaseKey,
    withUltrafixTransitionLease,
} from '../src/jobs/ultrafixTransitionLease.js';

function createLockRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async set(key: string, value: string, ...args: Array<string | number>) {
            if (args.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        async eval(script: string, _keyCount: number, key: string, token: string) {
            if (store.get(key) !== token) return 0;
            if (script.includes("redis.call('del'")) store.delete(key);
            return 1;
        },
    };
}

test('terminal side effects finish before a fresh loop can take transition ownership', async () => {
    const redis = createLockRedis();
    const identity = { owner: 'integry', repo: 'propr', pr: 1806 };
    const events: string[] = [];
    let markOldStarted!: () => void;
    let releaseOld!: () => void;
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });

    const oldTerminal = withUltrafixTransitionLease(
        redis as never,
        identity,
        'old-generation',
        async () => {
            events.push('old-ownership-check');
            markOldStarted();
            await oldGate;
            events.push('old-terminal-side-effects');
        },
    );
    await oldStarted;

    const freshStartup = withUltrafixTransitionLease(
        redis as never,
        identity,
        'fresh-generation',
        async () => { events.push('fresh-generation-startup'); },
    );
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepEqual(events, ['old-ownership-check']);

    releaseOld();
    await Promise.all([oldTerminal, freshStartup]);

    assert.deepEqual(events, [
        'old-ownership-check',
        'old-terminal-side-effects',
        'fresh-generation-startup',
    ]);
    assert.equal(redis.store.has(getUltrafixTransitionLeaseKey(identity)), false);
});
