import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { validateAgentSchedule } from '@propr/shared';
import { AgentEditor } from './AgentEditor';
import {
  AgentApiError,
  createAgentDefinition,
  getAgentDefinition,
  updateAgentDefinition,
  type AgentDefinitionRecord,
} from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  createAgentDefinition: vi.fn(),
  getAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  uploadAgentAttachment: vi.fn(),
  deleteAgentAttachment: vi.fn(),
  triggerAgentRun: vi.fn(),
}));

vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn().mockResolvedValue([{ name: 'integry/propr', enabled: true }]),
}));

const definition: AgentDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
};

const renderEditor = (definitionId: string | null = null) => render(
  <AgentEditor definitionId={definitionId} onSaved={vi.fn()} onDeleted={vi.fn()} />,
);

const fillRequired = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly triage' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize new issues' } });
};

describe('AgentEditor', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [
        { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' },
        { alias: 'opencode-main', type: 'opencode', enabled: true, supportedModels: ['opencode-model'] },
      ],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows the shared validation message for an invalid cron and sends no request', async () => {
    renderEditor();
    fillRequired();
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '61 * * * *' } });

    const message = validateAgentSchedule('61 * * * *')!;
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent(message);

    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(createAgentDefinition).not.toHaveBeenCalled();
  });

  it('requires a name before creating', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('name is required');
    expect(createAgentDefinition).not.toHaveBeenCalled();
  });

  it('creates an agent with the form contents', async () => {
    vi.mocked(createAgentDefinition).mockResolvedValue({ ...definition, id: 'agent-2' });
    renderEditor();
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(createAgentDefinition).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nightly triage', prompt: 'Summarize new issues', schedule: null, autonomy: 'dry_run', capabilities: ['repository_read'],
    })));
  });

  it('disables the propr_mcp toggle and acting autonomy for an OpenCode agent', async () => {
    renderEditor();
    const agentSelect = await screen.findByTitle('Select AI agent');
    await waitFor(() => expect(screen.getByRole('option', { name: 'opencode-main' })).toBeInTheDocument());

    fireEvent.change(agentSelect, { target: { value: 'claude-main' } });
    const mcpToggle = screen.getByRole('switch', { name: /ProPR tools/ });
    expect(mcpToggle).toBeEnabled();
    fireEvent.click(mcpToggle);
    expect(mcpToggle).toBeChecked();

    fireEvent.change(agentSelect, { target: { value: 'opencode-main' } });
    expect(mcpToggle).toBeDisabled();
    expect(mcpToggle).not.toBeChecked();
    expect(screen.getByTestId('agent-capability-propr_mcp-hint')).toHaveTextContent('only Claude and Codex');
    expect(screen.getByTestId('agent-capability-web-hint')).toHaveTextContent('Best effort on opencode');
    expect(screen.getByRole('radio', { name: /^Auto/ })).toBeDisabled();
  });

  it('previews the next run of a preset in UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays 09:00' }));

    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 9 * * 1-5');
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent('Next run: Thu 8 Oct 09:00 UTC');
  });

  it('sends the loaded revision and shows a conflict when the agent changed elsewhere', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    renderEditor('agent-1');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Changed elsewhere — reload')).toBeInTheDocument();
    expect(updateAgentDefinition).toHaveBeenCalledWith('agent-1', expect.objectContaining({ name: 'Renamed' }), 3);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, name: 'Changed in another tab', revision: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Changed in another tab'));
    expect(screen.queryByText('Changed elsewhere — reload')).not.toBeInTheDocument();
  });

  it('locks the name and description while a save is pending so later typing is not overwritten', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finish: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderEditor('agent-1');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeDisabled());
    expect(screen.getByLabelText('Description')).toBeDisabled();

    finish({ ...definition, name: 'Renamed', revision: 4 });
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeEnabled());
    expect(screen.getByLabelText('Description')).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Renamed');
  });
});
