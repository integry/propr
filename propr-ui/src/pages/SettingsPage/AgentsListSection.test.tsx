import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentsListSection from './AgentsListSection';

vi.mock('./AgentLoginModal', () => ({
  default: ({ agent }: { agent: { alias: string } }) => (
    <div role="dialog">Login dialog for {agent.alias}</div>
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

  it('offers login for supported agents and opens their dialog', () => {
    renderList();

    const loginButtons = screen.getAllByRole('button', { name: 'Log in' });
    expect(loginButtons).toHaveLength(1);
    fireEvent.click(loginButtons[0]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Login dialog for codex');
  });

  it('disables login in demo mode', () => {
    renderList(true);
    expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();
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
