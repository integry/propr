import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
export interface TaskSubmission {
  id: string;
  state: 'prepared' | 'creating' | 'issue_created' | 'queued' | 'failed';
  issueNumber: number | null;
  issueUrl: string | null;
  taskId: string | null;
  error: string | null;
}
export interface TaskRequest {
  repository: string;
  instruction: string;
  agentAlias?: string;
  model?: string;
  todoIds?: string[];
}
async function request(path: string, options?: RequestInit): Promise<TaskSubmission> {
  const response = await apiFetch(`${API_BASE_URL}/api/task-submissions${path}`, { credentials: 'include', ...options });
  try { await handleApiResponse(response); }
  catch (error) { throw Object.assign(error as Error, { status: response.status }); }
  return response.json();
}
export async function submitTask(key: string, payload: TaskRequest, files: File[]): Promise<TaskSubmission> {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  files.forEach(file => form.append('files', file));
  return request('', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form });
}
export const getTaskSubmission = (key: string) => request(`/${encodeURIComponent(key)}`);
export const retryTaskSubmission = (key: string) => request(`/${encodeURIComponent(key)}/retry`, { method: 'POST' });

export interface TaskSnapshot { key: string; payload: TaskRequest; files: File[] }
/** Structured cloning preserves File bytes for lost-response/reload recovery. */
export async function taskSnapshotStorage(scope: string, key?: string, value?: TaskSnapshot | null): Promise<TaskSnapshot | undefined> {
  if (value !== undefined && !key) throw new Error('A submission identity is required');
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('propr-task-launcher', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('submissions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('submissions', value === undefined && key ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('submissions');
      const identity = key ? JSON.stringify([scope, key]) : scope;
      const request = value === undefined ? store.get(identity) : value === null ? store.delete(identity) : store.put(value, identity);
      // Keep legacy recovery available across concurrent mounts (including
      // StrictMode). Completion removes the legacy copy only for its identity.
      if (!key) request.onsuccess = () => {
        const legacy = request.result as TaskSnapshot | undefined;
        if (legacy) store.put(legacy, JSON.stringify([scope, legacy.key]));
      };
      if (value === null) {
        const legacy = store.get(scope);
        legacy.onsuccess = () => { if (legacy.result?.key === key) store.delete(scope); };
      }
      transaction.oncomplete = () => resolve(value === undefined ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Could not save task recovery data'));
    });
  } finally { database.close(); }
}

/** Discover retained requests even after the active tab starts another request. */
export async function listTaskSnapshots(scope: string): Promise<TaskSnapshot[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('propr-task-launcher', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('submissions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('submissions', 'readonly');
      const request = transaction.objectStore('submissions').openCursor();
      const snapshots = new Map<string, TaskSnapshot>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const snapshot = cursor.value as TaskSnapshot;
        if (cursor.key === scope || cursor.key === JSON.stringify([scope, snapshot.key])) snapshots.set(snapshot.key, snapshot);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve([...snapshots.values()]);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Could not read task recovery data'));
    });
  } finally { database.close(); }
}
