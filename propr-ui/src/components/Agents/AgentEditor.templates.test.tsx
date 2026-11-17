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

const renderEditor = (props: { definitionId?: string | null; templateId?: string | null; onUnsavedChange?: (unsaved: boolean) => void } = {}) =>
  render(<AgentEditor definitionId={props.definitionId ?? null} templateId={props.templateId} onUnsavedChange={props.onUnsavedChange} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

const expectPrefilled = () => {
  expect(screen.getByLabelText('Name')).toHaveValue(triage.name);
  expect(screen.getByLabelText('Description')).toHaveValue(triage.description);
  expect(screen.getByLabelText('Prompt')).toHaveValue(triage.prompt);
  expect(screen.getByLabelText('Cron expression')).toHaveValue(triage.schedule);
  expect(screen.getByRole('radio', { name: 'Report only' })).toBeChecked();
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

  it('asks before a template replaces a typed name and prompt, and keeps them when declined', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My own review' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Look at the open PRs' } });
    const option = () => within(screen.getByTestId('agent-template-picker')).getByRole('button', { name: new RegExp(triage.name) });

    fireEvent.click(option());
    const question = screen.getByRole('dialog', { name: `Replace what you entered with “${triage.name}”?` });
    fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('My own review');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Look at the open PRs');

    fireEvent.click(option());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use template' }));
    expectPrefilled();
    // Filled from the template and not edited since: another template applies without asking.
    fireEvent.click(option());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['a repository', async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Add repository/ }));
      fireEvent.click(await screen.findByTestId('repo-item'));
      expect(within(screen.getByRole('list', { name: 'Selected repositories' })).getByText('integry/propr')).toBeInTheDocument();
    }],
    ['a coding agent', async () => {
      const agentSelect = await screen.findByTitle('Select AI agent');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument());
      fireEvent.change(agentSelect, { target: { value: 'claude-main' } });
    }],
  ])('still counts %s chosen before a template as unsaved input', async (_label, choose) => {
    const onUnsavedChange = vi.fn();
    renderEditor({ onUnsavedChange });
    await choose();
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(true));
    onUnsavedChange.mockClear();

    // The template keeps the choice and replaces nothing typed, so it applies without asking.
    fireEvent.click(within(screen.getByTestId('agent-template-picker')).getByRole('button', { name: new RegExp(triage.name) }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectPrefilled();
    // Closing now must still ask: the kept choice would be lost.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onUnsavedChange).not.toHaveBeenCalledWith(false);
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
