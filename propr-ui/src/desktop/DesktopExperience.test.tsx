import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { adaptersFor, deferred, localProfile, remoteProfile } from './DesktopExperience.testUtils';
import type { DesktopConnectionResult, DesktopProfile } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

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

    expect(await screen.findByRole('heading', { name: 'Check the essentials' })).toBeInTheDocument();
    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Open dashboard/i }));

    expect(await screen.findByText('Shared route tree')).toBeInTheDocument();
    expect(adapters.localSetup.start).toHaveBeenCalledOnce();
    expect(adapters.connection.probe).toHaveBeenCalledWith(localProfile);
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith('local');
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
    expect(apiMock.setApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
  });

  it('stages a Connect deep link for explicit confirmation without probing or mutating profiles', async () => {
    const adapters = adaptersFor();
    const deepLinks = new DesktopDeepLinkInbox();
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Shared route tree</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    vi.clearAllMocks();
    act(() => deepLinks.receive('propr://connect?api=https%3A%2F%2Fcandidate.example'));

    expect(await screen.findByRole('status')).toHaveTextContent(/untrusted instance address/i);
    expect(screen.getByLabelText('Instance URL')).toHaveValue('https://candidate.example');
    expect(adapters.discovery.discover).not.toHaveBeenCalled();
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Shared route tree')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledOnce();
    expect(adapters.profiles.save).toHaveBeenCalledOnce();
    expect(adapters.profiles.setActiveId).toHaveBeenCalledOnce();
  });

  it('routes a bounded Open deep link only for the validated active profile', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    const deepLinks = new DesktopDeepLinkInbox();
    window.location.hash = '';
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    act(() => deepLinks.receive('propr://open?path=%2Ftasks%3Fstatus%3Dopen'));
    expect(window.location.hash).toBe('#/tasks?status=open');
  });

  it('uses one fixed redacted UI state for malformed desktop links', async () => {
    const adapters = adaptersFor();
    const deepLinks = new DesktopDeepLinkInbox();
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Connected app</div></DesktopExperience>);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    act(() => deepLinks.receive('propr://open?path=SENTINEL_ATTACKER_VALUE'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ProPR Desktop could not use that link. Choose an instance and try again.');
    expect(alert).not.toHaveTextContent('SENTINEL_ATTACKER_VALUE');
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
  });

  it.each(['macos', 'windows'] as const)('activates an existing remote profile on %s', async platform => {
    const adapters = adaptersFor([remoteProfile], remoteProfile.id);
    adapters.platform = platform;
    render(<DesktopExperience adapters={adapters}><div>Remote dashboard</div></DesktopExperience>);

    expect(await screen.findByText('Remote dashboard')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(remoteProfile);
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenCalledWith(remoteProfile.baseUrl);
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
