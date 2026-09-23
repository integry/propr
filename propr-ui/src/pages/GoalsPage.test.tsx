/* eslint-disable max-lines -- list and detail behavior share one focused route-level suite */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoalsPage from './GoalsPage';
import * as goalsApi from '../api/goals';
import { getInstanceCatalog, getTaskLiveDetails } from '../api/proprApi';
import ThinkingLog from '../components/TaskDetails/ThinkingLog';

const resizeImage = vi.hoisted(() => vi.fn());

vi.mock('../api/goals', () => ({
  getGoalCapabilities: vi.fn(), listGoals: vi.fn(), getGoal: vi.fn(), createGoal: vi.fn(),
  getGoalVisualPreviews: vi.fn(),
  pauseGoal: vi.fn(), resumeGoal: vi.fn(), cancelGoal: vi.fn(), deleteGoal: vi.fn(), requestGoalModel: vi.fn(), sendGoalInput: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getTaskLiveDetails: vi.fn() }));
vi.mock('../components/TaskPlanner/imageUtils', () => ({ resizeImage }));
const demoState = { isDemoMode: false };
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => demoState }));
const socket = vi.hoisted(() => ({
  isConnected: false as boolean, subscribeToTask: vi.fn(), unsubscribeFromTask: vi.fn(),
  subscribeToTaskLive: vi.fn(), unsubscribeFromTaskLive: vi.fn(),
  onTaskUpdate: vi.fn((handler?: (payload: never) => void) => { void handler; return vi.fn(); }),
  onTaskLiveUpdate: vi.fn((handler?: (payload: never) => void) => { void handler; return vi.fn(); }),
}));
vi.mock('../contexts/useSocket', () => ({ useSocket: () => socket }));

const capability = {
  agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
  lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' } as const,
  controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
  models: ['gpt-5.6-sol', 'gpt-5.6-luna'], defaultModel: 'gpt-5.6-sol',
  objectiveMaxCharacters: 3_994,
};
const goal: goalsApi.Goal = {
  id: 'goal-1', owner: 'owner', repository: 'acme/web', title: 'Launch Customer Analytics Dashboard', objective: 'Ship the dashboard',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Ship the dashboard\n\nLaunch strategy — Agent orchestrates through ProPR',
  attachments: [],
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/worktree',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' }, requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  failureReason: null, pausePending: false,
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null, finalPr: null, artifacts: [],
  checkpoint: null,
  artifactStats: { issues: 1, openIssues: 1, pullRequests: 1, openPullRequests: 1 },
  liveSummary: { currentTask: 'Implement API', todos: [{ id: 'todo-1', content: 'Implement API', status: 'in_progress' },], tokenUsage: { input_tokens: 10, output_tokens: 5 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(), pausedAt: null, completedAt: null, elapsedMs: 1000, activeMs: 1000, pausedMs: 0,
};

/** Surfaces the query string so filter tests can assert what a shared goals URL carries. */
const LocationProbe = () => <span data-testid="location-search">{useLocation().search}</span>;

const openGoalCreator = () => fireEvent.click(screen.getByRole('button', { name: 'New goal' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GoalsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    demoState.isDemoMode = false;
    socket.isConnected = false;
    socket.onTaskUpdate.mockImplementation(() => vi.fn());
    socket.onTaskLiveUpdate.mockImplementation(() => vi.fn());
    resizeImage.mockImplementation((file: File) => Promise.resolve(file));
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability] });
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web', enabled: true }] });
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [] });
    vi.mocked(goalsApi.getGoal).mockResolvedValue({ goal });
    vi.mocked(goalsApi.getGoalVisualPreviews).mockResolvedValue({ previews: [] });
    vi.mocked(getTaskLiveDetails).mockResolvedValue({ events: [], todos: [{ id: 'todo-1', content: 'Implement API', status: 'in_progress' }], currentTask: 'Implement API', tokenUsage: { input_tokens: 10, output_tokens: 5 } });
    vi.mocked(goalsApi.pauseGoal).mockResolvedValue({ goal: { ...goal, desiredState: 'paused', pausedAt: new Date().toISOString() } });
    vi.mocked(goalsApi.sendGoalInput).mockResolvedValue({ goal });
    vi.mocked(goalsApi.cancelGoal).mockResolvedValue({ goal: { ...goal, desiredState: 'cancelled', resultState: null } });
    vi.mocked(goalsApi.deleteGoal).mockResolvedValue();
    vi.mocked(goalsApi.requestGoalModel).mockResolvedValue({ goal: { ...goal, requestedModel: 'gpt-5.6-luna' } });
  });

  it('renders up to three inline previews in the responsive goal row without per-row requests', async () => {
    const previewMedia = Array.from({ length: 5 }, (_, index) => ({ type: 'image' as const, title: `Preview ${index}`, url: `https://github.com/user-attachments/assets/goal-${index}` }));
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [{ ...goal, previewMedia }] });
    render(<MemoryRouter><GoalsPage /></MemoryRouter>);
    await screen.findByRole('heading', { name: goal.title });
    expect(screen.getAllByRole('img', { name: /Preview/ })).toHaveLength(3);
    expect(goalsApi.getGoalVisualPreviews).not.toHaveBeenCalled();
  });

  it('waits for a successful goal read before presenting the empty queue', async () => {
    const request = deferred<Awaited<ReturnType<typeof goalsApi.listGoals>>>();
    vi.mocked(goalsApi.listGoals).mockReturnValue(request.promise);
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(screen.getByText('Loading goals…')).toBeInTheDocument();
    expect(screen.queryByText('No goals yet')).not.toBeInTheDocument();

    await act(async () => { request.resolve({ goals: [] }); });
    expect(await screen.findByText('No goals yet')).toBeInTheDocument();
  });

  it('keeps a failed initial goal read as an error instead of an empty queue', async () => {
    const request = deferred<Awaited<ReturnType<typeof goalsApi.listGoals>>>();
    vi.mocked(goalsApi.listGoals).mockReturnValue(request.promise);
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    await act(async () => { request.reject(new Error('Goals unavailable')); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Goals unavailable');
    expect(screen.queryByText('No goals yet')).not.toBeInTheDocument();
  });

  it('creates exactly one native goal from repository, agent, model and objective', async () => {
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /><Route path="/goals/:goalId" element={<div>Goal detail</div>} /></Routes></MemoryRouter>);
    expect(screen.queryByLabelText('Objective')).not.toBeInTheDocument();
    openGoalCreator();
    await screen.findByRole('option', { name: 'Codex' });
    expect(screen.getByRole('button', { name: /acme.*web/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.6 Sol' })).toHaveValue('gpt-5.6-sol');
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the dashboard' } });
    fireEvent.click(screen.getByLabelText('Agent orchestrates through ProPR'));
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/web', agentId: 'agent-1', model: 'gpt-5.6-sol', objective: 'Ship the dashboard', launchStrategy: 'orchestrate' })));
    expect(await screen.findByText('Goal detail')).toBeInTheDocument();
  });

  it('counts Unicode characters and applies only the selected provider objective limit', async () => {
    const unlimitedCapability = {
      ...capability,
      agentId: 'agent-2',
      agentAlias: 'antigravity',
      agentType: 'antigravity',
      models: ['gemini-3-pro'],
      defaultModel: 'gemini-3-pro',
      objectiveMaxCharacters: null,
    };
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability, unlimitedCapability] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();
    await screen.findByRole('option', { name: 'Codex' });

    const objective = screen.getByLabelText('Objective');
    const exactCodexObjective = `${'x'.repeat(3_993)}😀`;
    fireEvent.change(objective, { target: { value: exactCodexObjective } });
    expect(screen.getByLabelText('Objective character count')).toHaveTextContent('3,994 / 3,994 characters');
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled();

    fireEvent.change(objective, { target: { value: `${exactCodexObjective}x` } });
    expect(objective).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Objective character count')).toHaveTextContent('3,995 / 3,994 characters');
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Start goal' }).closest('form')!);
    expect(goalsApi.createGoal).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Coding agent'), { target: { value: 'agent-2' } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('gemini-3-pro'));
    expect(screen.queryByLabelText('Objective character count')).not.toBeInTheDocument();
    expect(objective).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled();
  });

  it('counts Claude objectives in UTF-16 units like Claude Code /goal does', async () => {
    const claudeCapability = {
      ...capability,
      agentId: 'agent-3',
      agentAlias: 'claude',
      agentType: 'claude',
      models: ['claude-opus-5'],
      defaultModel: 'claude-opus-5',
      objectiveMaxCharacters: 4_000,
    };
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [claudeCapability] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();
    await screen.findByRole('option', { name: 'Claude' });

    const objective = screen.getByLabelText('Objective');
    fireEvent.change(objective, { target: { value: '😀'.repeat(2_000) } });
    expect(screen.getByLabelText('Objective character count')).toHaveTextContent('4,000 / 4,000 characters');
    expect(screen.getByText(/Claude accepts up to 4,000 characters \(emoji and some symbols count as two\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled();

    fireEvent.change(objective, { target: { value: `${'😀'.repeat(2_000)}x` } });
    expect(screen.getByLabelText('Objective character count')).toHaveTextContent('4,001 / 4,000 characters');
    expect(objective).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled();

    fireEvent.change(objective, { target: { value: `  ${'x'.repeat(4_000)}\n` } });
    expect(screen.getByLabelText('Objective character count')).toHaveTextContent('4,000 / 4,000 characters');
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled();
  });

  it('keeps goal creation read-only in demo mode', async () => {
    demoState.isDemoMode = true;
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();

    expect(await screen.findByText('Demo mode is read-only. You can inspect existing goals, but cannot start a new one.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Goal creation controls' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled();
    expect(screen.getByLabelText('Objective')).toBeDisabled();

    fireEvent.submit(screen.getByRole('button', { name: 'Start goal' }).closest('form')!);
    expect(goalsApi.createGoal).not.toHaveBeenCalled();
  });

  it('remembers reusable settings from the previously created goal', async () => {
    window.localStorage.setItem('propr.goalFormSettings', JSON.stringify({
      repository: 'acme/api',
      agentId: 'agent-2',
      model: 'claude-opus-4-6',
      launchStrategy: 'direct',
      maxParallelTasks: 6,
      ultrafix: true,
      checkpointIntervalMinutes: 60,
    }));
    const claudeCapability = {
      ...capability,
      agentId: 'agent-2',
      agentAlias: 'claude',
      agentType: 'claude',
      models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      defaultModel: 'claude-sonnet-4-6',
      objectiveMaxCharacters: null,
    };
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [capability, claudeCapability] });
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [],
      repositories: [{ name: 'acme/web', enabled: true }, { name: 'acme/api', enabled: true }],
    });
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal });

    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /><Route path="/goals/:goalId" element={<div>Goal detail</div>} /></Routes></MemoryRouter>);
    openGoalCreator();

    expect(await screen.findByRole('option', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acme.*api/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Coding agent')).toHaveValue('agent-2');
    expect(screen.getByLabelText('Model')).toHaveValue('claude-opus-4-6');
    expect(screen.getByLabelText('Maximum parallel tasks')).toHaveValue(6);
    expect(screen.getByLabelText('Agent implements directly')).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ask the coding agent to use Ultrafix' })).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Checkpoint target cadence' })).toHaveAttribute('aria-valuetext', '60 minutes');
    expect(screen.getByLabelText('Objective')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the API' } });
    fireEvent.click(screen.getByLabelText('Agent orchestrates through ProPR'));
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));

    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem('propr.goalFormSettings') || '{}')).toEqual({
      repository: 'acme/api',
      agentId: 'agent-2',
      model: 'claude-opus-4-6',
      launchStrategy: 'orchestrate',
      maxParallelTasks: 6,
      ultrafix: true,
      checkpointIntervalMinutes: 60,
    });
  });

  it('configures worker checkpoints only for direct goals', async () => {
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal: { ...goal, launchStrategy: 'direct' } });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /><Route path="/goals/:goalId" element={<div>Goal detail</div>} /></Routes></MemoryRouter>);
    openGoalCreator();
    await screen.findByRole('option', { name: 'Codex' });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the dashboard' } });
    const checkpointSlider = screen.getByRole('slider', { name: 'Checkpoint target cadence' });
    expect(checkpointSlider).toHaveAttribute('aria-valuetext', '15 minutes');
    const checkpointOptions = screen.getByLabelText('Checkpoint target cadence options');
    for (const minutes of [5, 10, 15, 30, 60, 120]) {
      expect(within(checkpointOptions).getByText(String(minutes))).toBeInTheDocument();
    }
    fireEvent.change(checkpointSlider, { target: { value: '3' } });
    expect(checkpointSlider).toHaveAttribute('aria-valuetext', '30 minutes');
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalledWith(expect.objectContaining({
      launchStrategy: 'direct', checkpointIntervalMinutes: 30,
    })));
  });

  it('starts a goal with selected files and supports pasted images in the objective', async () => {
    vi.mocked(goalsApi.createGoal).mockResolvedValue({ goal });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /><Route path="/goals/:goalId" element={<div>Goal detail</div>} /></Routes></MemoryRouter>);
    openGoalCreator();
    await screen.findByRole('option', { name: 'Codex' });
    const objective = screen.getByLabelText('Objective');
    fireEvent.change(objective, { target: { value: 'Implement the attached design' } });
    const textFile = new File(['expected layout'], 'requirements.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [textFile] } });
    expect(await screen.findByText('requirements.txt')).toBeInTheDocument();

    const pastedImage = new File(['image'], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(objective, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => pastedImage }] } });
    expect(await screen.findByText(/pasted-image-/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));

    await waitFor(() => expect(goalsApi.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Implement the attached design' }),
      expect.arrayContaining([textFile, expect.objectContaining({ type: 'image/png' })]),
    ));
  });

  it('hides unsupported runtime diagnostics when at least one agent supports goals', async () => {
    vi.mocked(goalsApi.getGoalCapabilities).mockResolvedValue({ agents: [
      capability,
      { ...capability, agentId: 'agent-2', agentAlias: 'opencode', agentType: 'opencode', goalCapable: false, reason: 'OpenCode does not support goal sessions' },
    ] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();

    await screen.findByRole('option', { name: 'Codex' });
    expect(screen.getByRole('option', { name: 'Opencode — unsupported' })).toBeDisabled();
    expect(screen.queryByText('OpenCode does not support goal sessions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recheck runtimes' })).not.toBeInTheDocument();
  });

  it('shows each unsupported provider reason, gates creation, and can recheck runtimes', async () => {
    vi.mocked(goalsApi.getGoalCapabilities)
      .mockResolvedValueOnce({ agents: [
        { ...capability, goalCapable: false, reason: 'Codex schema lacks thread/goal/clear' },
        { ...capability, agentId: 'agent-2', agentAlias: 'antigravity', agentType: 'antigravity', goalCapable: false, reason: 'Antigravity lacks --conversation' },
      ] })
      .mockResolvedValueOnce({ agents: [capability] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();
    expect(await screen.findByText('No configured coding-agent runtime currently supports goals.')).toBeInTheDocument();
    expect(screen.getByText('Codex schema lacks thread/goal/clear')).toBeInTheDocument();
    expect(screen.getByText('Antigravity lacks --conversation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck runtimes' }));
    await waitFor(() => expect(goalsApi.getGoalCapabilities).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByText('Codex schema lacks thread/goal/clear')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the dashboard' } });
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled();
  });

  it('keeps existing work first in a compact responsive queue with bounded row content', async () => {
    const longTodo = 'A very long follow-up task that should not be rendered as an unbounded nested checklist inside the work queue row';
    const queueGoals = Array.from({ length: 4 }, (_, index) => ({
      ...goal,
      id: `goal-${index + 1}`,
      title: `${goal.title} ${index + 1}`,
      objective: `${goal.objective} ${index + 1} with a long explanation that must remain visually bounded in the compact queue`,
      liveSummary: {
        ...goal.liveSummary,
        todos: [...goal.liveSummary.todos, { id: `todo-${index + 2}`, content: longTodo, status: 'pending' as const }],
      },
    }));
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: queueGoals });

    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const queue = await screen.findByRole('list', { name: 'Goal work queue' });
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Objective')).not.toBeInTheDocument();
    expect(within(queue).getAllByRole('link')).toHaveLength(4);
    expect(screen.getByText('4 of 4')).toBeInTheDocument();
    expect(screen.queryByText(longTodo)).not.toBeInTheDocument();
    expect(screen.getAllByText('2/2 steps')).toHaveLength(4);

    const firstLink = within(queue).getAllByRole('link')[0];
    expect(firstLink).toHaveClass('grid', 'grid-cols-2', 'lg:items-center');
    expect(firstLink.className).toContain('lg:grid-cols-[');
    expect(firstLink.className).toContain('xl:grid-cols-[');
    expect(queue.parentElement).toHaveClass('border-y');
    expect(queue.parentElement).not.toHaveClass('rounded-lg', 'shadow-sm');
    expect(screen.getByText(queueGoals[0].objective)).toHaveClass('truncate');
    expect(screen.getByText(queueGoals[0].title)).toHaveClass('truncate', 'text-sm', 'font-semibold');
  });

  it('confirms discarding unsaved creation input and restores focus on cancel or Escape', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: 'New goal' });
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByRole('dialog', { name: 'Start a goal' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Unsaved goal details' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Start a goal' })).toBeInTheDocument();
    expect(screen.getByLabelText('Objective')).toHaveValue('Unsaved goal details');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Start a goal' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(confirm).toHaveBeenCalledTimes(2);

    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Start a goal' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Start a goal' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    confirm.mockRestore();
  });

  it('guards every dismissal path while a selected attachment is still processing', async () => {
    let finishProcessing: (file: File) => void = () => undefined;
    resizeImage.mockImplementation(() => new Promise<File>(resolve => { finishProcessing = resolve; }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();

    const dialog = await screen.findByRole('dialog', { name: 'Start a goal' });
    const selectedImage = new File(['image'], 'pending.png', { type: 'image/png' });
    fireEvent.change(within(dialog).getByLabelText('Attach files'), { target: { files: [selectedImage] } });
    expect(within(dialog).getByText('Preparing files…')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(dialog).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(3);

    await act(async () => { finishProcessing(selectedImage); });
    expect(await within(dialog).findByText('pending.png')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('dismisses the open repository picker before handling Escape in the goal creator', async () => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [],
      repositories: [
        { name: 'acme/web', enabled: true },
        { name: 'acme/api', enabled: true },
      ],
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    openGoalCreator();

    const dialog = await screen.findByRole('dialog', { name: 'Start a goal' });
    fireEvent.change(within(dialog).getByLabelText('Objective'), { target: { value: 'Keep this draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /acme.*web/ }));
    const repositoryFilter = within(dialog).getByPlaceholderText('Filter repositories...');
    expect(repositoryFilter).toHaveFocus();

    fireEvent.keyDown(repositoryFilter, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('Filter repositories...')).not.toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Objective')).toHaveValue('Keep this draft');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('projects native checklist, time, token, and repository artifact stats in the goal list', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [{
      ...goal,
      liveSummary: {
        ...goal.liveSummary,
        nativeGoal: { objective: goal.objective, status: 'active', tokenBudget: 1000, tokensUsed: 330, timeUsedSeconds: 42 },
      },
    }] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('330')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
    expect(screen.getByText('1 issue')).toBeInTheDocument();
    expect(screen.getByText('1 PR')).toBeInTheDocument();
    expect(screen.getByText('Implement API')).toBeInTheDocument();
    expect(screen.getByText(goal.title)).toHaveClass('truncate');
    expect(screen.getByText(goal.objective)).toHaveClass('truncate');
    expect(screen.getByText('acme/web')).toHaveClass('font-mono');
    expect(screen.getByText('Codex')).toHaveClass('sr-only');
    expect(screen.getByText('GPT-5.6 Sol')).toBeInTheDocument();
  });

  it('abbreviates large token counts and keeps the exact total on hover', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [{
      ...goal,
      liveSummary: {
        ...goal.liveSummary,
        nativeGoal: { objective: goal.objective, status: 'active', tokenBudget: 0, tokensUsed: 101_280_735, timeUsedSeconds: 75 },
      },
    }] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const tokens = await screen.findByText('101M');
    expect(tokens).toHaveAttribute('title', '101,280,735 tokens');
    expect(screen.getByText('1m 15s')).toBeInTheDocument();
  });

  it('gives every status badge the same icon-plus-label geometry', async () => {
    const states = [
      { id: 'goal-running', desiredState: 'running' as const, resultState: null, label: 'running' },
      { id: 'goal-completed', desiredState: 'running' as const, resultState: 'completed' as const, label: 'completed' },
      { id: 'goal-failed', desiredState: 'running' as const, resultState: 'failed' as const, label: 'failed' },
      { id: 'goal-paused', desiredState: 'paused' as const, resultState: null, label: 'paused' },
      { id: 'goal-cancelled', desiredState: 'cancelled' as const, resultState: 'cancelled' as const, label: 'cancelled' },
      { id: 'goal-cancelling', desiredState: 'cancelled' as const, resultState: null, label: 'cancelling' },
    ];
    vi.mocked(goalsApi.listGoals).mockResolvedValue({
      goals: states.map(({ id, desiredState, resultState }) => ({ ...goal, id, desiredState, resultState })),
    });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    await screen.findByText('running');
    states.forEach(({ label }) => {
      const badge = screen.getByText(label);
      expect(badge).toHaveClass('inline-flex', 'items-center', 'gap-1.5', 'rounded-full', 'px-2', 'py-0.5', 'text-xs');
      expect(badge.querySelector('svg')).not.toBeNull();
    });
  });

  it('shows the repository as a hugging monospace chip with no repeated GitHub fallback mark', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const chip = await screen.findByTestId('repository-chip');
    expect(chip).toHaveClass('inline-flex', 'font-mono', 'bg-slate-100', 'border', 'border-slate-200', 'rounded-sm');
    expect(chip).not.toHaveClass('block', 'w-full');
    expect(chip).toHaveTextContent('acme/web');
    // Repositories without their own icon leave the slug alone instead of repeating the GitHub logo.
    expect(within(chip).queryByTestId('repository-icon-fallback')).not.toBeInTheDocument();
  });

  it('holds one uniform row height with a single neutral sub-status line', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [
      { ...goal, id: 'goal-running' },
      {
        ...goal,
        id: 'goal-settled',
        resultState: 'completed' as const,
        artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
      },
    ] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const queue = await screen.findByRole('list', { name: 'Goal work queue' });
    // A busy row and a settled row are the same height on the desktop table.
    within(queue).getAllByRole('link').forEach(row => expect(row).toHaveClass('lg:h-16', 'lg:items-center'));

    // Status, running task and step count share one line, and the sub-status stays neutral slate.
    const activity = screen.getByText('Implement API');
    const subStatus = activity.parentElement as HTMLElement;
    expect(subStatus).toHaveClass('flex', 'items-center', 'text-slate-500');
    expect(subStatus).not.toHaveClass('text-blue-500', 'text-blue-600');
    expect(activity).toHaveClass('truncate');
    expect(within(subStatus).getByText('1/1 steps')).toHaveAttribute('title', '1 open of 1 steps');
    expect(subStatus.querySelector('.text-blue-500')).toBeNull();

    // The goal cell keeps its model beside the objective rather than adding a third line.
    const objective = screen.getAllByText(goal.objective)[0];
    expect(objective).toHaveClass('truncate');
    expect(within(objective.parentElement as HTMLElement).getByText('GPT-5.6 Sol')).toBeInTheDocument();
  });

  it('keeps completed rows quiet, gray and free of a repeated activity column', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [{
      ...goal,
      desiredState: 'running' as const,
      resultState: 'completed' as const,
      artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
    }] });
    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const completed = await screen.findByText('completed');
    expect(completed).toHaveClass('bg-slate-100', 'text-slate-600');
    expect(completed).not.toHaveClass('bg-green-100');
    // A settled goal has no live activity or open checklist to report.
    expect(screen.queryByText('Implement API')).not.toBeInTheDocument();
    expect(screen.queryByText('1/1 steps')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('filters goals by repository and stores the selection in the URL', async () => {
    const apiGoal = {
      ...goal,
      id: 'goal-2',
      repository: 'acme/api',
      title: 'Launch Billing API',
      objective: 'Ship the billing API',
    };
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal, apiGoal] });

    render(<MemoryRouter initialEntries={['/goals?repository=acme/api']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText(apiGoal.title)).toBeInTheDocument();
    expect(screen.queryByText(goal.title)).not.toBeInTheDocument();
    const filter = screen.getByRole('group', { name: 'Filter goals by repository' });
    expect(within(filter).getByRole('button', { name: /acme.*api/ })).toBeInTheDocument();

    fireEvent.click(within(filter).getByRole('button', { name: /acme.*api/ }));
    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    expect(screen.getByText(apiGoal.title)).toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: /All Repos/ })).toBeInTheDocument();
  });

  it('explains a filtered-empty queue and provides a direct reset', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal] });
    render(<MemoryRouter initialEntries={['/goals?repository=acme/missing']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText('No goals in acme/missing')).toBeInTheDocument();
    expect(screen.getByText('0 of 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all goals' }));

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('filters goals by status, folds cancelling into cancelled, and stores the selection in the URL', async () => {
    const pausedGoal = { ...goal, id: 'goal-2', title: 'Tune Billing Retries', desiredState: 'paused' as const };
    const cancellingGoal = { ...goal, id: 'goal-3', title: 'Retire Legacy Worker', desiredState: 'cancelled' as const, resultState: null };
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal, pausedGoal, cancellingGoal] });

    render(<MemoryRouter initialEntries={['/goals?status=paused']}><Routes><Route path="/goals" element={<><GoalsPage /><LocationProbe /></>} /></Routes></MemoryRouter>);

    expect(await screen.findByText(pausedGoal.title)).toBeInTheDocument();
    expect(screen.queryByText(goal.title)).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    const statusFilter = screen.getByRole('combobox', { name: 'Filter goals by status' });
    fireEvent.change(statusFilter, { target: { value: 'cancelled' } });

    expect(await screen.findByText(cancellingGoal.title)).toBeInTheDocument();
    expect(screen.queryByText(pausedGoal.title)).not.toBeInTheDocument();
    expect(screen.getByTestId('location-search')).toHaveTextContent('status=cancelled');

    fireEvent.change(statusFilter, { target: { value: 'all' } });

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('status=');
  });

  it('narrows the queue by every search keyword and mirrors the query in the URL', async () => {
    const apiGoal = {
      ...goal,
      id: 'goal-2',
      repository: 'acme/api',
      title: 'Launch Billing API',
      objective: 'Ship the billing API',
    };
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal, apiGoal] });

    render(<MemoryRouter initialEntries={['/goals']}><Routes><Route path="/goals" element={<><GoalsPage /><LocationProbe /></>} /></Routes></MemoryRouter>);

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search goals' }), { target: { value: 'billing api' } });

    await waitFor(() => expect(screen.queryByText(goal.title)).not.toBeInTheDocument());
    expect(screen.getByText(apiGoal.title)).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    // The debounce commits the filter and the URL together, but React Router applies the
    // navigation in a transition, so the probe catches up a render after the filtered list.
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('search=billing+api'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('search=');
  });

  it('names the search that emptied the queue and resets every filter at once', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [goal] });

    render(<MemoryRouter initialEntries={['/goals?repository=acme/web&status=failed&search=nothing%20here']}><Routes><Route path="/goals" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText('No goals match “nothing here”')).toBeInTheDocument();
    expect(screen.getByText('0 of 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all goals' }));

    expect(await screen.findByText(goal.title)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search goals' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Filter goals by status' })).toHaveValue('all');
  });

  it('renders existing task live details and sends canned status input through the same session', async () => {
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    expect((await screen.findAllByText('Implement API')).length).toBeGreaterThan(0);
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('ProPR orchestrated')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: goal.title })).toBeInTheDocument();
    expect(screen.getByText('Goal description')).toBeInTheDocument();
    expect(screen.getByText(/\/goal Ship the dashboard/)).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Goal monitor' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Steering console' })).toBeInTheDocument();
    expect(screen.getAllByText('GPT-5.6 Sol').length).toBeGreaterThan(0);
    expect(screen.queryByText('gpt-5.6-sol')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.6 Luna' })).toHaveValue('gpt-5.6-luna');
    fireEvent.click(screen.getByRole('button', { name: "What's done?" }));
    await waitFor(() => expect(goalsApi.sendGoalInput).toHaveBeenCalledWith('goal-1', { canned: 'done' }));
    expect(goalsApi.pauseGoal).not.toHaveBeenCalled();
  });

  it('keeps running goal controls and corrections read-only in demo mode', async () => {
    demoState.isDemoMode = true;
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByPlaceholderText('Demo mode is read-only. Corrections disabled.')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "What's done?" })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Correction or follow-up')).toBeDisabled();
    expect(screen.queryByLabelText('Model for next continuation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('More goal actions'));
    expect(screen.queryByRole('button', { name: 'Delete goal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open task history' })).toBeInTheDocument();
    expect(goalsApi.pauseGoal).not.toHaveBeenCalled();
    expect(goalsApi.cancelGoal).not.toHaveBeenCalled();
    expect(goalsApi.deleteGoal).not.toHaveBeenCalled();
    expect(goalsApi.requestGoalModel).not.toHaveBeenCalled();
    expect(goalsApi.sendGoalInput).not.toHaveBeenCalled();
  });

  it('shows visual preview evidence fetched from the open goal PR', async () => {
    vi.mocked(goalsApi.getGoal).mockResolvedValue({
      goal: { ...goal, finalPr: { number: 42, url: 'https://github.com/acme/web/pull/42' } },
    });
    vi.mocked(goalsApi.getGoalVisualPreviews).mockResolvedValue({
      previews: [{
        type: 'image',
        title: 'Dashboard filters',
        description: 'The current desktop implementation.',
        url: 'https://github.com/user-attachments/assets/preview-1',
      }],
    });

    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Visual previews' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Dashboard filters' })).toHaveAttribute(
      'src',
      'https://github.com/user-attachments/assets/preview-1',
    );
    expect(screen.getByText('The current desktop implementation.')).toBeInTheDocument();
    expect(goalsApi.getGoalVisualPreviews).toHaveBeenCalledWith('goal-1');
  });

  it('sends files and pasted images with a running goal correction', async () => {
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    const correction = await screen.findByLabelText('Correction or follow-up');
    fireEvent.change(correction, { target: { value: 'Use these references.' } });
    const selectedFile = new File(['details'], 'details.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [selectedFile] } });
    expect(await screen.findByText('details.md')).toBeInTheDocument();
    const pastedImage = new File(['image'], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(correction, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => pastedImage }] } });
    expect(await screen.findByText(/pasted-image-/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(goalsApi.sendGoalInput).toHaveBeenCalledWith(
      'goal-1',
      { message: 'Use these references.' },
      expect.arrayContaining([selectedFile, expect.objectContaining({ type: 'image/png' })]),
    ));
  });

  it('shows human-readable goal output by default and lets the user switch to raw terminal output', async () => {
    vi.mocked(getTaskLiveDetails).mockResolvedValue({
      events: [
        { id: 'thought-1', type: 'thought', content: 'Implemented the dashboard filters.' },
        { id: 'tool-1', type: 'tool_use', toolName: 'Bash', input: { command: 'npm test' } },
        { id: 'result-1', type: 'tool_result', result: 'Tests passed.' },
      ],
      todos: [],
      currentTask: 'Run tests',
      tokenUsage: null,
    });

    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Implemented the dashboard filters.')).toBeInTheDocument());
    expect(screen.getByText('IMPLEMENTATION LOG')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Human readable' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Raw terminal' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('npm test')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Raw terminal' }));

    expect(screen.getByRole('button', { name: 'Raw terminal' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('npm test')).toHaveLength(2);
  });

  it('merges operator corrections into the human readable and raw terminal goal output', async () => {
    const startedAt = '2026-09-22T10:00:00.000Z';
    vi.mocked(goalsApi.getGoal).mockResolvedValue({
      goal: {
        ...goal,
        startedAt,
        inputs: [
          {
            id: 'input-1', message: 'Use the existing design tokens', attachmentCount: 2,
            state: 'delivered', createdAt: '2026-09-22T10:00:30.000Z', deliveredAt: '2026-09-22T10:01:00.000Z',
          },
          {
            id: 'input-2', message: 'Also update the changelog', attachmentCount: 0,
            state: 'pending', createdAt: '2026-09-22T10:00:10.000Z', deliveredAt: null,
          },
        ],
      },
    });
    vi.mocked(getTaskLiveDetails).mockResolvedValue({
      events: [
        { id: 'thought-1', type: 'thought', content: 'Starting on the dashboard filters.', timestamp: '2026-09-22T10:00:20.000Z' },
        { id: 'thought-2', type: 'thought', content: 'Applying the correction now.', timestamp: '2026-09-22T10:02:00.000Z' },
      ],
      todos: [],
      currentTask: 'Run tests',
      tokenUsage: null,
    });

    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);

    await screen.findByText('Applying the correction now.');
    const delivered = screen.getByText('Use the existing design tokens');
    const log = document.getElementById('thinking-log-section')!;
    const text = log.textContent || '';
    // Delivered corrections sit at their delivery time; pending ones wait at the end.
    expect(text.indexOf('Use the existing design tokens')).toBeGreaterThan(text.indexOf('Starting on the dashboard filters.'));
    expect(text.indexOf('Applying the correction now.')).toBeGreaterThan(text.indexOf('Use the existing design tokens'));
    expect(text.indexOf('Also update the changelog')).toBeGreaterThan(text.indexOf('Applying the correction now.'));
    expect(within(log).getAllByText('YOU')).toHaveLength(2);
    expect(within(delivered.closest('[data-testid="goal-user-message"]')!).queryByText('Queued')).not.toBeInTheDocument();
    expect(within(delivered.closest('[data-testid="goal-user-message"]')!).getByText('2 attachments')).toBeInTheDocument();
    const pending = screen.getByText('Also update the changelog').closest<HTMLElement>('[data-testid="goal-user-message"]')!;
    expect(within(pending).getByText('Queued')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Raw terminal' }));

    expect(screen.getAllByText('YOU')).toHaveLength(2);
    expect(screen.getAllByText('Use the existing design tokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Also update the changelog').length).toBeGreaterThan(0);
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('uses the refined completed-goal hierarchy and locked command bar', async () => {
    const startedAt = '2026-09-09T10:00:00.000Z';
    vi.mocked(goalsApi.getGoal).mockResolvedValue({
      goal: {
        ...goal,
        desiredState: 'running',
        resultState: 'completed',
        startedAt,
        completedAt: '2026-09-09T10:10:59.000Z',
      },
    });
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);

    const title = await screen.findByRole('heading', { name: goal.title });
    const completedStatus = within(title.parentElement!).getByText('Completed');
    expect(completedStatus).toHaveClass('text-slate-500');
    expect(completedStatus).not.toHaveClass('bg-green-100');
    expect(screen.getByRole('complementary', { name: 'Steering console' })).toHaveClass('bg-slate-50');
    expect(screen.getByRole('heading', { name: 'Goal output' })).toHaveClass('text-[10px]', 'uppercase', 'font-bold', 'text-slate-500');
    expect(screen.queryByText("Follow the agent's progress or inspect the raw provider stream.")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Goal completed. Corrections disabled.')).toBeDisabled();
  });

  it('keeps readable log gutter metadata quiet but legible', () => {
    render(<ThinkingLog events={[{
      id: 'summary-1', type: 'thought', content: 'Summary: the goal is finished.', relativeTime: '6m 59s',
    }]} />);

    expect(screen.getByText('SUMMARY')).toHaveClass('text-slate-500');
    expect(screen.getByText('6m 59s')).toHaveClass('text-slate-500');
  });

  it('accepts a correction while the initial provider identity is still pending', async () => {
    vi.mocked(goalsApi.getGoal).mockResolvedValue({ goal: { ...goal, sessionId: null } });
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    const correction = await screen.findByLabelText('Correction or follow-up');
    fireEvent.change(correction, { target: { value: 'Use the existing API shape.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(goalsApi.sendGoalInput).toHaveBeenCalledWith('goal-1', { message: 'Use the existing API shape.' }));
  });

  it('requests the next model separately from the effective model and exposes cancellation', async () => {
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.change(screen.getByLabelText('Model for next continuation'), { target: { value: 'gpt-5.6-luna' } });
    await waitFor(() => expect(goalsApi.requestGoalModel).toHaveBeenCalledWith('goal-1', 'gpt-5.6-luna'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(goalsApi.cancelGoal).toHaveBeenCalledWith('goal-1'));
    expect(await screen.findByText('cancelling')).toBeInTheDocument();
    expect(screen.getByText(/Cancelling at the provider boundary/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Goal closed. Corrections disabled.')).toBeDisabled();
    expect(screen.queryByLabelText('Model for next continuation')).not.toBeInTheDocument();
  });

  it('confirms deletion and returns to the goals list after the server stops and removes the goal', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /><Route path="/goals" element={<div>Goals list</div>} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('More goal actions'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete goal' }));
    await waitFor(() => expect(goalsApi.deleteGoal).toHaveBeenCalledWith('goal-1'));
    expect(await screen.findByText('Goals list')).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('stopped first'));
  });

  it('shows agent-declared checkpoints and their prompt target cadence', async () => {
    const directGoal: goalsApi.Goal = {
      ...goal,
      launchStrategy: 'direct',
      finalPr: { number: 42, url: 'https://github.com/acme/web/pull/42' },
      checkpoint: {
        intervalMinutes: 15, count: 2, lastAt: new Date().toISOString(), lastCommitSha: 'abc123',
        error: null, pending: false,
        latest: {
          kind: 'agent', state: 'completed', commitSha: 'abc123', message: 'feat(goals): publish stable work',
          include: ['src/goals.ts', 'test/goals.test.ts'], exclude: ['src/in-progress.ts'],
          summary: 'Checkpoint declaration and tests are complete.', error: null,
          createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        },
      },
    };
    vi.mocked(goalsApi.getGoal).mockResolvedValue({ goal: directGoal });
    render(<MemoryRouter initialEntries={['/goals/goal-1']}><Routes><Route path="/goals/:goalId" element={<GoalsPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('The agent declares when coherent work is ready.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Checkpoint now' })).not.toBeInTheDocument();
    expect(screen.getByText('Target cadence: about every 15 minutes.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Latest checkpoint declaration' })).toBeInTheDocument();
    expect(screen.getByText('feat(goals): publish stable work')).toBeInTheDocument();
    expect(screen.getByText('Checkpoint declaration and tests are complete.')).toBeInTheDocument();
    expect(screen.getByText('src/goals.ts')).toBeInTheDocument();
    expect(screen.getByText('test/goals.test.ts')).toBeInTheDocument();
    expect(screen.getByText('src/in-progress.ts')).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open draft PR/ })).toHaveAttribute('href', directGoal.finalPr!.url);
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
      taskId: 'goal-task-1', events: [{ id: 'initial', type: 'thought', content: 'Initial native output' }],
      todos: [], currentTask: 'Implementing', tokenUsage: null,
    } as never));
    act(() => liveHandler?.({
      taskId: 'goal-task-1', events: [{ id: 'next', type: 'thought', content: 'Incremental update' }],
      todos: [], currentTask: 'Testing', tokenUsage: null,
    } as never));
    expect(await screen.findByText('Initial native output')).toBeInTheDocument();
    expect(await screen.findByText('Incremental update')).toBeInTheDocument();

    socket.isConnected = false;
    view.rerender(page());
    socket.isConnected = true;
    view.rerender(page());
    await waitFor(() => expect(socket.subscribeToTaskLive).toHaveBeenCalledTimes(2));
  });
});
