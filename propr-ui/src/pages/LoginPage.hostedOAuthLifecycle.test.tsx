import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../api/proprApi';
import LoginPage from './LoginPage';
import type { CurrentUser } from '../api/proprTypes';

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock('../contexts/DemoModeContext', () => ({
  useDemoMode: () => ({ isDemoMode: false, isLoading: false }),
}));

vi.mock('../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/runtimeConfig')>();
  return {
    ...actual,
    getApiBaseUrl: vi.fn(() => 'https://t-lifecycle.propr.dev'),
    isHostedUiOrigin: vi.fn(() => true),
    pathWithActiveHostedTunnelFlow: vi.fn((path: string) => path),
  };
});

vi.mock('../api/proprApi', () => ({
  API_BASE_URL: '',
  getCurrentUser: vi.fn(),
}));

const mockGetCurrentUser = vi.mocked(getCurrentUser);

const authenticatedUser: CurrentUser = {
  id: '100',
  login: 'owner',
  username: 'owner',
  displayName: 'Owner',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: [],
  authorizationSource: 'local',
};

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
};

const renderHostedLogin = () =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/plans' } }]}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/plans" element={<div>plans page</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('LoginPage hosted OAuth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('performs one final parent session check after observing popup close and completes on success', async () => {
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockResolvedValueOnce(authenticatedUser);
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    renderHostedLogin();
    const loginButton = await screen.findByRole('button', { name: 'Sign in with GitHub' });
    vi.useFakeTimers();
    fireEvent.click(loginButton);

    Object.defineProperty(popup, 'closed', { value: true, configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
    expect(screen.queryByText(/closed before login completed/i)).not.toBeInTheDocument();
  });

  it('times out by closing the popup, clearing timers, restoring the button, and ignoring late auth', async () => {
    let resolvePendingUser: (user: CurrentUser) => void = () => {};
    const pendingUser = new Promise<CurrentUser>((resolve) => {
      resolvePendingUser = resolve;
    });
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockImplementation(() => pendingUser);
    const popup = { closed: false, close: vi.fn(function close(this: { closed: boolean }) { this.closed = true; }) } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    renderHostedLogin();
    const loginButton = await screen.findByRole('button', { name: 'Sign in with GitHub' });
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    fireEvent.click(loginButton);
    expect(screen.getByRole('button', { name: 'Waiting for GitHub...' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    });

    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('GitHub sign-in timed out. Try again and finish the popup sign-in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).not.toBeDisabled();

    await act(async () => {
      resolvePendingUser(authenticatedUser);
      await pendingUser;
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/login');
    expect(screen.queryByText('plans page')).not.toBeInTheDocument();
  });
});
