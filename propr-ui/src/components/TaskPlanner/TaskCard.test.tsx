import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TaskCard from './TaskCard';
import type { PlanTask } from '../../api/proprApi';

const task = {
  id: 'task-3',
  title: 'Agents v1 (3/3): Agent run store with guarded state machine',
  body: 'Body',
  implementation: '',
} as PlanTask;

describe('TaskCard heading', () => {
  it('drops the generated "<plan> (n/m):" prefix so a reordered step does not show a stale counter', () => {
    render(<TaskCard task={task} isHighlighted={false} stepNumber={1} draftId="draft" onChange={vi.fn()} onDelete={vi.fn()} />);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent(/^Agent run store with guarded state machine$/);
    expect(heading).toHaveAttribute('title', task.title);
    expect(screen.getByText('1.')).toBeInTheDocument();
  });

  it('keeps titles without a step counter unchanged', () => {
    render(<TaskCard task={{ ...task, title: 'Agent run store (v2): phase one' }} isHighlighted={false} stepNumber={2} draftId="draft" onChange={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Agent run store (v2): phase one');
  });
});

describe('TaskCard delete', () => {
  const renderCard = (isMobile: boolean) => {
    const onDelete = vi.fn();
    render(<TaskCard task={task} isHighlighted={false} stepNumber={3} draftId="draft" onChange={vi.fn()} onDelete={onDelete} isMobile={isMobile} />);
    return onDelete;
  };

  it('asks for confirmation before the desktop heading icon deletes the task', () => {
    const onDelete = renderCard(false);
    fireEvent.click(screen.getByTitle('Delete task'));
    expect(onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Delete task 3?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Delete task'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps only the pencil in the phone heading and moves a guarded Delete into edit mode', () => {
    const onDelete = renderCard(true);
    expect(screen.queryByTitle('Delete task')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Edit task'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('puts the edit-mode Delete at the end of the step, after the notes, not inside the specification', () => {
    renderCard(true);
    fireEvent.click(screen.getByTitle('Edit task'));
    const deleteButton = screen.getByRole('button', { name: 'Delete task' });
    for (const section of ['Suggested Implementation', 'User Notes']) {
      expect(screen.getByText(section).compareDocumentPosition(deleteButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('TaskCard title editor', () => {
  it('wraps the full title instead of clipping it in a one-line input, and keeps it one line of text', () => {
    const onChange = vi.fn();
    render(<TaskCard task={task} isHighlighted={false} stepNumber={1} draftId="draft" onChange={onChange} onDelete={vi.fn()} isMobile />);
    fireEvent.click(screen.getByTitle('Edit task'));
    const title = screen.getByRole('textbox', { name: 'Task title' });
    expect(title.tagName).toBe('TEXTAREA');
    expect(title).toHaveValue(task.title);
    expect(title).toHaveClass('resize-none');
    fireEvent.change(title, { target: { value: 'Shared\ncontracts' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: 'Shared contracts' }));
  });
});
