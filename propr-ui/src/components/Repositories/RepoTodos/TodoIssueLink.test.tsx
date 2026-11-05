import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RepoTodo } from '../../../api/repoTodosApi';
import TodoIssueLink from './TodoIssueLink';
import SortableTodoItem from './SortableTodoItem';
import CompletedItemsAccordion from './CompletedItemsAccordion';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, transform: null, transition: undefined, isDragging: false }),
}));

const todo = (overrides: Partial<RepoTodo> = {}): RepoTodo => ({
  todoId: 'todo-1', categoryId: null, content: 'Fix invoice dates', orderIndex: 0, isCompleted: false,
  linkedDraftId: null, linkedIssueRepository: null, linkedIssueNumber: null, linkedTaskId: null,
  createdAt: '', updatedAt: '', ...overrides,
});

describe('TodoIssueLink', () => {
  it('renders nothing for a to-do without an issue', () => {
    const { container } = render(<TodoIssueLink todo={todo()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links to the GitHub issue in a new tab', () => {
    render(<TodoIssueLink todo={todo({ linkedIssueRepository: 'acme/alpha', linkedIssueNumber: 42 })} />);
    const link = screen.getByRole('link', { name: '#42' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/alpha/issues/42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('is shown on active to-dos next to the plan chip without selecting the to-do', () => {
    const onToggleSelect = vi.fn();
    render(<SortableTodoItem todo={todo({ linkedDraftId: 'draft-1', linkedIssueRepository: 'acme/alpha', linkedIssueNumber: 42 })}
      isSelected={false} onToggleSelect={onToggleSelect} onToggleComplete={vi.fn()} onDelete={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText('Linked to plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '#42' }));
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('is shown on completed to-dos', () => {
    render(<CompletedItemsAccordion forceExpand onToggleComplete={vi.fn()} onDeleteTodo={vi.fn()}
      todos={[todo({ isCompleted: true, linkedIssueRepository: 'acme/alpha', linkedIssueNumber: 7 })]} />);
    expect(screen.getByRole('link', { name: '#7' })).toHaveAttribute('href', 'https://github.com/acme/alpha/issues/7');
  });
});
