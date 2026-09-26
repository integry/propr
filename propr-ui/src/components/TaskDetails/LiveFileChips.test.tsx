import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveFileChips from './LiveFileChips';

const fileChangesMocks = vi.hoisted(() => ({
  getFileChanges: vi.fn(),
}));

const socketMocks = vi.hoisted(() => ({
  taskUpdateHandler: null as ((payload: { taskId: string }) => void) | null,
}));

vi.mock('../../api/fileChangesApi', () => ({
  getFileChanges: fileChangesMocks.getFileChanges,
}));

vi.mock('../../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    onTaskUpdate: (handler: typeof socketMocks.taskUpdateHandler) => {
      socketMocks.taskUpdateHandler = handler;
      return () => {
        if (socketMocks.taskUpdateHandler === handler) socketMocks.taskUpdateHandler = null;
      };
    },
  }),
}));

describe('LiveFileChips live refreshes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socketMocks.taskUpdateHandler = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fileChangesMocks.getFileChanges.mockResolvedValue({ files: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns the fixture baseline of three burst invalidations into one additional file-changes request', async () => {
    render(<LiveFileChips taskId="task-1" isActive={true} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fileChangesMocks.getFileChanges).toHaveBeenCalledTimes(1);

    act(() => {
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1' });
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1' });
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1' });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Fixture count: 1 initial + 1 coalesced live read (previously 1 + 3).
    expect(fileChangesMocks.getFileChanges).toHaveBeenCalledTimes(2);
  });
});
