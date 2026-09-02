import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AgentConfig } from '../api/proprApi';
import type { SyntheticAgentConfig } from '@propr/shared';
import { CommittedConfigWriteError } from '../api/apiClient';
import AiAgentsPage from './AiAgentsPage';

const apiMocks = vi.hoisted(() => ({
  chatWithAgents: vi.fn(),
  getAgents: vi.fn(),
  saveAgents: vi.fn(),
  getSyntheticAgents: vi.fn(),
  saveSyntheticAgents: vi.fn(),
}));

const agentTankApiMocks = vi.hoisted(() => ({
  getAgentTankStatus: vi.fn(),
}));

vi.mock('../api/proprApi', () => apiMocks);
vi.mock('../api/revertApi', () => agentTankApiMocks);

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: PropsWithChildren) => <div>{children}</div>,
  PanelGroup: ({ children }: PropsWithChildren) => <div>{children}</div>,
  PanelResizeHandle: ({ children }: PropsWithChildren) => <div>{children}</div>
}));

const sharedModelId = 'provider:model:1';

const agents: AgentConfig[] = [
  {
    id: 'agent:first',
    type: 'codex',
    alias: 'First Codex',
    enabled: true,
    dockerImage: 'codex',
    configPath: '/first',
    supportedModels: [sharedModelId]
  },
  {
    id: 'agent:second',
    type: 'codex',
    alias: 'Second Codex',
    enabled: true,
    dockerImage: 'codex',
    configPath: '/second',
    supportedModels: [sharedModelId]
  },
  {
    id: 'agent:disabled',
    type: 'codex',
    alias: 'Disabled Codex',
    enabled: false,
    dockerImage: 'codex',
    configPath: '/disabled',
    supportedModels: [sharedModelId]
  }
];

const syntheticPool: SyntheticAgentConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  alias: 'Balanced Pool',
  enabled: true,
  defaultModel: 'balanced',
  models: [{
    id: 'balanced',
    displayName: 'Balanced',
    enabled: true,
    strategy: 'round_robin',
    members: [{
      id: '22222222-2222-4222-8222-222222222222',
      directAgentAlias: 'First Codex',
      model: sharedModelId,
      enabled: true,
      priority: 100,
    }],
  }],
};

describe('AiAgentsPage model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getAgents.mockResolvedValue({ agents });
    apiMocks.chatWithAgents.mockResolvedValue({ results: [] });
    apiMocks.saveAgents.mockResolvedValue({ success: true, agents });
    apiMocks.getSyntheticAgents.mockResolvedValue({ synthetic_agents: [syntheticPool] });
    apiMocks.saveSyntheticAgents.mockResolvedValue({ success: true, synthetic_agents: [syntheticPool] });
    agentTankApiMocks.getAgentTankStatus.mockResolvedValue({ available: true });
  });

  it('replaces Playground selections with the exact enabled agent/model pair and opens the mobile Playground', async () => {
    render(<AiAgentsPage />);

    const firstChips = await screen.findAllByRole('button', {
      name: `First Codex: ${sharedModelId}`
    });
    const secondChips = screen.getAllByRole('button', {
      name: `Second Codex: ${sharedModelId}`
    });

    await waitFor(() => {
      firstChips.forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true'));
    });

    fireEvent.click(secondChips[0]);

    await waitFor(() => {
      screen.getAllByRole('button', {
        name: `First Codex: ${sharedModelId}`
      }).forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true'));
      screen.getAllByRole('button', {
        name: `Second Codex: ${sharedModelId}`
      }).forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true'));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));

    const disabledModelButtons = screen.getAllByRole('button', {
      name: `Select ${sharedModelId} from Disabled Codex in Playground`
    });
    disabledModelButtons.forEach(button => expect(button).toBeDisabled());
    fireEvent.click(disabledModelButtons[0]);

    expect(screen.getByRole('button', {
      name: `First Codex: ${sharedModelId}`
    })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', {
      name: `Second Codex: ${sharedModelId}`
    })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getAllByRole('button', {
      name: `Select ${sharedModelId} from Second Codex in Playground`
    })[0]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Playground' })).toHaveClass('border-b-2');
      screen.getAllByRole('button', {
        name: `First Codex: ${sharedModelId}`
      }).forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'false'));
      screen.getAllByRole('button', {
        name: `Second Codex: ${sharedModelId}`
      }).forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true'));
    });

    const playgroundInput = screen.getAllByPlaceholderText('Type a message to test...')[0];
    fireEvent.change(playgroundInput, { target: { value: 'Hello' } });
    fireEvent.keyDown(playgroundInput, { key: 'Enter' });

    await waitFor(() => {
      expect(apiMocks.chatWithAgents).toHaveBeenCalledWith(
        [{ agentId: 'agent:second', model: sharedModelId }],
        'Hello',
        ''
      );
    });
  });

  it('sends the stable synthetic configuration ID and virtual model from the Playground', async () => {
    render(<AiAgentsPage />);

    const directChips = await screen.findAllByRole('button', { name: `First Codex: ${sharedModelId}` });
    await waitFor(() => directChips.forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true')));
    const poolChips = await screen.findAllByRole('button', { name: 'Balanced Pool: Balanced' });
    fireEvent.click(poolChips[0]);
    fireEvent.click(directChips[0]);

    const playgroundInput = screen.getAllByPlaceholderText('Type a message to test...')[0];
    fireEvent.change(playgroundInput, { target: { value: 'Route this' } });
    fireEvent.keyDown(playgroundInput, { key: 'Enter' });

    await waitFor(() => expect(apiMocks.chatWithAgents).toHaveBeenCalledWith(
      [{
        agentId: syntheticPool.id,
        syntheticConfigId: syntheticPool.id,
        model: 'balanced',
      }],
      'Route this',
      '',
    ));
  });

  it('reloads persisted synthetic pools and closes the editor after a committed save warning', async () => {
    const persistedPool = { ...syntheticPool, alias: 'Persisted Pool' };
    apiMocks.getSyntheticAgents
      .mockResolvedValueOnce({ synthetic_agents: [syntheticPool] })
      .mockResolvedValueOnce({ synthetic_agents: [persistedPool] });
    apiMocks.saveSyntheticAgents.mockRejectedValueOnce(new CommittedConfigWriteError(500, {
      committed: true,
      warning: 'Synthetic pools were saved, but registry publication failed.',
    }));

    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    const poolName = await screen.findByText('Balanced Pool');
    fireEvent.click(poolName.closest('button')!);
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'Draft Pool' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pool' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Synthetic pool editor' })).not.toBeInTheDocument());
    expect(apiMocks.getSyntheticAgents).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Persisted Pool')).toBeInTheDocument();
    expect(screen.getByText(/Synthetic pools were saved, but registry publication failed.*has been reloaded/)).toBeInTheDocument();
  });

  it('blocks synthetic mutations when committed state cannot be reloaded', async () => {
    apiMocks.getSyntheticAgents
      .mockResolvedValueOnce({ synthetic_agents: [syntheticPool] })
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    apiMocks.saveSyntheticAgents.mockRejectedValueOnce(new CommittedConfigWriteError(500, {
      committed: true,
      error: 'Synthetic pools were saved, but registry publication failed.',
    }));

    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    const poolName = await screen.findByText('Balanced Pool');
    fireEvent.click(poolName.closest('button')!);
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'Draft Pool' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pool' }));

    expect(await screen.findByText(/Automatic refresh failed \(refresh unavailable\).*Reload this page/)).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save pool' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save pool' }));
    expect(apiMocks.saveSyntheticAgents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pool editor' }));
    expect(screen.getByRole('button', { name: '+ Add Pool' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete synthetic pool Balanced Pool' })).toBeDisabled();
  });

  it('blocks synthetic mutations when the initial configuration load fails', async () => {
    apiMocks.getSyntheticAgents.mockRejectedValueOnce(new Error('initial load unavailable'));

    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    expect(await screen.findByText('initial load unavailable')).toBeInTheDocument();

    const addPoolButton = screen.getByRole('button', { name: '+ Add Pool' });
    const createPoolButton = screen.getByRole('button', { name: 'Create synthetic pool' });
    expect(addPoolButton).toBeDisabled();
    expect(createPoolButton).toBeDisabled();

    fireEvent.click(addPoolButton);
    fireEvent.click(createPoolButton);

    expect(screen.queryByRole('dialog', { name: 'Synthetic pool editor' })).not.toBeInTheDocument();
    expect(apiMocks.saveSyntheticAgents).not.toHaveBeenCalled();
  });

  it('consumes a cancelled add request before switching configuration views', async () => {
    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Pool' }));
    expect(await screen.findByRole('dialog', { name: 'Synthetic pool editor' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Synthetic pool editor' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Direct agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic Pools' }));

    expect(screen.queryByRole('dialog', { name: 'Synthetic pool editor' })).not.toBeInTheDocument();
  });

  it('keeps the virtual model ID focused while it is edited', async () => {
    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    fireEvent.click((await screen.findByText('Balanced Pool')).closest('button')!);

    const modelId = screen.getByLabelText('Virtual model ID');
    modelId.focus();
    fireEvent.change(modelId, { target: { value: 'balanced-next' } });

    expect(modelId).toHaveFocus();
    expect(modelId).toHaveValue('balanced-next');
  });

  it('shows each synthetic model GitHub label and updates the editor preview', async () => {
    const labeledPool: SyntheticAgentConfig = {
      ...syntheticPool,
      alias: 'balanced-pool',
      models: [
        syntheticPool.models[0],
        {
          ...syntheticPool.models[0],
          id: 'review',
          displayName: 'Review',
          members: [{
            ...syntheticPool.models[0].members[0],
            id: '33333333-3333-4333-8333-333333333333',
          }],
        },
      ],
    };
    apiMocks.getSyntheticAgents.mockResolvedValue({ synthetic_agents: [labeledPool] });

    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    expect(await screen.findByText('llm-balanced-pool~balanced')).toBeInTheDocument();
    expect(screen.getByText('llm-balanced-pool~review')).toBeInTheDocument();

    fireEvent.click(screen.getByText('balanced-pool').closest('button')!);
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'routing-pool' } });
    fireEvent.change(screen.getAllByLabelText('Virtual model ID')[0], { target: { value: 'primary' } });

    expect(screen.getByText('llm-routing-pool~primary')).toBeInTheDocument();
    expect(screen.getByText('llm-routing-pool~review')).toBeInTheDocument();
  });

  it.each([
    [true, false],
    [false, true],
  ])('shows the usage-cap warning only when Agent Tank availability is %s', async (available, warningExpected) => {
    agentTankApiMocks.getAgentTankStatus.mockResolvedValue({ available });
    apiMocks.getSyntheticAgents.mockResolvedValue({
      synthetic_agents: [{
        ...syntheticPool,
        models: [{
          ...syntheticPool.models[0],
          members: [{
            ...syntheticPool.models[0].members[0],
            usageLimits: { weeklyMaxPercent: 80 },
          }],
        }],
      }],
    });

    render(<AiAgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Pools' }));
    fireEvent.click((await screen.findByText('Balanced Pool')).closest('button')!);
    await waitFor(() => expect(agentTankApiMocks.getAgentTankStatus).toHaveBeenCalled());

    const warning = screen.queryByText(/Usage caps require fresh Agent Tank data/);
    if (warningExpected) expect(warning).toBeInTheDocument();
    else expect(warning).not.toBeInTheDocument();
  });
});
