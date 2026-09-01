import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DesktopPairingPage from './DesktopPairingPage';
import { approveDesktopPairing, getDesktopPairingApproval } from '../api/desktopAuth';

vi.mock('../api/desktopAuth', () => ({
  approveDesktopPairing: vi.fn(),
  getDesktopPairingApproval: vi.fn(),
}));

const pairingId = `dpr_${'A'.repeat(22)}`;
const pending = {
  pairingId,
  clientName: 'Alice’s MacBook',
  status: 'pending' as const,
  createdAt: '2026-08-29T14:00:00.000Z',
  expiresAt: '2026-08-29T14:10:00.000Z',
};

describe('DesktopPairingPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the server-provided client name and requires an explicit approval click', async () => {
    vi.mocked(getDesktopPairingApproval).mockResolvedValue(pending);
    vi.mocked(approveDesktopPairing).mockResolvedValue({ ...pending, status: 'approved' });
    render(
      <MemoryRouter initialEntries={[`/desktop/pairing?pairing_id=${pairingId}`]}>
        <DesktopPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Alice’s MacBook')).toBeInTheDocument();
    expect(approveDesktopPairing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve desktop' }));

    await waitFor(() => expect(approveDesktopPairing).toHaveBeenCalledWith(pairingId));
    expect(await screen.findByText('Desktop paired')).toBeInTheDocument();
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
