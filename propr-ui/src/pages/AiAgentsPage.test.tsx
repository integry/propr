import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AgentConfig } from '../api/proprApi';
import AiAgentsPage from './AiAgentsPage';

const apiMocks = vi.hoisted(() => ({
  chatWithAgents: vi.fn(),
  getAgents: vi.fn(),
  saveAgents: vi.fn()
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

describe('AiAgentsPage model selection', () => {
  beforeEach(() => {
    apiMocks.getAgents.mockResolvedValue({ agents });
    apiMocks.chatWithAgents.mockResolvedValue({ results: [] });
    apiMocks.saveAgents.mockResolvedValue({ success: true, agents });
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
});
