import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export class DesktopPairingUnavailableError extends Error {}

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
  try {
    await handleApiResponse(response);
  } catch (error) {
    if (response.status === 404 || response.status === 410 || response.status === 409) {
      // This endpoint uses 409 when another client has already consumed the request.
      throw new DesktopPairingUnavailableError('Pairing request can no longer be approved');
    }
    throw error;
  }
  return response.json() as Promise<DesktopPairingApproval>;
}
