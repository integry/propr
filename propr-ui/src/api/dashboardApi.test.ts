import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiBaseUrl, setAuthenticatedApiReadIdentity } from './apiClient';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
  getDashboardSummary,
} from './dashboardApi';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const requestedUrl = (call: unknown[]): string => String(call[0]);

afterEach(() => {
  setApiBaseUrl('');
  setAuthenticatedApiReadIdentity(null);
  vi.restoreAllMocks();
});

describe('dashboard reads', () => {
  it('requests every section with the repository filter the caller asked for', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));

    await getDashboardSummary('integry/propr');
    await getDashboardAttention('integry/propr');
    await getDashboardActive('all');
    await getDashboardOutcomes('all', 5);
    await getDashboardOutcomes('all', 5, '  retry budget ');
    await getDashboardStats('integry/propr', '30d');

    expect(fetchSpy.mock.calls.map(requestedUrl)).toEqual([
      '/api/dashboard/summary?repository=integry%2Fpropr',
      '/api/dashboard/attention?repository=integry%2Fpropr',
      '/api/dashboard/active?repository=all',
      '/api/dashboard/outcomes?repository=all&limit=5',
      '/api/dashboard/outcomes?repository=all&limit=5&search=retry%20budget',
      '/api/stats/dashboard?repository=integry%2Fpropr&period=30d',
    ]);
  });

  it('shares one pending read between concurrently mounted sections', async () => {
    const pending = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending.promise);

    const first = getDashboardSummary('all');
    const second = getDashboardSummary('all');

    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    pending.resolve(jsonResponse({ repository: 'all', needsAttention: 2, running: 1, queued: 0, completedRecently: 4, recentWindowHours: 24 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { repository: 'all', needsAttention: 2, running: 1, queued: 0, completedRecently: 4, recentWindowHours: 24 },
      { repository: 'all', needsAttention: 2, running: 1, queued: 0, completedRecently: 4, recentWindowHours: 24 },
    ]);
  });

  it('does not share reads across different repository filters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(deferred<Response>().promise)
      .mockReturnValueOnce(deferred<Response>().promise);

    const all = getDashboardActive('all');
    const scoped = getDashboardActive('integry/propr');

    expect(scoped).not.toBe(all);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
