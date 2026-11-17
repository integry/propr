import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AgentsPage from './AgentsPage';
import { listAutomationDefinitions, listAutomationRuns, type AutomationDefinitionRecord } from '../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../api/proprApi';

vi.mock('../api/automationDefinitionsApi', () => ({
  listAutomationDefinitions: vi.fn(),
  listAutomationRuns: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../api/userRepoPreferencesApi', () => ({ getUserRepoPreferences: vi.fn(async () => ({})) }));
vi.mock('../api/repoIndexingApi', () => ({
  getRepositoriesIndexingStatus: vi.fn(async () => ({ repositories: [] })),
  getRepoStatusKey: (name: string, branch?: string) => `${name}@${branch ?? ''}`,
}));
// The editor has its own suites; here it only has to say which automation it shows and offer Close.
vi.mock('../components/Agents/AgentEditor', () => ({
  AgentEditor: ({ definitionId, headerControls }: { definitionId: string | null; headerControls?: React.ReactNode }) => (
    <div data-testid="agent-editor">editor for {definitionId ?? 'new'}{headerControls}</div>
  ),
}));

const agent = (id: string, name: string, patch: Partial<AutomationDefinitionRecord> = {}): AutomationDefinitionRecord => ({
  id, ownerId: '1', name, description: null, repositories: ['integry/propr'], prompt: 'Report', attachments: [],
  agentAlias: 'claude-main', modelName: 'claude-opus-4-5', capabilities: ['repository_read'],
  includePreviousReports: false, previousReportsLimit: 0, scheduleCron: null, scheduleTimezone: 'UTC',
  scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run', enabled: true, revision: 0, createdAt: 0, updatedAt: 0,
  ...patch,
});

const definitions = [
  agent('a1', 'Dependency review', { repositories: ['integry/propr', 'integry/api'] }),
  agent('a2', 'Issue triage', { repositories: ['integry/api'], description: 'Labels new issues' }),
  agent('a3', 'Weekly digest', { repositories: [] }),
];

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

/** Stands in for the browser's Back button. */
const BackButton = () => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Browser back</button>;
};

const renderAt = (...entries: string[]) => render(
  <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
    <Routes>
      <Route path="/automations" element={<AgentsPage />} />
      <Route path="/automations/:definitionId" element={<AgentsPage />} />
      <Route path="/elsewhere" element={<p>Elsewhere</p>} />
    </Routes>
    <LocationProbe />
    <BackButton />
  </MemoryRouter>,
);

const setViewport = (wide: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
};

const rowNames = () => screen.queryAllByTestId('agent-row').map(row => row.querySelector('.truncate')?.textContent);
const location = () => screen.getByTestId('location').textContent;

describe('AgentsPage list filters', () => {
  beforeEach(() => {
    setViewport(true);
    vi.mocked(listAutomationDefinitions).mockResolvedValue({ definitions, total: definitions.length, limit: 200, offset: 0 });
    vi.mocked(listAutomationRuns).mockResolvedValue({ runs: [], total: 0, limit: 1, offset: 0, nextOffset: null });
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents: [], repositories: [] } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the shared list header: title, search and repository filter', async () => {
    renderAt('/automations');
    await screen.findByText('Dependency review');
    const header = screen.getByRole('heading', { level: 1, name: 'Automations' }).closest('header')!;
    expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toHaveClass('text-lg', 'sm:text-2xl', 'font-bold');
    expect(header).toHaveClass('px-4', 'py-2', 'sm:px-6', 'sm:py-4', 'bg-slate-50');
    expect(within(header).getByRole('textbox', { name: 'Search automations' })).toHaveAttribute('maxLength', '500');
    expect(within(header).getByRole('group', { name: 'Filter automations by repository' })).toBeInTheDocument();
  });

  it('narrows the list to automations in the selected repository and leaves ones without repositories under All Repos', async () => {
    renderAt('/automations');
    await screen.findByText('Dependency review');
    expect(rowNames()).toEqual(['Dependency review', 'Issue triage', 'Weekly digest']);

    const filter = screen.getByRole('group', { name: 'Filter automations by repository' });
    fireEvent.click(within(filter).getByRole('button', { name: /All Repos/ }));
    fireEvent.click(await screen.findByRole('button', { name: /integry.*api/ }));

    expect(location()).toBe('/automations?repository=integry%2Fapi');
    expect(rowNames()).toEqual(['Dependency review', 'Issue triage']);

    fireEvent.click(within(filter).getByRole('button', { name: /integry.*api/ }));
    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));
    expect(location()).toBe('/automations');
    expect(rowNames()).toEqual(['Dependency review', 'Issue triage', 'Weekly digest']);
  });

  it('searches automation names case-insensitively after the debounce and keeps the query in the URL', async () => {
    renderAt('/automations');
    await screen.findByText('Dependency review');
    const search = screen.getByRole('textbox', { name: 'Search automations' });

    fireEvent.change(search, { target: { value: 'TRIAGE' } });
    // The field follows typing at once; the list and the URL follow one debounce behind.
    expect(rowNames()).toHaveLength(3);
    await waitFor(() => expect(rowNames()).toEqual(['Issue triage']));
    expect(location()).toBe('/automations?search=TRIAGE');

    // The list does not show descriptions, so they are not searched.
    fireEvent.change(search, { target: { value: 'labels' } });
    await waitFor(() => expect(screen.getByText('No automations match “labels”')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(location()).toBe('/automations');
  });

  it('searches for "all" like any other word, not as the All Repos sentinel', async () => {
    const withAll = [...definitions, agent('a4', 'All checks', { repositories: ['integry/api'] })];
    vi.mocked(listAutomationDefinitions).mockResolvedValue({ definitions: withAll, total: withAll.length, limit: 200, offset: 0 });
    renderAt('/automations');
    await screen.findByText('Dependency review');

    fireEvent.change(screen.getByRole('textbox', { name: 'Search automations' }), { target: { value: 'all' } });
    await waitFor(() => expect(location()).toBe('/automations?search=all'));
    expect(rowNames()).toEqual(['All checks']);

    // Choosing All Repos still clears the repository filter and leaves the search alone.
    const filter = screen.getByRole('group', { name: 'Filter automations by repository' });
    fireEvent.click(within(filter).getByRole('button', { name: /All Repos/ }));
    fireEvent.click(await screen.findByRole('button', { name: /integry.*api/ }));
    expect(location()).toBe('/automations?search=all&repository=integry%2Fapi');
    fireEvent.click(within(filter).getByRole('button', { name: /integry.*api/ }));
    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));
    expect(location()).toBe('/automations?search=all');
    expect(rowNames()).toEqual(['All checks']);
  });

  it('applies the previous query again when it is re-entered right after Clear search', async () => {
    renderAt('/automations');
    await screen.findByText('Dependency review');
    const search = screen.getByRole('textbox', { name: 'Search automations' });
    fireEvent.change(search, { target: { value: 'triage' } });
    await waitFor(() => expect(location()).toBe('/automations?search=triage'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(location()).toBe('/automations');
    // Within the debounce that followed the clear.
    fireEvent.change(search, { target: { value: 'triage' } });
    await waitFor(() => expect(location()).toBe('/automations?search=triage'));
    expect(rowNames()).toEqual(['Issue triage']);
    expect(search).toHaveValue('triage');
  });

  it('applies the previous query again when it is re-entered right after Clear filters', async () => {
    renderAt('/automations?search=labels');
    expect(await screen.findByText('No automations match “labels”')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(location()).toBe('/automations');
    const search = screen.getByRole('textbox', { name: 'Search automations' });
    fireEvent.change(search, { target: { value: 'labels' } });
    await waitFor(() => expect(location()).toBe('/automations?search=labels'));
    expect(screen.getByText('No automations match “labels”')).toBeInTheDocument();
  });

  it('restores both filters from the URL on reload and on Back', async () => {
    renderAt('/elsewhere', '/automations?repository=integry%2Fapi&search=review');
    await screen.findByText('Dependency review');
    expect(rowNames()).toEqual(['Dependency review']);
    expect(screen.getByRole('textbox', { name: 'Search automations' })).toHaveValue('review');
    expect(within(screen.getByRole('group', { name: 'Filter automations by repository' })).getByRole('button', { name: /integry.*api/ })).toBeInTheDocument();

    // Opening an automation beside the list keeps the filters it was found with; Close returns to them.
    fireEvent.click(screen.getByRole('link', { name: /Dependency review/ }));
    expect(location()).toBe('/automations/a1?repository=integry%2Fapi&search=review');
    expect(rowNames()).toEqual(['Dependency review']);
    fireEvent.click(screen.getByRole('button', { name: 'Close automation' }));
    expect(location()).toBe('/automations?repository=integry%2Fapi&search=review');

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(location()).toBe('/automations/a1?repository=integry%2Fapi&search=review');
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(location()).toBe('/elsewhere');
  });

  it('tells a filtered-empty list apart from having no automations', async () => {
    renderAt('/automations?search=nothing-like-this');
    expect(await screen.findByText('No automations match “nothing-like-this”')).toBeInTheDocument();
    expect(screen.queryByText('No automations yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New automation' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(location()).toBe('/automations');
    expect(rowNames()).toHaveLength(3);
    expect(screen.getByRole('textbox', { name: 'Search automations' })).toHaveValue('');
  });

  it('says which repository emptied the list', async () => {
    renderAt('/automations?repository=integry%2Fdesktop');
    expect(await screen.findByText('No automations in integry/desktop')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rowNames()).toHaveLength(3);
  });

  it('keeps the call to action when there are no automations at all, even with filters in the URL', async () => {
    vi.mocked(listAutomationDefinitions).mockResolvedValue({ definitions: [], total: 0, limit: 200, offset: 0 });
    renderAt('/automations?search=triage');
    expect(await screen.findByText('No automations yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New automation' })).toBeInTheDocument();
    expect(screen.queryByText(/No automations match/)).not.toBeInTheDocument();
    // Nothing to filter yet, so the header carries only the title.
    expect(screen.queryByRole('textbox', { name: 'Search automations' })).not.toBeInTheDocument();
  });
});
