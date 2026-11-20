import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AgentCliVersionStatus from './AgentCliVersionStatus';
import type { AgentCliVersionState } from '../../api/proprApi';

const state = (overrides: Partial<AgentCliVersionState>): AgentCliVersionState => ({
  agentId: 'codex-1', alias: 'codex', type: 'codex', configuredVersion: '0.170.0', effectiveVersion: '0.171.0', status: 'preparing', ...overrides,
});

describe('AgentCliVersionStatus', () => {
  it('shows a pending version next to the version runs use', () => {
    render(<AgentCliVersionStatus state={state({})} />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the agent image for CLI 0.170.0');
    expect(screen.getByRole('status')).toHaveTextContent('Runs use CLI 0.171.0 until it is ready.');
  });

  it('shows a failed preparation with its error', () => {
    render(<AgentCliVersionStatus state={state({ status: 'failed', error: 'npm install failed', nextRetryAt: '2026-11-20T18:30:00Z' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the image for CLI 0.170.0 failed: npm install failed');
    expect(screen.getByRole('status')).toHaveTextContent('It will be retried automatically.');
  });

  it('confirms a version that became ready, and stays quiet otherwise', () => {
    const ready = state({ status: 'ready', effectiveVersion: '0.170.0' });
    const { rerender } = render(<AgentCliVersionStatus state={ready} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<AgentCliVersionStatus state={ready} becameReady />);
    expect(screen.getByRole('status')).toHaveTextContent('CLI 0.170.0 is now in effect.');
  });
});
