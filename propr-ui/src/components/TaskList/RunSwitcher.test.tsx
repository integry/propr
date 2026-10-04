import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunSwitcher } from './RunSwitcher';
import type { TaskGroup } from './types';

const group: TaskGroup = {
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: [
    { id: 'run-8', title: 'Ultrafix PR #2664: Stop work when intent is withdrawn', subtitle: 'Ultrafix cycle 3 (linting)', status: 'processing', createdAt: '2026-09-10T12:09:00Z', prNumber: 2664 },
    { id: 'run-7', title: 'Followup: Update 7', subtitle: 'Fixed seedCommit test', status: 'completed', createdAt: '2026-09-10T12:08:00Z', prNumber: 2664 },
    { id: 'run-6', title: 'Followup: Update 6', status: 'failed', failedReason: 'Lint failed', createdAt: '2026-09-10T12:07:00Z', prNumber: 2664 },
  ],
};

describe('RunSwitcher', () => {
  it('names the open run against the task\'s run count and lists every run newest first', () => {
    render(<RunSwitcher group={group} selectedTaskId="run-8" onSelect={vi.fn()} />);
    expect(screen.getByTestId('run-switcher')).toHaveTextContent('Run 3 of 3 (Active)');
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Run 3 (Active) — Ultrafix cycle 3 (linting)',
      'Run 2 (Completed) — Fixed seedCommit test',
      'Run 1 (Failed) — Lint failed',
    ]);
  });

  it('opens the chosen run', () => {
    const onSelect = vi.fn();
    render(<RunSwitcher group={group} selectedTaskId="run-7" onSelect={onSelect} />);
    expect(screen.getByTestId('run-switcher')).toHaveTextContent('Run 2 of 3 (Completed)');
    fireEvent.change(screen.getByRole('combobox', { name: 'Run' }), { target: { value: 'run-6' } });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('run-6');
  });

  it('is not drawn for a task with one run', () => {
    render(<RunSwitcher group={{ ...group, tasks: group.tasks.slice(0, 1) }} selectedTaskId="run-8" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('run-switcher')).not.toBeInTheDocument();
  });
});
