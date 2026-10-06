import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ScheduledBadge } from './ScheduledBadge';
import { scheduledLabel } from '../utils/scheduleProvenance';
import { TaskTableContent } from './TaskList/StateComponents';
import type { TaskGroup } from './TaskList/types';
import ContextStrip from './TaskDetails/ContextStrip';

const scheduledGroup = (scheduleName: string | null, scheduleId: string | null = 'schedule-1'): TaskGroup => ({
  key: 'integry/propr-issue-12', repoOwner: 'integry', repoName: 'propr',
  tasks: [{
    id: 'task-scheduled', title: 'Bump vulnerable dependencies', status: 'completed', issueNumber: 12,
    createdAt: '2026-10-06T02:00:00Z', completedAt: '2026-10-06T02:10:00Z',
    ...(scheduleId ? { scheduleId, scheduleName } : {}),
  }],
});

const renderRows = (group: TaskGroup, onRowClick = vi.fn(), selectsInPlace = false) => render(
  <MemoryRouter>
    <TaskTableContent groupedTasks={[group]} expandedGroups={new Set()} onRowClick={onRowClick} onToggleGroup={vi.fn()} selectsInPlace={selectsInPlace} />
  </MemoryRouter>,
);

describe('scheduled task provenance', () => {
  it('labels a scheduled task row "Scheduled: <name>" and links to the schedules', () => {
    const onRowClick = vi.fn();
    renderRows(scheduledGroup('Nightly dependency patrol'), onRowClick);
    const [badge] = screen.getAllByTestId('scheduled-badge');
    expect(badge).toHaveTextContent('Scheduled: Nightly dependency patrol');
    expect(badge).toHaveAttribute('href', '/settings?tab=automation#scheduled-tasks');
    fireEvent.click(badge);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('shows the badge on the card form of the row', () => {
    renderRows(scheduledGroup('Nightly dependency patrol'), vi.fn(), true);
    const card = screen.getAllByTestId('task-card')[0];
    expect(within(card).getByTestId('scheduled-badge')).toHaveTextContent('Scheduled: Nightly dependency patrol');
  });

  it('says "Scheduled" once the schedule is deleted, and nothing for a manual task', () => {
    const { unmount } = renderRows(scheduledGroup(null));
    expect(screen.getAllByTestId('scheduled-badge')[0]).toHaveTextContent(/^Scheduled$/);
    unmount();
    renderRows(scheduledGroup(null, null));
    expect(screen.queryByTestId('scheduled-badge')).not.toBeInTheDocument();
  });

  it('shows the schedule in the task detail context strip', () => {
    render(
      <MemoryRouter>
        <ContextStrip
          taskInfo={{ repoOwner: 'integry', repoName: 'propr', type: 'issue', number: 12, scheduleId: 'schedule-1', scheduleName: 'Nightly dependency patrol' }}
          modelName="gpt-6-astra"
          part="git"
        />
      </MemoryRouter>,
    );
    const git = screen.getByRole('group', { name: 'Git context' });
    expect(within(git).getByTestId('scheduled-badge')).toHaveTextContent('Scheduled: Nightly dependency patrol');
  });

  it('falls back to "Scheduled" for a blank name', () => {
    expect(scheduledLabel('  ')).toBe('Scheduled');
    render(<MemoryRouter><ScheduledBadge scheduleName="Weekly cleanup" /></MemoryRouter>);
    expect(screen.getByTestId('scheduled-badge')).toHaveAttribute('title', 'Scheduled: Weekly cleanup — open scheduled tasks');
  });
});
