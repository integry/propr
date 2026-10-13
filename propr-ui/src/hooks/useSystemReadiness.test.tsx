import { act, render, renderHook, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSearch } from './useGlobalSearch';
import GlobalSearch from '../components/GlobalSearch';
import { MemoryRouter } from 'react-router-dom';
import { logout } from '../api/proprApi';
import * as proprApi from '../api/proprApi';
import { setDesktopConnectionScope } from '../api/apiClient';
const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock('../config/runtimeMode', async importOriginal => ({
  ...await importOriginal<typeof import('../config/runtimeMode')>(),
  isDesktopRuntime: () => runtime.desktop,
}));
import { useSystemReadiness } from './useSystemReadiness';

const deferred = <T,>() => {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const Probe = ({ name }: { name: string }) => {
  const readiness = useSystemReadiness();
  return (
    <div data-testid={name}>
      {readiness.isLoading ? 'loading' : readiness.error ? 'error' : readiness.hasTasks ? 'populated' : 'empty'}
    </div>
  );
};

afterEach(() => {
  cleanup();
  setDesktopConnectionScope(null);
  runtime.desktop = false;
  delete window.proprDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSystemReadiness shared startup state', () => {
  it('keeps two consumers loading through an empty response while issuing one read per contract', async () => {
    const tasks = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('/api/instance/catalog')) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [], repositories: [] })));
      }
      if (String(url).includes('/api/tasks?')) return tasks.promise;
      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    render(<><Probe name="layout" /><Probe name="dashboard" /></>);

    expect(screen.getByTestId('layout')).toHaveTextContent('loading');
    expect(screen.getByTestId('dashboard')).toHaveTextContent('loading');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/instance/catalog'))).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('limit=1'))).toHaveLength(1);

    await act(async () => {
      tasks.resolve(new Response(JSON.stringify({ tasks: [], total: 0 })));
    });

    await waitFor(() => expect(screen.getByTestId('layout')).toHaveTextContent('empty'));
    expect(screen.getByTestId('dashboard')).toHaveTextContent('empty');
  });
});

const populatedCatalog = { agents: [{ id: 'agent', defaultModel: 'model' }], repositories: [{ name: 'owner/repo' }] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const mountConsumers = () => renderHook(() => ({
  search: useGlobalSearch(), layout: useSystemReadiness(), dashboard: useSystemReadiness(),
}));
const bindDesktop = (nativeLogout = vi.fn().mockResolvedValue(undefined), id = 'a') => {
  runtime.desktop = true;
  const bridge = { auth: { logout: nativeLogout }, connection: { invalidate: vi.fn().mockResolvedValue({ invalidated: false }) } } as never;
  window.proprDesktop = bridge;
  act(() => setDesktopConnectionScope({ bridge, profileId: id, transportScope: `scope-${id}` }));
};

describe('desktop logout data loading', () => {
  it('keeps the search component renderable without a binding and across logout', async () => {
    runtime.desktop = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json(populatedCatalog)));
    const view = render(<MemoryRouter><GlobalSearch /></MemoryRouter>);
    expect(screen.getByRole('combobox', { name: 'Search' })).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();

    bindDesktop();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    act(() => setDesktopConnectionScope(null));
    view.rerender(<MemoryRouter><GlobalSearch /></MemoryRouter>);
    expect(screen.getByRole('combobox', { name: 'Search' })).toHaveValue('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('starts no repository/readiness/search loads when mounted without a binding', async () => {
    runtime.desktop = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = mountConsumers();
    act(() => hook.result.current.search.setQuery('repo'));
    await act(async () => {});
    expect(errors).not.toHaveBeenCalled();
    expect(hook.result.current.search.isLoading).toBe(false);
    expect(hook.result.current.layout.isLoading).toBe(false);
    expect(hook.result.current.dashboard.isLoading).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('cancels an already queued search when the desktop binding is cleared', async () => {
    bindDesktop();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(url => Promise.resolve(
      json(String(url).includes('/api/instance/catalog') ? populatedCatalog : { total: 1 }),
    ));
    const hook = mountConsumers();
    await waitFor(() => expect(hook.result.current.layout.hasRepos).toBe(true));
    const calls = fetchSpy.mock.calls.length;
    vi.useFakeTimers();
    act(() => hook.result.current.search.setQuery('repo'));
    act(() => setDesktopConnectionScope(null));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(calls);
    expect(hook.result.current.search.query).toBe('');
    expect(hook.result.current.search.isLoading).toBe(false);
  });

  it.each(['success', 'failure'] as const)('drops pending repository/readiness %s across actual logout', async outcome => {
    const nativeLogout = deferred<void>();
    bindDesktop(vi.fn(() => nativeLogout.promise));
    const catalog = deferred<Response>();
    const tasks = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('/api/instance/catalog')) return catalog.promise;
      if (String(url).includes('/api/tasks?')) return tasks.promise;
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = mountConsumers();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    let loggingOut!: void | Promise<void>;
    act(() => { loggingOut = logout(); });
    expect(hook.result.current.layout.isLoading).toBe(false);
    await act(async () => {
      if (outcome === 'success') {
        catalog.resolve(json(populatedCatalog)); tasks.resolve(json({ total: 1 }));
      } else {
        catalog.reject(new Error('Desktop authentication is required.'));
        tasks.reject(new Error('Desktop authentication is required.'));
      }
    });
    expect(hook.result.current.layout.hasRepos).toBe(false);
    expect(hook.result.current.dashboard.hasTasks).toBe(false);
    expect(hook.result.current.layout.error).toBeNull();
    expect(hook.result.current.search.results.repositories).toEqual([]);
    // Current-user provider can remount the anonymous dashboard while the
    // native token deletion is pending. Neither readiness consumer may reload.
    hook.unmount();
    mountConsumers();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    await act(async () => { nativeLogout.resolve(); await loggingOut; });
  });

  it.each(['success', 'failure'] as const)('fences mounted search %s and reloads for a replacement binding', async outcome => {
    bindDesktop();
    const pendingTasks = deferred<Response>();
    const pendingDrafts = deferred<Response>();
    let searching = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('/api/instance/catalog')) return Promise.resolve(json(populatedCatalog));
      if (String(url).includes('/api/tasks?')) return searching ? pendingTasks.promise : Promise.resolve(json({ total: 1 }));
      if (String(url).includes('/api/planner/drafts')) return pendingDrafts.promise;
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = mountConsumers();
    await waitFor(() => expect(hook.result.current.layout.hasRepos).toBe(true));
    searching = true;
    vi.useFakeTimers();
    act(() => hook.result.current.search.setQuery('repo'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/planner/drafts'))).toBe(true);
    const calls = fetchSpy.mock.calls.length;
    act(() => setDesktopConnectionScope(null));
    act(() => hook.result.current.search.setQuery('repo'));
    await act(async () => {
      if (outcome === 'success') {
        pendingTasks.resolve(json({ tasks: [{ id: 'stale' }] }));
        pendingDrafts.resolve(json({ drafts: [{ id: 'stale' }] }));
      } else {
        pendingTasks.reject(new Error('revoked')); pendingDrafts.reject(new Error('revoked'));
      }
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    expect(fetchSpy).toHaveBeenCalledTimes(calls);
    expect(hook.result.current.search.results).toEqual({ plans: [], tasks: [], repositories: [] });
    expect(hook.result.current.search.error).toBeNull();
    expect(hook.result.current.search.isLoading).toBe(false);
    expect(hook.result.current.layout.hasRepos).toBe(false);
    expect(hook.result.current.dashboard.hasTasks).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    searching = false;
    bindDesktop(undefined, 'b');
    await waitFor(() => expect(hook.result.current.layout.hasRepos).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(calls + 2);
  });

  it.each(['success', 'failure'] as const)('fences hook-level stale %s even if a loader ignores transport cancellation', async outcome => {
    bindDesktop();
    const catalog = deferred<Awaited<ReturnType<typeof proprApi.getInstanceCatalog>>>();
    const tasks = deferred<Awaited<ReturnType<typeof proprApi.getReadinessTaskExistence>>>();
    vi.spyOn(proprApi, 'getInstanceCatalog').mockReturnValue(catalog.promise);
    vi.spyOn(proprApi, 'getReadinessTaskExistence').mockReturnValue(tasks.promise);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = mountConsumers();
    act(() => setDesktopConnectionScope(null));
    await act(async () => {
      if (outcome === 'success') {
        catalog.resolve({ agents: [], repositories: [{ name: 'stale/repo', baseBranch: 'main', enabled: true }] });
        tasks.resolve({ total: 1, tasks: [] });
      } else {
        catalog.reject(new Error('obsolete catalog'));
        tasks.reject(new Error('obsolete readiness'));
      }
    });
    expect(hook.result.current.layout.hasRepos).toBe(false);
    expect(hook.result.current.dashboard.hasTasks).toBe(false);
    expect(hook.result.current.layout.error).toBeNull();
    expect(hook.result.current.search.error).toBeNull();
    expect(hook.result.current.search.results.repositories).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(proprApi.getInstanceCatalog).toHaveBeenCalledTimes(3);
    expect(proprApi.getReadinessTaskExistence).toHaveBeenCalledTimes(2);
  });

  it.each(['INVALID_INSTANCE_TOKEN', 'INSTANCE_TOKEN_EXPIRED', 'INSTANCE_TOKEN_REVOKED', 'AUTHORIZATION_CHANGED'])('still reports active-binding %s failures', async message => {
    bindDesktop();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: message }), { status: 401 })));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = mountConsumers();
    await waitFor(() => expect(hook.result.current.layout.error).toBeTruthy());
    expect(hook.result.current.dashboard.error).toBeTruthy();
    expect(errors.mock.calls.map(([prefix]) => prefix).sort()).toEqual([
      'Failed to fetch repositories:', 'Failed to fetch system readiness:', 'Failed to fetch system readiness:',
    ]);
  });
});
