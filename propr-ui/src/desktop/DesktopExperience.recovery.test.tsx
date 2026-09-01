import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

const savedProfile: DesktopProfile = {
  id: 'opaque-profile-id',
  name: 'Managed workspace',
  baseUrl: 'https://t-stale123.propr.dev',
  kind: 'remote',
};

const replacement: DesktopProfile = {
  ...savedProfile,
  baseUrl: 'https://t-restarted456.propr.dev',
};

const adaptersFor = (
  probe: (profile: DesktopProfile) => Promise<DesktopConnectionResult> = async () => ({ status: 'offline', message: 'offline' }),
): DesktopAdapters => ({
  platform: 'linux',
  profiles: {
    list: vi.fn(async () => [savedProfile]),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getActiveId: vi.fn(async () => savedProfile.id),
    setActiveId: vi.fn(async () => undefined),
  },
  discovery: { supported: false, discover: vi.fn(async () => []) },
  authentication: { authenticate: vi.fn(async () => undefined) },
  externalBrowser: { open: vi.fn(async () => undefined) },
  localSetup: { supported: false, setup: vi.fn(async () => savedProfile) },
  connection: { probe: vi.fn(probe) },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
};

const renderOfflineProfile = async (adapters: DesktopAdapters) => {
  render(<DesktopExperience adapters={adapters}><div>Dashboard content</div></DesktopExperience>);
  return await screen.findByRole('button', { name: 'Rediscover Connect endpoint' });
};

describe('DesktopExperience managed Connect recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows bounded recovery guidance without endpoint or raw failure details', async () => {
    const adapters = adaptersFor(async () => ({
      status: 'offline',
      message: 'Failed at https://t-stale123.propr.dev?token=secret-sentinel',
    }));
    await renderOfflineProfile(adapters);

    expect(screen.getByText(/endpoint may be stale or the local stack may have restarted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-enter Connect address' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('t-stale123.propr.dev');
    expect(document.body).not.toHaveTextContent('secret-sentinel');
  });

  it('does not give renderer network discovery authority when the trusted adapter is absent', async () => {
    const adapters = adaptersFor();
    vi.mocked(adapters.discovery.discover).mockResolvedValue([
      { ...savedProfile, id: 'unrelated', baseUrl: 'https://t-unrelated.propr.dev' },
      replacement,
    ]);
    fireEvent.click(await renderOfflineProfile(adapters));

    expect(await screen.findByText(/rediscovery is unavailable.*re-enter/i)).toBeInTheDocument();
    expect(adapters.discovery.discover).not.toHaveBeenCalled();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null],
    ['mismatched profile', { ...replacement, id: 'other-profile' }],
    ['trailing slash', { ...replacement, baseUrl: `${replacement.baseUrl}/` }],
    ['mixed case', { ...replacement, baseUrl: 'https://T-restarted456.propr.dev' }],
    ['nested reserved host', { ...replacement, baseUrl: 'https://x.t-restarted456.propr.dev' }],
    ['missing endpoint', { ...replacement, baseUrl: undefined } as unknown as DesktopProfile],
  ])('keeps the saved profile untouched for a %s candidate', async (_case, candidate) => {
    const adapters = adaptersFor();
    adapters.managedTunnelRecovery = { rediscover: vi.fn(async () => candidate) };
    fireEvent.click(await renderOfflineProfile(adapters));

    expect(await screen.findByText(/rediscovery is unavailable.*re-enter/i)).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.connection.probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved profile untouched when trusted rediscovery rejects', async () => {
    const adapters = adaptersFor();
    adapters.managedTunnelRecovery = {
      rediscover: vi.fn(async () => { throw new Error('token-sentinel at /private/path'); }),
    };
    fireEvent.click(await renderOfflineProfile(adapters));

    expect(await screen.findByText(/rediscovery is unavailable.*re-enter/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/token-sentinel|private\/path/i);
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it('identifies the bounded saved label, hides both endpoints, and requires confirmation', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'offline' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor(probe);
    adapters.managedTunnelRecovery = { rediscover: vi.fn(async () => replacement) };
    fireEvent.click(await renderOfflineProfile(adapters));

    expect(await screen.findByRole('heading', { name: 'Use the rediscovered endpoint?' })).toBeInTheDocument();
    expect(screen.getByText(/replacement endpoint was discovered for the saved connection “Managed workspace”/i)).toBeInTheDocument();
    expect(adapters.managedTunnelRecovery.rediscover).toHaveBeenCalledWith(savedProfile.id);
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(savedProfile.baseUrl);
    expect(document.body).not.toHaveTextContent(replacement.baseUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Connect to rediscovered endpoint' }));
    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({
      id: savedProfile.id,
      name: savedProfile.name,
      baseUrl: replacement.baseUrl,
      lastConnectedAt: expect.any(String),
    }));
  });

  it('cancels confirmation without saving and preserves Retry and Re-enter recovery', async () => {
    const adapters = adaptersFor();
    adapters.managedTunnelRecovery = { rediscover: vi.fn(async () => replacement) };
    fireEvent.click(await renderOfflineProfile(adapters));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep saved connection' }));

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-enter Connect address' })).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it('falls back from an unsafe saved label without exposing label contents', async () => {
    const unsafeLabel = 'https://old-host.example/private?token=label-secret';
    const adapters = adaptersFor();
    vi.mocked(adapters.profiles.list).mockResolvedValue([{ ...savedProfile, name: unsafeLabel }]);
    adapters.managedTunnelRecovery = { rediscover: vi.fn(async () => replacement) };
    fireEvent.click(await renderOfflineProfile(adapters));

    expect(await screen.findByText(/saved connection “Saved connection”/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/old-host|private|label-secret/i);
  });

  it('fences a stale concurrent rediscovery result from the current confirmation', async () => {
    const first = deferred<DesktopProfile | null>();
    const second = deferred<DesktopProfile | null>();
    const secondReplacement = { ...replacement, baseUrl: 'https://t-current789.propr.dev' };
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'offline' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor(probe);
    adapters.managedTunnelRecovery = {
      rediscover: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    };
    const button = await renderOfflineProfile(adapters);
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => second.resolve(secondReplacement));
    expect(await screen.findByRole('heading', { name: 'Use the rediscovered endpoint?' })).toBeInTheDocument();
    await act(async () => first.resolve(replacement));

    fireEvent.click(screen.getByRole('button', { name: 'Connect to rediscovered endpoint' }));
    await waitFor(() => expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({
      id: savedProfile.id,
      baseUrl: secondReplacement.baseUrl,
    })));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: secondReplacement.baseUrl }));
  });

  it('re-enters a managed address without exposing or overwriting the stale value', async () => {
    const adapters = adaptersFor();
    const reenter = await renderOfflineProfile(adapters);
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter Connect address' }));

    expect(reenter).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instance URL')).toHaveValue('');
    expect(document.body).not.toHaveTextContent(savedProfile.baseUrl);
    expect(adapters.profiles.save).not.toHaveBeenCalled();
  });

  it('turns a managed pairing failure into recovery without leaking the failure', async () => {
    const adapters = adaptersFor(async () => ({
      status: 'authentication-required',
      message: 'pair at private-path-sentinel',
    }));
    vi.mocked(adapters.authentication.authenticate).mockRejectedValueOnce(
      new Error('password-sentinel at /Users/private/config'),
    );
    render(<DesktopExperience adapters={adapters}><div>Dashboard content</div></DesktopExperience>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in in browser' }));

    expect(await screen.findByText(/pairing could not be completed.*try again/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/password-sentinel|Users\/private/i);
  });

  it('reports a managed connection-help failure as a bounded help error', async () => {
    const adapters = adaptersFor();
    vi.mocked(adapters.externalBrowser.open).mockRejectedValueOnce(
      new Error('browser-sentinel at /Users/private/config'),
    );
    await renderOfflineProfile(adapters);
    fireEvent.click(screen.getByRole('button', { name: 'Open connection help' }));

    expect(await screen.findByText(/could not open connection help.*try again/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/pairing could not be completed|browser-sentinel|Users\/private/i);
  });
});
