import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAgentHealth } from '../../api/agentHealthApi';
import AgentsListSection from './AgentsListSection';

vi.mock('../../api/agentHealthApi', () => ({ checkAgentHealth: vi.fn() }));

beforeEach(() => {
  vi.mocked(checkAgentHealth).mockReset().mockImplementation(async agentId => ({ agentId, status: 'ready', model: 'test' }));
});

vi.mock('./AgentLoginModal', () => ({
  default: ({ agent, onClose }: { agent: { alias: string }; onClose: () => void }) => (
    <div role="dialog">Login dialog for {agent.alias}<button onClick={onClose}>Close login</button></div>
  ),
}));

vi.mock('../../api/agentVersionApi', () => ({
  getAgentVersions: vi.fn().mockResolvedValue({
    agentType: 'claude',
    defaultVersion: 'default',
    availableTags: [],
    recentVersions: [],
  }),
}));

const agents = [
  {
    id: 'codex-1',
    type: 'codex' as const,
    alias: 'codex',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/home/propr/.codex',
    supportedModels: ['gpt-test'],
  },
  {
    id: 'vibe-1',
    type: 'vibe' as const,
    alias: 'vibe',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/home/propr/.vibe',
    supportedModels: ['vibe-test'],
  },
];

function renderList(readOnly = false) {
  return render(
    <AgentsListSection
      agents={agents}
      loading={false}
      saving={false}
      error={null}
      success={null}
      warning={null}
      onSaveAgents={vi.fn()}
      readOnly={readOnly}
    />,
  );
}

describe('AgentsListSection web login', () => {
  it('folds legacy models within each provider until requested', () => {
    render(
      <AgentsListSection
        agents={[{
          ...agents[0],
          supportedModels: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.2', 'gpt-5-nano'],
        }]}
        loading={false}
        saving={false}
        error={null}
        success={null}
        warning={null}
        onSaveAgents={vi.fn()}
        onSelectModel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Select GPT-6 Astra from codex in Playground' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select GPT-5.2 from codex in Playground' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 legacy models' }));

    expect(screen.getByRole('button', { name: 'Select GPT-5.2 from codex in Playground' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide legacy models' }));
    expect(screen.queryByRole('button', { name: 'Select GPT-5.2 from codex in Playground' })).not.toBeInTheDocument();
  });

  it('shows Sonnet 5.5 as current and folds older Sonnet models', () => {
    render(
      <AgentsListSection
        agents={[{
          ...agents[0],
          type: 'claude',
          alias: 'claude',
          supportedModels: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
        }]}
        loading={false}
        saving={false}
        error={null}
        success={null}
        warning={null}
        onSaveAgents={vi.fn()}
        onSelectModel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Select Claude Sonnet 5.5 from claude in Playground' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select Claude Sonnet 5 from claude in Playground' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 legacy models' }));

    expect(screen.getByRole('button', { name: 'Select Claude Sonnet 5 from claude in Playground' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Claude Sonnet 4.6 from claude in Playground' })).toBeInTheDocument();
  });

  it('offers login for supported agents and opens their dialog', () => {
    renderList();

    expect(screen.queryByRole('menuitem', { name: 'Log in' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for codex' }));
    const loginButtons = screen.getAllByRole('menuitem', { name: 'Log in' });
    expect(loginButtons).toHaveLength(1);
    fireEvent.click(loginButtons[0]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Login dialog for codex');
  });

  it('disables login in demo mode', () => {
    renderList(true);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for codex' }));
    expect(screen.getByRole('menuitem', { name: 'Log in' })).toBeDisabled();
  });

  it('saves a newly managed agent before opening its login dialog', async () => {
    const onSaveAgents = vi.fn(async updatedAgents => updatedAgents);
    render(
      <AgentsListSection
        agents={[]}
        loading={false}
        saving={false}
        error={null}
        success={null}
        warning={null}
        onSaveAgents={onSaveAgents}
        showAddModal
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add Agent & Log In' }));

    await waitFor(() => expect(onSaveAgents).toHaveBeenCalledOnce());
    expect(await screen.findByRole('dialog')).toHaveTextContent('Login dialog for claude');
    expect(onSaveAgents.mock.calls[0][0][0].configPath).toMatch(
      /^~\/\.propr\/agent-credentials\/.+\/\.claude$/,
    );
  });
});


describe('agent health checks', () => {
  const props = {
    agents, loading: false, saving: false, error: null, success: null, warning: null, onSaveAgents: vi.fn(),
  };

  it('checks only enabled agents once, including in StrictMode and after unrelated renders', async () => {
    const configured = [agents[0], { ...agents[1], enabled: false }];
    const view = render(<StrictMode><AgentsListSection {...props} agents={configured} /></StrictMode>);
    await screen.findByText('Ready');
    expect(checkAgentHealth).toHaveBeenCalledTimes(1);
    expect(checkAgentHealth).toHaveBeenCalledWith('codex-1', expect.any(String));
    view.rerender(<StrictMode><AgentsListSection {...props} agents={[...configured]} saving /></StrictMode>);
    expect(checkAgentHealth).toHaveBeenCalledTimes(1);
    view.rerender(<StrictMode><AgentsListSection {...props} /></StrictMode>);
    await waitFor(() => expect(checkAgentHealth).toHaveBeenCalledTimes(2));
    expect(checkAgentHealth).toHaveBeenLastCalledWith('vibe-1', expect.any(String));
  });

  it('does not probe while loading or in demo mode', () => {
    const view = render(<AgentsListSection {...props} loading />);
    expect(checkAgentHealth).not.toHaveBeenCalled();
    view.rerender(<AgentsListSection {...props} readOnly />);
    expect(checkAgentHealth).not.toHaveBeenCalled();
  });

  it('displays checking, errors inside a collapsed card, and refreshes after login', async () => {
    let finish!: (result: Awaited<ReturnType<typeof checkAgentHealth>>) => void;
    vi.mocked(checkAgentHealth).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<AgentsListSection {...props} agents={[agents[0]]} />);
    expect(screen.getByText('Checking agent…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse codex models' }));
    finish({ agentId: 'codex-1', status: 'error', errorCode: 'auth_required', error: 'Login expired' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Login expired');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Login dialog for codex');
    fireEvent.click(screen.getByRole('button', { name: 'Close login' }));
    expect(await screen.findByText('Ready')).toBeVisible();
    expect(checkAgentHealth).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('surfaces request failures and can retry agents without interactive login', async () => {
    vi.mocked(checkAgentHealth).mockRejectedValueOnce(new Error('Check timed out'));
    render(<AgentsListSection {...props} agents={[agents[1]]} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check timed out');
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText('Ready');
    expect(checkAgentHealth).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale result after an agent is disabled or edited', async () => {
    let finish!: (result: Awaited<ReturnType<typeof checkAgentHealth>>) => void;
    vi.mocked(checkAgentHealth).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<AgentsListSection {...props} agents={[agents[0]]} />);
    view.rerender(<AgentsListSection {...props} agents={[{ ...agents[0], enabled: false }]} />);
    finish({ agentId: 'codex-1', status: 'error', error: 'Old credentials' });
    expect(screen.queryByText('Old credentials')).not.toBeInTheDocument();
    view.rerender(<AgentsListSection {...props} agents={[{ ...agents[0], configPath: '/new/path' }]} />);
    await screen.findByText('Ready');
    expect(checkAgentHealth).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Old credentials')).not.toBeInTheDocument();
  });
});
