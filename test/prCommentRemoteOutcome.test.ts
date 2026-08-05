import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getPRCommentRemoteOutcomeKey,
    loadPRCommentRemoteOutcome,
    persistPRCommentRemoteOutcome,
} from '../src/jobs/prCommentRemoteOutcome.js';

test('persists a remote outcome with the live lease and a bounded TTL', async () => {
    const evalMock = mock.fn(async () => 1);
    const result = {
        status: 'complete',
        commit: 'commit-abc',
        prProcessingAttemptGeneration: 'generation-hash',
    };

    await persistPRCommentRemoteOutcome({ eval: evalMock } as never, {
        taskId: 'task-1748',
        lockKey: 'lock:pr:integry:propr:1748',
        lockToken: 'attempt-token',
        result,
    });

    const args = evalMock.mock.calls[0].arguments;
    assert.equal(args[2], 'lock:pr:integry:propr:1748');
    assert.equal(args[3], getPRCommentRemoteOutcomeKey('task-1748'));
    assert.equal(args[4], 'attempt-token');
    assert.equal(args[5], 30 * 24 * 3600);
    assert.deepEqual(JSON.parse(args[6] as string), result);
});

test('rejects an outcome checkpoint after lease ownership changes', async () => {
    await assert.rejects(
        persistPRCommentRemoteOutcome({ eval: async () => 0 } as never, {
            taskId: 'task-1748',
            lockKey: 'lock:pr:integry:propr:1748',
            lockToken: 'stale-token',
            result: {
                status: 'complete',
                prProcessingAttemptGeneration: 'generation-hash',
            },
        }),
        /lease was lost/,
    );
});

test('loads only complete remote outcome shapes with an attempt generation', async () => {
    const valid = await loadPRCommentRemoteOutcome({
        get: async () => JSON.stringify({
            status: 'partial',
            commit: 'commit-abc',
            prProcessingAttemptGeneration: 'generation-hash',
        }),
    } as never, 'task-1748');
    const invalid = await loadPRCommentRemoteOutcome({
        get: async () => JSON.stringify({ status: 'failed' }),
    } as never, 'task-1748');

    assert.equal(valid?.status, 'partial');
    assert.equal(invalid, null);
});
