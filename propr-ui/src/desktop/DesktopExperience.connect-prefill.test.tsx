import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_LOCAL_API_BASE_URL } from '@propr/shared';
import { describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { adaptersFor, deferred, remoteProfile, renderConnectedExperience } from './DesktopExperience.testSupport';
import type { DesktopProfile } from './types';

vi.mock('../api/apiClient', () => ({ getDesktopConnectionScope: () => null, setApiBaseUrl: vi.fn(), setDesktopConnectionScope: vi.fn() }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: vi.fn() }));

const discovered: DesktopProfile = {
  id: 'fresh-main-owned-id', name: 'Discovered name',
  baseUrl: 'https://t-preview123.propr.dev', kind: 'remote',
};

for (const platform of ['macos', 'linux'] as const) describe(`${platform} Add Instance Connect prefill`, () => {
  const setup = async (discover = vi.fn(async () => [discovered]), deepLinks?: DesktopDeepLinkInbox) => {
    const adapters = adaptersFor([remoteProfile]);
    adapters.platform = platform;
    adapters.discovery.discover = discover;
    render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Connected app</div></DesktopExperience>);
    fireEvent.click(await screen.findByRole('button', { name: /Connect to an existing instance/ }));
    return adapters;
  };
  const useConnect = () => fireEvent.click(screen.getByRole('button', { name: 'Use ProPR Connect' }));

  it('preserves the typed name and requires confirmation before probe, pairing, or persistence', async () => {
    const adapters = await setup();
    expect(screen.getByLabelText('Instance URL')).toHaveValue(DEFAULT_LOCAL_API_BASE_URL);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Shared development' } });
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
    expect(screen.getByLabelText('Display name')).toHaveValue('Shared development');
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ id: discovered.id, name: 'Shared development', baseUrl: discovered.baseUrl }));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: discovered.id, name: 'Shared development' }));
  });

  it.each(['empty', 'error'] as const)('offers safe actionable retry guidance for %s discovery', async mode => {
    const discover = vi.fn(async (): Promise<DesktopProfile[]> => {
      if (mode === 'error') throw new Error('SECRET /private/native/config');
      return [];
    });
    await setup(discover);
    useConnect();
    expect(await screen.findByText(/Open or run ProPR Connect/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instance URL')).toHaveValue(DEFAULT_LOCAL_API_BASE_URL);
    discover.mockResolvedValue([discovered]);
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
  });

  it('requires explicit selection when discovery returns multiple endpoints', async () => {
    const other = { ...discovered, id: 'other-main-id', baseUrl: 'https://t-preview456.propr.dev' };
    const adapters = await setup(vi.fn(async () => [discovered, other]));
    useConnect();
    expect(await screen.findByRole('group', { name: 'Choose a ProPR Connect endpoint' })).toBeInTheDocument();
    expect(screen.getByLabelText('Instance URL')).toHaveValue(DEFAULT_LOCAL_API_BASE_URL);
    fireEvent.click(screen.getByRole('button', { name: other.baseUrl }));
    expect(screen.getByLabelText('Instance URL')).toHaveValue(other.baseUrl);
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ id: other.id })));
  });

  it.each(['cancel', 'manual', 'back'] as const)('ignores late discovery after %s', async action => {
    const pending = deferred<DesktopProfile[]>();
    const adapters = await setup(vi.fn(() => pending.promise));
    useConnect();
    if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel discovery' }));
    if (action === 'manual') fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://manual.example.test' } });
    if (action === 'back') {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(screen.getByRole('button', { name: /Connect to an existing instance/ }));
    }
    await act(async () => { pending.resolve([discovered]); await pending.promise; });
    expect(screen.getByLabelText('Instance URL')).toHaveValue(action === 'manual' ? 'https://manual.example.test' : DEFAULT_LOCAL_API_BASE_URL);
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it('uses a fresh manual binding after editing the prefilled URL', async () => {
    const adapters = await setup();
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://manual.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalled());
    const profile = vi.mocked(adapters.connection.probe).mock.calls[0][0];
    expect(profile.id).not.toBe(discovered.id);
    expect(profile.id).not.toBe(remoteProfile.id);
    expect(profile.baseUrl).toBe('https://manual.example.test');
    expect(profile.account).toBeUndefined();
  });

  it('retains URL validation and the main identity binding after correcting a manual edit', async () => {
    const adapters = await setup();
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: `${discovered.baseUrl}/` } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The configured ProPR API URL is invalid.');
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: discovered.baseUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ id: discovered.id })));
  });

  it('ignores a cancelled failure while a new discovery succeeds', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<DesktopProfile[]>((_resolve, fail) => { reject = fail; });
    const discover = vi.fn(async () => [discovered]).mockImplementationOnce(() => pending);
    await setup(discover);
    useConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel discovery' }));
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
    await act(async () => { reject(new Error('SECRET')); await pending.catch(() => undefined); });
    expect(screen.queryByText(/Could not discover|SECRET/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl);
  });

  it('allows manual confirmation while discovery is pending without a late switch', async () => {
    const pending = deferred<DesktopProfile[]>();
    const adapters = await setup(vi.fn(() => pending.promise));
    useConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    await act(async () => { pending.resolve([discovered]); await pending.promise; });
    expect(adapters.connection.probe).toHaveBeenCalledTimes(1);
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: DEFAULT_LOCAL_API_BASE_URL }));
    expect(screen.queryByLabelText('Instance URL')).not.toBeInTheDocument();
  });

  it('keeps a competing deep link in its explicit confirmation flow', async () => {
    const pending = deferred<DesktopProfile[]>();
    const inbox = new DesktopDeepLinkInbox();
    const adapters = await setup(vi.fn(() => pending.promise), inbox);
    useConnect();
    await act(async () => { inbox.receive('propr://connect?api=https%3A%2F%2Ft-link123.propr.dev'); });
    expect(screen.getByLabelText('Instance URL')).toHaveValue('https://t-link123.propr.dev');
    await act(async () => { pending.resolve([discovered]); await pending.promise; });
    expect(screen.getByLabelText('Instance URL')).toHaveValue('https://t-link123.propr.dev');
    expect(screen.getByText(/Review this untrusted instance address/)).toBeInTheDocument();
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it('prefills from the connected manager without changing the active account', async () => {
    const adapters = adaptersFor([remoteProfile], remoteProfile.id);
    adapters.platform = platform;
    adapters.discovery.discover = vi.fn(async () => [discovered]);
    renderConnectedExperience(adapters, 'Connected app');
    fireEvent.click(await screen.findByRole('button', { name: /Team server/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add instance' }));
    vi.mocked(adapters.connection.probe).mockClear();
    vi.mocked(adapters.profiles.save).mockClear();
    vi.mocked(adapters.profiles.setActiveId).mockClear();
    useConnect();
    await waitFor(() => expect(screen.getByLabelText('Instance URL')).toHaveValue(discovered.baseUrl));
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close instance manager' }));
    expect(screen.getByText('Connected app')).toBeVisible();
  });
});
