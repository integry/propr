import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('shows a retryable failure when the connection adapter rejects', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('The desktop host did not respond.'))
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    render(<DesktopExperience adapters={adapters}><div>Dashboard content</div></DesktopExperience>);

    expect(await screen.findByText(/could not check this instance/i)).toBeInTheDocument();
    expect(screen.getByText(/desktop host did not respond/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reports persistence failures distinctly and allows retrying', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    vi.mocked(adapters.profiles.save)
      .mockRejectedValueOnce(new Error('Profile storage is unavailable.'))
      .mockResolvedValueOnce(undefined);
    render(<DesktopExperience adapters={adapters}><div>Dashboard content</div></DesktopExperience>);

    expect(await screen.findByText(/could not save this connection/i)).toBeInTheDocument();
    expect(screen.getByText(/profile storage is unavailable/i)).toBeInTheDocument();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledTimes(2);
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(localProfile.id);
  });

  it('ignores a stale connection result after the adapters change', async () => {
    let resolveFirstProbe: ((result: DesktopConnectionResult) => void) | undefined;
    const firstProbe = vi.fn(() => new Promise<DesktopConnectionResult>(resolve => {
      resolveFirstProbe = resolve;
    }));
    const firstAdapters = adaptersFor([localProfile], localProfile.id, firstProbe);
    const replacementProfile = { ...localProfile, id: 'replacement', name: 'Replacement instance' };
    const replacementAdapters = adaptersFor(
      [replacementProfile],
      replacementProfile.id,
      async () => ({ status: 'offline', message: 'The replacement instance is unavailable.' })
    );
    const { rerender } = render(
      <DesktopExperience adapters={firstAdapters}><div>Stale dashboard</div></DesktopExperience>
    );

    await waitFor(() => expect(firstProbe).toHaveBeenCalledOnce());
    rerender(<DesktopExperience adapters={replacementAdapters}><div>Replacement dashboard</div></DesktopExperience>);
    expect(await screen.findByText('The replacement instance is unavailable.')).toBeInTheDocument();

    await act(async () => {
      resolveFirstProbe?.({ status: 'ready', version: '0.8.15' });
    });

    expect(screen.getByText('The replacement instance is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Stale dashboard')).not.toBeInTheDocument();
    expect(firstAdapters.profiles.save).not.toHaveBeenCalled();
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
