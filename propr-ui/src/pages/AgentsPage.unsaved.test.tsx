import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AgentsPage from './AgentsPage';
import { listAutomationDefinitions, listAutomationRuns, type AutomationDefinitionRecord } from '../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../api/proprApi';

vi.mock('../api/automationDefinitionsApi', () => ({
  listAutomationDefinitions: vi.fn(),
  listAutomationRuns: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));

type EditorCallbacks = import('../components/Agents/useAgentEditor').AgentEditorCallbacks;
/** The callbacks each mocked editor was last rendered with, by the agent it shows ('new' for creation). */
const editorCallbacks = new Map<string, EditorCallbacks>();

// The editor has its own suite; here it only has to say which agent it shows and where its controls are.
vi.mock('../components/Agents/AgentEditor', () => ({
  AgentEditor: ({ definitionId, headerControls, templateId, ...callbacks }: { definitionId: string | null; headerControls?: React.ReactNode; templateId?: string | null } & EditorCallbacks) => {
    editorCallbacks.set(definitionId ?? 'new', callbacks);
    return <div data-testid="agent-editor">editor for {definitionId ?? 'new'}{templateId ? ` from ${templateId}` : ''}{headerControls}</div>;
  },
}));

const agent = (id: string, name: string, patch: Partial<AutomationDefinitionRecord> = {}): AutomationDefinitionRecord => ({
  id, ownerId: '1', name, description: null, repositories: ['integry/propr'], prompt: 'Report', attachments: [],
  agentAlias: 'claude-main', modelName: 'claude-opus-4-5', capabilities: ['repository_read'],
  includePreviousReports: false, previousReportsLimit: 0, scheduleCron: null, scheduleTimezone: 'UTC',
  scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run', enabled: true, revision: 0, createdAt: 0, updatedAt: 0,
  ...patch,
});

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/automations" element={<AgentsPage />} />
      <Route path="/automations/new" element={<AgentsPage isNew />} />
      <Route path="/automations/:definitionId" element={<AgentsPage />} />
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

/** Templates shown once, and typed input that closing or replacing the editor would drop. */
describe('AgentsPage unsaved input and templates', () => {
  beforeEach(() => {
    vi.mocked(listAutomationDefinitions).mockResolvedValue({
      definitions: [
        agent('a1', 'Dependency review', { scheduleCron: '0 9 * * *', scheduleEnabled: true, nextRunAt: Date.now() + 3 * 3_600_000, autonomyMode: 'preview' }),
        agent('a2', 'Issue triage'),
      ],
      total: 2, limit: 200, offset: 0,
    });
    vi.mocked(listAutomationRuns).mockImplementation(async id => ({
      runs: id === 'a1' ? [{ id: 'r1', state: 'completed' } as never] : [], total: 0, limit: 1, offset: 0, nextOffset: null,
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

  it('shows the templates once, in the new-automation form, when it is open beside an empty list', async () => {
    setViewport(true);
    vi.mocked(listAutomationDefinitions).mockResolvedValue({ definitions: [], total: 0, limit: 200, offset: 0 });
    renderAt('/automations/new');
    expect(await screen.findByText('No automations yet')).toBeInTheDocument();
    expect(screen.getByText('A saved prompt that runs on a schedule or on demand and writes a report.')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-template-links')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('agent-split-list')).queryByRole('link', { name: 'New automation' })).not.toBeInTheDocument();
  });

  it('asks before Escape, Close or another automation drops unsaved input, and keeps it when declined', async () => {
    setViewport(true);
    renderAt('/automations/a1');
    await screen.findByRole('link', { name: /Issue triage/ });
    const markUnsaved = (id: string, unsaved: boolean) =>
      act(() => { (editorCallbacks.get(id) as EditorCallbacks & { onUnsavedChange: (value: boolean) => void }).onUnsavedChange(unsaved); });
    markUnsaved('a1', true);

    fireEvent.keyDown(window, { key: 'Escape' });
    const question = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
    fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/automations/a1');

    fireEvent.click(screen.getByRole('link', { name: /Issue triage/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/automations/a1');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Discard' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/automations/a2');
    expect(screen.getByTestId('agent-editor')).toHaveTextContent('editor for a2');

    // Nothing typed: Close goes straight away.
    markUnsaved('a2', false);
    fireEvent.click(screen.getByRole('button', { name: 'Close automation' }));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/automations$/);
  });

  it('asks before the Close button drops unsaved input', async () => {
    setViewport(true);
    renderAt('/automations/new');
    await screen.findByTestId('agent-editor');
    act(() => { (editorCallbacks.get('new') as EditorCallbacks & { onUnsavedChange: (value: boolean) => void }).onUnsavedChange(true); });
    fireEvent.click(screen.getByRole('button', { name: 'Close automation' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Discard' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/automations$/);
  });
});
