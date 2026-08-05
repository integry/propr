import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getPRCommentRemoteOutcomeKey,
    loadPRCommentPublicationCheckpoint,
    loadPRCommentRemoteOutcome,
    persistPRCommentPublicationCheckpoint,
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

test('persists and validates an in-progress publication checkpoint', async () => {
    const evalMock = mock.fn(async () => 1);
    const checkpoint = {
        kind: 'implementation-publication' as const,
        stage: 'completion_comment_published' as const,
        prProcessingAttemptGeneration: 'generation-hash',
        result: {
            status: 'complete',
            commit: 'commit-abc',
            prProcessingAttemptGeneration: 'generation-hash',
        },
        branchName: 'feature-branch',
        completionComment: {
            id: 42,
            body: 'completed',
            htmlUrl: 'https://example.test/comment/42',
        },
        reviewCommentIds: [10, 20],
    };

    await persistPRCommentPublicationCheckpoint({ eval: evalMock } as never, {
        taskId: 'task-1748',
        lockKey: 'lock:pr:integry:propr:1748',
        lockToken: 'attempt-token',
        checkpoint,
    });
    const serialized = evalMock.mock.calls[0].arguments[6] as string;
    const loaded = await loadPRCommentPublicationCheckpoint({
        get: async () => serialized,
    }, 'task-1748');

    assert.deepEqual(loaded, checkpoint);
    assert.equal(await loadPRCommentRemoteOutcome({ get: async () => serialized }, 'task-1748'), null);
});

test('rejects a publication checkpoint whose nested result belongs to another generation', async () => {
    const loaded = await loadPRCommentPublicationCheckpoint({
        get: async () => JSON.stringify({
            kind: 'implementation-publication',
            stage: 'branch_pushed',
            prProcessingAttemptGeneration: 'generation-new',
            result: { status: 'complete', prProcessingAttemptGeneration: 'generation-old' },
            branchName: 'feature-branch',
            completionComment: { id: 42, body: 'completed' },
            reviewCommentIds: [],
        }),
    }, 'task-1748');

    assert.equal(loaded, null);
});
