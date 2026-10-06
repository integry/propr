import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecuteAllBar } from './ExecuteAllBar';

const baseProps = {
  remainingCount: 14,
  taskCount: 17,
  hasRunningIssues: false,
  canExecute: true,
  unavailableReason: null,
  executing: false,
};

describe('ExecuteAllBar', () => {
  it('queues the remaining epic from one batch action', () => {
    const onExecuteAll = vi.fn();
    render(<ExecuteAllBar {...baseProps} useEpic onExecuteAll={onExecuteAll} />);

    fireEvent.click(screen.getByRole('button', { name: 'Execute All Remaining (14 tasks)' }));
    expect(onExecuteAll).toHaveBeenCalledTimes(1);
  });

  it('explains why individual tasks cannot be chained without auto-merge', () => {
    render(<ExecuteAllBar {...baseProps} onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Execute All Remaining/ })).toBeDisabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('auto-merge');
  });

  it('waits for running issues before queueing the batch', () => {
    render(<ExecuteAllBar {...baseProps} autoMerge hasRunningIssues onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Execute All Remaining/ })).toBeDisabled();
  });

  it('is hidden for single-task plans', () => {
    const { container } = render(<ExecuteAllBar {...baseProps} taskCount={1} remainingCount={1} useEpic onExecuteAll={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
