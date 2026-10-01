import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTableContent } from './StateComponents';
import type { TaskGroup } from './types';

const prTitle = 'Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when an issue or PR withdraws intent';
const group: TaskGroup = {
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index}`,
    title: index ? `Followup: Update ${index}` : prTitle,
    subtitle: index ? `Change number ${index}` : 'Ultrafix cycle 3 (linting)',
    status: index ? 'completed' : 'processing', createdAt: `2026-09-10T12:0${9 - index}:00Z`, completedAt: index ? '2026-09-10T12:10:00Z' : null,
    issueNumber: 2664, linkedIssueNumber: 2659, prNumber: 2664, llmProvider: 'codex', model: 'gpt-6-astra',
    critiqueScore: index === 1 ? 8 : null,
    previewMedia: index === 0 ? [
      { type: 'image' as const, title: 'Desktop', url: 'https://github.com/user-attachments/assets/a' },
      { type: 'image' as const, title: 'Mobile', url: 'https://github.com/user-attachments/assets/b' },
    ] : undefined,
  })),
};

function Fixture({ onRowClick = vi.fn() }: { onRowClick?: (id: string) => void }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  return <TaskTableContent groupedTasks={[group]} expandedGroups={expandedGroups} onRowClick={onRowClick}
    onToggleGroup={key => setExpandedGroups(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    })} />;
}

afterEach(() => { vi.restoreAllMocks(); window.getSelection()?.removeAllRanges(); });

describe('task ledger rows', () => {
  it('labels every column', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent))
      .toEqual(['Task / PR', 'Repo', 'Status', 'Agent', 'Duration', 'Updated', 'Score']);
  });

  it('keeps all seven columns when earlier runs are expanded, and spans runs across the row', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    fireEvent.click(within(table).getByRole('button', { name: /5 earlier runs/ }));
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7);
    const runsCell = within(table).getByRole('list', { name: 'Earlier runs' }).closest('[role="cell"]')!;
    expect(runsCell).toHaveAttribute('aria-colspan', '7');
    expect(runsCell.parentElement!.children).toHaveLength(1);
  });

  it('renders one flat row per group with a sanitized title and a single PR chip', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).getAllByTestId('task-row')).toHaveLength(1);
    const title = within(table).getByRole('button', { name: 'Stop work when an issue or PR withdraws intent' });
    expect(title).toBeInTheDocument();
    expect(table.textContent).not.toContain('[2659 by');
    expect(table.textContent).not.toContain('Ultrafix PR #2664');
    expect(within(table).getAllByText('PR #2664')).toHaveLength(1);
    expect(within(table).getByText('Ultrafix cycle 3 (linting)')).toBeInTheDocument();
    expect(within(table).queryByText(/^Update \d$/)).not.toBeInTheDocument();
  });

  it('announces previews as a badge instead of drawing thumbnails', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).getByTestId('preview-count')).toHaveTextContent('2 previews');
    expect(within(table).queryByRole('img')).not.toBeInTheDocument();
    expect(within(table).queryByRole('group', { name: 'Published visual previews' })).not.toBeInTheDocument();
  });

  it('keeps earlier runs rolled up until asked, then opens each run on its own', () => {
    const navigate = vi.fn();
    render(<Fixture onRowClick={navigate} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).queryByText('Change number 1')).not.toBeInTheDocument();
    const toggle = within(table).getByRole('button', { name: /5 earlier runs/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(navigate).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const runs = within(table).getByRole('list', { name: 'Earlier runs' });
    expect(within(runs).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(runs).getByText('Change number 5'));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-5');
    fireEvent.click(within(table).getByRole('button', { name: /Hide 5 earlier runs/ }));
    expect(within(table).queryByRole('list', { name: 'Earlier runs' })).not.toBeInTheDocument();
  });

  it('uses the bracketed score pill', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    fireEvent.click(within(table).getByRole('button', { name: /5 earlier runs/ }));
    const score = within(table).getByTitle('Code Quality Score: 8/10');
    expect(score.textContent).toBe('[8]');
  });

  it('keeps selection from opening a row and permits intentional keyboard activation', () => {
    const navigate = vi.fn();
    render(<Fixture onRowClick={navigate} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    const title = within(table).getByRole('button', { name: 'Stop work when an issue or PR withdraws intent' });
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.addRange(range);
    fireEvent.click(title.closest('[role="row"]')!);
    fireEvent.click(title, { detail: 1 });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(title, { detail: 0 });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-0');
    selection.removeAllRanges();
    navigate.mockClear();
    fireEvent.click(title.closest('[role="row"]')!);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-0');
  });
});
