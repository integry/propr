import { describe, it, expect, vi, afterEach } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./apiClient', () => ({ API_BASE_URL: 'https://example.test', apiFetch }));
import { STORAGE_CONFIRMATION_INVALID_CODE, STORAGE_INSTANCE_CHANGED_CODE } from '@propr/shared';
import { StorageConfirmationError, StorageExportGoneError, StorageTransientError, databaseExportStatus, downloadDatabaseExport, startDatabaseExport, storageExecute, storagePreview, verifyStorageActor } from './instanceStorageApi';

const job = { version: 1 as const, instanceId: 'instance', generation: 'generation', operationId: 'job', scope: 'customer_database' as const, state: 'running' as const, expiresAt: new Date().toISOString() };
const capabilities = { version: 1 as const, instanceId: 'instance', generation: 'generation', features: ['database_export' as const] };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error as Error; } throw new Error('expected failure'); };

describe('instance storage error classification', () => {
  afterEach(() => apiFetch.mockReset());
  it('treats 503, 5xx, 429 and network failures as transient', async () => {
    for (const status of [503, 500, 502, 429]) {
      apiFetch.mockResolvedValueOnce(reply(status, { error: 'Storage operation unavailable; data retained' }));
      expect(await failure(() => databaseExportStatus(job))).toBeInstanceOf(StorageTransientError);
    }
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await failure(() => databaseExportStatus(job))).toBeInstanceOf(StorageTransientError);
  });
  it('surfaces a sanitized 409 lock state as transient, but an instance change as authority-bearing', async () => {
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Another database export is in progress. Wait for it to finish or expire, then try again.' }));
    const busy = await failure(() => startDatabaseExport(capabilities));
    expect(busy).toBeInstanceOf(StorageTransientError);
    expect(busy.message).toMatch(/in progress/);
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Instance selection changed', code: STORAGE_INSTANCE_CHANGED_CODE }));
    const changed = await failure(() => startDatabaseExport(capabilities));
    expect(changed).not.toBeInstanceOf(StorageTransientError);
    expect(changed.message).toMatch(/Instance selection changed/);
  });
  it('classifies an instance change by structured code, not display text', async () => {
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Reworded instance message', code: STORAGE_INSTANCE_CHANGED_CODE }));
    const changed = await failure(() => storagePreview('instance'));
    expect(changed).not.toBeInstanceOf(StorageTransientError);
    expect(changed.message).toMatch(/Instance selection changed/);
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Instance selection changed', code: 'something_else' }));
    expect(await failure(() => startDatabaseExport(capabilities))).toBeInstanceOf(StorageTransientError);
  });
  it('classifies dead cleanup confirmations and generation changes by structured code', async () => {
    const preview = { version: 1 as const, instanceId: 'instance', confirmation: 'confirmation', expiresAt: new Date().toISOString(), categories: ['repository_caches' as const], candidates: [], impact: '' };
    for (const error of ['Confirmation expired', 'Confirmation unavailable or consumed']) {
      apiFetch.mockResolvedValueOnce(reply(409, { error, code: STORAGE_CONFIRMATION_INVALID_CODE }));
      const dead = await failure(() => storageExecute(preview));
      expect(dead).toBeInstanceOf(StorageConfirmationError); expect(dead.message).toMatch(error);
    }
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Instance generation changed', code: STORAGE_INSTANCE_CHANGED_CODE }));
    const changed = await failure(() => storageExecute(preview));
    expect(changed).not.toBeInstanceOf(StorageTransientError); expect(changed).not.toBeInstanceOf(StorageConfirmationError);
    expect(changed.message).toMatch(/Instance selection changed/);
  });
  it('treats 401/403, 404 and desktop scope aborts as authority-bearing', async () => {
    for (const status of [401, 403, 404]) {
      apiFetch.mockResolvedValueOnce(reply(status));
      const error = await failure(() => databaseExportStatus(job));
      expect(error).not.toBeInstanceOf(StorageTransientError); expect(error).not.toBeInstanceOf(StorageExportGoneError);
    }
    apiFetch.mockRejectedValueOnce(new DOMException('Desktop connection changed', 'AbortError'));
    expect(await failure(() => databaseExportStatus(job))).not.toBeInstanceOf(StorageTransientError);
  });
  it('treats 410 and a refused one-shot download as a gone job', async () => {
    apiFetch.mockResolvedValueOnce(reply(410));
    expect(await failure(() => databaseExportStatus(job))).toBeInstanceOf(StorageExportGoneError);
    for (const status of [410, 404, 400]) {
      apiFetch.mockResolvedValueOnce(reply(status));
      expect(await failure(() => downloadDatabaseExport(job))).toBeInstanceOf(StorageExportGoneError);
    }
    apiFetch.mockResolvedValueOnce(reply(403));
    expect(await failure(() => downloadDatabaseExport(job))).not.toBeInstanceOf(StorageExportGoneError);
  });
  it('keeps a possibly-unredeemed download retryable on transient failure', async () => {
    for (const status of [503, 502, 429, 408]) {
      apiFetch.mockResolvedValueOnce(reply(status, { error: 'Storage operation unavailable; data retained' }));
      expect(await failure(() => downloadDatabaseExport(job))).toBeInstanceOf(StorageTransientError);
    }
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Export not ready for download' }));
    expect(await failure(() => downloadDatabaseExport(job))).toBeInstanceOf(StorageTransientError);
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await failure(() => downloadDatabaseExport(job))).toBeInstanceOf(StorageTransientError);
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Instance selection changed', code: STORAGE_INSTANCE_CHANGED_CODE }));
    const changed = await failure(() => downloadDatabaseExport(job));
    expect(changed).not.toBeInstanceOf(StorageTransientError); expect(changed).not.toBeInstanceOf(StorageExportGoneError);
  });
  it('treats a body failure after a successful download response as consumed', async () => {
    const broken = (reason: Error) => new Response(new ReadableStream({ start(controller) { controller.error(reason); } }), { status: 200 });
    apiFetch.mockResolvedValueOnce(broken(new TypeError('network error')));
    expect(await failure(() => downloadDatabaseExport(job))).toBeInstanceOf(StorageExportGoneError);
    apiFetch.mockResolvedValueOnce(broken(new DOMException('Desktop connection changed', 'AbortError')));
    const aborted = await failure(() => downloadDatabaseExport(job));
    expect(aborted).not.toBeInstanceOf(StorageExportGoneError); expect(aborted).not.toBeInstanceOf(StorageTransientError);
  });
  it('actor verification is transient only for server or network failure', async () => {
    apiFetch.mockResolvedValueOnce(reply(503));
    expect(await failure(() => verifyStorageActor('admin'))).toBeInstanceOf(StorageTransientError);
    apiFetch.mockResolvedValueOnce(reply(401));
    expect(await failure(() => verifyStorageActor('admin'))).not.toBeInstanceOf(StorageTransientError);
    apiFetch.mockResolvedValueOnce(reply(200, { id: 'other', role: 'admin', permissions: ['instance.manage_settings'] }));
    expect(await failure(() => verifyStorageActor('admin'))).not.toBeInstanceOf(StorageTransientError);
  });
});
