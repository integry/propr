import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskCardList } from './TaskCardList';
import type { PlanTask } from '../../api/proprApi';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('./TaskCard', () => ({
  default: ({ task, id }: { task: PlanTask; id: string }) => <article id={id}>{task.title}</article>,
}));

const makeTasks = (count: number): PlanTask[] => Array.from({ length: count }, (_, index) => ({
  id: `task-${index + 1}`,
  title: `Plan (${index + 1}/${count}): Step title ${index + 1}`,
  body: 'Body',
  implementation: '',
}) as PlanTask);

const renderList = (count: number) => render(
  <TaskCardList tasks={makeTasks(count)} highlightedIds={[]} draftId="draft" onTaskChange={vi.fn()} onDeleteTask={vi.fn()} />
);

describe('TaskCardList adaptive navigation', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('uses a tab bar instead of the outline rail for plans with fewer than 5 steps', () => {
    renderList(3);
    expect(screen.queryByRole('navigation', { name: 'Plan outline' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Plan steps' });
    expect(tabs.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Step title 1/ })).toHaveAttribute('aria-current', 'step');

    fireEvent.click(screen.getByRole('button', { name: /Step title 3/ }));
    expect(screen.getByRole('button', { name: /Step title 3/ })).toHaveAttribute('aria-current', 'step');
  });

  it('shows no navigation for a single-step plan', () => {
    renderList(1);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders a collapsible outline rail for plans with 5 or more steps', () => {
    renderList(5);
    expect(screen.queryByRole('navigation', { name: 'Plan steps' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Plan outline' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse outline' }));
    expect(screen.queryByRole('navigation', { name: 'Plan outline' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));
    expect(screen.getByRole('navigation', { name: 'Plan outline' })).toBeInTheDocument();
  });
});
