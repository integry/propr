import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AgentConfig } from '../api/proprApi';
import type { SyntheticAgentConfig } from '@propr/shared';
import AiAgentsPage from './AiAgentsPage';

const apiMocks = vi.hoisted(() => ({
  chatWithAgents: vi.fn(),
  getAgents: vi.fn(),
  saveAgents: vi.fn(),
  getSyntheticAgents: vi.fn(),
  saveSyntheticAgents: vi.fn(),
}));

vi.mock('../api/proprApi', () => apiMocks);

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
    apiMocks.getAgents.mockResolvedValue({ agents });
    apiMocks.chatWithAgents.mockResolvedValue({ results: [] });
    apiMocks.saveAgents.mockResolvedValue({ success: true, agents });
    apiMocks.getSyntheticAgents.mockResolvedValue({ synthetic_agents: [syntheticPool] });
    apiMocks.saveSyntheticAgents.mockResolvedValue({ success: true, synthetic_agents: [syntheticPool] });
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
});
