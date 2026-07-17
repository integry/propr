import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import {
  getAgentRuntimePackageState,
  searchAgentRuntimePackageCatalog,
  updateAgentRuntimePackageState,
  validateAgentRuntimePackageSelection
} from '../../api/agentRuntimeApi';

vi.mock('../../api/agentRuntimeApi', () => ({
  getAgentRuntimePackageState: vi.fn(),
  searchAgentRuntimePackageCatalog: vi.fn(),
  updateAgentRuntimePackageState: vi.fn(),
  validateAgentRuntimePackageSelection: vi.fn()
}));

const getState = vi.mocked(getAgentRuntimePackageState);
const searchCatalog = vi.mocked(searchAgentRuntimePackageCatalog);
const updateState = vi.mocked(updateAgentRuntimePackageState);
const validateSelection = vi.mocked(validateAgentRuntimePackageSelection);

describe('AgentRuntimePackagesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockResolvedValue({
      installationId: 'test-installation',
      packages: ['jq'],
      activePackages: ['jq'],
      status: 'ready',
      images: {
        codex: {
          baseImage: 'codex',
          baseImageId: 'sha256:one',
          image: 'runtime-codex',
          packageManager: 'apt',
          builtAt: 'now'
        }
      },
      updatedAt: 'now'
    });
    updateState.mockResolvedValue({
      installationId: 'test-installation',
      packages: ['chromium', 'jq'],
      activePackages: ['jq'],
      status: 'pending',
      buildId: 'build-1',
      images: {},
      updatedAt: 'now'
    });
    searchCatalog.mockResolvedValue({
      query: 'chromium',
      suggestions: ['chromium', 'chromium-common'],
      sources: [{ packageManager: 'apt', osName: 'Debian 12', images: ['codex'] }]
    });
    validateSelection.mockImplementation(async packages => ({
      valid: true,
      packages: [...new Set(packages)].sort(),
      errors: [],
      sources: [{ packageManager: 'apt', osName: 'Debian 12', images: ['codex'] }]
    }));
  });

  it('adds a package and submits the complete desired profile', async () => {
    render(<AgentRuntimePackagesSection />);

    expect(await screen.findByText('jq')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'Chromium=1.2+BuildA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));
    expect(await screen.findByText('chromium=1.2+BuildA')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateState).toHaveBeenCalledWith(['chromium=1.2+BuildA', 'jq']));
    expect(await screen.findByText('pending')).toBeInTheDocument();
  });

  it('offers catalog suggestions and validates a selected package', async () => {
    render(<AgentRuntimePackagesSection />);
    await screen.findByText('jq');

    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'chromium' } });
    fireEvent.click(await screen.findByRole('option', { name: 'chromium' }));

    await waitFor(() => expect(validateSelection).toHaveBeenCalledWith(['jq', 'chromium']));
    expect(await screen.findByText('chromium')).toBeInTheDocument();
    expect(screen.getByText('Debian 12 (apt)')).toBeInTheDocument();
  });

  it('allows an unchanged failed profile to be retried', async () => {
    getState.mockResolvedValueOnce({
      installationId: 'test-installation',
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

    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'jq;id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));

    expect(screen.getByText('Invalid package spec: jq;id')).toBeInTheDocument();
    expect(validateSelection).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
  });

  it('hides runtime controls for non-admin users', async () => {
    getState.mockResolvedValueOnce({
      installationId: 'test-installation',
      packages: ['jq'],
      activePackages: ['jq'],
      status: 'ready',
      images: {},
      canManage: false,
      updatedAt: 'now'
    });

    render(<AgentRuntimePackagesSection />);

    await waitFor(() => expect(screen.queryByLabelText('Package name')).not.toBeInTheDocument());
    expect(screen.queryByText('Agent Runtime Packages')).not.toBeInTheDocument();
  });
});
