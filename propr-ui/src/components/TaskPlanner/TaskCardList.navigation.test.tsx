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
    Element.prototype.scrollTo = vi.fn();
  });

  it('uses a tab bar instead of the outline rail for plans with fewer than 5 steps', () => {
    renderList(3);
    expect(screen.queryByRole('navigation', { name: 'Plan outline' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Plan steps' });
    expect(tabs.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Step Title 1/ })).toHaveAttribute('aria-current', 'step');

    fireEvent.click(screen.getByRole('button', { name: /Step Title 3/ }));
    expect(screen.getByRole('button', { name: /Step Title 3/ })).toHaveAttribute('aria-current', 'step');
  });

  it('keeps the tab bar outside the scroll container and scrolls only the specification', () => {
    renderList(3);
    const tabs = screen.getByRole('navigation', { name: 'Plan steps' });
    const list = document.querySelector('[data-task-list]') as HTMLElement;
    expect(list.contains(tabs)).toBe(false);
    expect(tabs.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    vi.mocked(Element.prototype.scrollTo).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Step Title 2/ }));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(vi.mocked(Element.prototype.scrollTo).mock.contexts).toEqual([list]);
  });

  it('follows the scroll position like a table of contents (scroll-spy)', () => {
    renderList(3);
    const list = document.querySelector('[data-task-list]') as HTMLElement;
    const cards = Array.from(list.querySelectorAll('[data-task-index]')) as HTMLElement[];
    // Each step is 600px tall in a 500px pane; scrollTop moves every step up.
    const layout = (scrollTop: number, scrollHeight = 1800) => {
      list.getBoundingClientRect = () => ({ top: 0, height: 500 }) as DOMRect;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: scrollHeight });
      list.scrollTop = scrollTop;
      cards.forEach((card, index) => { card.getBoundingClientRect = () => ({ top: index * 600 - scrollTop }) as DOMRect; });
      fireEvent.scroll(list);
    };
    const tab = (name: RegExp) => screen.getByRole('button', { name });

    layout(0);
    expect(tab(/Step Title 1/)).toHaveAttribute('aria-current', 'step');
    layout(520);
    expect(tab(/Step Title 2/)).toHaveAttribute('aria-current', 'step');
    layout(100);
    expect(tab(/Step Title 1/)).toHaveAttribute('aria-current', 'step');
    // At the bottom the last step is active even though its heading never reaches the top.
    layout(1300);
    expect(tab(/Step Title 3/)).toHaveAttribute('aria-current', 'step');
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
