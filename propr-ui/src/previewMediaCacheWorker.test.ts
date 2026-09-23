import { describe, expect, test } from 'vitest';
import {
  CAPTURE_URL, PREVIEW_CACHE, PREVIEW_STAMP_PARAMETER, PREVIEW_TTL_MS,
  createHarness, dispatchFetch, waitableEvent,
} from './test/serviceWorkerHarness';

const capture = {
  url: CAPTURE_URL, method: 'GET', mode: 'no-cors' as RequestMode,
  destination: 'image' as RequestDestination,
};
const stampOf = (url: string) => `${url}?${PREVIEW_STAMP_PARAMETER}`;

describe('preview media worker cache', () => {
  test.each([
    // Opaque bytes would fail a CORS load outright, and nothing else on the host is ours to hold.
    ['a CORS request for a capture', { ...capture, mode: 'cors' as RequestMode }],
    ['any other github.com resource', { url: 'https://github.com/integry/propr/pull/1', method: 'GET', mode: 'no-cors' as RequestMode }],
    ['a capture requested with a query', { ...capture, url: `${CAPTURE_URL}?raw=1` }],
    ['a non-GET capture request', { ...capture, method: 'POST' }],
    // A published capture may be a video, which seeks with range requests that
    // one whole-resource entry keyed on the URL cannot answer.
    ['a published video', { ...capture, destination: 'video' as RequestDestination }],
  ])('never answers %s', (_label, request) => {
    const harness = createHarness();
    expect(dispatchFetch(harness, request)).toBeUndefined();
    expect(harness.networkRequests).toEqual([]);
  });

  test('holds a published capture so the next load paints without the network', async () => {
    const harness = createHarness();

    await dispatchFetch(harness, capture);
    expect(harness.networkRequests).toEqual([CAPTURE_URL]);
    expect(harness.cacheContents(PREVIEW_CACHE)).toEqual([CAPTURE_URL, stampOf(CAPTURE_URL)]);

    const served = await dispatchFetch(harness, capture);
    // The signed asset behind the attachment is single-use and `no-store`, so a
    // second load that reached the network would re-download the whole capture.
    expect(harness.networkRequests).toEqual([CAPTURE_URL]);
    expect(served).toBeDefined();
  });

  test('never writes a partial capture under the whole-resource key', async () => {
    const harness = createHarness();

    const served = await dispatchFetch(harness, {
      ...capture, headers: new Headers({ Range: 'bytes=128-' }),
    });

    // The request still reaches the network; only the entry that a later
    // whole-resource load would be answered from is withheld.
    expect(served).toBeDefined();
    expect(harness.networkRequests).toEqual([CAPTURE_URL]);
    expect(harness.cacheContents(PREVIEW_CACHE)).toEqual([]);
  });

  test('re-fetches a capture once the one-week window has passed', async () => {
    const harness = createHarness();
    harness.seedPreview(CAPTURE_URL, Date.now() - PREVIEW_TTL_MS - 1000);

    await dispatchFetch(harness, capture);

    expect(harness.networkRequests).toEqual([CAPTURE_URL]);
  });

  test('paints an expired capture rather than failing when the network is unavailable', async () => {
    const harness = createHarness();
    harness.seedPreview(CAPTURE_URL, Date.now() - PREVIEW_TTL_MS - 1000);
    harness.failNetwork(true);

    const served = await dispatchFetch(harness, capture);

    expect(await (served as Response).text()).toBe('cached capture');
  });

  test('drops captures past the window when a new worker activates', async () => {
    const harness = createHarness();
    const fresh = 'https://github.com/user-attachments/assets/screen-1';
    harness.seedPreview(CAPTURE_URL, Date.now() - PREVIEW_TTL_MS - 1000);
    harness.seedPreview(fresh, Date.now());
    const activate = waitableEvent({});

    harness.dispatch('activate', activate.event);
    await activate.completion();

    expect(harness.cacheContents(PREVIEW_CACHE)).toEqual([fresh, stampOf(fresh)]);
  });

  test.each([
    ['the capture whose bytes the page could not decode', CAPTURE_URL, []],
    ['nothing for an untrusted URL', 'https://attacker.example/capture.png', [CAPTURE_URL, stampOf(CAPTURE_URL)]],
  ])('forgets %s', async (_label, url, remaining) => {
    const harness = createHarness();
    harness.seedPreview(CAPTURE_URL, Date.now());
    const message = waitableEvent({ data: { type: 'propr-forget-preview', url } });

    harness.dispatch('message', message.event);
    await message.completion();

    // An opaque entry could equally be a GitHub error page, which only the
    // element that failed to decode it can recognise.
    expect(harness.cacheContents(PREVIEW_CACHE)).toEqual(remaining);
  });
});
