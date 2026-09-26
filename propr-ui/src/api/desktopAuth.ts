import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export interface DesktopPairingApproval {
  pairingId: string;
  clientName: string;
  status: 'pending' | 'approved' | 'consumed';
  createdAt: string;
  expiresAt: string;
}

const pairingPath = (pairingId: string): string =>
  `${API_BASE_URL}/api/desktop/pairings/${encodeURIComponent(pairingId)}`;

export async function getDesktopPairingApproval(pairingId: string): Promise<DesktopPairingApproval> {
  const response = await apiFetch(`${pairingPath(pairingId)}/approval`, {
    credentials: 'include',
    cache: 'no-store',
  });
  await handleApiResponse(response);
  return response.json() as Promise<DesktopPairingApproval>;
}

export async function approveDesktopPairing(pairingId: string): Promise<DesktopPairingApproval> {
  const response = await apiFetch(`${pairingPath(pairingId)}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await handleApiResponse(response);
  return response.json() as Promise<DesktopPairingApproval>;
}
