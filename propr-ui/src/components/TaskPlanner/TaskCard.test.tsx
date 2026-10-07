import { render, screen } from '@testing-library/react';
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
