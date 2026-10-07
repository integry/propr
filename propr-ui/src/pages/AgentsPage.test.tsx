import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AgentsPage from './AgentsPage';
import { listAgentDefinitions, listAgentRuns, type AgentDefinitionRecord } from '../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../api/proprApi';

vi.mock('../api/agentDefinitionsApi', () => ({
  listAgentDefinitions: vi.fn(),
  listAgentRuns: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));

type EditorCallbacks = import('../components/Agents/useAgentEditor').AgentEditorCallbacks;
/** The callbacks each mocked editor was last rendered with, by the agent it shows ('new' for creation). */
const editorCallbacks = new Map<string, EditorCallbacks>();

// The editor has its own suite; here it only has to say which agent it shows and where its controls are.
vi.mock('../components/Agents/AgentEditor', () => ({
  AgentEditor: ({ definitionId, headerControls, ...callbacks }: { definitionId: string | null; headerControls?: React.ReactNode } & EditorCallbacks) => {
    editorCallbacks.set(definitionId ?? 'new', callbacks);
    return <div data-testid="agent-editor">editor for {definitionId ?? 'new'}{headerControls}</div>;
  },
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
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'] }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
    editorCallbacks.clear();
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

  it('names models and agents rather than showing their ids', async () => {
    vi.mocked(listAgentDefinitions).mockResolvedValue({
      definitions: [
        agent('a1', 'Dependency review'),
        agent('a2', 'Issue triage', { modelName: null }),
        agent('a3', 'Docs sweep', { agentAlias: null, modelName: null }),
      ],
      total: 3, limit: 200, offset: 0,
    });
    setViewport(true);
    renderAt('/agents');

    expect(await screen.findByRole('link', { name: /Dependency review/ })).toHaveTextContent('Claude Opus 4.5');
    expect(await screen.findByRole('link', { name: /Issue triage/ })).toHaveTextContent(/propr\s*Claude\s*Manual/);
    expect(screen.getByRole('link', { name: /Docs sweep/ })).toHaveTextContent('Default agent');
    expect(screen.getByRole('list', { name: 'Agents' })).not.toHaveTextContent(/claude-main|claude-opus-4-5/);
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

  it('reads every page so agents past the first page can be found by search', async () => {
    setViewport(true);
    const firstPage = Array.from({ length: 200 }, (_, index) => agent(`p${index}`, `Agent ${index}`));
    vi.mocked(listAgentDefinitions).mockImplementation(async page => (page?.offset ?? 0) === 0
      ? { definitions: firstPage, total: 202, limit: 200, offset: 0 }
      // The last row of page one shifted down while paging; it must not appear twice.
      : { definitions: [firstPage[199], agent('late', 'Quarterly audit')], total: 202, limit: 200, offset: 200 });
    renderAt('/agents');

    await screen.findByRole('link', { name: /Agent 0/ });
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Quarterly' } });

    expect(await screen.findByRole('link', { name: /Quarterly audit/ })).toBeInTheDocument();
    expect(listAgentDefinitions).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    expect(listAgentDefinitions).toHaveBeenCalledWith({ limit: 200, offset: 200 });
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Agent 199' } });
    expect(screen.getAllByRole('link', { name: /Agent 199/ })).toHaveLength(1);
  });

  it('lists a creation that finishes after its editor was closed without leaving the agent now open', async () => {
    setViewport(true);
    renderAt('/agents/new');
    await screen.findByRole('link', { name: /Issue triage/ });
    const creating = editorCallbacks.get('new')!;

    fireEvent.click(screen.getByRole('link', { name: /Issue triage/ }));
    expect(screen.getByTestId('agent-editor')).toHaveTextContent('editor for a2');

    act(() => creating.onSaved(agent('a3', 'Fresh agent'), true, false));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/a2');
    expect(screen.getByTestId('agent-editor')).toHaveTextContent('editor for a2');
    expect(screen.getByRole('link', { name: /Fresh agent/ })).toBeInTheDocument();
  });

  it('opens a created agent when its editor is still open', async () => {
    setViewport(true);
    renderAt('/agents/new');
    await screen.findByRole('link', { name: /Issue triage/ });

    act(() => editorCallbacks.get('new')!.onSaved(agent('a3', 'Fresh agent'), true, true));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/a3');
    expect(screen.getByRole('link', { name: /Fresh agent/ })).toBeInTheDocument();
  });

  it('drops a deleted agent from the list without leaving the agent now open', async () => {
    setViewport(true);
    renderAt('/agents/a1');
    await screen.findByRole('link', { name: /Issue triage/ });
    const deleting = editorCallbacks.get('a1')!;

    fireEvent.click(screen.getByRole('link', { name: /Issue triage/ }));
    act(() => deleting.onDeleted('a1', false));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/a2');
    expect(screen.queryByRole('link', { name: /Dependency review/ })).not.toBeInTheDocument();
  });

  it('explains what an agent is when there are none', async () => {
    setViewport(true);
    vi.mocked(listAgentDefinitions).mockResolvedValue({ definitions: [], total: 0, limit: 200, offset: 0 });
    renderAt('/agents');
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(screen.getByText(/runs on demand or on a schedule/)).toBeInTheDocument();
  });
  it('refreshes an unfinished run until it settles, including a run started from the editor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport(true);
    const states: Record<string, string> = { a1: 'completed', a2: 'running' };
    vi.mocked(listAgentRuns).mockImplementation(async id => ({ runs: [{ id: `r-${id}`, state: states[id] } as never], total: 1, limit: 1, offset: 0 }));
    renderAt('/agents/a1');

    const triage = await screen.findByRole('link', { name: /Issue triage/ });
    expect(await within(triage).findByText('Running')).toBeInTheDocument();
    states.a2 = 'awaiting_approval';
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(within(triage).getByText('Awaiting approval')).toBeInTheDocument();
    states.a2 = 'completed';
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(within(triage).getByText('Completed')).toBeInTheDocument();

    // Settled agents are no longer read.
    vi.mocked(listAgentRuns).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(listAgentRuns).not.toHaveBeenCalled();

    const review = screen.getByRole('link', { name: /Dependency review/ });
    states.a1 = 'queued';
    act(() => editorCallbacks.get('a1')!.onRunStarted!({ id: 'r-new', definitionId: 'a1', state: 'queued' } as never));
    expect(within(review).getByText('Queued')).toBeInTheDocument();
    states.a1 = 'failed';
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(within(review).getByText('Failed')).toBeInTheDocument();
    expect(listAgentRuns).toHaveBeenCalledWith('a1', { limit: 1 });
  });

  it('does not let a read sent before a run started overwrite that run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport(true);
    let finishRead: () => void = () => undefined;
    vi.mocked(listAgentRuns).mockImplementation(async id => {
      if (id === 'a1') await new Promise<void>(resolve => { finishRead = resolve; });
      return { runs: id === 'a1' ? [{ id: 'old', state: 'completed' } as never] : [], total: 1, limit: 1, offset: 0 };
    });
    renderAt('/agents/a1');
    const review = await screen.findByRole('link', { name: /Dependency review/ });
    await waitFor(() => expect(listAgentRuns).toHaveBeenCalledWith('a1', { limit: 1 }));

    act(() => editorCallbacks.get('a1')!.onRunStarted!({ id: 'new', definitionId: 'a1', state: 'queued' } as never));
    await act(async () => { finishRead(); });
    expect(within(review).getByText('Queued')).toBeInTheDocument();
  });

  it('stops refreshing run states when the page unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport(true);
    vi.mocked(listAgentRuns).mockResolvedValue({ runs: [{ id: 'r', state: 'running' } as never], total: 1, limit: 1, offset: 0 });
    const { unmount } = renderAt('/agents');
    const triage = await screen.findByRole('link', { name: /Issue triage/ });
    await within(triage).findByText('Running');

    unmount();
    vi.mocked(listAgentRuns).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(listAgentRuns).not.toHaveBeenCalled();
  });
});
