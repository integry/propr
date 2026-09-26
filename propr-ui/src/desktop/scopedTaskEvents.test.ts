import { TASK_UPDATE } from '@propr/shared';
import { describe, expect, test } from 'vitest';
import { normalizeScopedDesktopTaskTransition } from './scopedTaskEvents';

describe('scoped desktop task event adapter', () => {
  test('projects only safe transition context and removes all metadata', () => {
    expect(normalizeScopedDesktopTaskTransition({
      eventType: TASK_UPDATE,
      taskId: 'task-1',
      state: 'failed',
      previousState: 'processing',
      repository: 'integry/propr',
      issueNumber: 2192,
      timestamp: '2026-09-07T18:45:00.000Z',
      version: 3,
      metadata: { prompt: 'must not cross native IPC', output: 'secret' },
    })).toEqual({
      taskId: 'task-1', state: 'failed', previousState: 'processing',
      repository: 'integry/propr', issueNumber: 2192,
      timestamp: '2026-09-07T18:45:00.000Z', version: 3,
    });
  });

  test('suppresses snapshot-like events and malformed context', () => {
    expect(normalizeScopedDesktopTaskTransition({
      eventType: TASK_UPDATE, taskId: 'task-1', state: 'completed',
      timestamp: '2026-09-07T18:45:00.000Z',
    })).toBeNull();
    expect(normalizeScopedDesktopTaskTransition({
      eventType: TASK_UPDATE, taskId: 'task-1', state: 'completed', previousState: 'processing',
      repository: 'invalid', timestamp: '2026-09-07T18:45:00.000Z',
    })).toBeNull();
  });

  test('rejects malformed runtime payload shapes without throwing', () => {
    expect(normalizeScopedDesktopTaskTransition(null)).toBeNull();
    expect(normalizeScopedDesktopTaskTransition('task update')).toBeNull();
    expect(normalizeScopedDesktopTaskTransition([])).toBeNull();
    expect(normalizeScopedDesktopTaskTransition({
      eventType: TASK_UPDATE,
      taskId: 'task-1',
      state: 'failed',
      previousState: 'processing',
      repository: null,
      timestamp: '2026-09-07T18:45:00.000Z',
    })).toBeNull();
  });
});
