import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskCardList } from './TaskCardList';
import type { PlanTask } from '../../api/proprApi';

vi.mock('./TaskCard', () => ({
  default: ({ task, id }: { task: PlanTask; id: string }) => <article id={id}>{task.title}</article>,
}));

const tasks = Array.from({ length: 8 }, (_, index) => ({
  id: `task-${index + 1}`, title: `Step ${index + 1}`, body: 'Body', implementation: '',
}) as PlanTask);
const originalWidth = window.innerWidth;
const renderAt = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  return render(<TaskCardList tasks={tasks} highlightedIds={[]} draftId="draft" onTaskChange={vi.fn()} onDeleteTask={vi.fn()} />);
};

describe('TaskCardList breakpoint', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalWidth });
  });

  it('uses the task jumper, not the outline rail, inside the phone editor layout (below 768px)', () => {
    renderAt(700);
    expect(screen.getByTestId('mobile-task-jumper')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Plan outline' })).not.toBeInTheDocument();
  });

  it('switches to the desktop outline at the editor breakpoint', () => {
    renderAt(768);
    expect(screen.queryByTestId('mobile-task-jumper')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Plan outline' })).toBeInTheDocument();
  });
});
