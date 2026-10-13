import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DesktopPairingPage from './DesktopPairingPage';
import { AuthProvider } from '../contexts/AuthContext';
import { approveDesktopPairing, getDesktopPairingApproval, DesktopPairingUnavailableError } from '../api/desktopAuth';

vi.mock('../api/desktopAuth', async importOriginal => ({
  ...await importOriginal<typeof import('../api/desktopAuth')>(),
  approveDesktopPairing: vi.fn(),
  getDesktopPairingApproval: vi.fn(),
}));

const pairingId = `dpr_${'A'.repeat(22)}`;
const pending = {
  pairingId,
  clientName: 'Alice’s MacBook',
  status: 'pending' as const,
  createdAt: '2026-08-29T14:00:00.000Z',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe('DesktopPairingPage', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('shows the server-provided client name and requires an explicit approval click', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    vi.mocked(approveDesktopPairing).mockResolvedValue({ ...pending, status: 'approved' });
    render(
      <MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}>
        <AuthProvider user={{ id: '101', login: 'alice', username: 'alice', displayName: 'Alice', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' }}>
          <DesktopPairingPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Alice’s MacBook')).toBeInTheDocument();
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change GitHub account' })).toBeInTheDocument();
    expect(screen.getByText(/Desktop will ask you to confirm/)).toBeInTheDocument();
    expect(approveDesktopPairing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve desktop' }));

    await waitFor(() => expect(approveDesktopPairing).toHaveBeenCalledWith(pairingId));
    expect(await screen.findByText('Desktop paired')).toBeInTheDocument();
  });

  const renderPending = () => render(
    <MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}>
      <AuthProvider user={{ id: '101', login: 'alice', username: 'alice', displayName: 'Alice', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' }}>
        <DesktopPairingPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  it('hides approval while changing account and preserves the exact request after logout', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, type: 'opaqueredirect', status: 0 });
    vi.stubGlobal('fetch', fetchMock);
    renderPending();
    fireEvent.click(await screen.findByRole('button', { name: 'Change GitHub account' }));
    expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub sign out' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/ProPR Connect shows the wrong account/)).toBeInTheDocument();
    // Replace only the navigation surface, avoiding jsdom's unsupported reload.
    const location = { href: '', hostname: 'localhost', search: '', pathname: '/desktop/pairing' };
    vi.stubGlobal('window', { location, document, setTimeout, clearTimeout });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' }));
    await waitFor(() => expect(location.href).toContain('/login?logged_out=true'));
    expect(new URL(location.href, 'http://localhost').searchParams.get('redirect_to')).toBe(`/desktop/pairing?pairing_id=${pairingId}`);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/logout'), { credentials: 'include', redirect: 'manual' });
    expect(approveDesktopPairing).not.toHaveBeenCalled();
  });

  it('keeps approval hidden and allows retry if logout fails', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    renderPending();
    fireEvent.click(await screen.findByRole('button', { name: 'Change GitHub account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out');
    expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep current account' }));
    expect(screen.getByRole('button', { name: 'Approve desktop' })).toBeInTheDocument();
    expect(approveDesktopPairing).not.toHaveBeenCalled();
  });

  it('offers unauthenticated users sign-in for the same request without fetching or approving', () => {
    render(<MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}><DesktopPairingPage /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Sign in to review this pairing request' });
    expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('redirect_to')).toBe(`/desktop/pairing?pairing_id=${pairingId}`);
    expect(getDesktopPairingApproval).not.toHaveBeenCalled();
    expect(approveDesktopPairing).not.toHaveBeenCalled();
  });

  it('cancels in the current tab without approving', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    renderPending();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Pairing cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
    expect(approveDesktopPairing).not.toHaveBeenCalled();
  });

  it('requires a fresh desktop request when the old request has expired', async () => {
    vi.mocked(getDesktopPairingApproval).mockRejectedValue(new Error('Expired'));
    renderPending();
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
    expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change GitHub account' })).not.toBeInTheDocument();
  });

  it('removes approval and account switching after an approval-time expiry rejection', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    vi.mocked(approveDesktopPairing).mockRejectedValue(new DesktopPairingUnavailableError('Pairing request was not found or has expired'));
    renderPending();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve desktop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
    expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change GitHub account' })).not.toBeInTheDocument();
    expect(approveDesktopPairing).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a transient approval failure while the request is still pending', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    vi.mocked(approveDesktopPairing).mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce({ ...pending, status: 'approved' });
    renderPending();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve desktop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be approved/);
    expect(screen.getByRole('button', { name: 'Change GitHub account' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve desktop' }));
    expect(await screen.findByText('Desktop paired')).toBeInTheDocument();
    expect(approveDesktopPairing).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed URL identifiers without making an API request', () => {
    render(
      <MemoryRouter initialEntries={['/desktop/pairing?pairing_id=../../secrets']}>
        <DesktopPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/invalid/i);
    expect(getDesktopPairingApproval).not.toHaveBeenCalled();
  });
});
