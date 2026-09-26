import { parseManagedPreviewStorageStatus, type ManagedPreviewStorageStatus } from '@propr/shared';
import { API_BASE_URL, apiFetch } from './apiClient';

export async function getManagedPreviewStorageStatus(): Promise<ManagedPreviewStorageStatus> {
  try {
    const response = await apiFetch(`${API_BASE_URL}/api/config/preview-storage`, { credentials: 'include' });
    if (response.ok) {
      const status = parseManagedPreviewStorageStatus(await response.json());
      if (status) return status;
    }
  } catch { /* An optional service must not hide GitHub upload settings. */ }
  return { version: 1, state: 'unavailable', enabled: false, effective: null };
}
