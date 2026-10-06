import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSteeringState } from '../../api/taskSteeringApi';
import TaskSteeringPanel from './TaskSteeringPanel';

const api = vi.hoisted(() => ({ getTaskSteering: vi.fn(), steerTask: vi.fn() }));
vi.mock('../../api/taskSteeringApi', () => api);

function steeringState(overrides: Partial<TaskSteeringState> = {}): TaskSteeringState {
  return {
    steers: [], running: true, capability: 'live', agentAlias: 'claude-default', agentType: 'claude',
    maxMessageLength: 4000, maxSteersPerRun: 20, ...overrides,
  };
}

describe('TaskSteeringPanel', () => {
  beforeEach(() => {
    api.getTaskSteering.mockReset();
    api.steerTask.mockReset();
  });
  afterEach(cleanup);

  it('sends a steer to a running live agent and lists it', async () => {
    api.getTaskSteering.mockResolvedValueOnce(steeringState()).mockResolvedValue(steeringState({
      steers: [{
        id: 'steer-1', sequence: 1, taskId: 'task-1', author: 'octocat', authorSource: 'session',
        message: 'Use the existing helper', createdAt: '2026-10-06T12:00:00Z',
        deliveredAt: '2026-10-06T12:00:01Z', delivery: 'live', acknowledgedAt: '2026-10-06T12:00:01Z',
      }],
    }));
    api.steerTask.mockResolvedValue({});
    render(<TaskSteeringPanel taskId="task-1" isTaskActive={false} />);

    const input = await screen.findByLabelText('Steer the running agent');
    fireEvent.change(input, { target: { value: '  Use the existing helper  ' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(api.steerTask).toHaveBeenCalledWith('task-1', 'Use the existing helper'));
    expect(await screen.findByText('Use the existing helper')).toBeTruthy();
    expect(screen.getByText('octocat · Delivered')).toBeTruthy();
    expect(screen.getByText('Operator input during the run')).toBeTruthy();
  });

  it('explains why an agent without steering cannot receive input', async () => {
    api.getTaskSteering.mockResolvedValue(steeringState({ capability: 'none', agentType: 'opencode' }));
    render(<TaskSteeringPanel taskId="task-1" isTaskActive={false} />);

    expect(await screen.findByText(/opencode agent cannot receive input during a task run \(steering capability: none\)/)).toBeTruthy();
    expect(screen.queryByLabelText('Steer the running agent')).toBeNull();
  });

  it('shows the API error when a steer is rejected', async () => {
    api.getTaskSteering.mockResolvedValue(steeringState());
    api.steerTask.mockRejectedValue(new Error('Task is not running'));
    render(<TaskSteeringPanel taskId="task-1" isTaskActive={false} />);

    fireEvent.change(await screen.findByLabelText('Steer the running agent'), { target: { value: 'Stop refactoring' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect((await screen.findByRole('alert')).textContent).toBe('Task is not running');
  });

  it('renders nothing for a finished task that was never steered', async () => {
    api.getTaskSteering.mockResolvedValue(steeringState({ running: false }));
    const { container } = render(<TaskSteeringPanel taskId="task-1" isTaskActive={false} />);
    await waitFor(() => expect(api.getTaskSteering).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('does not show or send a draft composed for one task after switching to another', async () => {
    let resolveB!: (state: TaskSteeringState) => void;
    api.getTaskSteering.mockImplementation((taskId: string) => (taskId === 'task-a'
      ? Promise.resolve(steeringState({ steers: [{
        id: 'steer-a', sequence: 1, taskId: 'task-a', author: 'octocat', authorSource: 'session',
        message: 'History of task A', createdAt: '2026-10-06T12:00:00Z',
        deliveredAt: null, delivery: null, acknowledgedAt: null,
      }] }))
      : new Promise<TaskSteeringState>(resolve => { resolveB = resolve; })));
    api.steerTask.mockResolvedValue({});
    const { rerender } = render(<TaskSteeringPanel taskId="task-a" isTaskActive={false} />);

    fireEvent.change(await screen.findByLabelText('Steer the running agent'), { target: { value: 'Instructions for A' } });
    expect(screen.getByText('History of task A')).toBeTruthy();

    rerender(<TaskSteeringPanel taskId="task-b" isTaskActive={false} />);
    await waitFor(() => expect(api.getTaskSteering).toHaveBeenCalledWith('task-b'));
    // While B loads, neither A's history nor A's send box is available.
    expect(screen.queryByText('History of task A')).toBeNull();
    expect(screen.queryByLabelText('Steer the running agent')).toBeNull();

    resolveB(steeringState());
    const input = await screen.findByLabelText('Steer the running agent') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest('form')!);
    expect(api.steerTask).not.toHaveBeenCalled();
  });

  it('ignores a steering response for a task the panel no longer shows', async () => {
    let resolveA!: (state: TaskSteeringState) => void;
    api.getTaskSteering.mockImplementation((taskId: string) => (taskId === 'task-a'
      ? new Promise<TaskSteeringState>(resolve => { resolveA = resolve; })
      : Promise.resolve(steeringState({ capability: 'none', agentType: 'opencode' }))));
    const { rerender } = render(<TaskSteeringPanel taskId="task-a" isTaskActive={false} />);
    await waitFor(() => expect(api.getTaskSteering).toHaveBeenCalledWith('task-a'));

    rerender(<TaskSteeringPanel taskId="task-b" isTaskActive={false} />);
    expect(await screen.findByText(/opencode agent cannot receive input/)).toBeTruthy();

    resolveA(steeringState());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText(/opencode agent cannot receive input/)).toBeTruthy();
    expect(screen.queryByLabelText('Steer the running agent')).toBeNull();
  });

  it('does not clear or report on the new task when a send for the previous task completes', async () => {
    let rejectSend!: (error: Error) => void;
    api.getTaskSteering.mockResolvedValue(steeringState());
    api.steerTask.mockImplementation(() => new Promise((_, reject) => { rejectSend = reject; }));
    const { rerender } = render(<TaskSteeringPanel taskId="task-a" isTaskActive={false} />);

    fireEvent.change(await screen.findByLabelText('Steer the running agent'), { target: { value: 'For A' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(api.steerTask).toHaveBeenCalledWith('task-a', 'For A'));

    rerender(<TaskSteeringPanel taskId="task-b" isTaskActive={false} />);
    const input = await screen.findByLabelText('Steer the running agent') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'For B' } });

    rejectSend(new Error('Task is not running'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Steer the running agent') as HTMLTextAreaElement).value).toBe('For B');
  });
});
