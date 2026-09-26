import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { getCurrentUser } from '../api/proprApi';
import { AuthProvider } from '../contexts/AuthContext';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import LoginPage from './LoginPage';

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({
  useDemoMode: () => ({ isDemoMode: false, isLoading: false }),
}));
vi.mock('../api/proprApi', () => ({ getCurrentUser: vi.fn() }));

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
};

describe('LoginPage desktop authentication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refreshes shared authentication state and resumes the return path after completion', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('Authentication required'));
    let completeAuthentication: (() => void) | undefined;
    const authenticate = vi.fn(() => new Promise<void>(resolve => {
      completeAuthentication = resolve;
    }));
    const refreshCurrentUser = vi.fn(async () => undefined);
    const desktop: DesktopContextValue = {
      isDesktop: true,
      platform: 'linux',
      profile: { id: 'local', name: 'This computer', baseUrl: 'http://127.0.0.1:3000', kind: 'local' },
      connection: { status: 'ready' },
      openProfileManager: vi.fn(),
      authenticate,
      openConnectionHelp: vi.fn(async () => undefined),
      retry: vi.fn(),
    };

    render(
      <AuthProvider user={null} refreshUser={refreshCurrentUser}>
        <DesktopContext.Provider value={desktop}>
          <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/plans' } }]}>
            <LocationProbe />
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/plans" element={<div>plans page</div>} />
            </Routes>
          </MemoryRouter>
        </DesktopContext.Provider>
      </AuthProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(screen.getByRole('button', { name: 'Waiting for GitHub...' })).toBeDisabled();
    expect(refreshCurrentUser).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');

    await act(async () => completeAuthentication?.());

    await waitFor(() => expect(refreshCurrentUser).toHaveBeenCalledOnce());
    expect(await screen.findByText('plans page')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
  });
});
