import { describe, expect, it } from 'vitest';
import type { LiveDetails } from './types';
import {
  mergeIncrementalLiveDetails,
  normalizeLiveTodos,
  type IncrementalTaskLiveUpdatePayload,
} from './useTaskData';

const previous: LiveDetails = {
  events: [{ type: 'thought', content: 'Existing event' }],
  todos: [{ id: 'todo-1', content: 'Keep this', status: 'in_progress' }],
  currentTask: 'Keep current task',
  tokenUsage: { input_tokens: 10, output_tokens: 4 },
};

describe('incremental task live updates', () => {
  it('preserves state fields omitted from an incremental event update', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [{ type: 'thought', content: 'New event', timestamp: '2026-08-03T00:00:00.000Z' }],
    };

    expect(mergeIncrementalLiveDetails(previous, payload)).toEqual({
      ...previous,
      events: [
        { type: 'thought', content: 'Existing event' },
        { type: 'thought', content: 'New event', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    });
  });

  it('applies explicit empty and null fields', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [],
      todos: [],
      currentTask: null,
      tokenUsage: null,
    };

    expect(mergeIncrementalLiveDetails(previous, payload)).toEqual({
      events: previous.events,
      todos: [],
      currentTask: null,
      tokenUsage: null,
    });
  });

  it('keeps distinct events that have stable IDs despite identical legacy content', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        { id: 'event-1', type: 'thought', content: 'Same output', timestamp: '2026-08-03T00:00:00.000Z' },
        { id: 'event-2', type: 'thought', content: 'Same output', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    };

    expect(mergeIncrementalLiveDetails({ ...previous, events: [] }, payload).events).toHaveLength(2);
  });

  it('deduplicates legacy resends even when a fallback timestamp is regenerated', () => {
    const firstEvent = {
      type: 'thought' as const,
      content: 'Repeated output',
      timestamp: '2026-08-03T00:00:00.000Z',
    };
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        firstEvent,
        { ...firstEvent },
        { ...firstEvent, timestamp: '2026-08-03T00:00:01.000Z' },
      ],
    };

    expect(mergeIncrementalLiveDetails({ ...previous, events: [] }, payload).events).toEqual([
      firstEvent,
    ]);
  });

  it('uses tool-use IDs without dropping the matching tool result', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        { type: 'tool_use', toolName: 'Read', toolUseId: 'call-1', input: { file_path: 'README.md' }, timestamp: '2026-08-03T00:00:00.000Z' },
        { type: 'tool_use', toolName: 'Read', toolUseId: 'call-2', input: { file_path: 'README.md' }, timestamp: '2026-08-03T00:00:00.000Z' },
        { type: 'tool_result', toolUseId: 'call-1', result: 'contents', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    };

    expect(mergeIncrementalLiveDetails({ ...previous, events: [] }, payload).events).toEqual(payload.events);
  });

  it('keeps todo IDs stable when distinct items are reordered', () => {
    const todos = [
      { content: 'Inspect the parser', status: 'pending' },
      { content: 'Run the tests', status: 'in_progress' },
    ];
    const original = normalizeLiveTodos(todos);
    const reordered = normalizeLiveTodos([...todos].reverse());

    expect(Object.fromEntries(original.map(todo => [todo.content, todo.id]))).toEqual(
      Object.fromEntries(reordered.map(todo => [todo.content, todo.id]))
    );
  });

  it('preserves IDs supplied by the server', () => {
    expect(normalizeLiveTodos([
      { id: 'server-todo-42', content: 'Keep this row', status: 'completed' },
    ])[0].id).toBe('server-todo-42');
  });
});
