import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    isNewerTaskUpdate,
    TASK_UPDATE,
    type TaskUpdatePayload,
} from '../packages/shared/src/events.js';

function taskUpdate(version: number | undefined, timestamp: string): TaskUpdatePayload {
    return {
        eventType: TASK_UPDATE,
        taskId: 'task-123',
        state: 'processing',
        timestamp,
        version,
    };
}

test('task update consumers reject stale and duplicate transition versions', () => {
    const latest = taskUpdate(4, '2026-08-05T10:00:04.000Z');

    assert.equal(isNewerTaskUpdate(latest, taskUpdate(3, '2026-08-05T10:00:05.000Z')), false);
    assert.equal(isNewerTaskUpdate(latest, taskUpdate(4, '2026-08-05T10:00:06.000Z')), false);
    assert.equal(isNewerTaskUpdate(latest, taskUpdate(5, '2026-08-05T10:00:03.000Z')), true);
});

test('versioned events supersede legacy events and cannot be replaced by them', () => {
    const legacy = taskUpdate(undefined, '2026-08-05T10:00:04.000Z');
    const versioned = taskUpdate(1, '2026-08-05T10:00:03.000Z');

    assert.equal(isNewerTaskUpdate(legacy, versioned), true);
    assert.equal(isNewerTaskUpdate(versioned, taskUpdate(undefined, '2026-08-05T10:00:05.000Z')), false);
});

test('legacy events fall back to timestamp ordering', () => {
    const latest = taskUpdate(undefined, '2026-08-05T10:00:04.000Z');

    assert.equal(isNewerTaskUpdate(latest, taskUpdate(undefined, '2026-08-05T10:00:03.000Z')), false);
    assert.equal(isNewerTaskUpdate(latest, taskUpdate(undefined, '2026-08-05T10:00:05.000Z')), true);
});
