import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AgentsPage from './AgentsPage';
import { getAgentDefinition, listAgentDefinitions, listAgentRuns, type AgentDefinitionRecord } from '../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../api/proprApi';

// The real editor is rendered here: what matters is that its working form survives a layout change.
vi.mock('../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/agentDefinitionsApi')>()),
  listAgentDefinitions: vi.fn(),
  listAgentRuns: vi.fn(),
  getAgentDefinition: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn().mockResolvedValue([{ name: 'integry/propr', enabled: true }]),
}));

const saved: AgentDefinitionRecord = {
  id: 'a1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 2, createdAt: 0, updatedAt: 0,
};

/** A viewport that starts at one side of the split breakpoint and can be resized across it. */
const stubViewport = (wide: boolean) => {
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return wide; },
    media: query, onchange: null,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  return (nextWide: boolean) => act(() => {
    wide = nextWide;
    listeners.forEach(listener => listener());
  });
};

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/automations/new" element={<AgentsPage isNew />} />
      <Route path="/automations/:definitionId" element={<AgentsPage />} />
    </Routes>
  </MemoryRouter>,
);

describe('AgentsPage across the split breakpoint', () => {
  beforeEach(() => {
    vi.mocked(listAgentDefinitions).mockResolvedValue({ definitions: [saved], total: 1, limit: 200, offset: 0 });
    vi.mocked(listAgentRuns).mockResolvedValue({ runs: [], total: 0, limit: 1, offset: 0, nextOffset: null });
    vi.mocked(getAgentDefinition).mockResolvedValue(saved);
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps an unsaved new agent when the viewport narrows and widens again', async () => {
    const resize = stubViewport(true);
    renderAt('/automations/new');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Nightly triage' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize new issues' } });

    resize(false);
    expect(screen.getByTestId('agents-detail-page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to list' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Nightly triage');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Summarize new issues');

    resize(true);
    expect(screen.getByTestId('agent-split-details')).toContainElement(screen.getByTestId('agent-editor'));
    expect(screen.getByRole('button', { name: 'Close automation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Nightly triage');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Summarize new issues');
  });

  it('keeps edits to a saved agent when the viewport widens and narrows again without reloading it', async () => {
    const resize = stubViewport(false);
    renderAt('/automations/a1');

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Dependency review');
    fireEvent.change(name, { target: { value: 'Dependency review (weekly)' } });

    resize(true);
    expect(screen.getByTestId('agent-split-details')).toContainElement(screen.getByTestId('agent-editor'));
    expect(screen.getByLabelText('Name')).toHaveValue('Dependency review (weekly)');

    resize(false);
    expect(screen.getByTestId('agents-detail-page')).toContainElement(screen.getByTestId('agent-editor'));
    expect(screen.getByLabelText('Name')).toHaveValue('Dependency review (weekly)');
    expect(getAgentDefinition).toHaveBeenCalledTimes(1);
  });
});
