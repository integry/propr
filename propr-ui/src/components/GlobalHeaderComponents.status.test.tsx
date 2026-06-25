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
    githubEventIntake: 'ProPR Connect',
    githubEventIntakeStatus: 'Connected',
    agents: [
      { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' },
      { id: 'antigravity-1', type: 'antigravity', alias: 'antigravity-prod', status: 'Failed' },
    ],
    isHealthy: false,
    ...overrides,
  };
}

describe('SystemHealth dropdown', () => {
  it('renders core services, indexing, and dynamic agents without a hardcoded Claude row', () => {
    const { container } = render(<SystemHealth systemHealth={makeSystemHealth()} />);

    fireEvent.mouseEnter(screen.getByLabelText('System Status'));

    expect(screen.getByText('Services')).toBeInTheDocument();
    expect(screen.getByText('Coding agents')).toBeInTheDocument();
    expect(screen.getByText('Daemon:')).toBeInTheDocument();
    expect(screen.getByText('Workers:')).toBeInTheDocument();
    expect(screen.getByText('Redis:')).toBeInTheDocument();
    expect(screen.getByText('GitHub:')).toBeInTheDocument();
    expect(screen.getByText('GitHub Intake:')).toBeInTheDocument();
    expect(screen.getByText('ProPR Connect')).toBeInTheDocument();
    expect(screen.getByText('Intake Status:')).toBeInTheDocument();
    expect(screen.getByText('Indexing:')).toBeInTheDocument();
    expect(screen.getByText('Codex:')).toBeInTheDocument();
    expect(screen.getByText('Antigravity:')).toBeInTheDocument();
    expect(screen.queryByText('Codex (codex-prod):')).not.toBeInTheDocument();
    expect(screen.queryByText('Antigravity (antigravity-prod):')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude:')).not.toBeInTheDocument();
    expect(container.querySelectorAll('span.rounded-full')).toHaveLength(8);
  });

  it('includes agent aliases when multiple instances of a type are shown', () => {
    render(<SystemHealth systemHealth={makeSystemHealth({
      agents: [
        { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' },
        { id: 'codex-2', type: 'codex', alias: 'codex-canary', status: 'Ready' },
        { id: 'antigravity-1', type: 'antigravity', alias: 'antigravity-prod', status: 'Ready' },
      ],
    })} />);

    fireEvent.mouseEnter(screen.getByLabelText('System Status'));

    expect(screen.getByText('Codex (codex-prod):')).toBeInTheDocument();
    expect(screen.getByText('Codex (codex-canary):')).toBeInTheDocument();
    expect(screen.getByText('Antigravity:')).toBeInTheDocument();
  });

  it('marks the overall indicator red when an enabled dynamic agent fails', () => {
    const { container } = render(<SystemHealth systemHealth={makeSystemHealth()} />);

    const indicator = container.querySelector('button[aria-label="System Status"] span.bg-red-500');

    expect(indicator).toBeInTheDocument();
  });

  it('marks the overall indicator red when the GitHub intake path is disconnected', () => {
    const { container } = render(<SystemHealth systemHealth={makeSystemHealth({
      agents: [{ id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' }],
      githubEventIntakeStatus: 'Disconnected',
    })} />);

    fireEvent.mouseEnter(screen.getByLabelText('System Status'));

    expect(screen.getByText('Intake Status:')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    const indicator = container.querySelector('button[aria-label="System Status"] span.bg-red-500');
    expect(indicator).toBeInTheDocument();
  });
});
