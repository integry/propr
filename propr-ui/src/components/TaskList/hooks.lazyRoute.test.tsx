import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { Suspense, lazy, useCallback, useState } from 'react';
import { BrowserRouter, HashRouter, Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedCallback, useListSearchParams } from './hooks';

// A departing list stays mounted while a lazy destination route loads (React Router
// renders navigations in a transition). Its debounced search write must not take the
// URL back to the list.

/** The Goals/Plans/Tasks search shape: instant input, debounced URL write, immediate clear. */
const SearchList: React.FC = () => {
  const [params, setParams] = useListSearchParams();
  const [query, setQuery] = useState(params.get('search') ?? '');
  const commit = useCallback((value: string) => {
    setParams(current => {
      const next = new URLSearchParams(current);
      if (value) next.set('search', value);
      else next.delete('search');
      return next;
    }, { replace: true });
  }, [setParams]);
  useDebouncedCallback(query, commit, 400);
  return (
    <>
      <h1>List</h1>
      <input aria-label="Search" value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" onClick={() => { setQuery(''); commit(''); }}>Clear search</button>
      <Link to="/settings">Settings</Link>
    </>
  );
};

const routerLocation = (router: 'browser' | 'hash') => {
  if (router === 'hash') return window.location.hash.slice(1) || '/';
  return `${window.location.pathname}${window.location.search}`;
};

const renderApp = (router: 'browser' | 'hash') => {
  let release!: () => void;
  const chunk = new Promise<{ default: React.FC }>(resolve => {
    release = () => resolve({ default: () => <h1>Settings</h1> });
  });
  const Settings = lazy(() => chunk);
  const Router = router === 'hash' ? HashRouter : BrowserRouter;
  render(
    <Router>
      <Suspense fallback={<p>Loading</p>}>
        <Routes>
          <Route path="/goals" element={<SearchList />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Suspense>
    </Router>,
  );
  return { release: () => act(async () => { release(); await chunk; }) };
};

describe.each(['browser', 'hash'] as const)('list search during a lazy route transition (%s router)', router => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, '', router === 'hash' ? '/#/goals' : '/goals');
  });
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  const leaveWhileSettingsLoads = async (release: () => Promise<void>) => {
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(routerLocation(router)).toBe('/settings');
    // The departing list is still on screen, and every debounce elapses.
    expect(screen.getByRole('heading', { name: 'List' })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(routerLocation(router)).toBe('/settings');

    await release();
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(routerLocation(router)).toBe('/settings');
  };

  it('a cleared search does not navigate back to the list', async () => {
    const { release } = renderApp(router);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'no-match' } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(routerLocation(router)).toBe('/goals?search=no-match');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(routerLocation(router)).toBe('/goals');
    await leaveWhileSettingsLoads(release);
  });

  it('a typed search still pending does not navigate back to the list', async () => {
    const { release } = renderApp(router);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'no-match' } });
    await leaveWhileSettingsLoads(release);
  });

  it('control: with no edit, the delayed destination opens', async () => {
    const { release } = renderApp(router);
    await leaveWhileSettingsLoads(release);
  });

  it('still writes the search while the list stays open', async () => {
    renderApp(router);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'billing' } });
    expect(routerLocation(router)).toBe('/goals');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(routerLocation(router)).toBe('/goals?search=billing');
  });
});
