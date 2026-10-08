import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import { deleteAgentDefinition, getAgentDefinition, updateAgentDefinition, type AgentDefinitionRecord } from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { useAgentEditor } from './useAgentEditor';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  getAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
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

/** A save answered after its agent was deleted would describe an agent that no longer exists, so deletion waits for it. */
describe('AgentEditor deletion while saving', () => {
  let finishSave: (saved: AgentDefinitionRecord) => void = () => undefined;

  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'] }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    vi.mocked(deleteAgentDefinition).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('disables Delete while a save is pending', async () => {
    render(<AgentEditor definitionId="agent-1" onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

    await screen.findByLabelText('Name');
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(deleteButton).toBeDisabled());
    finishSave({ ...definition, revision: 4 });
    await waitFor(() => expect(deleteButton).toBeEnabled());
  });

  it('ignores a deletion requested while a save is in flight, even before the button re-renders', async () => {
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    // Both actions come from the same render, as two clicks handled before React re-renders would.
    const { save, remove } = result.current;
    let pendingSave: Promise<void> = Promise.resolve();
    let removed: boolean | undefined;
    await act(async () => {
      pendingSave = save();
      removed = await remove();
    });
    expect(removed).toBe(false);
    expect(deleteAgentDefinition).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();

    await act(async () => {
      finishSave({ ...definition, revision: 4 });
      await pendingSave;
    });
  });
});
