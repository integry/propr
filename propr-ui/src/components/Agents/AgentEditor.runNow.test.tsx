import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import {
  getAgentCapacity,
  getAgentDefinition,
  triggerAgentRun,
  updateAgentDefinition,
  type AgentCapacity,
  type AgentDefinitionRecord,
} from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { ToastProvider } from '../ui/Toast';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  getAgentDefinition: vi.fn(),
  getAgentCapacity: vi.fn(),
  triggerAgentRun: vi.fn(),
  updateAgentDefinition: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));
// The run view has its own suite; here it only has to show which run was opened.
vi.mock('./AgentRunDetail', () => ({ AgentRunDetail: ({ runId }: { runId: string }) => <p>run {runId}</p> }));

const definition: AgentDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
};

const nearLimit: AgentCapacity = { capacity: { status: 'near_limit', sessionPercent: 94, weeklyPercent: 40, provider: 'claude' }, threshold: 90 };

const roomy: AgentCapacity = { capacity: { status: 'ok', sessionPercent: 20, provider: 'claude' }, threshold: 90 };

/** A capacity check that stays pending until the test answers it. */
function pendingCapacity() {
  let answer: (capacity: AgentCapacity) => void = () => {};
  vi.mocked(getAgentCapacity).mockReturnValue(new Promise(resolve => { answer = resolve; }));
  return (capacity: AgentCapacity) => answer(capacity);
}

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

const Editor = () => {
  const location = useLocation();
  const runId = location.pathname.match(/\/runs\/([^/]+)$/)?.[1] ?? null;
  return <AgentEditor definitionId="agent-1" section={runId ? 'run' : 'settings'} runId={runId} onSaved={vi.fn()} onDeleted={vi.fn()} />;
};

const renderEditor = () => render(
  <ToastProvider>
    <MemoryRouter initialEntries={['/automations/agent-1']}>
      <Routes><Route path="/automations/*" element={<Editor />} /></Routes>
      <LocationProbe />
    </MemoryRouter>
  </ToastProvider>,
);

describe('AgentEditor Run now', () => {
  beforeEach(() => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents: [], repositories: [] } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-9', definitionId: 'agent-1', state: 'queued' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('starts the run and opens it when the subscription has room', async () => {
    vi.mocked(getAgentCapacity).mockResolvedValue({ capacity: { status: 'ok', sessionPercent: 20, provider: 'claude' }, threshold: 90 });
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/automations/agent-1/runs/run-9'));
    expect(getAgentCapacity).toHaveBeenCalledWith('agent-1');
    expect(triggerAgentRun).toHaveBeenCalledWith('agent-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('run run-9')).toBeInTheDocument();
  });

  it('confirms the start in a toast and shows the run under a breadcrumb instead of the tabs', async () => {
    vi.mocked(getAgentCapacity).mockResolvedValue(roomy);
    renderEditor();
    expect(await screen.findByRole('navigation', { name: 'Automation sections' })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await screen.findByText('run run-9');
    const header = screen.getByRole('banner');
    expect(within(header).queryByText('Run started')).not.toBeInTheDocument();
    expect(screen.getByText('Run started')).toBeInTheDocument();

    expect(screen.queryByRole('navigation', { name: 'Automation sections' })).not.toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Dependency review' })).toHaveAttribute('href', '/automations/agent-1');
    expect(within(breadcrumb).getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/automations/agent-1/runs');
    expect(within(breadcrumb).getByText('Run run-9')).toHaveAttribute('aria-current', 'page');
  });

  it('asks before running near the limit, and cancelling sends no run request', async () => {
    vi.mocked(getAgentCapacity).mockResolvedValue(nearLimit);
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('agent-capacity-warning')).toHaveTextContent(
      'Claude is at 94% of its session window (pause threshold 90%). Run anyway?',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(triggerAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/automations/agent-1');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
  });

  it('runs near the limit once the user confirms', async () => {
    vi.mocked(getAgentCapacity).mockResolvedValue(nearLimit);
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run anyway' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/automations/agent-1/runs/run-9'));
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
  });

  it('runs without asking when the usage cannot be read', async () => {
    vi.mocked(getAgentCapacity).mockRejectedValue(new Error('Agent Tank unavailable'));
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(triggerAgentRun).toHaveBeenCalledWith('agent-1'));
  });

  it('does not start the saved configuration when the form was edited while capacity was being checked', async () => {
    const answer = pendingCapacity();
    renderEditor();

    const runNow = await screen.findByRole('button', { name: 'Run now' });
    fireEvent.click(runNow);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Something else' } });
    answer(roomy);

    await waitFor(() => expect(screen.getByText('Save your changes to run them')).toBeInTheDocument());
    await act(async () => {});
    expect(triggerAgentRun).not.toHaveBeenCalled();

    // Undoing the edit offers Run now again: nothing was left marked as running.
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: definition.prompt } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled());
  });

  it('offers Run now again when a save made during the capacity check refused the start', async () => {
    const answer = pendingCapacity();
    let finishSave: (saved: AgentDefinitionRecord) => void = () => {};
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { answer(roomy); });
    expect(triggerAgentRun).not.toHaveBeenCalled();

    await act(async () => { finishSave({ ...definition, revision: 4 }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled());
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it('disables Run now for a disabled agent', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, enabled: false });
    renderEditor();

    expect(await screen.findByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByText('This automation is disabled')).toBeInTheDocument();
  });
});
