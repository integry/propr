import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import {
  getAgentRuntimePackageState,
  searchAgentRuntimePackageCatalog,
  updateAgentRuntimePackageState,
  validateAgentRuntimePackageSelection,
  type AgentRuntimePackageState
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

  it('saves a list whose availability could not be verified and shows the warning', async () => {
    const warning = 'could not verify availability: the Debian 12 (bookworm) package index could not be fetched (fetch failed)';
    validateSelection.mockImplementationOnce(async packages => ({ valid: true, packages: [...packages].sort(), errors: [], warnings: [warning] }));
    updateState.mockResolvedValueOnce({
      installationId: 'test-installation',
      packages: ['figlet', 'jq'],
      activePackages: ['jq'],
      status: 'pending',
      images: {},
      appliedBy: 'Installed at every Fly Machine start; no Docker image is built',
      updatedAt: 'now',
      warnings: [warning]
    });
    render(<AgentRuntimePackagesSection />);

    expect(await screen.findByText('jq')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'figlet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));
    expect(await screen.findByText(`Warning: ${warning}`)).toBeInTheDocument();
    expect(await screen.findByText('figlet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateState).toHaveBeenCalledWith(['figlet', 'jq']));
    expect(await screen.findByText(`Warning: ${warning}`)).toHaveClass('text-amber-700');
  });

  it('shows packages applied by remote runtimes instead of an image count', async () => {
    getState.mockResolvedValueOnce({
      installationId: 'test-installation',
      packages: ['postgresql-client'],
      activePackages: ['postgresql-client'],
      status: 'ready',
      images: {},
      appliedBy: 'Installed at every Fly Machine start; no Docker image is built',
      updatedAt: 'now'
    });
    render(<AgentRuntimePackagesSection />);

    expect(await screen.findByText('1 active · Installed at every Fly Machine start; no Docker image is built')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('ready');
    expect(screen.queryByText(/active across/)).not.toBeInTheDocument();
  });

  it('shows each runtime\'s own state when remote runtimes are in use, with a refusal on its row', async () => {
    getState.mockResolvedValueOnce({
      installationId: 'test-installation',
      packages: ['jq', 'postfix'],
      activePackages: ['jq'],
      status: 'failed',
      images: {},
      error: 'Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix',
      runtimes: [
        { runtime: 'docker', label: 'Docker', status: 'ready', activePackages: ['jq', 'postfix'], source: 'derived Docker image' },
        { runtime: 'sprites', label: 'Sprites', status: 'failed', activePackages: ['jq'], source: 'Ubuntu 26.04 LTS (resolute)',
          error: 'Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix' },
      ],
      updatedAt: 'now'
    });
    render(<AgentRuntimePackagesSection />);

    const list = await screen.findByRole('list', { name: 'Runtime package state per runtime' });
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Docker');
    expect(rows[0]).toHaveTextContent('ready · 2 active');
    expect(rows[1]).toHaveTextContent('Ubuntu 26.04 LTS (resolute)');
    expect(rows[1]).toHaveTextContent('failed · 1 active');
    // The refusal is shown once, on the runtime that refused the list.
    expect(screen.getAllByText('Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix')).toHaveLength(1);
  });

  it('shows no per-runtime list on a Docker-only instance', async () => {
    getState.mockResolvedValueOnce({
      installationId: 'test-installation', packages: ['jq'], activePackages: ['jq'], status: 'ready', images: {}, updatedAt: 'now',
      runtimes: [{ runtime: 'docker', label: 'Docker', status: 'ready', activePackages: ['jq'], source: 'derived Docker image' }],
    });
    render(<AgentRuntimePackagesSection />);
    expect(await screen.findByText(/active across/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Runtime package state per runtime' })).not.toBeInTheDocument();
  });

  it('explains why packages are needed and how to find their names', async () => {
    render(<AgentRuntimePackagesSection />);
    await screen.findByText('jq');

    expect(screen.getByText(/without sudo/)).toBeInTheDocument();
    expect(screen.getByText(/comes from/)).toHaveTextContent('psql comes from postgresql-client');
    expect(screen.getByRole('link', { name: 'Finding package names' })).toHaveAttribute('href', 'https://docs.propr.dev/docs/features/propr-cli#finding-package-names');
    expect(screen.queryByText(/packages\.debian\.org/)).toBeNull();
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
    expect(screen.queryByText('Agent runtime packages')).not.toBeInTheDocument();
  });

  it('renders nothing until runtime package permissions load', async () => {
    let resolveState: (state: AgentRuntimePackageState) => void = () => undefined;
    getState.mockReturnValueOnce(new Promise<AgentRuntimePackageState>(resolve => { resolveState = resolve; }));

    render(<AgentRuntimePackagesSection />);

    expect(screen.queryByText('Agent runtime packages')).not.toBeInTheDocument();

    resolveState({
      installationId: 'test-installation',
      packages: [],
      activePackages: [],
      status: 'disabled',
      images: {},
      canManage: false,
      updatedAt: 'now'
    });

    await waitFor(() => expect(screen.queryByText('Agent runtime packages')).not.toBeInTheDocument());
  });
});
