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
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
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
});
