import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoalsPage from './GoalsPage';
import * as goalsApi from '../api/goals';
import { getInstanceCatalog, getTaskLiveDetails } from '../api/proprApi';

vi.mock('../api/goals', () => ({
  getGoalCapabilities: vi.fn(), listGoals: vi.fn(), getGoal: vi.fn(), createGoal: vi.fn(),
  pauseGoal: vi.fn(), resumeGoal: vi.fn(), cancelGoal: vi.fn(), requestGoalModel: vi.fn(), sendGoalInput: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getTaskLiveDetails: vi.fn() }));
const socket = vi.hoisted(() => ({
  isConnected: false as boolean, subscribeToTask: vi.fn(), unsubscribeFromTask: vi.fn(),
  subscribeToTaskLive: vi.fn(), unsubscribeFromTaskLive: vi.fn(),
  onTaskUpdate: vi.fn((handler?: (payload: never) => void) => { void handler; return vi.fn(); }),
  onTaskLiveUpdate: vi.fn((handler?: (payload: never) => void) => { void handler; return vi.fn(); }),
}));
vi.mock('../contexts/useSocket', () => ({ useSocket: () => socket }));

const capability = {
  agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
  models: ['gpt-5.6', 'gpt-5.6-fast'], defaultModel: 'gpt-5.6',
};
const goal: goalsApi.Goal = {
  id: 'goal-1', owner: 'owner', repository: 'acme/web', objective: 'Ship the dashboard',
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/worktree',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' }, requestedModel: 'gpt-5.6', effectiveModel: 'gpt-5.6',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null, finalPr: null, artifacts: [],
  taskState: 'claude_execution', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(), pausedAt: null, completedAt: null, elapsedMs: 1000, activeMs: 1000, pausedMs: 0,
};

describe('GoalsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.isConnected = false;
    socket.onTaskUpdate.mockImplementation(() => vi.fn());
    socket.onTaskLiveUpdate.mockImplementation(() => vi.fn());
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability] });
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web', enabled: true }] });
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [] });
    vi.mocked(goalsApi.getGoal).mockResolvedValue({ goal });
    vi.mocked(getTaskLiveDetails).mockResolvedValue({ events: [], todos: [{ id: 'todo-1', content: 'Implement API', status: 'in_progress' }], currentTask: 'Implement API', tokenUsage: { input_tokens: 10, output_tokens: 5 } });
    vi.mocked(goalsApi.pauseGoal).mockResolvedValue({ goal: { ...goal, desiredState: 'paused', pausedAt: new Date().toISOString() } });
    vi.mocked(goalsApi.sendGoalInput).mockResolvedValue({ goal });
    vi.mocked(goalsApi.cancelGoal).mockResolvedValue({ goal: { ...goal, desiredState: 'cancelled', resultState: 'cancelled' } });
    vi.mocked(goalsApi.requestGoalModel).mockResolvedValue({ goal: { ...goal, requestedModel: 'gpt-5.6-fast' } });
  });

  it('creates exactly one native goal from repository, agent, model and objective', async () => {
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /><Route path="/goals/:goalId" element={<div>Goal detail</div>} /></Routes></MemoryRouter>);
    await screen.findByRole('option', { name: 'codex' });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the dashboard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start native goal' }));
    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/web', agentId: 'agent-1', model: 'gpt-5.6', objective: 'Ship the dashboard' })));
    expect(await screen.findByText('Goal detail')).toBeInTheDocument();
  });

  it('gates creation when the pinned provider lacks native goal capability', async () => {
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [{ ...capability, goalCapable: false, reason: 'No /goal' }] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText(/No pinned coding-agent CLI/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start native goal' })).toBeDisabled();
  });

  it('renders existing task live details and sends canned status input through the same session', async () => {
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    expect((await screen.findAllByText('Implement API')).length).toBeGreaterThan(0);
    expect(screen.getByText('15')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "What's done?" }));
    await waitFor(() => expect(goalsApi.pauseGoal).toHaveBeenCalledWith('goal-1'));
    await waitFor(() => expect(goalsApi.sendGoalInput).toHaveBeenCalledWith('goal-1', { canned: 'done' }));
  });

  it('requests the next model separately from the effective model and exposes cancellation', async () => {
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.change(screen.getByLabelText('Model for next continuation'), { target: { value: 'gpt-5.6-fast' } });
    await waitFor(() => expect(goalsApi.requestGoalModel).toHaveBeenCalledWith('goal-1', 'gpt-5.6-fast'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(goalsApi.cancelGoal).toHaveBeenCalledWith('goal-1'));
  });

  it('re-subscribes after reconnect and merges incremental native output', async () => {
    socket.isConnected = true;
    let liveHandler: ((payload: never) => void) | undefined;
    socket.onTaskLiveUpdate.mockImplementation(handler => {
      liveHandler = handler;
      return vi.fn();
    });
    const page = () => <MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>;
    const view = render(page());
    await waitFor(() => expect(socket.subscribeToTaskLive).toHaveBeenCalledWith('goal-task-1'));
    act(() => liveHandler?.({
      taskId: 'goal-task-1', events: [{ id: 'next', type: 'assistant', content: 'Incremental update' }],
      todos: [], currentTask: 'Testing', tokenUsage: null,
    } as never));
    expect(await screen.findByText('Incremental update')).toBeInTheDocument();

    socket.isConnected = false;
    view.rerender(page());
    socket.isConnected = true;
    view.rerender(page());
    await waitFor(() => expect(socket.subscribeToTaskLive).toHaveBeenCalledTimes(2));
  });
});
