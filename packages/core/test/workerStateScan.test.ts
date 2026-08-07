import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    scanNonTerminalTaskStates,
} from '../src/utils/workerStateScan.js';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
} from '../src/utils/workerStateManager.types.js';

function makeTask(taskId: string, state: TaskState = TaskStates.PROCESSING): TaskStateData {
    const timestamp = '2026-08-05T12:00:00.000Z';
    return {
        taskId,
        issueRef: { type: 'pr_comment', number: 1748, repoOwner: 'integry', repoName: 'propr' },
        correlationId: `correlation-${taskId}`,
        state,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 1,
        history: [],
    };
}

test('scans one Redis page, pipelines reads, and returns only matching nonterminal tasks', async () => {
    const keys = [
        'worker:state:active',
        'worker:state:complete',
        'worker:state:mismatched',
        'worker:state:malformed',
    ];
    const records = new Map([
        [keys[0], JSON.stringify(makeTask('active'))],
        [keys[1], JSON.stringify(makeTask('complete', TaskStates.COMPLETED))],
        [keys[2], JSON.stringify(makeTask('different-task'))],
        [keys[3], '{invalid'],
    ]);
    const requestedKeys: string[] = [];
    const scanCalls: unknown[][] = [];
    const redis = {
        scan: async (...args: unknown[]) => {
            scanCalls.push(args);
            return ['42', keys] as [string, string[]];
        },
        pipeline: () => ({
            get: (key: string) => { requestedKeys.push(key); },
            exec: async () => requestedKeys.map(key => [null, records.get(key)]),
        }),
    };

    const result = await scanNonTerminalTaskStates(
        redis as Parameters<typeof scanNonTerminalTaskStates>[0],
        'worker:state:',
        '7',
        25,
    );

    assert.equal(result.nextCursor, '42');
    assert.deepEqual(result.tasks.map(task => task.taskId), ['active']);
    assert.deepEqual(requestedKeys, keys);
    assert.deepEqual(scanCalls[0], ['7', 'MATCH', 'worker:state:*', 'COUNT', 25]);
});

test('clamps invalid page sizes before passing the SCAN hint to Redis', async () => {
    const calls: unknown[][] = [];
    const redis = {
        scan: async (...args: unknown[]) => {
            calls.push(args);
            return ['0', []] as [string, string[]];
        },
        pipeline: () => {
            throw new Error('pipeline should not be created for an empty page');
        },
    };

    await scanNonTerminalTaskStates(
        redis as Parameters<typeof scanNonTerminalTaskStates>[0],
        'state:',
        '0',
        Number.POSITIVE_INFINITY,
    );
    assert.equal(calls[0].at(-1), 100);
});
