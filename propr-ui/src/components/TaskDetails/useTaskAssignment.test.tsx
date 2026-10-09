import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttributedUser } from '@propr/shared';
import { useTaskAssignment } from './useTaskAssignment';
import AssignmentControl from './AssignmentControl';
import { TaskAssignmentRequestError } from '../../api/taskAssignment';

const api = vi.hoisted(() => ({
  getTaskAssignees: vi.fn(),
  getAssignableUsers: vi.fn(),
  setTaskAssignees: vi.fn(),
}));
vi.mock('../../api/taskAssignment', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/taskAssignment')>()),
  ...api,
}));
const addToast = vi.fn();
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast }) }));

const user = (id: number, login: string): AttributedUser => ({ id: String(id), login, displayName: null, avatarUrl: null });
const octocat = user(1, 'octocat');
const hubot = user(2, 'hubot');
const monalisa = user(3, 'monalisa');
const subject = { owner: 'integry', repo: 'propr', number: 2894, kind: 'issue' as const };
const outage = () => new TaskAssignmentRequestError('GitHub could not be reached', 502, 'GITHUB_UNAVAILABLE');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const logins = (users: AttributedUser[]) => users.map(entry => entry.login);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getTaskAssignees.mockResolvedValue({ subject, assignees: [octocat], synced: true });
  api.getAssignableUsers.mockResolvedValue({ users: [octocat, hubot, monalisa], truncated: false });
});

describe('useTaskAssignment saves', () => {
  it('refuses a second save while the first is in flight and restores the confirmed assignees when it fails', async () => {
    const pending = deferred<never>();
    api.setTaskAssignees.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useTaskAssignment('task-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first!: Promise<boolean>;
    act(() => { first = result.current.save(['hubot']); });
    expect(logins(result.current.assignees)).toEqual(['hubot']);
    expect(result.current.saving).toBe(true);

    let second!: boolean;
    await act(async () => { second = await result.current.save(['monalisa']); });
    expect(second).toBe(false);
    expect(api.setTaskAssignees).toHaveBeenCalledTimes(1);
    expect(logins(result.current.assignees)).toEqual(['hubot']);

    await act(async () => {
      pending.reject(outage());
      await expect(first).resolves.toBe(false);
    });
    expect(logins(result.current.assignees)).toEqual(['octocat']);
    expect(result.current.saving).toBe(false);
  });

  it('accepts the next save once the first settles, rolling back to what GitHub last confirmed', async () => {
    api.setTaskAssignees
      .mockResolvedValueOnce({ subject, assignees: [hubot], rejected: [] })
      .mockRejectedValueOnce(outage());
    const { result } = renderHook(() => useTaskAssignment('task-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await expect(result.current.save(['hubot'])).resolves.toBe(true); });
    await act(async () => { await expect(result.current.save(['monalisa'])).resolves.toBe(false); });

    expect(api.setTaskAssignees).toHaveBeenCalledTimes(2);
    expect(logins(result.current.assignees)).toEqual(['hubot']);
  });

  it('takes saves again after switching task while one was in flight', async () => {
    api.setTaskAssignees.mockReturnValueOnce(deferred<never>().promise);
    const { result, rerender } = renderHook(({ id }) => useTaskAssignment(id), { initialProps: { id: 'task-1' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.save(['hubot']); });

    api.setTaskAssignees.mockResolvedValueOnce({ subject, assignees: [monalisa], rejected: [] });
    rerender({ id: 'task-2' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.save(['monalisa'])).resolves.toBe(true); });
    expect(logins(result.current.assignees)).toEqual(['monalisa']);
  });
});

describe('AssignmentControl while saving', () => {
  const Harness = () => {
    const assignment = useTaskAssignment('task-1');
    return <AssignmentControl assignment={assignment} />;
  };

  it('does not open the editor until the pending save settles', async () => {
    const pending = deferred<never>();
    api.setTaskAssignees.mockReturnValueOnce(pending.promise);
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit assignees' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /@hubot/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const trigger = screen.getByRole('button', { name: 'Edit assignees' });
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog', { name: 'Assign users' })).toBeNull();

    await act(async () => { pending.reject(outage()); });
    expect(screen.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Assigned to @hubot' })).toBeNull();
    expect(trigger).not.toHaveAttribute('aria-disabled');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Assign users' })).toBeInTheDocument();
  });

  it('disables Save in an editor that was already open when another save started', async () => {
    const pending = deferred<never>();
    api.setTaskAssignees.mockReturnValueOnce(pending.promise);
    let assignment!: ReturnType<typeof useTaskAssignment>;
    const Open = () => {
      assignment = useTaskAssignment('task-1');
      return <AssignmentControl assignment={assignment} />;
    };
    render(<Open />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit assignees' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /@monalisa/ }));
    // The other layout's editor saves first.
    act(() => { void assignment.save(['hubot']); });

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(api.setTaskAssignees).toHaveBeenCalledTimes(1);

    await act(async () => { pending.reject(outage()); });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
