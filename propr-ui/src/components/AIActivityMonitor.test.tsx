import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunningItem } from '../hooks/useHeaderStats';
import AIActivityMonitor from './AIActivityMonitor';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const taskItem = (overrides: Partial<RunningItem>): RunningItem => ({
  id: 'queue-job',
  type: 'task',
  label: 'Live queue job',
  repository: 'integry/propr',
  status: 'Implementing',
  createdAt: '2026-08-14T20:00:00.000Z',
  ...overrides,
});

function openMonitor(runningItems: RunningItem[]): void {
  render(<AIActivityMonitor runningItems={runningItems} runningCount={runningItems.length} />);
  fireEvent.click(screen.getByRole('button', { name: `${runningItems.length}Running` }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AIActivityMonitor task navigation', () => {
  it.each([
    ['issue child', 'Issue child task', 'issue-task-id'],
    ['PR job', 'Pull request task', 'pr-job-id'],
  ])('navigates a %s using its proven task ID', (_kind, label, navigationId) => {
    openMonitor([taskItem({ id: `${navigationId}-queue`, label, navigationId })]);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${navigationId}`);
  });

  it('renders parent, system, and import jobs as disabled non-navigation entries', () => {
    openMonitor([
      taskItem({ id: 'issue-parent', label: 'Issue matrix parent' }),
      taskItem({ id: 'system-job', label: 'System revert job' }),
      taskItem({ id: 'import-job', label: 'Task import job' }),
    ]);

    for (const label of ['Issue matrix parent', 'System revert job', 'Task import job']) {
      const entry = screen.getByRole('button', { name: new RegExp(label) });
      expect(entry).toBeDisabled();
      fireEvent.click(entry);
    }

    expect(navigate).not.toHaveBeenCalled();
  });
});
