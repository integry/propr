import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import LoginPage from './LoginPage';
import { getCurrentUser } from '../api/proprApi';
import type { CurrentUser } from '../api/proprTypes';

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false, isLoading: false }) }));
vi.mock('../api/proprApi', () => ({ API_BASE_URL: '', getCurrentUser: vi.fn() }));

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const existingUser: CurrentUser = {
  id: '100', login: 'owner', username: 'owner', displayName: 'Owner', email: null, avatarUrl: null,
  role: 'admin', permissions: [], authorizationSource: 'local',
};

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
};

const renderLogin = (entry: string) => render(
  <MemoryRouter initialEntries={[entry]}>
    <LocationProbe />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<div>dashboard</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('LoginPage OAuth failure reporting', () => {
  beforeEach(() => mockGetCurrentUser.mockReset());

  it('keeps a failed OAuth renewal visible instead of returning to an older session', async () => {
    mockGetCurrentUser.mockResolvedValue(existingUser);

    renderLogin('/login?error=oauth_state_mismatch');

    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub sign-in did not complete');
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login?error=oauth_state_mismatch');
  });

  it('renders generic copy for an unknown login error code', async () => {
    renderLogin('/login?error=%3Cinjected%3E');

    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub sign-in did not complete. Try again.');
    expect(screen.queryByText('<injected>')).not.toBeInTheDocument();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'renders generic copy and a usable sign-in button for inherited property code %s',
    async (code) => {
      renderLogin(`/login?error=${code}`);

      expect(await screen.findByRole('alert')).toHaveTextContent('GitHub sign-in did not complete. Try again.');
      expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    },
  );
});
