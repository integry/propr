import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
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

const adaptersFor = (
  profiles: DesktopProfile[] = [],
  activeId: string | null = null,
  probe: (profile: DesktopProfile) => Promise<DesktopConnectionResult> = async () => ({ status: 'ready', version: '0.8.15' })
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const renderConnectedExperience = (adapters: DesktopAdapters, content?: string) => render(
  <DesktopExperience adapters={adapters}>
    <DesktopTitleBar />
    {content && <div>{content}</div>}
  </DesktopExperience>
);

describe('DesktopExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers network search only when the adapter has a real discovery provider', async () => {
    const capable = adaptersFor();
    const { unmount } = render(
      <DesktopExperience adapters={capable}><div>Capable app</div></DesktopExperience>
    );
    const search = await screen.findByRole('button', { name: /Search for instances on this network/i });
    fireEvent.click(search);
    await waitFor(() => expect(capable.discovery.discover).toHaveBeenCalledOnce());
    unmount();

    const incapable = adaptersFor();
    incapable.discovery.supported = false;
    render(<DesktopExperience adapters={incapable}><div>Incapable app</div></DesktopExperience>);
    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Search for instances on this network/i })).not.toBeInTheDocument();
    expect(incapable.discovery.discover).not.toHaveBeenCalled();
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

  it('stages a Connect deep link for confirmation with zero pre-confirmation effects', async () => {
    const adapters = adaptersFor();
    adapters.connection.activate = vi.fn(async (_profile, result) => result);
    adapters.connection.deactivate = vi.fn();
    const deepLinks = new DesktopDeepLinkInbox();
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Shared route tree</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    act(() => deepLinks.receive('propr://connect?api=https%3A%2F%2Fconnect.propr.dev'));

    expect(await screen.findByRole('status')).toHaveTextContent(/untrusted instance address/i);
    expect(screen.getByLabelText('Instance URL')).toHaveValue('https://connect.propr.dev');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(adapters.discovery.discover).not.toHaveBeenCalled();
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.connection.activate).not.toHaveBeenCalled();
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(adapters.connection.deactivate).not.toHaveBeenCalled();
    expect(runtimeMock.setDesktopApiBaseUrl).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledOnce());
    expect(adapters.profiles.save).toHaveBeenCalledOnce();
    expect(adapters.connection.activate).toHaveBeenCalledOnce();
  });

  it('returns from the prefilled profile editor to every packaged-layout chooser element', async () => {
    const adapters = adaptersFor();
    const deepLinks = new DesktopDeepLinkInbox();
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Shared route tree</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    act(() => deepLinks.receive('propr://connect?api=https%3A%2F%2Fconnect.propr.dev'));
    expect(await screen.findByLabelText('Instance URL')).toHaveValue('https://connect.propr.dev');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Let’s set up this computer' });

    for (const selector of [
      '.desktop-entry',
      '.desktop-welcome-card',
      '.desktop-welcome-card .desktop-brand img',
      '.desktop-welcome-card .desktop-welcome-copy h1',
      '.desktop-welcome-card .desktop-choice-button',
      '.desktop-welcome-card .desktop-choice-button small',
    ]) {
      expect(document.querySelector(selector), selector).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('keeps Open deep-link navigation separate and bound to the active profile', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    const deepLinks = new DesktopDeepLinkInbox();
    window.location.hash = '';
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    act(() => deepLinks.receive('propr://open?path=%2Ftasks%3Fstatus%3Dopen'));

    expect(window.location.hash).toBe('#/tasks?status=open');
    expect(screen.queryByLabelText('Instance URL')).not.toBeInTheDocument();
  });

  it('rejects malformed desktop links with a fixed redacted message and no effects', async () => {
    const adapters = adaptersFor();
    const deepLinks = new DesktopDeepLinkInbox();
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Shared route tree</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    act(() => deepLinks.receive('propr://connect?api=SENTINEL_ATTACKER_VALUE&token=secret'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ProPR Desktop could not use that link. Choose an instance and try again.');
    expect(alert).not.toHaveTextContent('SENTINEL_ATTACKER_VALUE');
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
  });

  it('identifies only a verified ProPR Connect endpoint while adding a profile', async () => {
    const adapters = adaptersFor();
    render(<DesktopExperience adapters={adapters}><div>Shared route tree</div></DesktopExperience>);
    fireEvent.click(await screen.findByRole('button', { name: /Connect to an existing instance/i }));

    const input = screen.getByLabelText('Instance URL');
    fireEvent.change(input, { target: { value: 'https://t-instance123.propr.dev' } });
    expect(screen.getByRole('status')).toHaveTextContent('Verified ProPR Connect endpoint');

    fireEvent.change(input, { target: { value: 'https://t-instance123.propr.dev:8443' } });
    expect(screen.queryByText('Verified ProPR Connect endpoint')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'https://t-instance123.foo.propr.dev' } });
    expect(screen.queryByText('Verified ProPR Connect endpoint')).not.toBeInTheDocument();
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
      kind: 'remote',
    }));
  });

  it('derives a remote-to-loopback edit kind from the normalized submitted URL', async () => {
    const adapters = adaptersFor([remoteProfile]);
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Recent instances')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'HTTP://LOCALHOST:3000/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({
      id: remoteProfile.id,
      baseUrl: 'http://localhost:3000',
      kind: 'local',
    }));
  });

  it('opens instance management with the desktop shortcut and exposes connection status', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    renderConnectedExperience(adapters);

    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('traps modal focus, makes the app inert, and restores focus to the opener', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    renderConnectedExperience(adapters);

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
    renderConnectedExperience(adapters, 'Connected app');

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
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
    renderConnectedExperience(adapters, 'Connected app');

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
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
    renderConnectedExperience(adapters, 'Connected app');

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://active.example.com');

    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
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
    renderConnectedExperience(adapters, 'Connected app');

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://unavailable.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/could not reach this instance/i)).toBeInTheDocument();
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
    renderConnectedExperience(adapters, 'Connected app');

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Retryable edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this instance.*try again/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/storage is locked/i);
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
    expect(screen.getByRole('alert')).not.toHaveTextContent(/storage is locked/i);
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
    expect(await screen.findByText(/could not open sign in.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/browser launch failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open connection help/i }));
    expect(await screen.findByText(/could not open connection help.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/no browser is configured/i)).not.toBeInTheDocument();
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
