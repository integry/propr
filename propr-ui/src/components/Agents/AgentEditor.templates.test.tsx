import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getAutomationTemplate, type AutomationTemplate } from '@propr/shared';
import { AgentEditor } from './AgentEditor';
import { createAutomationDefinition, getAutomationDefinition, type AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { emptyAgentForm, formFromTemplate, formToInput } from './agentEditorForm';

vi.mock('../../api/automationDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/automationDefinitionsApi')>()),
  createAutomationDefinition: vi.fn(), getAutomationDefinition: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn().mockResolvedValue([{ name: 'integry/propr', enabled: true }]),
}));

const triage = getAutomationTemplate('daily-issue-triage') as AutomationTemplate;

const saved: AutomationDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: null, modelName: null,
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: 0, updatedAt: 0,
};

const renderEditor = (props: { definitionId?: string | null; templateId?: string | null } = {}) =>
  render(<AgentEditor definitionId={props.definitionId ?? null} templateId={props.templateId} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

const expectPrefilled = () => {
  expect(screen.getByLabelText('Name')).toHaveValue(triage.name);
  expect(screen.getByLabelText('Description')).toHaveValue(triage.description);
  expect(screen.getByLabelText('Prompt')).toHaveValue(triage.prompt);
  expect(screen.getByLabelText('Cron expression')).toHaveValue(triage.schedule);
  expect(screen.getByRole('radio', { name: 'Dry run' })).toBeChecked();
  const review = screen.getByTestId('agent-template-review');
  for (const label of ['Repositories', 'Schedule', 'Autonomy']) expect(review).toHaveTextContent(`${label}:`);
};

describe('AgentEditor templates', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('prefills the form from a chosen template and creates nothing until the user saves', async () => {
    vi.mocked(createAutomationDefinition).mockResolvedValue({ ...saved, id: 'agent-2' });
    renderEditor();
    const picker = screen.getByTestId('agent-template-picker');
    expect(picker).toHaveTextContent('Start from a template');
    expect(screen.queryByTestId('agent-template-review')).not.toBeInTheDocument();

    fireEvent.click(within(picker).getByRole('button', { name: /Daily issue triage/ }));
    expectPrefilled();
    expect(within(picker).getByRole('button', { name: /Daily issue triage/ })).toHaveAttribute('aria-pressed', 'true');
    expect(createAutomationDefinition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(createAutomationDefinition).toHaveBeenCalledTimes(1));
    expect(createAutomationDefinition).toHaveBeenCalledWith(expect.objectContaining({
      name: triage.name, description: triage.description, prompt: triage.prompt, schedule: triage.schedule,
      autonomy: 'dry_run', capabilities: triage.capabilities, previousReportCount: triage.previousReportCount, repositories: [],
    }));
  });

  it('opens prefilled from the template named in the link', () => {
    renderEditor({ templateId: 'daily-issue-triage' });
    expectPrefilled();
  });

  it('opens an empty form for an unknown template', () => {
    renderEditor({ templateId: 'no-such-template' });
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.queryByTestId('agent-template-review')).not.toBeInTheDocument();
  });

  it('offers no templates when editing a saved automation', async () => {
    vi.mocked(getAutomationDefinition).mockResolvedValue(saved);
    renderEditor({ definitionId: 'agent-1', templateId: 'daily-issue-triage' });
    expect(await screen.findByLabelText('Name')).toHaveValue('Dependency review');
    expect(screen.queryByTestId('agent-template-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-template-review')).not.toBeInTheDocument();
  });

  it('keeps chosen repositories and agent, and always resets autonomy to dry_run', () => {
    const current = { ...emptyAgentForm(), repositories: ['integry/propr'], agentId: 'claude-main', model: 'claude-opus-4-5', autonomy: 'auto' as const, name: 'Mine' };
    const form = formFromTemplate(triage, current);
    expect(form).toMatchObject({ repositories: ['integry/propr'], agentId: 'claude-main', model: 'claude-opus-4-5', autonomy: 'dry_run', name: triage.name, scheduleEnabled: true });
    expect(formToInput(form)).toMatchObject({ autonomy: 'dry_run', schedule: triage.schedule, repositories: ['integry/propr'] });
  });
});
