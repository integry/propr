import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { getSystemStatus } from '../api/proprApi';
import type { ConnectAccountStatus, CurrentUser, SystemStatus } from '../api/proprTypes';
import { AuthProvider } from '../contexts/AuthContext';
import { ConnectAccountProvider } from '../contexts/ConnectAccountContext';
import {
  ConnectCapacityBanner,
  ConnectSoftPromoBanner,
} from './ConnectPlusBanner';
import {
  capacityFingerprint,
  connectPlusDismissalKey,
} from './connectPlusBannerState';

vi.mock('../api/proprApi', () => ({ getSystemStatus: vi.fn() }));
const mockGetSystemStatus = vi.mocked(getSystemStatus);

const admin: CurrentUser = {
  id: '1',
  login: 'AdminUser',
  username: 'AdminUser',
  displayName: 'Admin',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_members'],
  authorizationSource: 'local',
};
const member: CurrentUser = {
  ...admin,
  id: '2',
  login: 'developer',
  username: 'developer',
  displayName: 'Developer',
  role: 'member',
  permissions: [],
};

const community = (overrides: Partial<ConnectAccountStatus> = {}): ConnectAccountStatus => ({
  installationId: 42,
  accountLogin: 'octo-org',
  plan: 'community',
  hasPlusAccess: false,
  activeSeats: 1,
  allowedSeats: 3,
  seatsRemaining: 2,
  billingCycleResetAt: '2026-09-01T00:00:00.000Z',
  seatLimitBlockedAt: null,
  sentAt: '2026-08-14T09:31:07.000Z',
  ...overrides,
});

const status = (connectAccount?: ConnectAccountStatus): SystemStatus => ({
  daemon: 'Running', workers: [], redis: 'Connected', githubAuth: 'Authenticated',
  claudeAuth: 'Authenticated', indexing: 'Idle', githubEventIntake: 'ProPR Connect',
  githubEventIntakeStatus: 'Connected', agents: [], connectAccount,
});

const banners = (user: CurrentUser = admin, disabled = false) => (
  <MemoryRouter>
    <AuthProvider user={user}>
      <ConnectAccountProvider disabled={disabled}>
        <ConnectCapacityBanner />
        <ConnectSoftPromoBanner />
      </ConnectAccountProvider>
    </AuthProvider>
  </MemoryRouter>
);

function renderBanners(user: CurrentUser = admin, disabled = false) {
  return render(banners(user, disabled));
}

beforeEach(() => {
  window.localStorage.clear();
  mockGetSystemStatus.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Connect Plus banners', () => {
  it('shows the compact Dashboard promotion only to an authorized Community admin', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community()));
    renderBanners();

    expect(await screen.findByText('Open ProPR securely from anywhere')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: 'Explore Plus' });
    expect(cta).toHaveAttribute(
      'href',
      'https://connect.propr.dev/dashboard?installation_id=42&focus=billing',
    );
    expect(screen.getByLabelText('ProPR Connect Plus')).toHaveClass('min-w-0');
  });

  it('hides soft promotion for members, Plus, and unknown status', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community()));
    renderBanners(member);
    await waitFor(() => expect(mockGetSystemStatus).toHaveBeenCalled());
    expect(screen.queryByText('Open ProPR securely from anywhere')).not.toBeInTheDocument();
    cleanup();

    mockGetSystemStatus.mockResolvedValue(status(community({ plan: 'plus', hasPlusAccess: true })));
    renderBanners();
    await waitFor(() => expect(mockGetSystemStatus).toHaveBeenCalled());
    expect(screen.queryByText('Open ProPR securely from anywhere')).not.toBeInTheDocument();
    cleanup();

    mockGetSystemStatus.mockResolvedValue(status());
    renderBanners();
    await waitFor(() => expect(mockGetSystemStatus).toHaveBeenCalled());
    expect(screen.queryByText(/Community seats|Open ProPR/)).not.toBeInTheDocument();
  });

  it('never loads or renders account banners when the provider is disabled for demo mode', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community({ activeSeats: 3, seatsRemaining: 0 })));
    renderBanners(admin, true);
    await waitFor(() => expect(mockGetSystemStatus).not.toHaveBeenCalled());
    expect(screen.queryByText(/Community seats|Open ProPR/)).not.toBeInTheDocument();
  });

  it('shows authoritative full capacity globally with an admin upgrade action', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community({
      activeSeats: 5, allowedSeats: 5, seatsRemaining: 0,
    })));
    renderBanners();

    expect(await screen.findByText('Community seats are full — 5 of 5 active')).toBeInTheDocument();
    expect(screen.getByText(/blocked before receiving a seat/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add seats with Plus' })).toHaveAttribute(
      'href',
      'https://connect.propr.dev/dashboard?installation_id=42&focus=billing',
    );
    expect(screen.queryByText('Open ProPR securely from anywhere')).not.toBeInTheDocument();
  });

  it('shows regular developers administrator guidance without a purchase action', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community({
      activeSeats: 3, allowedSeats: 3, seatsRemaining: 0,
    })));
    renderBanners(member);

    expect(await screen.findByText('Ask an instance administrator')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add seats with Plus' })).not.toBeInTheDocument();
  });

  it('surfaces a recent block without inaccurately calling changed capacity full', async () => {
    mockGetSystemStatus.mockResolvedValue(status(community({
      activeSeats: 2,
      allowedSeats: 5,
      seatsRemaining: 3,
      seatLimitBlockedAt: '2026-08-14T09:31:06.000Z',
    })));
    renderBanners();

    expect(await screen.findByText(
      'A developer was blocked by the Community seat limit — 2 of 5 active',
    )).toBeInTheDocument();
    expect(screen.getByText(/reported capacity has since changed/)).toBeInTheDocument();
  });

  it('uses distinct dismissal scopes for installations and authenticated logins', () => {
    expect(connectPlusDismissalKey(42, 'AdminUser')).toBe(connectPlusDismissalKey(42, 'adminuser'));
    expect(connectPlusDismissalKey(42, 'AdminUser')).not.toBe(connectPlusDismissalKey(43, 'AdminUser'));
    expect(connectPlusDismissalKey(42, 'AdminUser')).not.toBe(connectPlusDismissalKey(42, 'developer'));
  });

  it('persists soft dismissal by campaign, installation, and login without suppressing capacity', async () => {
    let current = community();
    mockGetSystemStatus.mockImplementation(async () => status(current));
    renderBanners();
    await screen.findByText('Open ProPR securely from anywhere');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss ProPR Connect notice' }));
    expect(screen.queryByText('Open ProPR securely from anywhere')).not.toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem(connectPlusDismissalKey(42, 'AdminUser')) ?? '{}');
    expect(stored.soft).toBe(true);

    current = community({ activeSeats: 3, seatsRemaining: 0, sentAt: '2026-08-14T09:32:00.000Z' });
    fireEvent.focus(window);
    expect(await screen.findByText('Community seats are full — 3 of 3 active')).toBeInTheDocument();
  });

  it('stores only an opaque capacity digest and keeps the same state dismissed after remount', async () => {
    const current = community({
      activeSeats: 3,
      seatsRemaining: 0,
      billingCycleResetAt: '2026-09-01T00:00:00.000Z',
      seatLimitBlockedAt: '2026-08-14T09:35:00.000Z',
    });
    mockGetSystemStatus.mockResolvedValue(status(current));
    renderBanners();
    await screen.findByText('Community seats are full — 3 of 3 active');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss ProPR Connect notice' }));

    const key = connectPlusDismissalKey(42, 'AdminUser');
    const serialized = window.localStorage.getItem(key) ?? '';
    const stored = JSON.parse(serialized) as { capacity?: unknown[] };
    expect(serialized).not.toContain(current.billingCycleResetAt);
    expect(serialized).not.toContain(current.seatLimitBlockedAt);
    expect(stored.capacity).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);

    cleanup();
    const storageRead = vi.spyOn(Storage.prototype, 'getItem');
    renderBanners();
    await waitFor(() => expect(storageRead).toHaveBeenCalledWith(key));
    expect(screen.queryByText('Community seats are full — 3 of 3 active')).not.toBeInTheDocument();
  });

  it.each([
    ['seat count', { activeSeats: 4, allowedSeats: 4 }],
    ['billing reset timestamp', { billingCycleResetAt: '2026-10-01T00:00:00.000Z' }],
    ['block event timestamp', { seatLimitBlockedAt: '2026-08-14T09:36:00.000Z' }],
  ] as const)('reappears after a relevant %s change', async (_label, change) => {
    let current = community({
      activeSeats: 3,
      seatsRemaining: 0,
      seatLimitBlockedAt: '2026-08-14T09:35:00.000Z',
    });
    mockGetSystemStatus.mockImplementation(async () => status(current));
    renderBanners();
    await screen.findByText('Community seats are full — 3 of 3 active');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss ProPR Connect notice' }));
    expect(screen.queryByText('Community seats are full — 3 of 3 active')).not.toBeInTheDocument();

    current = community({
      activeSeats: 3,
      seatsRemaining: 0,
      seatLimitBlockedAt: '2026-08-14T09:35:00.000Z',
      sentAt: '2026-08-14T09:35:01.000Z',
      ...change,
    });
    fireEvent.focus(window);
    expect(await screen.findByText(/Community seats are full/)).toBeInTheDocument();
  });

  it('does not apply a stale capacity digest to a different authenticated login', async () => {
    const current = community({ activeSeats: 3, seatsRemaining: 0 });
    const adminFingerprint = await capacityFingerprint(current);
    window.localStorage.setItem(
      connectPlusDismissalKey(42, admin.login),
      JSON.stringify({ soft: false, capacity: [adminFingerprint] }),
    );

    const digest = window.crypto.subtle.digest.bind(window.crypto.subtle);
    let releaseFirstDigest: (() => Promise<void>) | undefined;
    const digestSpy = vi.spyOn(window.crypto.subtle, 'digest')
      .mockImplementationOnce((algorithm, data) => new Promise(resolve => {
        releaseFirstDigest = async () => resolve(await digest(algorithm, data));
      }))
      .mockImplementation((algorithm, data) => digest(algorithm, data));
    mockGetSystemStatus.mockResolvedValue(status(current));

    const view = renderBanners(admin);
    await waitFor(() => expect(digestSpy).toHaveBeenCalledTimes(1));
    view.rerender(banners(member));
    expect(await screen.findByText('Ask an instance administrator')).toBeInTheDocument();

    await act(async () => { await releaseFirstDigest?.(); });
    expect(screen.getByText('Ask an instance administrator')).toBeInTheDocument();
  });

  it('keeps rendering and closing when localStorage access fails', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    mockGetSystemStatus.mockResolvedValue(status(community()));
    renderBanners();

    await screen.findByText('Open ProPR securely from anywhere');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss ProPR Connect notice' }));
    expect(screen.queryByText('Open ProPR securely from anywhere')).not.toBeInTheDocument();

    cleanup();
    mockGetSystemStatus.mockResolvedValue(status(community({ activeSeats: 3, seatsRemaining: 0 })));
    renderBanners();
    await screen.findByText('Community seats are full — 3 of 3 active');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss ProPR Connect notice' }));
    expect(screen.queryByText('Community seats are full — 3 of 3 active')).not.toBeInTheDocument();
  });
});
