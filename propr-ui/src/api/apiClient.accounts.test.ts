import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch, setApiBaseUrl, setDesktopConnectionScope } from './apiClient';

const scope = (id: string) => ({ bridge: {} as never, profileId: id, transportScope: id.repeat(22) });
afterEach(() => { setDesktopConnectionScope(null); vi.restoreAllMocks(); });

it('aborts old requests and rejects late success from the same endpoint after A → B → A', async () => {
  setApiBaseUrl('https://team.test');
  setDesktopConnectionScope(scope('a'));
  let complete!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = apiFetch('/api/tasks');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const init = fetch.mock.calls[0][1];
  setDesktopConnectionScope(scope('b'));
  setDesktopConnectionScope(scope('a'));
  expect(init?.signal?.aborted).toBe(true);
  complete(new Response(JSON.stringify({ private: 'alice' })));
  await rejected;
});

it('rejects a response body and its clone when decoding finishes after switching', async () => {
  setDesktopConnectionScope(scope('a'));
  let finish!: () => void;
  const data = new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode('{"private":"alice"}')); controller.close(); };
  } });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(data));
  const response = await apiFetch('/api/tasks');
  const copy = response.clone();
  const originalBody = expect(response.json()).rejects.toMatchObject({ name: 'AbortError' });
  const clonedBody = expect(copy.json()).rejects.toMatchObject({ name: 'AbortError' });
  setDesktopConnectionScope(scope('b'));
  finish();
  await Promise.all([originalBody, clonedBody]);
});

it('invalidates buffered responses and clones when only the API base URL changes', async () => {
  setDesktopConnectionScope(scope('a'));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"private":"alice"}'));
  const response = await apiFetch('/api/tasks');
  const clone = response.clone();
  setApiBaseUrl('https://other.test');
  const { handleApiResponse } = await import('./apiClient');
  await expect(handleApiResponse(response)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(handleApiResponse(clone)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(response.json()).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => clone.clone()).toThrowError(expect.objectContaining({ name: 'AbortError' }));
});

it('cleans up an unconsumed late body when a transport ignores cancellation', async () => {
  setDesktopConnectionScope(scope('a'));
  const cancel = vi.fn();
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const rejected = expect(apiFetch('/api/tasks')).rejects.toMatchObject({ name: 'AbortError' });
  setDesktopConnectionScope(scope('b'));
  finish(new Response(new ReadableStream({ cancel })));
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects error-body parsing invalidated by an endpoint change without dispatching authorization events', async () => {
  const { handleApiResponse, INSTANCE_AUTHORIZATION_CHANGED_EVENT } = await import('./apiClient');
  setDesktopConnectionScope(scope('a'));
  let finish!: () => void;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode('{"code":"INSUFFICIENT_INSTANCE_PERMISSION"}')); controller.close(); };
  } }), { status: 403 }));
  const response = await apiFetch('/api/tasks');
  const listener = vi.fn();
  window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
  try {
    const rejected = expect(handleApiResponse(response)).rejects.toMatchObject({ name: 'AbortError' });
    setApiBaseUrl('https://other.test');
    finish();
    await rejected;
    expect(listener).not.toHaveBeenCalled();
  } finally { window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener); }
});
