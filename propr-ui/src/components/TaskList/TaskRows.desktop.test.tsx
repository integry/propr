import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTableContent } from './StateComponents';
import type { TaskGroup } from './types';

const runtime = vi.hoisted(() => ({ platform: 'macos' as string | null }));
vi.mock('../../desktop/DesktopContext', () => ({ useDesktop: () => runtime.platform ? { platform: runtime.platform } : null }));
const group: TaskGroup = {
  key: 'fixture/desktop#42', repoOwner: 'fixture', repoName: 'desktop', prNumber: 42,
  tasks: Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index}`, title: index ? `Followup: Update ${index}` : 'New Issue: Improve task navigation',
    status: 'completed', createdAt: '2026-09-10T12:00:00Z', completedAt: '2026-09-10T12:05:00Z',
  })),
};

function Fixture({ onRowClick = vi.fn() }: { onRowClick?: (id: string) => void }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  return <TaskTableContent groupedTasks={[group]} expandedGroups={expandedGroups} onRowClick={onRowClick}
    onToggleGroup={key => setExpandedGroups(new Set([key]))} />;
}

afterEach(() => { runtime.platform = 'macos'; vi.restoreAllMocks(); });

describe('desktop task rows', () => {
  it.each(['macos', 'linux'])('retains named navigation and independent expansion on %s', platform => {
    runtime.platform = platform;
    const navigate = vi.fn();
    render(<Fixture onRowClick={navigate} />);
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Improve task navigation' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-0');
    navigate.mockClear();
    fireEvent.click(within(table).getByRole('button', { name: 'Show 2 older updates...' }));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(within(table).getByRole('button', { name: 'Update 5' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-5');
  });

  it('keeps selection from opening a row and permits intentional keyboard activation', () => {
    const navigate = vi.fn();
    render(<Fixture onRowClick={navigate} />);
    const table = screen.getByRole('table');
    const title = within(table).getByRole('button', { name: 'Improve task navigation' });
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.addRange(range);
    fireEvent.click(title.closest('tr')!);
    fireEvent.click(title, { detail: 1 });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(title, { detail: 0 });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-0');
    selection.removeAllRanges();
    navigate.mockClear();
    fireEvent.click(title.closest('tr')!);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('task-0');
  });

  it.each([null, 'windows'])('preserves the existing table outside macOS/Linux (%s)', platform => {
    runtime.platform = platform;
    render(<Fixture />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Improve task navigation' })).not.toBeInTheDocument();
  });
});
