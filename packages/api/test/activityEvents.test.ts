import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_UPDATE, TASK_UPDATE, DRAFT_UPDATE, INDEXING_UPDATE, QUEUE_STATS_UPDATE } from '@propr/shared';
import {
    activityFromDraftUpdate,
    activityFromIndexingUpdate,
    activityFromQueueStatsUpdate,
    activityFromTaskUpdate,
} from '../services/activityEvents.js';

test('a finished task becomes a terminal task activity', () => {
    const activity = activityFromTaskUpdate({
        eventType: TASK_UPDATE,
        taskId: 'task-1',
        state: 'completed',
        previousState: 'processing',
        repository: 'integry/propr',
        timestamp: '2026-09-26T12:00:00.000Z',
    });

    assert.deepEqual(activity, {
        eventType: ACTIVITY_UPDATE,
        domain: 'task',
        change: 'completed',
        repository: 'integry/propr',
        subjectId: 'task-1',
        terminal: true,
        occurredAt: '2026-09-26T12:00:00.000Z',
    });
});

test('a task still running is activity, but not terminal', () => {
    const activity = activityFromTaskUpdate({
        eventType: TASK_UPDATE,
        taskId: 'task-2',
        state: 'claude_execution',
        timestamp: '2026-09-26T12:00:01.000Z',
    });

    assert.equal(activity.change, 'started');
    assert.equal(activity.terminal, false);
});

test('a queued task reads as created so a new arrival wakes the queue widget', () => {
    const activity = activityFromTaskUpdate({
        eventType: TASK_UPDATE,
        taskId: 'task-3',
        state: 'queued',
        timestamp: '2026-09-26T12:00:02.000Z',
    });

    assert.equal(activity.change, 'created');
});

test('draft progress without a status transition produces no activity', () => {
    assert.equal(activityFromDraftUpdate({
        eventType: DRAFT_UPDATE,
        draftId: 'draft-1',
        step: 'context',
        status: 'in_progress',
        timestamp: '2026-09-26T12:00:03.000Z',
    }), null);
});

test('a failed plan becomes a terminal plan activity', () => {
    const activity = activityFromDraftUpdate({
        eventType: DRAFT_UPDATE,
        draftId: 'draft-1',
        step: 'llm',
        status: 'failed',
        draftStatus: 'failed',
        timestamp: '2026-09-26T12:00:04.000Z',
    });

    assert.deepEqual(activity, {
        eventType: ACTIVITY_UPDATE,
        domain: 'plan',
        change: 'failed',
        subjectId: 'draft-1',
        terminal: true,
        occurredAt: '2026-09-26T12:00:04.000Z',
    });
});

test('indexing progress is a non-terminal indexing activity for its repository', () => {
    const activity = activityFromIndexingUpdate({
        eventType: INDEXING_UPDATE,
        repository: 'integry/propr',
        phase: 'files',
        timestamp: '2026-09-26T12:00:05.000Z',
    });

    assert.equal(activity.domain, 'indexing');
    assert.equal(activity.change, 'progress');
    assert.equal(activity.repository, 'integry/propr');
    assert.equal(activity.terminal, false);
});

test('a run starting is distinguishable from its per-file churn', () => {
    // Health surfaces read the instance, not the file counter: they react to a
    // run starting or ending and ignore `progress`.
    const started = activityFromIndexingUpdate({
        eventType: INDEXING_UPDATE,
        repository: 'integry/propr',
        phase: 'indexing',
        timestamp: '2026-09-26T12:00:04.000Z',
    });
    const finished = activityFromIndexingUpdate({
        eventType: INDEXING_UPDATE,
        repository: 'integry/propr',
        phase: 'completed',
        timestamp: '2026-09-26T12:00:09.000Z',
    });

    assert.equal(started.change, 'started');
    assert.equal(started.terminal, false);
    assert.equal(finished.change, 'completed');
    assert.equal(finished.terminal, true);
});

test('queue statistics are a queue activity with no subject', () => {
    const activity = activityFromQueueStatsUpdate({
        eventType: QUEUE_STATS_UPDATE,
        stats: { waiting: 1, active: 2, completed: 3, failed: 0, delayed: 0, total: 6 },
        timestamp: '2026-09-26T12:00:06.000Z',
    });

    assert.equal(activity.domain, 'queue');
    assert.equal(activity.change, 'updated');
    assert.equal(activity.subjectId, undefined);
});
