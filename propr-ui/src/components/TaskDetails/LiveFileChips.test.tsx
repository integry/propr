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

  it('shows the shared directory once with 32 filenames ordered by changed lines and keeps every diff accessible', async () => {
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
    expect(within(list).getAllByText('src/credentials/')).toHaveLength(1);
    expect(buttons[0]).not.toHaveTextContent('src/credentials/');
    expect(buttons[31]).toHaveAccessibleName(`View diff for ${files[0].path}`);
    fireEvent.click(buttons[31]);
    expect(screen.getByTitle('Close diff view')).toBeInTheDocument();
    expect(document.querySelector('pre')).toHaveTextContent('+Added validation 0');
    fireEvent.click(screen.getByTitle('Close diff view'));
    expect(screen.queryByTitle('Close diff view')).not.toBeInTheDocument();
  });

  it('shows a failed load as a quiet alert with a retry instead of raw red text', async () => {
    fileChangesMocks.getFileChanges
      .mockRejectedValueOnce(new Error('The server ran into a problem (HTTP 503). Please try again in a moment.'))
      .mockResolvedValueOnce({ files: [{ path: 'src/a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, diff: '+a' }] });
    render(<LiveFileChips taskId="task-1" isActive={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('bg-slate-50', 'border-slate-200', 'text-slate-600');
    expect(alert).toHaveTextContent('HTTP 503');
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    // A bordered button with a hit area widened past its visible edge, not loose text.
    expect(retry).toHaveClass('border', 'border-slate-300', 'bg-white', 'after:-inset-y-[9px]');
    fireEvent.click(retry);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View diff for src/a.ts' })).toBeInTheDocument();
  });
});
