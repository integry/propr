import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPresentationBoundary } from './DesktopPresentationBoundary';
import type { ProprDesktopBridge } from './types';

const bridgeWithDeepLinks = () => {
  const listeners = new Set<(value: string) => void>();
  const onDeepLink = vi.fn((listener: (value: string) => void) => {
    listeners.add(listener);
    return vi.fn(() => listeners.delete(listener));
  });
  const bridge: ProprDesktopBridge = {
    isDesktop: true,
    platform: 'linux',
    app: { onDeepLink },
    profiles: {
      list: async () => [],
      save: async () => undefined,
      remove: async () => undefined,
      getActiveId: async () => null,
      setActiveId: async () => undefined,
    },
    discovery: { supported: false, discover: async () => [] },
    authentication: { authenticate: async () => undefined },
    externalBrowser: { open: async () => undefined },
    localSetup: { supported: false, setup: async () => { throw new Error('not used'); } },
    connection: { probe: async () => ({ status: 'ready' }) },
  };
  return { bridge, listeners, onDeepLink };
};

describe('DesktopPresentationBoundary deep-link subscription', () => {
  afterEach(() => {
    delete window.__PROPR_DESKTOP__;
    vi.restoreAllMocks();
  });

  it('subscribes once, tears down, and does not replay a consumed candidate after remount', async () => {
    const { bridge, listeners, onDeepLink } = bridgeWithDeepLinks();
    window.__PROPR_DESKTOP__ = bridge;
    const first = render(<DesktopPresentationBoundary desktop={<div>Desktop app</div>} fallback={<div>Web app</div>} />);

    expect(await screen.findByRole('heading', { name: 'Connect to ProPR' })).toBeInTheDocument();
    expect(onDeepLink).toHaveBeenCalledOnce();
    first.rerender(<DesktopPresentationBoundary desktop={<div>Desktop app</div>} fallback={<div>Web app</div>} />);
    expect(onDeepLink).toHaveBeenCalledOnce();
    act(() => listeners.forEach(listener => listener('propr://connect?api=https%3A%2F%2Ffirst.example')));
    expect(await screen.findByDisplayValue('https://first.example')).toBeInTheDocument();

    const unsubscribe = onDeepLink.mock.results[0]?.value;
    first.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);

    render(<DesktopPresentationBoundary desktop={<div>Desktop app</div>} fallback={<div>Web app</div>} />);
    expect(await screen.findByRole('heading', { name: 'Connect to ProPR' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://first.example')).not.toBeInTheDocument();
    expect(onDeepLink).toHaveBeenCalledTimes(2);
  });
});
