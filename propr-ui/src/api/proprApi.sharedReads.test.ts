import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentUser,
  getInstanceCatalog,
  getReadinessTaskExistence,
  getTasks,
  setApiBaseUrl,
  setAuthenticatedApiReadIdentity,
  setDesktopConnectionScope,
} from './proprApi';

const catalog = (name: string) => ({
  agents: [],
  repositories: [{ name, enabled: true }],
});

const user = (id: string) => ({
  id,
  login: id,
  username: id,
  displayName: id,
  email: null,
  avatarUrl: null,
  role: 'admin' as const,
  permissions: ['instance.manage_settings' as const],
  authorizationSource: 'local' as const,
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const deferredJsonResponse = () => {
  const body = deferred<unknown>();
  const response = jsonResponse({});
  const json = vi.fn(() => body.promise);
  Object.defineProperty(response, 'json', { configurable: true, value: json });
  return { body, response, json };
};

const desktopScope = (name: string) => ({
  bridge: {} as never,
  profileId: `profile-${name}`,
  transportScope: `transport-${name}`,
});

afterEach(() => {
  setDesktopConnectionScope(null);
  setApiBaseUrl('');
  setAuthenticatedApiReadIdentity(null);
  vi.restoreAllMocks();
});

describe('same-scope startup reads', () => {
  it('shares one pending catalog read between two consumers, then reads fresh after settlement', async () => {
    const first = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(jsonResponse(catalog('second/repo')));

    const consumerA = getInstanceCatalog();
    const consumerB = getInstanceCatalog();

    expect(consumerB).toBe(consumerA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.resolve(jsonResponse(catalog('first/repo')));
    await expect(Promise.all([consumerA, consumerB])).resolves.toEqual([
      catalog('first/repo'),
      catalog('first/repo'),
    ]);

    await expect(getInstanceCatalog()).resolves.toEqual(catalog('second/repo'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('removes a failed pending read so a later consumer can retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'temporary' }, 503))
      .mockResolvedValueOnce(jsonResponse(catalog('recovered/repo')));

    const consumerA = getInstanceCatalog();
    const consumerB = getInstanceCatalog();
    expect(consumerB).toBe(consumerA);
    await expect(consumerA).rejects.toThrow('HTTP 503');
    await expect(consumerB).rejects.toThrow('HTTP 503');

    await expect(getInstanceCatalog()).resolves.toEqual(catalog('recovered/repo'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a deferred account-A response and never shares it with account B', async () => {
    setAuthenticatedApiReadIdentity('account-a');
    const accountA = deferred<Response>();
    const accountB = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(accountA.promise)
      .mockReturnValueOnce(accountB.promise);

    const oldRead = getInstanceCatalog();
    const oldReadRejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
    setAuthenticatedApiReadIdentity('account-b');
    const newRead = getInstanceCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    accountA.resolve(jsonResponse(catalog('account-a/private')));
    accountB.resolve(jsonResponse(catalog('account-b/private')));
    await oldReadRejected;
    await expect(newRead).resolves.toEqual(catalog('account-b/private'));
  });

  it('does not let stale current-user JSON reset a newer account read scope', async () => {
    setAuthenticatedApiReadIdentity('account-a');
    const accountAUser = deferredJsonResponse();
    const accountB = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(accountAUser.response)
      .mockReturnValueOnce(accountB.promise);

    const oldCurrentUser = getCurrentUser();
    await vi.waitFor(() => expect(accountAUser.json).toHaveBeenCalledOnce());
    setAuthenticatedApiReadIdentity('account-b');
    const accountBRead = getInstanceCatalog();
    expect(getInstanceCatalog()).toBe(accountBRead);
    const accountBResult = expect(accountBRead).resolves.toEqual(catalog('account-b/private'));

    accountAUser.body.resolve(user('account-a'));
    await expect(oldCurrentUser).resolves.toEqual(user('account-a'));
    expect(getInstanceCatalog()).toBe(accountBRead);
    accountB.resolve(jsonResponse(catalog('account-b/private')));
    await accountBResult;
  });

  it('still accepts a fresh current user as the authenticated read identity', async () => {
    setAuthenticatedApiReadIdentity('account-a');
    const accountA = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(accountA.promise)
      .mockResolvedValueOnce(jsonResponse(user('account-b')))
      .mockResolvedValueOnce(jsonResponse(catalog('account-b/private')));

    const accountARead = getInstanceCatalog();
    const accountARejected = expect(accountARead).rejects.toMatchObject({ name: 'AbortError' });
    await expect(getCurrentUser()).resolves.toEqual(user('account-b'));
    await accountARejected;
    await expect(getInstanceCatalog()).resolves.toEqual(catalog('account-b/private'));
  });

  it('does not let late current-user parsing disturb reads after an API endpoint rotation', async () => {
    setApiBaseUrl('https://account-a.example.test');
    setAuthenticatedApiReadIdentity('account-a');
    const accountAUser = deferredJsonResponse();
    const accountB = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(accountAUser.response)
      .mockReturnValueOnce(accountB.promise);

    const oldCurrentUser = getCurrentUser();
    await vi.waitFor(() => expect(accountAUser.json).toHaveBeenCalledOnce());
    setApiBaseUrl('https://account-b.example.test');
    setAuthenticatedApiReadIdentity('account-b');
    const accountBRead = getInstanceCatalog();
    const accountBResult = expect(accountBRead).resolves.toEqual(catalog('account-b/private'));

    accountAUser.body.resolve(user('account-a'));
    await expect(oldCurrentUser).resolves.toEqual(user('account-a'));
    accountB.resolve(jsonResponse(catalog('account-b/private')));
    await accountBResult;
  });

  it('keeps new Desktop endpoint and transport reads isolated from late current-user JSON', async () => {
    setDesktopConnectionScope(desktopScope('a'), 'https://account-a.example.test');
    setAuthenticatedApiReadIdentity('account-a');
    const accountAUser = deferredJsonResponse();
    const accountB = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(accountAUser.response)
      .mockReturnValueOnce(accountB.promise);

    const oldCurrentUser = getCurrentUser();
    await vi.waitFor(() => expect(accountAUser.json).toHaveBeenCalledOnce());
    setDesktopConnectionScope(desktopScope('b'), 'https://account-b.example.test');
    setAuthenticatedApiReadIdentity('account-b');
    const accountBRead = getInstanceCatalog();
    const accountBResult = expect(accountBRead).resolves.toEqual(catalog('account-b/private'));

    accountAUser.body.resolve(user('account-a'));
    await expect(oldCurrentUser).rejects.toThrow('Current-user response schema was invalid.');
    accountB.resolve(jsonResponse(catalog('account-b/private')));
    await accountBResult;
  });

  it('starts fresh reads after a Desktop reconnect rotates its transport scope', async () => {
    setDesktopConnectionScope(desktopScope('a'));
    const connectionA = deferred<Response>();
    const connectionB = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(connectionA.promise)
      .mockReturnValueOnce(connectionB.promise);

    const oldRead = getInstanceCatalog();
    const oldReadRejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
    setDesktopConnectionScope(desktopScope('b'));
    const newRead = getInstanceCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    connectionA.resolve(jsonResponse(catalog('connection-a/private')));
    connectionB.resolve(jsonResponse(catalog('connection-b/private')));
    await oldReadRejected;
    await expect(newRead).resolves.toEqual(catalog('connection-b/private'));
  });

  it('shares only readiness existence reads and preserves distinct task query contracts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse({ tasks: [], total: 0 })));

    await Promise.all([
      getTasks('all', 100, 0),
      getTasks({ limit: 30, forReview: true, excludeMerged: true }),
      getReadinessTaskExistence(),
      getReadinessTaskExistence(),
    ]);

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(3);
    expect(urls).toContain('/api/tasks?status=all&limit=100&offset=0&repository=all');
    expect(urls).toContain('/api/tasks?status=all&limit=30&offset=0&repository=all&forReview=true&excludeMerged=true');
    expect(urls).toContain('/api/tasks?status=all&limit=1&offset=0&repository=all');
  });
});
