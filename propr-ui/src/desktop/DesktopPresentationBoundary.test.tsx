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
    discovery: { discover: async () => [] },
    authentication: { authenticate: async () => undefined, cancel: async () => undefined },
    externalBrowser: { open: async () => undefined },
    localSetup: {
      status: async () => ({
        phase: 'idle',
        capability: { supported: true, kind: 'local', platform: 'linux' },
        sessionId: '00000000-0000-4000-8000-000000000000',
        logs: [],
      }),
      start: async () => { throw new Error('not used'); },
      retry: async () => { throw new Error('not used'); },
      cancel: async () => { throw new Error('not used'); },
      selectPrivateKey: async () => null,
      acquireWebhookSecret: async () => null,
      onProgress: () => () => undefined,
    },
    connection: {
      probe: async () => ({ status: 'ready', activationTicket: 'test-ticket' }),
      activate: async () => ({ status: 'ready', profileId: 'test', transportScope: 'A'.repeat(22), identityEpoch: 'B'.repeat(22) }),
      discard: async () => ({ discarded: true }),
      invalidate: async () => ({ invalidated: true }),
    },
  };
  return { bridge, listeners, onDeepLink };
};

describe('DesktopPresentationBoundary deep-link subscription', () => {
  afterEach(() => {
    delete window.__PROPR_DESKTOP__;
    vi.restoreAllMocks();
  });

  it('subscribes once, unsubscribes on teardown, and does not replay after remount', async () => {
    const { bridge, listeners, onDeepLink } = bridgeWithDeepLinks();
    window.__PROPR_DESKTOP__ = bridge;
    const first = render(<DesktopPresentationBoundary desktop={<div>Desktop app</div>} fallback={<div>Web app</div>} />);

    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Let’s set up this computer' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://first.example')).not.toBeInTheDocument();
    expect(onDeepLink).toHaveBeenCalledTimes(2);
  });
});
