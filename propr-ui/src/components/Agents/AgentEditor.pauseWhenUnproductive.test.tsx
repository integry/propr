import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import {
  getAutomationCapacity,
  getAutomationDefinition,
  updateAutomationDefinition,
  type AutomationDefinitionRecord,
} from '../../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/automationDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/automationDefinitionsApi')>()),
  getAutomationDefinition: vi.fn(),
  getAutomationCapacity: vi.fn(),
  updateAutomationDefinition: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([{ name: 'integry/propr', enabled: true }]) }));

const definition: AutomationDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: '0 22 * * *', scheduleTimezone: 'UTC', scheduleEnabled: true, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
};

describe('AgentEditor pause when unproductive', () => {
  beforeEach(() => {
    vi.mocked(getAutomationCapacity).mockResolvedValue({ capacity: { status: 'ok', sessionPercent: 20, provider: 'claude' }, threshold: 90 });
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('is off by default under a cron schedule and is saved with the definition', async () => {
    vi.mocked(getAutomationDefinition).mockResolvedValue(definition);
    vi.mocked(updateAutomationDefinition).mockImplementation(async (_id, input) => ({ ...definition, ...input, revision: 4 } as unknown as AutomationDefinitionRecord));
    render(<AgentEditor definitionId="agent-1" onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

    const toggle = await screen.findByTestId('agent-pause-when-unproductive');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateAutomationDefinition).toHaveBeenCalledWith(
      'agent-1', expect.objectContaining({ pauseWhenUnproductive: true, schedule: '0 22 * * *' }), 3,
    ));
  });

  it('reflects a stored opt-in and is hidden while the schedule is off', async () => {
    vi.mocked(getAutomationDefinition).mockResolvedValue({ ...definition, pauseWhenUnproductive: true });
    render(<AgentEditor definitionId="agent-1" onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
    expect(await screen.findByTestId('agent-pause-when-unproductive')).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(screen.queryByTestId('agent-pause-when-unproductive')).not.toBeInTheDocument();
  });
});
