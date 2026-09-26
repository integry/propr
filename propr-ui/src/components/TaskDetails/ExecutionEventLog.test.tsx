import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExecutionEventLog from './ExecutionEventLog';
import type { LiveEvent } from './types';

const defaultProps = {
  onToggleCollapse: vi.fn(),
  lastThought: null,
  isTaskActive: true,
  taskInfo: null,
};

describe('ExecutionEventLog', () => {
  it('does not materialize historical event details while collapsed', () => {
    const commandRead = vi.fn();
    const input = Object.defineProperty({}, 'command', {
      configurable: true,
      enumerable: true,
      get: () => {
        commandRead();
        return 'npm test';
      },
    });
    const events: LiveEvent[] = [
      { id: 'tool-1', type: 'tool_use', toolName: 'Bash', input },
      { id: 'thought-2', type: 'thought', content: 'Waiting for the test result' },
    ];

    const { rerender } = render(
      <ExecutionEventLog {...defaultProps} events={events} collapsed={true} />,
    );

    expect(screen.getByText('EXECUTION LOG (2)')).toBeTruthy();
    expect(commandRead).not.toHaveBeenCalled();
    expect(document.querySelector('#execution-event-log-content')?.children).toHaveLength(1);
    expect(screen.queryByText('BASH')).toBeNull();

    rerender(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} />);

    expect(commandRead).toHaveBeenCalled();
    expect(screen.getByText('TERMINAL OUTPUT (2)')).toBeTruthy();
    expect(screen.getByText('BASH')).toBeTruthy();
  });

  it('keeps the collapsed summary interactive without rendering the hidden history', () => {
    const onToggleCollapse = vi.fn();
    render(
      <ExecutionEventLog
        {...defaultProps}
        events={[{ id: 'thought-1', type: 'thought', content: 'A current summary' }]}
        collapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    expect(screen.getByText('Thinking: A current summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /execution log/i }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });
});
