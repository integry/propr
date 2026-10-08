import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const renderEditor = () =>
  render(<AgentEditor definitionId={null} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

describe('AgentEditor fields', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [
        { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' },
        { alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.5'], defaultModel: 'gpt-5.5' },
      ],
      defaultAgentAlias: 'claude-main',
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('picks autonomy from a segmented control and explains only the chosen mode', () => {
    renderEditor();
    const group = screen.getByRole('radiogroup', { name: 'Autonomy' });
    expect(screen.getByRole('radio', { name: 'Dry run' })).toBeChecked();
    expect(screen.getByTestId('agent-autonomy-description')).toHaveTextContent('Nothing else happens.');

    fireEvent.click(screen.getByRole('radio', { name: 'Preview & approve' }));
    expect(screen.getByRole('radio', { name: 'Preview & approve' })).toBeChecked();
    expect(screen.getByTestId('agent-autonomy-description')).toHaveTextContent('waits for your approval');
    expect(group).not.toHaveTextContent('Nothing else happens.');
  });

  it('names the model the default coding agent runs on', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox', { name: 'Coding agent' });
    expect(await within(select).findByRole('option', { name: 'Claude Opus 5.5 (Default)' })).toHaveValue('');
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('falls back to the agent named default when none is configured', async () => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'default', type: 'codex', enabled: true, supportedModels: ['gpt-5.5'], defaultModel: 'gpt-5.5' }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
    renderEditor();
    const select = await screen.findByRole('combobox', { name: 'Coding agent' });
    expect(await within(select).findByRole('option', { name: /\(Default\)$/ })).toHaveValue('');
    expect(within(select).queryByRole('option', { name: 'Default coding agent' })).not.toBeInTheDocument();
  });

  it('labels the previous reports checkbox without repeating the field name', () => {
    renderEditor();
    expect(screen.getByRole('checkbox', { name: 'Feed previous run reports back into prompt context' })).toBeInTheDocument();
  });
});
