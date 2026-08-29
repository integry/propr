import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopTitleBar } from './DesktopTitleBar';
import { DESKTOP_ACCESS_INVALID_EVENT, type DesktopAdapters, type DesktopConnectionResult, type DesktopProfile } from './types';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

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
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
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

  it('serializes deferred persistence so the latest connection owns the stored profile and active ID', async () => {
    const firstSave = deferred<void>();
    let storedProfile: DesktopProfile | null = null;
    let storedActiveId: string | null = null;
    const adapters = adaptersFor([localProfile, remoteProfile]);
    vi.mocked(adapters.profiles.save).mockImplementation(async profile => {
      if (vi.mocked(adapters.profiles.save).mock.calls.length === 1) {
        await firstSave.promise;
      }
      storedProfile = profile;
    });
    vi.mocked(adapters.profiles.setActiveId).mockImplementation(async id => { storedActiveId = id; });
    render(<DesktopExperience adapters={adapters}><div>Latest dashboard</div></DesktopExperience>);

    expect(await screen.findByText('Recent instances')).toBeInTheDocument();
    fireEvent.click(screen.getByText('This computer').closest('button')!);
    await waitFor(() => expect(adapters.profiles.save).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click((await screen.findByText('Team server')).closest('button')!);
    await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledWith(remoteProfile));
    expect(adapters.profiles.save).toHaveBeenCalledOnce();

    await act(async () => { firstSave.resolve(); });

    expect(await screen.findByText('Latest dashboard')).toBeInTheDocument();
    expect(storedProfile).toMatchObject({ id: remoteProfile.id, baseUrl: remoteProfile.baseUrl });
    expect(storedActiveId).toBe(remoteProfile.id);
    expect(adapters.profiles.setActiveId).toHaveBeenCalledTimes(1);
  });

  it('offers Back while probing and prevents a cancelled probe from committing', async () => {
    const pendingProbe = deferred<DesktopConnectionResult>();
    const adapters = adaptersFor([localProfile], null, () => pendingProbe.promise);
    render(<DesktopExperience adapters={adapters}><div>Cancelled dashboard</div></DesktopExperience>);

    fireEvent.click((await screen.findByText('This computer')).closest('button')!);
    expect(await screen.findByRole('heading', { name: 'Connecting to This computer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Recent instances')).toBeInTheDocument();

    await act(async () => { pendingProbe.resolve({ status: 'ready', version: '0.8.15' }); });

    expect(screen.queryByText('Cancelled dashboard')).not.toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(null);
  });

  it('ignores a delayed access-invalid event from A after B has connected', async () => {
    const probe = vi.fn(async (profile: DesktopProfile): Promise<DesktopConnectionResult> => ({
      status: 'ready',
      version: '0.8.15',
      connectionGeneration: profile.id === localProfile.id ? 11 : 12,
    }));
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id, probe);
    adapters.connection.deactivate = vi.fn();
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click((await screen.findByText('Team server')).closest('button')!);
    await waitFor(() => expect(probe).toHaveBeenCalledWith(remoteProfile));
    expect(await screen.findByText('Connected app')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(DESKTOP_ACCESS_INVALID_EVENT, {
      detail: { profileId: localProfile.id, connectionGeneration: 11, code: 'INVALID_INSTANCE_TOKEN' },
    }));

    expect(screen.getByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.deactivate).not.toHaveBeenCalled();
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

  it('traps modal focus, makes the app inert, and restores focus to the opener', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    render(
      <DesktopExperience adapters={adapters}>
        <DesktopTitleBar />
      </DesktopExperience>
    );

    const opener = await screen.findByRole('button', { name: 'Connected: This computer' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'Manage instances' });
    const app = opener.closest('.desktop-app');
    const close = screen.getByRole('button', { name: 'Close instance manager' });
    const last = screen.getByRole('button', { name: /Add instance/i });
    expect(app).toHaveAttribute('inert');
    expect(app).toHaveAttribute('aria-hidden', 'true');
    expect(dialog).toContainElement(close);
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(app).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('connects a new instance added from the manager', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: /Add instance/i }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New server' } });
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://new.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New server',
      baseUrl: 'https://new.example.com',
    }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(expect.any(String));
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenLastCalledWith('https://new.example.com');
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://new.example.com');
  });

  it.each(['new', 'active'] as const)('closes the instance manager after a %s profile starts connecting', async profileKind => {
    const pendingProbe = deferred<DesktopConnectionResult>();
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' })
      .mockImplementationOnce(() => pendingProbe.promise);
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    if (profileKind === 'new') {
      fireEvent.click(await screen.findByRole('button', { name: /Add instance/i }));
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New server' } });
      fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://new.example.com/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
      fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    }

    expect(await screen.findByRole('heading', { name: new RegExp(`Connecting to ${profileKind === 'new' ? 'New server' : 'This computer'}`) })).toBeInTheDocument();
    await act(async () => { pendingProbe.resolve({ status: 'ready', version: '0.8.15' }); });

    const app = await screen.findByText('Connected app');
    expect(screen.queryByRole('dialog', { name: 'Manage instances' })).not.toBeInTheDocument();
    expect(app.closest('.desktop-app')).not.toHaveAttribute('inert');
    expect(app.closest('.desktop-app')).not.toHaveAttribute('aria-hidden');
  });

  it('reconnects an edited active instance but saves an inactive edit without connecting', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
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
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
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
      async () => ({ status: 'authentication-required', message: 'Please sign in.' })
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
});
