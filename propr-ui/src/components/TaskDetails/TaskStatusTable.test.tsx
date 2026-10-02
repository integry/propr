import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';

const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 50, second)).toISOString();

describe('Task timeline lifecycle', () => {
  it('updates a running phase in place and measures it from its original start', () => {
    const first = { state: 'PROCESSING', timestamp: at(29) };
    const { rerender } = render(<TaskStatusTable history={[first]} />);
    expect(screen.getByText('Running...')).toBeInTheDocument();
    rerender(<TaskStatusTable history={[first, { state: 'processing', timestamp: at(30) }]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(1);
    expect(screen.getAllByText('Running...')).toHaveLength(1);
    rerender(<TaskStatusTable history={[
      first, { state: 'PROCESSING', timestamp: at(30) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(37) },
      { state: 'COMPLETED', timestamp: at(47) },
    ]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(1);
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
    expect(screen.queryByText('Running...')).not.toBeInTheDocument();
  });

  it('preserves separate pipeline cycles and execution checkpoints and pool attempts', () => {
    render(<TaskStatusTable history={[
      { state: 'PROCESSING', timestamp: at(1) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(2), metadata: { description: 'First checkpoint' } },
      { state: 'CLAUDE_EXECUTION', timestamp: at(3), metadata: { description: 'Second checkpoint' } },
      { state: 'PROCESSING', timestamp: at(4) },
      { state: 'CLAUDE_EXECUTION_STARTED', timestamp: at(5), metadata: { syntheticRouting: { attemptNumber: 1, callId: 'a' } } },
      { state: 'CLAUDE_EXECUTION_STARTED', timestamp: at(6), metadata: { syntheticRouting: { attemptNumber: 2, callId: 'b' } } },
    ]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(2);
    for (const label of ['First checkpoint', 'Second checkpoint', 'Pool attempt 1', 'Pool attempt 2']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
