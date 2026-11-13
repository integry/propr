import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { getAutomationDefinition, updateAutomationDefinition, type AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';
import { useAgentEditor } from './useAgentEditor';

vi.mock('../../api/automationDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/automationDefinitionsApi')>()),
  getAutomationDefinition: vi.fn(), updateAutomationDefinition: vi.fn(), getAutomationCapacity: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({
  getInstanceCatalog: vi.fn().mockResolvedValue({
    agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' }],
    repositories: [],
  }),
}));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const definition: AutomationDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Recover blocked issues', description: null, repositories: ['acme/app', 'acme/api'],
  prompt: 'Unblock the issue', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
  eventTriggers: [{ event: 'plan.issue_blocked', repositories: ['acme/app'], reasonKinds: [] }],
};

describe('AgentEditor event trigger filter', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('refuses to save a trigger filter whose last repository was removed instead of widening it', async () => {
    vi.mocked(getAutomationDefinition).mockResolvedValue(definition);
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    act(() => result.current.update({ repositories: ['acme/api'] }));
    await act(async () => { await result.current.save(); });
    expect(result.current.error).toMatch(/no longer in this automation/);
    expect(updateAutomationDefinition).not.toHaveBeenCalled();

    // An explicit choice saves.
    vi.mocked(updateAutomationDefinition).mockResolvedValue({ ...definition, repositories: ['acme/api'] });
    act(() => result.current.update({ blockedTriggerRepositories: ['acme/api'] }));
    await act(async () => { await result.current.save(); });
    expect(updateAutomationDefinition).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      repositories: ['acme/api'], eventTriggers: [{ event: 'plan.issue_blocked', repositories: ['acme/api'], reasonKinds: [] }],
    }), 3);
  });
});
