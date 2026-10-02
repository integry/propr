import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('shows 32 full file paths in a bounded list ordered by changed lines and keeps every diff accessible', async () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `src/credentials/agentWorkerCredentialValidation${index}.test.ts`,
      status: 'modified', linesAdded: index + 1, linesRemoved: index,
      diff: `+Added validation ${index}`,
    }));
    fileChangesMocks.getFileChanges.mockResolvedValue({ files });
    render(<LiveFileChips taskId="task-1" isActive={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const list = screen.getByRole('region', { name: 'Changed files' });
    expect(list).toHaveClass('max-h-48', 'overflow-y-auto');
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(32);
    expect(buttons[0]).toHaveAccessibleName(`View diff for ${files[31].path}`);
    expect(buttons[0]).toHaveTextContent('agentWorkerCredentialValidation31.test.ts');
    expect(buttons[0]).toHaveTextContent('src/credentials/');
    expect(buttons[31]).toHaveAccessibleName(`View diff for ${files[0].path}`);
    fireEvent.click(buttons[31]);
    expect(screen.getByTitle('Close diff view')).toBeInTheDocument();
    expect(document.querySelector('pre')).toHaveTextContent('+Added validation 0');
    fireEvent.click(screen.getByTitle('Close diff view'));
    expect(screen.queryByTitle('Close diff view')).not.toBeInTheDocument();
  });

});
