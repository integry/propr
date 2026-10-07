import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskTimeline } from './TaskTimeline';

describe('TaskTimeline plan outline', () => {
  it('lists every step title and jumps to the selected step', () => {
    const onScrollToTask = vi.fn();
    render(
      <TaskTimeline
        taskCount={3}
        activeIndex={0}
        onStepClick={vi.fn()}
        taskTitles={[
          'Agents v1 (1/3): Shared contracts & capabilities',
          'Agents v1 (2/3): Database migration & store',
          'Agent run store with state machine',
        ]}
        taskIds={['a', 'b', 'c']}
        onScrollToTask={onScrollToTask}
      />
    );

    expect(screen.getByRole('navigation', { name: 'Plan outline' })).toHaveClass('w-72');
    const active = screen.getByRole('button', { name: /Shared contracts & capabilities/ });
    expect(active).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Database migration & store')).toBeInTheDocument();
    expect(screen.queryByText(/Agents v1 \(2\/3\)/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Agent run store with state machine/ }));
    expect(onScrollToTask).toHaveBeenCalledWith('c', 2);
  });

  it('keeps the active entry visible by scrolling only the outline list', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const titles = ['One', 'Two', 'Three'];
    const view = render(<TaskTimeline taskCount={3} activeIndex={0} onStepClick={vi.fn()} taskTitles={titles} taskIds={['a', 'b', 'c']} />);
    const list = screen.getByRole('list');
    const items = screen.getAllByRole('listitem');
    list.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    items.forEach((item, index) => { item.getBoundingClientRect = () => ({ top: index * 80, bottom: index * 80 + 30 }) as DOMRect; });

    view.rerender(<TaskTimeline taskCount={3} activeIndex={2} onStepClick={vi.fn()} taskTitles={titles} taskIds={['a', 'b', 'c']} />);
    expect(list.scrollTop).toBe(90);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
