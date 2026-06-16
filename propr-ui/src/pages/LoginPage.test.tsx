import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom';
import LoginPage from './LoginPage';
import { getCurrentUser } from '../api/proprApi';

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

const demoState = { isDemoMode: false, isLoading: false };
vi.mock('../contexts/DemoModeContext', () => ({
  useDemoMode: () => demoState,
}));

vi.mock('../api/proprApi', () => ({
  API_BASE_URL: '',
  getCurrentUser: vi.fn(),
}));

const mockGetCurrentUser = vi.mocked(getCurrentUser);

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
};

const renderLogin = (entry: InitialEntry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/plans" element={<div>plans page</div>} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('LoginPage session recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    demoState.isDemoMode = false;
    demoState.isLoading = false;
  });

  it('redirects to the previous page when /api/auth/user succeeds', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin({ pathname: '/login', state: { from: '/plans' } });

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
  });

  it('falls back to the dashboard for an external redirect_to query param', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin('/login?redirect_to=https%3A%2F%2Fevil.example');

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('falls back to the dashboard for a protocol-relative redirect_to query param', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin('/login?redirect_to=%2F%2Fevil.example');

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('falls back to the dashboard for an external router state return path', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin({ pathname: '/login', state: { from: 'https://evil.example' } });

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('uses object-shaped router state with pathname, search, and hash', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin({
      pathname: '/login',
      state: { from: { pathname: '/plans', search: '?tab=active', hash: '#details' } },
    });

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/plans?tab=active#details');
  });

  it('falls back to the dashboard for return paths containing backslashes', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin({ pathname: '/login', state: { from: '/plans\\evil' } });

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('keeps the login button visible when the auth check fails', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('Authentication required'));

    renderLogin('/login');

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
    });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('skips the session recovery check after an explicit logout', async () => {
    mockGetCurrentUser.mockResolvedValue({});

    renderLogin('/login?logged_out=true');

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
    });
    expect(screen.getByText('You have been successfully logged out.')).toBeInTheDocument();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('shows an accessible status indicator while checking the current session', () => {
    demoState.isLoading = true;

    renderLogin('/login');

    expect(screen.getByRole('status', { name: 'Checking session' })).toBeInTheDocument();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });
});
