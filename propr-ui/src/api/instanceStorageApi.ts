import { API_BASE_URL, apiFetch } from './apiClient';
import { STORAGE_CONFIRMATION_INVALID_CODE, STORAGE_INSTANCE_CHANGED_CODE } from '@propr/shared';
import type { DatabaseExportStatus, RepositoryStorageInventory, StorageCapabilities, StorageCleanupPreview, StorageCleanupResult, StorageErrorBody } from '@propr/shared';

const base = () => `${API_BASE_URL}/api/instance/storage/v1`;
/** A retryable failure that carries no authority change: keep the known export job. */
export class StorageTransientError extends Error {}
/** The server no longer holds this export job: discard it, but keep instance authority. */
export class StorageExportGoneError extends Error {}
/** The cleanup confirmation expired or was consumed: discard the preview, but keep instance authority. */
export class StorageConfirmationError extends Error {}
async function storageFetch(url: string, init: RequestInit): Promise<Response> {
  try { return await apiFetch(url, init); }
  catch (error) {
    // Network failure only; desktop scope changes and aborts stay authority-bearing.
    if (error instanceof TypeError) throw new StorageTransientError('Storage service unreachable. Check the connection and try again.');
    throw error;
  }
}
async function serverError(response: Response): Promise<{ message?: string; code?: StorageErrorBody['code'] }> {
  try {
    const body: Partial<StorageErrorBody> | null = await response.json();
    const code = body?.code === STORAGE_INSTANCE_CHANGED_CODE || body?.code === STORAGE_CONFIRMATION_INVALID_CODE ? body.code : undefined;
    return { message: typeof body?.error === 'string' ? body.error : undefined, code };
  } catch { return {}; }
}
async function failure(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403) return new Error('Current instance administrator access is required.');
  if (response.status === 404) return new Error('This runtime does not support instance storage management.');
  if (response.status === 410) return new StorageExportGoneError('This export is no longer available. Create a new export.');
  const { message, code } = await serverError(response);
  // The structured code, not the display text, carries the authority change.
  if (response.status === 409 && code === STORAGE_INSTANCE_CHANGED_CODE) return new Error('Instance selection changed. Refresh before continuing.');
  if (response.status === 409 && code === STORAGE_CONFIRMATION_INVALID_CODE) return new StorageConfirmationError(`${message || 'Confirmation unavailable'}. Preview cleanup again.`);
  // Server contract messages are sanitized: no paths, credentials or snapshot contents.
  if (response.status === 409) return new StorageTransientError(message || 'Storage is busy. Try again shortly.');
  if (response.status === 408 || response.status === 429 || response.status >= 500) return new StorageTransientError('Storage operation temporarily unavailable. Try again.');
  return new Error('Storage operation unavailable or expired. Refresh and try again.');
}
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await storageFetch(base() + route, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}
export const storageCapabilities = () => request<StorageCapabilities>('/capabilities');
export const storageInventory = () => request<RepositoryStorageInventory>('/repositories');
export const storagePreview = (instanceId: string) => request<StorageCleanupPreview>('/cleanup/preview', { instanceId, categories: ['repository_caches'] });
export const storageExecute = (preview: StorageCleanupPreview) => request<StorageCleanupResult>('/cleanup/execute', { instanceId: preview.instanceId, confirmation: preview.confirmation });
export const startDatabaseExport = (capabilities: StorageCapabilities) => request<DatabaseExportStatus>('/exports', { instanceId: capabilities.instanceId, generation: capabilities.generation });
export const databaseExportStatus = (job: DatabaseExportStatus) => request<DatabaseExportStatus>(`/exports/${encodeURIComponent(job.operationId)}?${new URLSearchParams({ instanceId: job.instanceId, generation: job.generation })}`);
export const cancelDatabaseExport = (job: DatabaseExportStatus) => request(`/exports/${encodeURIComponent(job.operationId)}/cancel`, { instanceId: job.instanceId, generation: job.generation });
export async function downloadDatabaseExport(job: DatabaseExportStatus): Promise<Blob> {
  const response = await storageFetch(base() + `/exports/${encodeURIComponent(job.operationId)}/download`, {
    method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' },
    body: JSON.stringify({ instanceId: job.instanceId, generation: job.generation }),
  });
  if (!response.ok) {
    const error = await failure(response);
    // A transient failure (5xx, 408/429, busy 409, network) may precede redemption: keep the job.
    // Retrying is safe: a consumed redemption is refused with a definitive 410.
    if (error instanceof StorageTransientError || response.status === 401 || response.status === 403 || response.status === 409) throw error;
    throw new StorageExportGoneError('Download denied, expired or already used. Create a new export.');
  }
  // A body failure after a successful response means the one-shot redemption was consumed.
  try { return await response.blob(); }
  catch (error) {
    // Desktop scope changes and aborts stay authority-bearing.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new StorageExportGoneError('Download interrupted after the one-shot export was consumed. Create a new export.');
  }
}
/** Detect a changed browser account before displaying or redeeming sensitive results. */
export async function verifyStorageActor(actor: string) {
  const response = await storageFetch(`${API_BASE_URL}/api/auth/user`, { credentials: 'include', cache: 'no-store' });
  if (response.status >= 500) throw new StorageTransientError('Account verification temporarily unavailable. Try again.');
  if (!response.ok) throw new Error('Current instance administrator access is required.');
  const user = await response.json();
  if (user.id !== actor || user.role !== 'admin' || !user.permissions?.includes('instance.manage_settings')) throw new Error('Account or instance authority changed. Reload Settings.');
}
