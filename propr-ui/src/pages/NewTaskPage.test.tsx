import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewTaskPage from './NewTaskPage';
import * as goalsApi from '../api/goals';
import { getInstanceCatalog } from '../api/proprApi';

vi.mock('../api/goals', () => ({ getGoalCapabilities: vi.fn(), createGoal: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getRepoBranches: vi.fn() }));
const demoState = { isDemoMode: false };
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => demoState }));

const capability = {
  agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
  lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' } as const,
  controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
  models: ['gpt-5.6-sol', 'gpt-5.6-luna'], defaultModel: 'gpt-5.6-sol',
  objectiveMaxCharacters: 3_994,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{JSON.stringify({ path: `${location.pathname}${location.search}`, state: location.state })}</div>;
}

const renderPage = (entry: string | { pathname: string; state: unknown }) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/tasks/new" element={<NewTaskPage />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);

const probedLocation = () => JSON.parse(screen.getByTestId('location').textContent || '{}') as { path: string; state: Record<string, unknown> | null };

describe('NewTaskPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    demoState.isDemoMode = false;
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability] });
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [],
      repositories: [{ name: 'acme/web', enabled: true }, { name: 'acme/api', enabled: true }],
    });
  });

  it('asks only for a repository and instruction, then starts a direct task and opens it', async () => {
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal: { id: 'task-1', kind: 'task' } as goalsApi.Goal });
    renderPage('/tasks/new?repository=acme/api');

    expect(await screen.findByRole('button', { name: /acme.*api/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Agent implements directly')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Maximum parallel tasks')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Coding agent')).toHaveValue('agent-1'));
    expect(screen.getByLabelText('Coding agent')).not.toBeVisible();

    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Fix the invoice date format' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));

    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalledWith({
      repository: 'acme/api', agentId: 'agent-1', model: 'gpt-5.6-sol', objective: 'Fix the invoice date format',
      kind: 'task', launchStrategy: 'direct', checkpointIntervalMinutes: 15, ultrafix: false,
    }));
    await waitFor(() => expect(probedLocation().path).toBe('/tasks/run/task-1'));
    expect(JSON.parse(window.localStorage.getItem('propr.taskFormSettings') || '{}')).toMatchObject({
      repository: 'acme/api', agentId: 'agent-1', model: 'gpt-5.6-sol',
    });
  });

  it('reuses the agent and model last chosen for a goal when no task defaults exist', async () => {
    const claude = { ...capability, agentId: 'agent-2', agentAlias: 'claude', agentType: 'claude', models: ['claude-opus-4-6'], defaultModel: 'claude-opus-4-6', objectiveMaxCharacters: null };
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability, claude] });
    window.localStorage.setItem('propr.goalFormSettings', JSON.stringify({ repository: 'acme/web', agentId: 'agent-2', model: 'claude-opus-4-6', launchStrategy: 'orchestrate' }));
    renderPage('/tasks/new');

    await waitFor(() => expect(screen.getByLabelText('Coding agent')).toHaveValue('agent-2'));
    expect(screen.getByLabelText('Model')).toHaveValue('claude-opus-4-6');
  });

  it('hands a prefilled instruction from to-dos to the planner with Plan first', async () => {
    renderPage({ pathname: '/tasks/new', state: { initialPrompt: 'Add dark mode', initialRepository: 'acme/web', todoIds: ['todo-1'] } });

    expect(await screen.findByLabelText('Instruction')).toHaveValue('Add dark mode');
    await screen.findByRole('button', { name: /acme.*web/ });
    fireEvent.click(screen.getByRole('button', { name: 'Plan first' }));

    expect(probedLocation()).toEqual({
      path: '/studio/new?mode=task',
      state: { initialPrompt: 'Add dark mode', initialRepository: 'acme/web', todoIds: ['todo-1'] },
    });
    expect(goalsApi.createGoal).not.toHaveBeenCalled();
  });

  it('keeps the launcher read-only in demo mode', async () => {
    demoState.isDemoMode = true;
    renderPage('/tasks/new');
    fireEvent.change(await screen.findByLabelText('Instruction'), { target: { value: 'Anything' } });
    expect(screen.getByRole('button', { name: 'Run task' })).toBeDisabled();
    expect(screen.getByText(/Demo mode is read-only/)).toBeInTheDocument();
  });
});
