import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopInstanceSelector } from './DesktopInstanceSelector';
import type { DesktopNativeCommandDelivery } from '../../../apps/desktop/src/shared/contract';
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

const localConnectionScope = {
  profileId: localProfile.id,
  transportScope: 'abcdefghijklmnopqrstuv',
};

const remoteConnectionScope = {
  profileId: remoteProfile.id,
  transportScope: 'zyxwvutsrqponmlkjihgfe',
};

const nativeDelivery = (
  command: DesktopNativeCommandDelivery['command'],
  connectionScope = localConnectionScope,
): DesktopNativeCommandDelivery => ({ command, connectionScope });

const connectedApp = <><DesktopInstanceSelector /><div>Connected app</div></>;
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
  app: { onDeepLink: () => () => undefined },
  profiles: {
    list: vi.fn(async () => profiles),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getActiveId: vi.fn(async () => activeId),
    setActiveId: vi.fn(async () => undefined),
  },
  discovery: { supported: true, discover: vi.fn(async () => []) },
  authentication: { authenticate: vi.fn(async () => undefined) },
  externalBrowser: { open: vi.fn(async () => undefined) },
  localSetup: { supported: true, setup: vi.fn(async () => localProfile) },
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

  it('switches instances and opens management from the compact connected selector', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    expect(screen.getByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Team serverRemote instance/i }));

    expect(await screen.findByRole('button', { name: 'Connected: Team server' })).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenLastCalledWith(remoteProfile);
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(remoteProfile.id);
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith(remoteProfile.baseUrl);
  });

  it('uses the native manage command to open the validated instance lifecycle surface', async () => {
    let nativeCommand: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    adapters.app.onNativeCommand = listener => {
      nativeCommand = listener as typeof nativeCommand;
      return () => { nativeCommand = undefined; };
    };
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    act(() => nativeCommand?.(nativeDelivery('manage-instances')));
    fireEvent.click(await screen.findByRole('button', { name: /Team serverRemote instance/i }));
    expect(await screen.findByRole('button', { name: 'Connected: Team server' })).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenLastCalledWith(remoteProfile);
  });

  it('leaves native menu accelerators to native command delivery', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    adapters.app.onNativeCommand = () => () => undefined;
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });

    expect(screen.queryByRole('dialog', { name: 'Manage instances' })).not.toBeInTheDocument();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('guards the instance-management fallback shortcut before leaving Plan Studio', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    window.location.hash = '#/studio/draft-1';
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(
      <DesktopExperience adapters={adapters}>
        <textarea aria-label="Plan composer" defaultValue="Unsaved plan details" />
      </DesktopExperience>,
    );
    expect(await screen.findByLabelText('Plan composer')).toHaveValue('Unsaved plan details');

    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });

    expect(window.confirm).toHaveBeenCalledWith('Leave this plan? Any unsaved changes will be lost.');
    expect(screen.queryByRole('dialog', { name: 'Manage instances' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Plan composer')).toHaveValue('Unsaved plan details');
    window.location.hash = '#/';
  });

  it('asks before native navigation can leave a plan composer', async () => {
    let nativeCommand: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
    const adapters = adaptersFor(
      [localProfile],
      localProfile.id,
      async () => ({ status: 'ready', version: '0.8.15', ...localConnectionScope }),
    );
    adapters.app.onNativeCommand = listener => {
      nativeCommand = listener as typeof nativeCommand;
      return () => { nativeCommand = undefined; };
    };
    window.location.hash = '#/studio/draft-1';
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    act(() => nativeCommand?.(nativeDelivery('tasks')));
    expect(window.confirm).toHaveBeenCalledWith('Leave this plan? Any unsaved changes will be lost.');
    expect(window.location.hash).toBe('#/studio/draft-1');
    window.location.hash = '#/';
  });

  it('drops native navigation received during an instance transition when the connection changes', async () => {
    let nativeCommand: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
    const remoteProbe = deferred<DesktopConnectionResult>();
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15', ...localConnectionScope })
      .mockReturnValueOnce(remoteProbe.promise);
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id, probe);
    adapters.app.onNativeCommand = listener => {
      nativeCommand = listener;
      return () => { nativeCommand = undefined; };
    };
    window.location.hash = '#/';
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();

    act(() => nativeCommand?.(nativeDelivery('manage-instances')));
    fireEvent.click(await screen.findByRole('button', { name: /Team serverRemote instance/i }));
    expect(await screen.findByText('Connecting to Team server')).toBeInTheDocument();
    act(() => nativeCommand?.(nativeDelivery('tasks')));
    await act(async () => remoteProbe.resolve({
      status: 'ready', version: '0.8.15', ...remoteConnectionScope,
    }));

    expect(await screen.findByRole('button', { name: 'Connected: Team server' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
  });

  it('keeps composer work when native instance management is declined', async () => {
    let nativeCommand: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    adapters.app.onNativeCommand = listener => {
      nativeCommand = listener as typeof nativeCommand;
      return () => { nativeCommand = undefined; };
    };
    window.location.hash = '#/studio/draft-1';
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(
      <DesktopExperience adapters={adapters}>
        <textarea aria-label="Plan composer" defaultValue="Unsaved plan details" />
      </DesktopExperience>,
    );
    expect(await screen.findByLabelText('Plan composer')).toHaveValue('Unsaved plan details');

    act(() => nativeCommand?.(nativeDelivery('manage-instances')));

    expect(window.confirm).toHaveBeenCalledWith('Leave this plan? Any unsaved changes will be lost.');
    expect(screen.queryByRole('dialog', { name: 'Manage instances' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Plan composer')).toHaveValue('Unsaved plan details');
    expect(adapters.connection.probe).toHaveBeenCalledTimes(1);
    window.location.hash = '#/';
  });

  it('keeps composer work when native quit is declined', async () => {
    let nativeCommand: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
    const adapters = adaptersFor([localProfile], localProfile.id);
    const quit = vi.fn(async () => undefined);
    adapters.app.onNativeCommand = listener => {
      nativeCommand = listener as typeof nativeCommand;
      return () => { nativeCommand = undefined; };
    };
    adapters.app.quit = quit;
    window.location.hash = '#/studio/draft-1';
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(
      <DesktopExperience adapters={adapters}>
        <textarea aria-label="Plan composer" defaultValue="Unsaved plan details" />
      </DesktopExperience>,
    );
    expect(await screen.findByLabelText('Plan composer')).toHaveValue('Unsaved plan details');

    act(() => nativeCommand?.(nativeDelivery('quit')));

    expect(window.confirm).toHaveBeenCalledWith('Leave this plan? Any unsaved changes will be lost.');
    expect(quit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Plan composer')).toHaveValue('Unsaved plan details');

    act(() => nativeCommand?.(nativeDelivery('quit')));
    expect(quit).toHaveBeenCalledTimes(1);
    window.location.hash = '#/';
  });

  it('reconnects an edited active instance but saves an inactive edit without connecting', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    render(<DesktopExperience adapters={adapters}>{connectedApp}</DesktopExperience>);

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://active.example.com');

    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });
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
    fireEvent.click(screen.getByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://unavailable.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/could not reach this instance.*try again/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('The updated server is unavailable.');
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
    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Retryable edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this instance.*try again/i);
    expect(document.body).not.toHaveTextContent('Profile storage is locked.');
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

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not remove this instance.*try again/i);
    expect(document.body).not.toHaveTextContent('Profile storage is locked.');
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
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(remoteProfile, expect.any(Function));
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
    expect(await screen.findByText(/desktop pairing could not be completed.*try again/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Browser launch failed.');
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open connection help/i }));
    expect(await screen.findByText(/could not open connection help.*try again/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('No browser is configured.');
    expect(screen.getByRole('button', { name: /Open connection help/i })).toBeInTheDocument();
  });

  it.each(['macos', 'windows'] as const)('offers remote connection guidance instead of local setup on %s', async platform => {
    const adapters = adaptersFor();
    adapters.platform = platform;
    adapters.localSetup.supported = false;
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Connect to ProPR' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up this computer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/local setup is currently available on Linux/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect to an existing instance/i })).toBeInTheDocument();
  });

  it('hides unsupported local setup when the adapter reports Linux', async () => {
    const adapters = adaptersFor();
    adapters.localSetup.supported = false;
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Connect to ProPR' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up this computer/i })).not.toBeInTheDocument();
    expect(adapters.localSetup.setup).not.toHaveBeenCalled();
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
    fireEvent.keyDown(document, { key: 'I', ctrlKey: true, shiftKey: true });
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
