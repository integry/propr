import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AgentsPage from './AgentsPage';
import { listAgentDefinitions, listAgentRuns, type AgentDefinitionRecord } from '../api/agentDefinitionsApi';

vi.mock('../api/agentDefinitionsApi', () => ({
  listAgentDefinitions: vi.fn(),
  listAgentRuns: vi.fn(),
}));

// The editor has its own suite; here it only has to say which agent it shows and where its controls are.
vi.mock('../components/Agents/AgentEditor', () => ({
  AgentEditor: ({ definitionId, headerControls }: { definitionId: string | null; headerControls?: React.ReactNode }) => (
    <div data-testid="agent-editor">editor for {definitionId ?? 'new'}{headerControls}</div>
  ),
}));

const agent = (id: string, name: string, patch: Partial<AgentDefinitionRecord> = {}): AgentDefinitionRecord => ({
  id, ownerId: '1', name, description: null, repositories: ['integry/propr'], prompt: 'Report', attachments: [],
  agentAlias: 'claude-main', modelName: 'claude-opus-4-5', capabilities: ['repository_read'],
  includePreviousReports: false, previousReportsLimit: 0, scheduleCron: null, scheduleTimezone: 'UTC',
  scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run', enabled: true, revision: 0, createdAt: 0, updatedAt: 0,
  ...patch,
});

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/new" element={<AgentsPage isNew />} />
      <Route path="/agents/:definitionId" element={<AgentsPage />} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>,
);

const setViewport = (wide: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
};

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.mocked(listAgentDefinitions).mockResolvedValue({
      definitions: [
        agent('a1', 'Dependency review', { scheduleCron: '0 9 * * *', scheduleEnabled: true, nextRunAt: Date.now() + 3 * 3_600_000, autonomyMode: 'preview' }),
        agent('a2', 'Issue triage'),
      ],
      total: 2, limit: 200, offset: 0,
    });
    vi.mocked(listAgentRuns).mockImplementation(async id => ({
      runs: id === 'a1' ? [{ id: 'r1', state: 'completed' } as never] : [], total: 0, limit: 1, offset: 0,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens an agent beside the list on wide screens without leaving /agents', async () => {
    setViewport(true);
    renderAt('/agents');

    const row = await screen.findByRole('link', { name: /Dependency review/ });
    expect(row).toHaveTextContent('Daily 09:00 UTC · next in 3h');
    expect(row).toHaveTextContent('Preview');
    expect(await within(row).findByText('Completed')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-editor')).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(screen.getByTestId('location')).toHaveTextContent('/agents/a1');
    expect(within(screen.getByTestId('agent-split-list')).getByRole('link', { name: /Issue triage/ })).toBeInTheDocument();
    expect(within(screen.getByTestId('agent-split-details')).getByTestId('agent-editor')).toHaveTextContent('editor for a1');
    expect(screen.queryByText('Back to list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close agent' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/agents$/);
    expect(screen.queryByTestId('agent-editor')).not.toBeInTheDocument();
  });

  it('navigates to the agent on narrow screens and offers a way back to the list', async () => {
    setViewport(false);
    renderAt('/agents');

    fireEvent.click(await screen.findByRole('link', { name: /Issue triage/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('/agents/a2');
    expect(screen.getByTestId('agent-editor')).toHaveTextContent('editor for a2');
    expect(screen.queryByRole('link', { name: /Dependency review/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Back to list' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/agents$/);
    expect(await screen.findByRole('link', { name: /Dependency review/ })).toBeInTheDocument();
  });

  it('opens the new-agent editor from the list', async () => {
    setViewport(true);
    renderAt('/agents');
    fireEvent.click(await screen.findByRole('link', { name: 'New agent' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/new');
    expect(screen.getByTestId('agent-editor')).toHaveTextContent('editor for new');
  });

  it('explains what an agent is when there are none', async () => {
    setViewport(true);
    vi.mocked(listAgentDefinitions).mockResolvedValue({ definitions: [], total: 0, limit: 200, offset: 0 });
    renderAt('/agents');
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(screen.getByText(/runs on demand or on a schedule/)).toBeInTheDocument();
  });
});
