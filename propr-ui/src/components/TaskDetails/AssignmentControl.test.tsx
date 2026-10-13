import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AssignmentControl from './AssignmentControl';
import type { TaskAssignment } from './useTaskAssignment';

it('opens and releases the mobile sheet without optional browser APIs', () => {
  vi.stubGlobal('matchMedia', undefined);
  vi.stubGlobal('scrollTo', undefined);
  const assignment: TaskAssignment = {
    taskId: 'task', assignees: [], subject: null, loading: false, error: null,
    reload: vi.fn(), unavailable: false, editable: true, saving: false,
    save: vi.fn(), loadAssignableUsers: vi.fn(),
    assignable: { users: [], loading: false, error: null, truncated: false },
  };
  const { unmount } = render(<AssignmentControl assignment={assignment} dense />);
  fireEvent.click(screen.getByRole('button', { name: 'Assign users' }));
  expect(screen.getByRole('dialog', { name: 'Assign users' })).toBeInTheDocument();
  expect(document.body.style.position).toBe('fixed');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.position).toBe('');
  unmount();
  vi.unstubAllGlobals();
});
