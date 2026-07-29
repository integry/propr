import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentsListSection from './AgentsListSection';

vi.mock('./AgentLoginModal', () => ({
  default: ({ agent }: { agent: { alias: string } }) => (
    <div role="dialog">Login dialog for {agent.alias}</div>
  ),
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
});
