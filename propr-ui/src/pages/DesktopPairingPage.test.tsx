import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import DesktopPairingPage from './DesktopPairingPage';
import { AuthProvider } from '../contexts/AuthContext';
import { approveDesktopPairing, getDesktopPairingApproval, DesktopPairingUnavailableError } from '../api/desktopAuth';

vi.mock('../api/desktopAuth', async importOriginal => ({
  ...await importOriginal<typeof import('../api/desktopAuth')>(),
  approveDesktopPairing: vi.fn(),
  getDesktopPairingApproval: vi.fn(),
}));

const pairingId = `dpr_${'A'.repeat(22)}`;
const nextPairingId = `dpr_${'B'.repeat(22)}`;
const PairingNavigation = () => {
  const navigate = useNavigate();
  return <>
    <button onClick={() => void navigate(`/desktop/pairing?pairing_id=${nextPairingId}`)}>Review next request</button>
    <button onClick={() => void navigate(-1)}>Review previous request</button>
  </>;
};
const pending = {
  pairingId,
  clientName: 'Alice’s MacBook',
  status: 'pending' as const,
  createdAt: '2026-08-29T14:00:00.000Z',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe('DesktopPairingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(approveDesktopPairing).mockReset();
    vi.mocked(getDesktopPairingApproval).mockReset();
  });
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

  for (const status of ['approved', 'consumed'] as const) {
    it(`clears local expiry feedback when a delayed current approval returns ${status}`, async () => {
      vi.useFakeTimers();
      try {
        const request = { ...pending, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        vi.mocked(getDesktopPairingApproval).mockResolvedValue(request);
        let finishApproval!: (value: Awaited<ReturnType<typeof approveDesktopPairing>>) => void;
        vi.mocked(approveDesktopPairing).mockImplementation(() => new Promise(resolve => { finishApproval = resolve; }));
        renderPending();
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: 'Approve desktop' }));
        expect(approveDesktopPairing).toHaveBeenCalledWith(pairingId);
        await act(async () => { vi.advanceTimersByTime(60_001); });
        expect(screen.getByRole('alert')).toHaveTextContent(/expired/);
        expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();

        await act(async () => { finishApproval({ ...request, status }); });
        expect(screen.getByRole('heading', { name: 'Desktop paired' })).toBeInTheDocument();
        expect(screen.getByText(/Return to the ProPR desktop app/)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Approve desktop' })).not.toBeInTheDocument();
        expect(approveDesktopPairing).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  }

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

  for (const change of ['pairing', 'identity', 'unmount'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores delayed logout ${outcome} after ${change} changes`, async () => {
        vi.mocked(getDesktopPairingApproval).mockImplementation(async id => ({ ...pending, pairingId: id }));
        let finishLogout!: (response: { ok: boolean; status: number }) => void;
        let finishCurrentLogout!: (response: { ok: boolean; status: number }) => void;
        const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishLogout = resolve; }))
          .mockImplementationOnce(() => new Promise(resolve => { finishCurrentLogout = resolve; }));
        vi.stubGlobal('fetch', fetchMock);
        const flow = (id: string) => (
          <MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}>
            <AuthProvider user={{ id, login: 'alice', username: 'alice', displayName: 'Alice', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' }}>
              <PairingNavigation />
              <DesktopPairingPage />
            </AuthProvider>
          </MemoryRouter>
        );
        const view = render(flow('101'));
        fireEvent.click(await screen.findByRole('button', { name: 'Change GitHub account' }));
        const location = { href: '', hostname: 'localhost', search: '', pathname: '/desktop/pairing' };
        vi.stubGlobal('window', { location, document, setTimeout, clearTimeout });
        fireEvent.click(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' }));
        expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();

        if (change === 'pairing') fireEvent.click(screen.getByRole('button', { name: 'Review next request' }));
        else if (change === 'identity') view.rerender(flow('202'));
        else view.unmount();
        if (change !== 'unmount') {
          expect(await screen.findByRole('button', { name: 'Approve desktop' })).toBeEnabled();
          fireEvent.click(screen.getByRole('button', { name: 'Change GitHub account' }));
          expect(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' })).toBeEnabled();
          // A newer operation can start without waiting for the obsolete fetch.
          fireEvent.click(screen.getByRole('button', { name: 'Sign out of ProPR and sign in again' }));
        }

        await act(async () => { finishLogout({ ok: outcome === 'success', status: outcome === 'success' ? 200 : 500 }); });
        expect(location.href).toBe('');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(approveDesktopPairing).not.toHaveBeenCalled();
        if (change !== 'unmount') {
          expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
          await act(async () => { finishCurrentLogout({ ok: true, status: 200 }); });
          const currentId = change === 'pairing' ? nextPairingId : pairingId;
          await waitFor(() => expect(location.href).toContain('/login?logged_out=true'));
          expect(new URL(location.href, 'http://localhost').searchParams.get('redirect_to')).toBe(`/desktop/pairing?pairing_id=${currentId}`);
          expect(fetchMock).toHaveBeenCalledTimes(2);
        }
      });
    }
  }

  for (const change of ['pairing', 'identity', 'pairing-return', 'identity-return', 'unmount'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores delayed approval ${outcome} after ${change} changes, including its busy cleanup`, async () => {
        vi.mocked(getDesktopPairingApproval).mockImplementation(async id => ({ ...pending, pairingId: id, clientName: id }));
        let resolveOld!: (value: Awaited<ReturnType<typeof approveDesktopPairing>>) => void;
        let rejectOld!: (error: Error) => void;
        let resolveCurrent!: (value: Awaited<ReturnType<typeof approveDesktopPairing>>) => void;
        vi.mocked(approveDesktopPairing)
          .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
          .mockImplementationOnce(() => new Promise(resolve => { resolveCurrent = resolve; }));
        const flow = (id: string) => (
          <MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}>
            <AuthProvider user={{ id, login: `user${id}`, username: `user${id}`, displayName: 'User', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' }}>
              <PairingNavigation />
              <DesktopPairingPage />
            </AuthProvider>
          </MemoryRouter>
        );
        const view = render(flow('101'));
        fireEvent.click(await screen.findByRole('button', { name: 'Approve desktop' }));
        expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled();
        expect(approveDesktopPairing).toHaveBeenNthCalledWith(1, pairingId);
        if (change === 'pairing' || change === 'pairing-return') {
          fireEvent.click(screen.getByRole('button', { name: 'Review next request' }));
          if (change === 'pairing-return') {
            expect(await screen.findByText(nextPairingId)).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Review previous request' }));
          }
        } else if (change === 'identity' || change === 'identity-return') {
          view.rerender(flow('202'));
          if (change === 'identity-return') {
            expect(await screen.findByText('@user202')).toBeInTheDocument();
            view.rerender(flow('101'));
          }
        } else view.unmount();
        const currentId = change === 'pairing' ? nextPairingId : pairingId;
        if (change !== 'unmount') {
          expect(await screen.findByText(currentId)).toBeInTheDocument();
          if (change === 'identity') expect(screen.getByText('@user202')).toBeInTheDocument();
          expect(screen.getByRole('button', { name: 'Approve desktop' })).toBeEnabled();
          expect(approveDesktopPairing).toHaveBeenCalledTimes(1);
          fireEvent.click(screen.getByRole('button', { name: 'Approve desktop' }));
          expect(approveDesktopPairing).toHaveBeenNthCalledWith(2, currentId);
        }
        await act(async () => {
          if (outcome === 'success') resolveOld({ ...pending, status: 'approved' });
          else rejectOld(new DesktopPairingUnavailableError('Expired'));
        });
        expect(screen.queryByText('Desktop paired')).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        if (change !== 'unmount') {
          expect(screen.getByText(currentId)).toBeInTheDocument();
          expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled();
          expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
          await act(async () => { resolveCurrent({ ...pending, pairingId: currentId, status: 'approved' }); });
          expect(screen.getByText('Desktop paired')).toBeInTheDocument();
          expect(approveDesktopPairing).toHaveBeenCalledTimes(2);
        }
      });
    }
  }

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
