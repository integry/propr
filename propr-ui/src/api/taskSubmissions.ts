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
/** Attachment bytes and metadata as persisted. Plain ArrayBuffers store in every engine; WebKit aborts File/Blob writes. */
interface StoredAttachment { name: string; type: string; lastModified: number; bytes: ArrayBuffer }
/** Older records hold structured-cloned File objects; newer ones hold StoredAttachment entries. */
interface StoredTaskSnapshot { key: string; payload: TaskRequest; files: Array<StoredAttachment | Blob> }

const encodeSnapshot = async (snapshot: TaskSnapshot): Promise<StoredTaskSnapshot> => ({
  key: snapshot.key, payload: snapshot.payload,
  files: await Promise.all(snapshot.files.map(async file => ({ name: file.name, type: file.type, lastModified: file.lastModified, bytes: await file.arrayBuffer() }))),
});
const decodeSnapshot = (stored: StoredTaskSnapshot): TaskSnapshot => ({
  key: stored.key, payload: stored.payload,
  files: (stored.files || []).map(entry => {
    if (entry instanceof File) return entry;
    if (entry instanceof Blob) return new File([entry], 'attachment', { type: entry.type });
    return new File([entry.bytes], entry.name, { type: entry.type, lastModified: entry.lastModified });
  }),
});

/** IndexedDB may report a failed request with a null transaction.error (WebKit). Always surface a real Error. */
function storageFailure(action: string, cause?: DOMException | Error | null): Error {
  const detail = cause?.message ? ` ${cause.message}` : '';
  return Object.assign(new Error(`Could not ${action} task recovery data in this browser.${detail}`), { cause });
}
const failureOf = (event: Event) => (event.target as IDBRequest | null)?.error;

function openTaskDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open('propr-task-launcher', 1); }
    catch (error) { reject(storageFailure('open', error as Error)); return; }
    request.onupgradeneeded = () => request.result.createObjectStore('submissions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageFailure('open', request.error));
    request.onblocked = () => reject(storageFailure('open', new Error('Close other ProPR tabs and try again.')));
  });
}

/** Persisted files are portable bytes; File objects are rebuilt for callers before and after storage. */
export async function taskSnapshotStorage(scope: string, key?: string, value?: TaskSnapshot | null): Promise<TaskSnapshot | undefined> {
  if (value !== undefined && !key) throw new Error('A submission identity is required');
  const action = value ? 'save' : value === null ? 'remove' : 'read';
  // Read every file before opening a transaction: async work would let it auto-commit.
  let stored: StoredTaskSnapshot | undefined;
  try { stored = value ? await encodeSnapshot(value) : undefined; }
  catch (error) { throw storageFailure('read the attachments for', error as Error); }
  const database = await openTaskDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let failure: DOMException | Error | null | undefined;
      const transaction = database.transaction('submissions', value === undefined && key ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('submissions');
      const identity = key ? JSON.stringify([scope, key]) : scope;
      let request: IDBRequest;
      try { request = value === undefined ? store.get(identity) : value === null ? store.delete(identity) : store.put(stored, identity); }
      catch (error) { transaction.abort(); reject(storageFailure(action, error as Error)); return; }
      // Keep legacy recovery available across concurrent mounts (including
      // StrictMode). Completion removes the legacy copy only for its identity.
      if (!key) request.onsuccess = () => {
        const legacy = request.result as StoredTaskSnapshot | undefined;
        if (!legacy) return;
        // Adoption is best effort; the legacy record stays readable if it fails.
        try { store.put(legacy, JSON.stringify([scope, legacy.key])).onerror = event => event.preventDefault(); } catch { /* Keep the legacy copy. */ }
      };
      if (value === null) {
        const legacy = store.get(scope);
        legacy.onsuccess = () => { if (legacy.result?.key === key) store.delete(scope); };
      }
      transaction.oncomplete = () => resolve(value === undefined && request.result ? decodeSnapshot(request.result as StoredTaskSnapshot) : undefined);
      transaction.onerror = event => { failure ??= failureOf(event); };
      transaction.onabort = () => reject(storageFailure(action, transaction.error || failure));
    });
  } finally { database.close(); }
}

/** Discover retained requests even after the active tab starts another request. */
export async function listTaskSnapshots(scope: string): Promise<TaskSnapshot[]> {
  const database = await openTaskDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let failure: DOMException | Error | null | undefined;
      const transaction = database.transaction('submissions', 'readonly');
      const request = transaction.objectStore('submissions').openCursor();
      const snapshots = new Map<string, StoredTaskSnapshot>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const snapshot = cursor.value as StoredTaskSnapshot;
        if (cursor.key === scope || cursor.key === JSON.stringify([scope, snapshot.key])) snapshots.set(snapshot.key, snapshot);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve([...snapshots.values()].map(decodeSnapshot));
      transaction.onerror = event => { failure ??= failureOf(event); };
      transaction.onabort = () => reject(storageFailure('read', transaction.error || failure));
    });
  } finally { database.close(); }
}
