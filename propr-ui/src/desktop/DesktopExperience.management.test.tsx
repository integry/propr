import { act, fireEvent, render, screen } from '@testing-library/react';
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

const remoteProfile: DesktopProfile = {
  id: 'remote',
  name: 'Team server',
  baseUrl: 'https://propr.example.com',
  kind: 'remote',
};

const connectedApp = <><DesktopTitleBar /><div>Connected app</div></>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

const adaptersFor = (
  profiles: DesktopProfile[] = [],
  activeId: string | null = null,
  probe: (profile: DesktopProfile) => Promise<DesktopConnectionResult> =
    async () => ({ status: 'ready', version: '0.8.15' }),
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

describe('DesktopExperience profile management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects an edited active instance but saves an inactive edit without connecting', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://active.example.com');

    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed team server' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Renamed team server')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote', name: 'Renamed team server' }));
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('does not persist an active profile edit until the updated connection is ready', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' })
      .mockResolvedValueOnce({ status: 'offline', message: 'The updated server is unavailable.' });
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://unavailable.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('The updated server is unavailable.')).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(runtimeMock.setDesktopApiBaseUrl).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('keeps a failed save in the manager editor so it can be retried', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    vi.mocked(adapters.profiles.save)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Profile storage is locked.'))
      .mockResolvedValueOnce(undefined);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Retryable edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this instance.*storage is locked.*try again/i);
    expect(screen.getByLabelText('Display name')).toHaveValue('Retryable edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Retryable edit')).toBeInTheDocument();
  });

  it('keeps a profile visible and reports a rejected removal', async () => {
    const adapters = adaptersFor([remoteProfile]);
    vi.mocked(adapters.profiles.remove).mockRejectedValueOnce(new Error('Profile storage is locked.'));
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Team server')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Team server' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not remove this instance.*storage is locked.*try again/i);
    expect(screen.getByText('Team server')).toBeInTheDocument();
    expect(adapters.profiles.remove).toHaveBeenCalledWith(remoteProfile.id);
  });

  it('reconnects after authentication completes and advances to the connected app', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'authentication-required', message: 'Please sign in.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor([remoteProfile], remoteProfile.id, probe);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(remoteProfile);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reports rejected authentication and connection-help operations in the blocked panel', async () => {
    const adapters = adaptersFor(
      [remoteProfile],
      remoteProfile.id,
      async () => ({ status: 'authentication-required', message: 'Please sign in.' }),
    );
    vi.mocked(adapters.authentication.authenticate).mockRejectedValueOnce(new Error('Browser launch failed.'));
    vi.mocked(adapters.externalBrowser.open).mockRejectedValueOnce(new Error('No browser is configured.'));
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));
    expect(await screen.findByText(/could not open sign in.*browser launch failed.*try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open connection help/i }));
    expect(await screen.findByText(/could not open connection help.*no browser is configured.*try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open connection help/i })).toBeInTheDocument();
  });

  it.each(['macos', 'windows'] as const)('offers remote connection guidance instead of local setup on %s', async platform => {
    const adapters = adaptersFor();
    adapters.platform = platform;
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Connect to ProPR' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up this computer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/local setup is currently available on Linux/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect to an existing instance/i })).toBeInTheDocument();
  });

  it('keeps management ready after out-of-order profile loading and a concurrent status refresh', async () => {
    const listed = deferred<DesktopProfile[]>();
    const selected = deferred<string | null>();
    const probed = deferred<DesktopConnectionResult>();
    const adapters = adaptersFor();
    vi.mocked(adapters.profiles.list).mockImplementation(() => listed.promise);
    vi.mocked(adapters.profiles.getActiveId).mockImplementation(() => selected.promise);
    vi.mocked(adapters.connection.probe).mockImplementation(() => probed.promise);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);

    await act(async () => { selected.resolve(localProfile.id); });
    expect(screen.getByText('Opening ProPR…')).toBeInTheDocument();
    await act(async () => { listed.resolve([localProfile, remoteProfile]); });
    expect(await screen.findByRole('heading', { name: 'Connecting to This computer' })).toBeInTheDocument();
    await act(async () => { probed.resolve({ status: 'ready', version: '0.8.15' }); });

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    fireEvent(window, new Event('offline'));
    expect(await screen.findByRole('button', { name: 'Offline: This computer' })).toBeInTheDocument();
    fireEvent(window, new Event('online'));
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('This computer');
    expect(screen.queryByText('Opening ProPR…')).not.toBeInTheDocument();
  });

  it('ignores late profile and status resolutions after unmount without stale publication', async () => {
    const listed = deferred<DesktopProfile[]>();
    const selected = deferred<string | null>();
    const adapters = adaptersFor();
    vi.mocked(adapters.profiles.list).mockImplementation(() => listed.promise);
    vi.mocked(adapters.profiles.getActiveId).mockImplementation(() => selected.promise);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);
    first.unmount();
    await act(async () => {
      listed.resolve([localProfile]);
      selected.resolve(localProfile.id);
      await Promise.resolve();
    });
    expect(adapters.connection.probe).not.toHaveBeenCalled();

    const probe = deferred<DesktopConnectionResult>();
    const probingAdapters = adaptersFor([localProfile], localProfile.id, () => probe.promise);
    const second = render(<DesktopExperience adapters={probingAdapters}>{connectedApp}</DesktopExperience>);
    expect(await screen.findByRole('heading', { name: 'Connecting to This computer' })).toBeInTheDocument();
    second.unmount();
    await act(async () => { probe.resolve({ status: 'ready', version: '0.8.15' }); });
    expect(probingAdapters.profiles.save).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();
    expect(runtimeMock.setDesktopApiBaseUrl).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
