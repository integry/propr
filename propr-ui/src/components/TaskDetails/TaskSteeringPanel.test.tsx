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
});
