import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
};

const LocationProbe = () => {
  const location = useLocation();
  const state = location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null;
  const from = state?.from
    ? `${state.from.pathname || ''}${state.from.search || ''}${state.from.hash || ''}`
    : '';
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>
      <div data-testid="state-from">{from}</div>
    </>
  );
};

describe('HostedFlowRouteSync', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('preserves the validated active flow across actual React Router navigation without duplicating query parameters', async () => {
    const runtimeConfig = await import('./config/runtimeConfig');
    const { HostedFlowRouteSync } = await import('./App');
    const storage = memoryStorage();

    runtimeConfig.resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-router123.propr.dev&source=connect',
      undefined,
      undefined,
      storage,
      'router-context'
    );
    const flowId = storage.setItem.mock.calls.find(
      ([key]) => key === runtimeConfig.HOSTED_TUNNEL_FLOW_ID_KEY
    )?.[1];

    render(
      <MemoryRouter initialEntries={['/tasks?status=open']}>
        <HostedFlowRouteSync hostname="app.propr.dev" />
        <Link to="/settings?tab=members&flow=attacker">Settings</Link>
        <LocationProbe />
        <Routes>
          <Route path="/tasks" element={<div>tasks</div>} />
          <Route path="/settings" element={<div>settings</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/tasks?status=open&flow=${flowId}`
      );
    });

    fireEvent.click(screen.getByText('Settings'));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/settings?tab=members&flow=${flowId}`
      );
    });
  });

  it('preserves router state.from when inserting flow during route normalization', async () => {
    const runtimeConfig = await import('./config/runtimeConfig');
    const { HostedFlowRouteSync } = await import('./App');
    const storage = memoryStorage();

    runtimeConfig.resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-router-state.propr.dev',
      undefined,
      undefined,
      storage,
      'router-state-context'
    );
    const flowId = storage.setItem.mock.calls.find(
      ([key]) => key === runtimeConfig.HOSTED_TUNNEL_FLOW_ID_KEY
    )?.[1];

    render(
      <MemoryRouter
        initialEntries={[{
          pathname: '/login',
          search: '?logged_out=true',
          state: { from: { pathname: '/plans', search: '?status=open&sort=updated', hash: '#details' } },
        }]}
      >
        <HostedFlowRouteSync hostname="app.propr.dev" />
        <LocationProbe />
        <Routes>
          <Route path="/login" element={<div>login</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/login?logged_out=true&flow=${flowId}`
      );
    });
    expect(screen.getByTestId('state-from')).toHaveTextContent('/plans?status=open&sort=updated#details');
  });

  it('does not carry a raw attacker flow from the catch-all dashboard link when no active flow exists', async () => {
    const runtimeConfig = await import('./config/runtimeConfig');
    const { HostedFlowRouteSync, NotFoundRouteContent } = await import('./App');

    runtimeConfig.activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');

    render(
      <MemoryRouter initialEntries={['/missing?flow=attacker']}>
        <HostedFlowRouteSync hostname="app.propr.dev" />
        <LocationProbe />
        <Routes>
          <Route path="/" element={<div>dashboard</div>} />
          <Route path="*" element={<NotFoundRouteContent />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/missing');
    });

    fireEvent.click(screen.getByRole('link', { name: 'Back to dashboard' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    });
  });

  it('retains the validated active flow when the catch-all dashboard link uses router navigation', async () => {
    const runtimeConfig = await import('./config/runtimeConfig');
    const { HostedFlowRouteSync, NotFoundRouteContent } = await import('./App');
    const storage = memoryStorage();

    runtimeConfig.resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-catchall.propr.dev',
      undefined,
      undefined,
      storage,
      'catchall-context'
    );
    const flowId = storage.setItem.mock.calls.find(
      ([key]) => key === runtimeConfig.HOSTED_TUNNEL_FLOW_ID_KEY
    )?.[1];

    render(
      <MemoryRouter initialEntries={['/missing']}>
        <HostedFlowRouteSync hostname="app.propr.dev" />
        <LocationProbe />
        <Routes>
          <Route path="/" element={<div>dashboard</div>} />
          <Route path="*" element={<NotFoundRouteContent />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/missing?flow=${flowId}`);
    });

    fireEvent.click(screen.getByRole('link', { name: 'Back to dashboard' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/?flow=${flowId}`);
    });
  });
});
