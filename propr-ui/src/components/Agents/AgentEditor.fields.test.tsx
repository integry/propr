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
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' }],
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
    expect(screen.getByRole('radio', { name: 'Dry run' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('agent-autonomy-description')).toHaveTextContent('Nothing else happens.');

    fireEvent.click(screen.getByRole('radio', { name: 'Preview & approve' }));
    expect(screen.getByRole('radio', { name: 'Preview & approve' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('agent-autonomy-description')).toHaveTextContent('waits for your approval');
    expect(group).not.toHaveTextContent('Nothing else happens.');
  });

  it('labels the coding agent field to match its placeholder', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox', { name: 'Coding agent' });
    expect(within(select).getByRole('option', { name: 'Default coding agent' })).toHaveValue('');
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });
});
