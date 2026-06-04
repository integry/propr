import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SystemHealth } from './GlobalHeaderComponents';
import type { HeaderStats } from '../hooks/useHeaderStats';

function makeSystemHealth(overrides: Partial<HeaderStats['systemHealth']> = {}): HeaderStats['systemHealth'] {
  return {
    daemon: 'Running',
    workers: 'Running',
    redis: 'Connected',
    githubAuth: 'Authenticated',
    claudeAuth: 'Failed',
    indexing: 'Idle',
    agents: [
      { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' },
      { id: 'gemini-1', type: 'gemini', alias: 'gemini-prod', status: 'Failed' },
    ],
    isHealthy: false,
    ...overrides,
  };
}

describe('SystemHealth dropdown', () => {
  it('renders core services, indexing, and dynamic agents without a hardcoded Claude row', () => {
    render(<SystemHealth systemHealth={makeSystemHealth()} />);

    fireEvent.mouseEnter(screen.getByLabelText('System Status'));

    expect(screen.getByText('Daemon:')).toBeInTheDocument();
    expect(screen.getByText('Workers:')).toBeInTheDocument();
    expect(screen.getByText('Redis:')).toBeInTheDocument();
    expect(screen.getByText('GitHub:')).toBeInTheDocument();
    expect(screen.getByText('Indexing:')).toBeInTheDocument();
    expect(screen.getByText('Codex (codex-prod):')).toBeInTheDocument();
    expect(screen.getByText('Gemini (gemini-prod):')).toBeInTheDocument();
    expect(screen.queryByText('Claude:')).not.toBeInTheDocument();
  });
});
