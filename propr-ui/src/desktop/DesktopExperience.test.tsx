import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopTitleBar } from './DesktopTitleBar';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

const localProfile: DesktopProfile = {
  id: 'local',
  name: 'This computer',
  baseUrl: 'http://127.0.0.1:3000',
  kind: 'local',
};

const adaptersFor = (
  profiles: DesktopProfile[] = [],
  activeId: string | null = null,
  probe: (profile: DesktopProfile) => Promise<DesktopConnectionResult> = async () => ({ status: 'ready', version: '0.8.15' })
): DesktopAdapters => ({
  platform: 'linux',
  profiles: {
    list: vi.fn(async () => profiles),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getActiveId: vi.fn(async () => activeId),
    setActiveId: vi.fn(async () => undefined),
  },
  discovery: { discover: vi.fn(async () => []) },
  authentication: { authenticate: vi.fn(async () => undefined) },
  externalBrowser: { open: vi.fn(async () => undefined) },
  localSetup: { setup: vi.fn(async () => localProfile) },
  connection: { probe: vi.fn(probe) },
});

describe('DesktopExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs first-time local setup through adapters before mounting the shared app', async () => {
    const adapters = adaptersFor();
    render(<DesktopExperience adapters={adapters}><div>Shared route tree</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    expect(screen.queryByText('Shared route tree')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Set up this computer/i }));

    expect(await screen.findByText('Shared route tree')).toBeInTheDocument();
    expect(adapters.localSetup.setup).toHaveBeenCalledOnce();
    expect(adapters.connection.probe).toHaveBeenCalledWith(localProfile);
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith('local');
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
    expect(apiMock.setApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
  });

  it('shows a retryable offline state and recovers without reloading', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'The instance is offline.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    render(<DesktopExperience adapters={adapters}><div>Dashboard content</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'This computer' })).toBeInTheDocument();
    expect(screen.getByText('The instance is offline.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('supports editing a recent profile and connecting to the updated URL', async () => {
    const adapters = adaptersFor([localProfile]);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Recent instances')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Office ProPR' } });
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://office.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local',
      name: 'Office ProPR',
      baseUrl: 'https://office.example.com',
    }));
  });

  it('opens instance management with the desktop shortcut and exposes connection status', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    render(
      <DesktopExperience adapters={adapters}>
        <DesktopTitleBar />
      </DesktopExperience>
    );

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

