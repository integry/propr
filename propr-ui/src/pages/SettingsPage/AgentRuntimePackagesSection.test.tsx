import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import {
  getAgentRuntimePackageState,
  updateAgentRuntimePackageState
} from '../../api/agentRuntimeApi';

vi.mock('../../api/agentRuntimeApi', () => ({
  getAgentRuntimePackageState: vi.fn(),
  updateAgentRuntimePackageState: vi.fn()
}));

const getState = vi.mocked(getAgentRuntimePackageState);
const updateState = vi.mocked(updateAgentRuntimePackageState);

describe('AgentRuntimePackagesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockResolvedValue({
      packages: ['jq'],
      activePackages: ['jq'],
      status: 'ready',
      images: {
        codex: { baseImage: 'codex', baseImageId: 'sha256:one', image: 'runtime-codex', builtAt: 'now' }
      },
      updatedAt: 'now'
    });
    updateState.mockResolvedValue({
      packages: ['chromium', 'jq'],
      activePackages: ['jq'],
      status: 'pending',
      buildId: 'build-1',
      images: {},
      updatedAt: 'now'
    });
  });

  it('adds a package and submits the complete desired profile', async () => {
    render(<AgentRuntimePackagesSection />);

    expect(await screen.findByText('jq')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Debian package name'), { target: { value: 'Chromium=1.2+BuildA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));
    expect(screen.getByText('chromium=1.2+BuildA')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateState).toHaveBeenCalledWith(['chromium=1.2+BuildA', 'jq']));
    expect(await screen.findByText('pending')).toBeInTheDocument();
  });

  it('allows an unchanged failed profile to be retried', async () => {
    getState.mockResolvedValueOnce({
      packages: ['jq'],
      activePackages: [],
      status: 'failed',
      images: {},
      error: 'apt failed',
      updatedAt: 'now'
    });
    render(<AgentRuntimePackagesSection />);

    expect(await screen.findByText('apt failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateState).toHaveBeenCalledWith(['jq']));
  });

  it('rejects shell syntax before submission', async () => {
    render(<AgentRuntimePackagesSection />);
    await screen.findByText('jq');

    fireEvent.change(screen.getByLabelText('Debian package name'), { target: { value: 'jq;id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));

    expect(screen.getByText('Invalid Debian package name: jq;id')).toBeInTheDocument();
    expect(updateState).not.toHaveBeenCalled();
  });
});
