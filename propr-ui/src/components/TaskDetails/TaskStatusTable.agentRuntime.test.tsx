import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';
import type { HistoryItem } from './types';

const at = (second: number) => new Date(Date.UTC(2026, 10, 20, 18, 10, second)).toISOString();

describe.each(['rail', 'branch'] as const)('%s agent runtime event', (variant) => {
  const runtime = (configuredCliVersion?: string): HistoryItem => ({
    state: 'claude_execution', timestamp: at(2), reason: 'Agent codex ran codex CLI 0.171.0',
    metadata: { event: 'agent.runtime', agentRuntime: { agentAlias: 'codex', agentType: 'codex', cliVersion: '0.171.0', image: 'propr/runtime-agent:old', ...(configuredCliVersion ? { configuredCliVersion } : {}) } },
  });

  it('shows the CLI version under the run step instead of as its own step', () => {
    render(<TaskStatusTable variant={variant} history={[
      { state: 'claude_execution', timestamp: at(1), reason: 'Execution started' },
      runtime(),
      { state: 'post_processing', timestamp: at(30) },
    ]} />);
    if (variant === 'branch') {
      screen.getAllByRole('button', { name: /Implementing Changes/ }).forEach(button => fireEvent.click(button));
    }
    expect(screen.getAllByText('Implementing Changes').length).toBeGreaterThan(0);
    expect(screen.queryByText('Agent CLI')).not.toBeInTheDocument();
    expect(screen.queryByText(/Retry/)).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-runtime-detail')).toHaveTextContent('codex · codex CLI 0.171.0');
  });

  it('says when a run used a previous version while the configured one was being prepared', () => {
    render(<TaskStatusTable variant={variant} history={[
      { state: 'claude_execution', timestamp: at(1), reason: 'Execution started' },
      runtime('0.170.0'),
    ]} />);
    if (variant === 'branch') {
      screen.getAllByRole('button', { name: /Implementing Changes/ }).forEach(button => fireEvent.click(button));
    }
    expect(screen.getByTestId('agent-runtime-detail')).toHaveTextContent('configured 0.170.0 was still being prepared');
  });
});
