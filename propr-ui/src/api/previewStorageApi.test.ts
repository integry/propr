import { afterEach, expect, test, vi } from 'vitest';
import { getManagedPreviewStorageStatus } from './previewStorageApi';
const unavailable = { version: 1, state: 'unavailable', enabled: false, effective: null };
afterEach(() => vi.restoreAllMocks());
test('settings API strips unknown fields and rejects unsupported or inconsistent contracts', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  fetchMock.mockResolvedValueOnce(Response.json({ ...unavailable, viewerToken: 'secret' }));
  expect(await getManagedPreviewStorageStatus()).toEqual(unavailable);
  for (const value of [{ ...unavailable, version: 2 }, { ...unavailable, enabled: true }, { ...unavailable, state: 'enabled' }]) {
    fetchMock.mockResolvedValueOnce(Response.json(value));
    expect(await getManagedPreviewStorageStatus()).toEqual(unavailable);
  }
});
test('network and server errors return unavailable without exposing sensitive details', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('https://signed.example/?token=secret'))
    .mockResolvedValueOnce(Response.json({ error: 'Bearer secret' }, { status: 503 }));
  expect(await getManagedPreviewStorageStatus()).toEqual(unavailable);
  expect(await getManagedPreviewStorageStatus()).toEqual(unavailable);
});
