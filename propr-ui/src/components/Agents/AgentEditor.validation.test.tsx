import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import { createAutomationDefinition, type AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/automationDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/automationDefinitionsApi')>()),
  createAutomationDefinition: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const definition = {
  id: 'agent-2', ownerId: '1', name: 'Nightly triage', description: null, repositories: [], prompt: 'Summarize new issues', attachments: [],
  agentAlias: null, modelName: null, capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run', enabled: true,
  revision: 1, createdAt: 0, updatedAt: 0,
} as AutomationDefinitionRecord;

const renderEditor = () =>
  render(<AgentEditor definitionId={null} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

const fillRequired = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly triage' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize new issues' } });
};

/** Errors in words under their fields, focus on the first after a refused submit, and the Report only rule for merging. */
describe('AgentEditor validation', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' }],
      defaultAgentAlias: 'claude-main',
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('words an invalid cron under the field, focuses it on submit and sends no request', async () => {
    renderEditor();
    fillRequired();
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '61 * * * *' } });

    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent('The minute must be from 0 to 59.');

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(screen.getByLabelText('Cron expression')).toHaveFocus());
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(createAutomationDefinition).not.toHaveBeenCalled();
  });

  it('requires a name and a prompt, shown under each field, and focuses the first', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    expect(await screen.findByTestId('agent-name-error')).toHaveTextContent('Enter a name.');
    expect(screen.getByTestId('agent-prompt-error')).toHaveTextContent('Enter a prompt.');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Enter a name.');
    expect(screen.queryByText('name is required')).not.toBeInTheDocument();
    // Once corrected, the field's error goes as it is typed.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly triage' } });
    expect(screen.queryByTestId('agent-name-error')).not.toBeInTheDocument();
    expect(createAutomationDefinition).not.toHaveBeenCalled();
  });

  it('disables Merge pull requests while the automation is Report only, keeps the choice, and never sends it', async () => {
    vi.mocked(createAutomationDefinition).mockResolvedValue({ ...definition, id: 'agent-2' });
    renderEditor();
    fillRequired();
    const mergeToggle = screen.getByRole('switch', { name: /Merge pull requests/ });
    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }));
    fireEvent.click(mergeToggle);
    expect(mergeToggle).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Report only' }));
    expect(mergeToggle).toBeDisabled();
    expect(mergeToggle).not.toBeChecked();
    expect(screen.getByTestId('agent-capability-merge-hint')).toHaveTextContent('Not available with Report only: there is no action step to merge in.');
    expect(mergeToggle).toHaveAccessibleDescription(/Not available with Report only/);
    // Choosing an autonomy with an action step again brings the choice back.
    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }));
    expect(mergeToggle).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Report only' }));

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(createAutomationDefinition).toHaveBeenCalled());
    expect(vi.mocked(createAutomationDefinition).mock.calls[0][0]).toEqual(expect.objectContaining({ autonomy: 'dry_run' }));
    expect(vi.mocked(createAutomationDefinition).mock.calls[0][0].capabilities).not.toContain('merge');
  });
});
