import { useState, type ReactElement } from 'react';
import { fireEvent, render as renderInDom, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTableContent } from './StateComponents';
import type { Task, TaskGroup } from './types';

const prTitle = 'Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when an issue or PR withdraws intent';
const group: TaskGroup = {
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index}`,
    title: index ? `Followup: Update ${index}` : prTitle,
    subtitle: index ? `Change number ${index}` : 'Ultrafix cycle 3 (linting)',
    status: index ? 'completed' : 'processing', createdAt: `2026-09-10T12:0${9 - index}:00Z`, completedAt: index ? '2026-09-10T12:10:00Z' : null,
    issueNumber: 2664, linkedIssueNumber: 2659, prNumber: 2664, llmProvider: 'codex', model: 'gpt-6-astra',
    critiqueScore: index === 0 ? 9 : index === 1 ? 8 : null,
    previewMedia: index === 0 ? [
      { type: 'image' as const, title: 'Desktop', url: 'https://github.com/user-attachments/assets/a' },
      { type: 'image' as const, title: 'Mobile', url: 'https://github.com/user-attachments/assets/b' },
    ] : undefined,
  } as Task & { critiqueScore: number | null })),
};

// Titles are links to the task page, so rows render inside a router.
const render = (ui: ReactElement) => renderInDom(<MemoryRouter>{ui}</MemoryRouter>);

function Fixture({ onRowClick = vi.fn(), selectedTaskId, groups = [group] }: { onRowClick?: (id: string) => void; selectedTaskId?: string | null; groups?: TaskGroup[] }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  return <TaskTableContent groupedTasks={groups} expandedGroups={expandedGroups} onRowClick={onRowClick} selectedTaskId={selectedTaskId}
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

  it('keeps all seven columns when earlier runs are expanded, and spans runs over TASK / PR to STATUS', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    fireEvent.click(within(table).getByRole('button', { name: '6 runs' }));
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7);
    const runsCell = within(table).getByRole('list', { name: 'Earlier runs' }).closest('[role="cell"]')!;
    expect(runsCell).toHaveAttribute('aria-colspan', '3');
    expect(runsCell.parentElement!.children).toHaveLength(1);
  });

  it('renders one flat row per group with a sanitized title and a single PR chip', () => {
    render(<Fixture />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).getAllByTestId('task-row')).toHaveLength(1);
    const title = within(table).getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
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
    const toggle = within(table).getByRole('button', { name: '6 runs' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(navigate).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const runs = within(table).getByRole('list', { name: 'Earlier runs' });
    expect(within(runs).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(runs).getByText('Change number 5'));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-5');
    fireEvent.click(within(table).getByRole('button', { name: '6 runs' }));
    expect(within(table).queryByRole('list', { name: 'Earlier runs' })).not.toBeInTheDocument();
  });

  it('shows the trend of runs and lists none under the row when the task opens beside the list', () => {
    render(<TaskTableContent groupedTasks={[group]} expandedGroups={new Set([group.key])} onRowClick={vi.fn()} onToggleGroup={vi.fn()} selectsInPlace />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    const chip = within(table).getByRole('img', { name: '6 runs' });
    expect(chip).toHaveAttribute('data-testid', 'run-count');
    expect(chip.tagName).toBe('SPAN');
    expect(table).not.toHaveTextContent(/earlier run/);
    expect(within(table).queryByRole('list', { name: 'Earlier runs' })).not.toBeInTheDocument();
  });

  it('caps the run track at the newest four runs, marked by outcome, and counts the rest', () => {
    const review = 'Review PR #2664: Stop work when intent is withdrawn';
    const outcomes: Array<Partial<Task>> = [
      { status: 'processing' }, { status: 'completed', score: 6, title: review }, { status: 'completed', score: 5, title: review },
      // A fix prints no score of its own, but the low one the loop recorded after it still marks the track: the code it left had findings.
      { status: 'completed', planIssueStatus: 'merged', score: 3 }, { status: 'failed' }, { status: 'completed', score: 9 },
      { status: 'completed', score: 4 }, { status: 'cancelled' },
    ];
    const busy: TaskGroup = { ...group, tasks: outcomes.map((outcome, index) => ({ ...group.tasks[Math.min(index, 5)], id: `busy-${index}`, ...outcome })) };
    render(<TaskTableContent groupedTasks={[busy]} expandedGroups={new Set()} onRowClick={vi.fn()} onToggleGroup={vi.fn()} selectsInPlace />);
    const chip = within(screen.getByRole('table', { name: 'Tasks' })).getByRole('img', { name: '8 runs' });
    expect(within(chip).getByTestId('run-track-overflow')).toHaveTextContent(/^\+4$/);
    // Oldest of the four first, the run in flight last: ■──■──■──⟳.
    expect([...chip.querySelectorAll('[data-outcome]')].map(node => node.getAttribute('data-outcome')))
      .toEqual(['findings', 'findings', 'findings', 'active']);
    // Only a review's score is quoted.
    expect(chip).toHaveAttribute('title', '8 runs: Run 5 left findings, Run 6 left findings (5/10), Run 7 left findings (6/10), Run 8 running');
  });

  it('ends each review in the inline run tree on its score, and gives a fix none', () => {
    const review = 'Review PR #2664: Stop work when intent is withdrawn';
    const runs: Array<Partial<Task>> = [
      { status: 'processing' }, { title: 'Followup: Update 2', subtitle: 'Fixed seedCommit test', score: 5 },
      { title: review, subtitle: 'Found 2 issues', score: 6 }, { title: review, subtitle: 'Initial review', score: 4 },
    ];
    const reviewed: TaskGroup = { ...group, tasks: runs.map((run, index) => ({ ...group.tasks[index], ...run })) };
    render(<Fixture groups={[reviewed]} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    fireEvent.click(within(table).getByRole('button', { name: '4 runs' }));
    const items = within(within(table).getByRole('list', { name: 'Earlier runs' })).getAllByRole('listitem');
    expect(items.map(item => [item.textContent?.match(/Review|Fix/)?.[0], within(item).queryByTestId('run-score')?.textContent ?? null]))
      .toEqual([['Fix', null], ['Review', '[6]'], ['Review', '[4]']]);
  });

  it('draws no chevron on a card: the title is the link and the run track shows the trend without opening runs in place', () => {
    const onRowClick = vi.fn();
    const { container } = render(<Fixture onRowClick={onRowClick} />);
    const card = container.querySelector('[data-testid="task-card"]') as HTMLElement;
    expect(card.querySelector('svg.lucide-chevron-right, svg.lucide-chevron-down')).toBeNull();
    expect(within(card).queryByRole('button')).toBeNull();
    fireEvent.click(within(card).getByRole('img', { name: '6 runs' }));
    expect(within(card).queryByRole('list', { name: 'Earlier runs' })).toBeNull();
    expect(onRowClick).toHaveBeenCalledWith(group.tasks[0].id);
  });

  it('marks a queued newest run as waiting, never as a run in flight', () => {
    const queued: TaskGroup = { ...group, tasks: [{ ...group.tasks[0], id: 'queued-run', status: 'queued' }, ...group.tasks.slice(1, 3)] };
    render(<TaskTableContent groupedTasks={[queued]} expandedGroups={new Set()} onRowClick={vi.fn()} onToggleGroup={vi.fn()} selectsInPlace />);
    const chip = within(screen.getByRole('table', { name: 'Tasks' })).getByRole('img', { name: '3 runs' });
    const newest = [...chip.querySelectorAll('[data-outcome]')].at(-1)!;
    expect(newest).toHaveAttribute('data-outcome', 'waiting');
    expect(chip.querySelector('.animate-ping')).toBeNull();
    expect(chip.getAttribute('title')).toMatch(/Run 3 waiting to start$/);
  });

  it('keeps a single run without a summary on one line, its type in front of the title', () => {
    const single: TaskGroup = {
      key: 'integry/desktop-workspaces-issue-86', repoOwner: 'integry', repoName: 'desktop-workspaces', prNumber: null,
      tasks: [{
        id: 'issue-86', title: 'New Issue: [86 by Claude] Support configuration paths', status: 'failed',
        createdAt: '2026-09-10T12:00:00Z', issueNumber: 86, previewMedia: [{ type: 'image', title: 'Desktop', url: 'https://github.com/user-attachments/assets/c' }],
      }],
    };
    render(<TaskTableContent groupedTasks={[single]} expandedGroups={new Set()} onRowClick={vi.fn()} onToggleGroup={vi.fn()} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    const title = within(table).getByRole('link', { name: 'Support configuration paths' });
    const titleLine = title.parentElement!;
    // Chip, type, title, previews: all on the title line, and nothing under it.
    expect([...titleLine.children].map(child => child.textContent)).toEqual(['Issue #86', 'Implement', 'Support configuration paths', '1 preview']);
    expect(titleLine.nextElementSibling).toBeNull();
    // The owner is the same on every row, so the repository cell shows the name; the tooltip keeps both.
    const repo = within(table).getByTestId('repository-chip');
    expect(repo).toHaveTextContent(/^desktop-workspaces$/);
    expect(repo).toHaveAttribute('title', 'integry/desktop-workspaces');
  });

  it('ignores historical critique scores in rows and earlier runs', () => {
    expect((group.tasks[0] as Task & { critiqueScore: number }).critiqueScore).toBe(9);
    expect((group.tasks[1] as Task & { critiqueScore: number }).critiqueScore).toBe(8);
    render(<Fixture />);
    expect(screen.queryByTitle('Code Quality Score: 9/10')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '6 runs' }));
    for (const runs of screen.getAllByRole('list', { name: 'Earlier runs' })) {
      expect(runs).toHaveTextContent('Change number 1');
    }
    expect(screen.queryByTitle('Code Quality Score: 8/10')).not.toBeInTheDocument();
  });

  it('shows the newest review score in the SCORE column, and a dash for a task no review scored', () => {
    const reviewed: TaskGroup = {
      key: 'integry/propr-pr-2700', repoOwner: 'integry', repoName: 'propr', prNumber: 2700,
      tasks: [
        { id: 'fix-2', title: 'Fix PR #2700', status: 'completed', createdAt: '2026-09-10T12:09:00Z', completedAt: '2026-09-10T12:10:00Z', prNumber: 2700, score: 5 },
        { id: 'review-2', title: 'Review PR #2700', status: 'completed', createdAt: '2026-09-10T12:08:00Z', completedAt: '2026-09-10T12:09:00Z', prNumber: 2700, score: 8 },
        { id: 'review-1', title: 'Review PR #2700', status: 'completed', createdAt: '2026-09-10T12:07:00Z', completedAt: '2026-09-10T12:08:00Z', prNumber: 2700, score: 4 },
      ] as Task[],
    };
    render(<Fixture groups={[reviewed, group]} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    const [reviewedRow, unscoredRow] = within(table).getAllByTestId('task-row');
    // A fix's score belongs to the loop, not the fix, so the newest review's 8 is the task's score.
    const score = within(reviewedRow).getByTitle('Review score: 8/10');
    expect(score.textContent).toBe('[8]');
    expect(score.closest('[role="cell"]')).toBe(reviewedRow.querySelector('[role="row"]')!.lastElementChild);
    expect(within(unscoredRow).getByLabelText('No score')).toHaveTextContent('—');
  });

  it('keeps selection from opening a row and permits intentional keyboard activation', () => {
    const navigate = vi.fn();
    render(<Fixture onRowClick={navigate} />);
    const table = screen.getByRole('table', { name: 'Tasks' });
    const title = within(table).getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
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

  it('links each title to its task page and leaves modified clicks to the browser', () => {
    const open = vi.fn();
    render(<Fixture onRowClick={open} />);
    const title = within(screen.getByRole('table')).getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
    expect(title).toHaveAttribute('href', '/tasks/task-0');
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(fireEvent.click(title, { detail: 1, ...modifier })).toBe(true);
    }
    expect(fireEvent.click(title, { detail: 1, button: 1 })).toBe(true);
    expect(open).not.toHaveBeenCalled();
    // A plain click is handled in place: the link's navigation is prevented.
    expect(fireEvent.click(title, { detail: 1 })).toBe(false);
    expect(open).toHaveBeenCalledExactlyOnceWith('task-0');
  });

  it('marks the row of the selected task, including when an earlier run is selected', () => {
    const { rerender } = render(<Fixture selectedTaskId="task-0" />);
    const row = () => within(screen.getByRole('table')).getAllByTestId('task-row')[0].querySelector('[role="row"]')!;
    expect(row()).toHaveAttribute('aria-selected', 'true');
    expect(row().className).toContain('bg-slate-100/80');
    // The open task's title is dark and bold, not drawn as a link.
    const title = row().querySelector('a.task-title')!;
    expect(title).toHaveAttribute('aria-current', 'true');
    expect(title.className).toContain('font-semibold');
    rerender(<MemoryRouter><Fixture selectedTaskId="task-3" /></MemoryRouter>);
    expect(row()).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '6 runs' }));
    const runs = within(screen.getByRole('table')).getByRole('list', { name: 'Earlier runs' });
    expect(within(runs).getByText('Change number 3').closest('button')).toHaveAttribute('aria-current', 'true');
    rerender(<MemoryRouter><Fixture selectedTaskId="elsewhere" /></MemoryRouter>);
    expect(row()).toHaveAttribute('aria-selected', 'false');
  });

  it('ends a legacy title that may be hard-cut at 100 characters with an ellipsis, keeping its last word, in rows, cards and earlier runs', () => {
    const hardCut = 'New Issue: Expose task changes, logs and events through the MCP server so that an MCP client can act';
    expect(hardCut).toHaveLength(100);
    const runCut = 'Followup: Expose the implementation log and the terminal output through MCP so that a client can rea';
    expect(runCut).toHaveLength(100);
    const cut: TaskGroup = {
      key: 'integry/propr-issue-12', repoOwner: 'integry', repoName: 'propr', prNumber: null,
      tasks: [
        { id: 'cut-0', title: hardCut, status: 'completed', createdAt: '2026-09-10T12:09:00Z', issueNumber: 12 },
        { id: 'cut-1', title: runCut, status: 'completed', createdAt: '2026-09-10T12:08:00Z', issueNumber: 12 },
      ],
    };
    render(<Fixture groups={[cut]} />);
    const shown = 'Expose task changes, logs and events through the MCP server so that an MCP client can act…';
    const table = screen.getByRole('table');
    const title = within(table).getByRole('link', { name: shown });
    expect(title).toHaveAttribute('title', 'Expose task changes, logs and events through the MCP server so that an MCP client can act');
    const cards = screen.getAllByTestId('task-card');
    expect(within(cards[0]).getByRole('link', { name: shown })).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: '2 runs' }));
    const runs = within(table).getByRole('list', { name: 'Earlier runs' });
    expect(runs).toHaveTextContent('Expose the implementation log and the terminal output through MCP so that a client can rea…');
  });
});
