import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AgentConfig } from '../api/proprApi';
import AiAgentsPage from './AiAgentsPage';

const apiMocks = vi.hoisted(() => ({
  chatWithAgents: vi.fn(),
  getAgents: vi.fn(),
  saveAgents: vi.fn(),
  getSyntheticAgents: vi.fn(),
  saveSyntheticAgents: vi.fn(),
}));

vi.mock('../api/proprApi', () => apiMocks);
vi.mock('../api/revertApi', () => ({
  getAgentTankStatus: vi.fn().mockResolvedValue({ available: false }),
}));
vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: PropsWithChildren) => <div>{children}</div>,
  PanelGroup: ({ children }: PropsWithChildren) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

const modelId = 'provider:model:1';
const agents: AgentConfig[] = [{
  id: 'agent:first',
  type: 'codex',
  alias: 'First Codex',
  enabled: true,
  dockerImage: 'codex',
  configPath: '/first',
  supportedModels: [modelId],
}];

const placeholder = 'Type a message to test...';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// jsdom ignores the md: breakpoint classes, so both the mobile and the desktop
// Playground render at once; the first input belongs to the mobile layout.
const inputs = () => screen.getAllByPlaceholderText(placeholder) as HTMLInputElement[];

async function renderPage() {
  render(<AiAgentsPage />);
  await waitFor(() => expect(inputs()).toHaveLength(2));
  await waitFor(() => inputs().forEach(input => expect(input).toBeEnabled()));
}

describe('AiAgentsPage Playground session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getAgents.mockResolvedValue({ agents });
    apiMocks.getSyntheticAgents.mockResolvedValue({ synthetic_agents: [] });
  });

  it('shows one unsent draft in both layouts and keeps it across mobile tabs', async () => {
    await renderPage();

    fireEvent.change(inputs()[1], { target: { value: 'Desktop draft' } });
    expect(inputs().map(input => input.value)).toEqual(['Desktop draft', 'Desktop draft']);

    fireEvent.change(inputs()[0], { target: { value: 'Mobile draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
    expect(inputs()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Playground' }));

    expect(inputs().map(input => input.value)).toEqual(['Mobile draft', 'Mobile draft']);
    expect(apiMocks.chatWithAgents).not.toHaveBeenCalled();
  });

  it('delivers a response that arrives while the mobile Playground is hidden exactly once', async () => {
    const reply = deferred<{ results: unknown[] }>();
    apiMocks.chatWithAgents.mockReturnValueOnce(reply.promise);
    await renderPage();

    fireEvent.change(inputs()[0], { target: { value: 'First question' } });
    fireEvent.keyDown(inputs()[0], { key: 'Enter' });
    // The other layout's panel must not start a second request.
    fireEvent.keyDown(inputs()[1], { key: 'Enter' });
    expect(screen.getAllByText('Thinking...')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
    await act(async () => {
      reply.resolve({ results: [{
        agentId: 'agent:first', agentAlias: 'First Codex', model: modelId, response: 'Delayed answer', durationMs: 5,
      }] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Playground' }));

    const [mobile] = screen.getAllByTestId('ai-agents-playground-transcript');
    expect(within(mobile).getAllByText('First question')).toHaveLength(1);
    expect(within(mobile).getAllByText('Delayed answer')).toHaveLength(1);
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    expect(apiMocks.chatWithAgents).toHaveBeenCalledTimes(1);
    expect(apiMocks.chatWithAgents).toHaveBeenCalledWith([{ agentId: 'agent:first', model: modelId }], 'First question', '');

    // The retained transcript is the context of the next turn.
    apiMocks.chatWithAgents.mockResolvedValueOnce({ results: [] });
    fireEvent.change(inputs()[1], { target: { value: 'Follow-up' } });
    fireEvent.keyDown(inputs()[1], { key: 'Enter' });
    await waitFor(() => expect(apiMocks.chatWithAgents).toHaveBeenLastCalledWith(
      [{ agentId: 'agent:first', model: modelId }],
      'Follow-up',
      'User: First question\nAssistant: (Previous response hidden)',
    ));
  });

  it('clears the shared transcript and drops a response still pending', async () => {
    const reply = deferred<{ results: unknown[] }>();
    apiMocks.chatWithAgents.mockReturnValueOnce(reply.promise);
    await renderPage();

    fireEvent.change(inputs()[0], { target: { value: 'Discard me' } });
    fireEvent.keyDown(inputs()[0], { key: 'Enter' });
    fireEvent.click(screen.getAllByTitle('Clear History')[1]);

    expect(screen.queryByText('Discard me')).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    await act(async () => {
      reply.resolve({ results: [{
        agentId: 'agent:first', agentAlias: 'First Codex', model: modelId, response: 'Stale answer', durationMs: 5,
      }] });
    });
    expect(screen.queryByText('Stale answer')).not.toBeInTheDocument();
    inputs().forEach(input => expect(input).toBeEnabled());
  });
});
