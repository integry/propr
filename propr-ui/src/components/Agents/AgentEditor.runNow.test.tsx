import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import {
  getAgentCapacity,
  getAgentDefinition,
  triggerAgentRun,
  type AgentCapacity,
  type AgentDefinitionRecord,
} from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  getAgentDefinition: vi.fn(),
  getAgentCapacity: vi.fn(),
  triggerAgentRun: vi.fn(),
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

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

const Editor = () => {
  const location = useLocation();
  const runId = location.pathname.match(/\/runs\/([^/]+)$/)?.[1] ?? null;
  return <AgentEditor definitionId="agent-1" section={runId ? 'run' : 'settings'} runId={runId} onSaved={vi.fn()} onDeleted={vi.fn()} />;
};

const renderEditor = () => render(
  <MemoryRouter initialEntries={['/agents/agent-1']}>
    <Routes><Route path="/agents/*" element={<Editor />} /></Routes>
    <LocationProbe />
  </MemoryRouter>,
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
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/agents/agent-1/runs/run-9'));
    expect(getAgentCapacity).toHaveBeenCalledWith('agent-1');
    expect(triggerAgentRun).toHaveBeenCalledWith('agent-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('run run-9')).toBeInTheDocument();
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
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/agent-1');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
  });

  it('runs near the limit once the user confirms', async () => {
    vi.mocked(getAgentCapacity).mockResolvedValue(nearLimit);
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run anyway' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/agents/agent-1/runs/run-9'));
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
  });

  it('runs without asking when the usage cannot be read', async () => {
    vi.mocked(getAgentCapacity).mockRejectedValue(new Error('Agent Tank unavailable'));
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(triggerAgentRun).toHaveBeenCalledWith('agent-1'));
  });

  it('disables Run now for a disabled agent', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, enabled: false });
    renderEditor();

    expect(await screen.findByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByText('This agent is disabled')).toBeInTheDocument();
  });
});
