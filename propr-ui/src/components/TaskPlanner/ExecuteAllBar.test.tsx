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

    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (14 tasks)' }));
    expect(onExecuteAll).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh epic instead of queueing "remaining" tasks when nothing has run yet', () => {
    render(<ExecuteAllBar {...baseProps} remainingCount={16} taskCount={16} useEpic onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Start Epic PR (16 tasks)' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
  });

  it('starts every task of a fresh auto-merge plan', () => {
    render(<ExecuteAllBar {...baseProps} remainingCount={3} taskCount={3} autoMerge onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Start All (3 tasks)' })).toBeEnabled();
  });

  it('queues the remaining tasks once the first one is running', () => {
    render(<ExecuteAllBar {...baseProps} remainingCount={16} taskCount={16} useEpic hasRunningIssues onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Queue Remaining (16 tasks)' })).toBeEnabled();
  });

  it('shows a quiet hint instead of a dead button when no chaining mode is on', () => {
    render(<ExecuteAllBar {...baseProps} onExecuteAll={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Enable auto-merge or Epic PR to queue the remaining tasks.');
  });

  it('describes the immediate head start instead of promising slot-based dispatch', () => {
    render(<ExecuteAllBar {...baseProps} remainingCount={10} autoMerge onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Queue Remaining (10 tasks)' })).toBeEnabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Starts the first of 10 tasks now');
    expect(screen.getByTestId('execute-all-hint')).not.toHaveTextContent('concurrency slots');
  });

  it('stays enabled while issues run so the backlog can be queued behind them', () => {
    const onExecuteAll = vi.fn();
    render(<ExecuteAllBar {...baseProps} remainingCount={10} autoMerge hasRunningIssues canExecute={false}
      unavailableReason="There is no eligible pending issue to start." onExecuteAll={onExecuteAll} />);

    const button = screen.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
    expect(button).toBeEnabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Queues 10 tasks behind the running work. Each starts automatically');
    fireEvent.click(button);
    expect(onExecuteAll).toHaveBeenCalledTimes(1);
  });
  it('keeps the epic batch enabled while issues are running', () => {
    render(<ExecuteAllBar {...baseProps} useEpic hasRunningIssues onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Queue Remaining/ })).toBeEnabled();
  });
  it('summarizes queued work once nothing is left to queue', () => {
    render(<ExecuteAllBar {...baseProps} remainingCount={0} queuedCount={10} useEpic hasRunningIssues onExecuteAll={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('10 tasks queued.');
  });
  it('is disabled for read-only viewers even while issues run', () => {
    render(<ExecuteAllBar {...baseProps} autoMerge hasRunningIssues readOnly onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Queue Remaining/ })).toBeDisabled();
  });

  it('explains the demo lock on an idle epic batch', () => {
    render(<ExecuteAllBar {...baseProps} useEpic readOnly locked onExecuteAll={vi.fn()} />);

    const button = screen.getByRole('button', { name: /Queue Remaining/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Demo mode is read-only');
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Demo mode is read-only.');
  });

  it('is disabled while execution settings are saving', () => {
    render(<ExecuteAllBar {...baseProps} useEpic locked onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Queue Remaining/ })).toBeDisabled();
  });

  it('shows why the batch cannot start when an earlier issue is unfinished', () => {
    const reason = 'There is no eligible pending issue to start. Resolve active or out-of-sequence work first.';
    render(<ExecuteAllBar {...baseProps} autoMerge canExecute={false} unavailableReason={reason} onExecuteAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Queue Remaining/ })).toBeDisabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent(reason);
  });

  it('is hidden for single-task plans', () => {
    const { container } = render(<ExecuteAllBar {...baseProps} taskCount={1} remainingCount={1} useEpic onExecuteAll={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
