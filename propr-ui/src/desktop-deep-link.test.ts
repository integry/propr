import { describe, expect, it, vi } from 'vitest';
import { DesktopDeepLinkNavigation } from './desktop-deep-link';

describe('desktop open deep-link navigation', () => {
  it('preserves a startup-buffered link until the dashboard is ready', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);

    expect(navigation.receiveWithState('propr://open?path=%2Ftasks')).toEqual({
      path: '/tasks',
      state: 'queued',
    });
    expect(navigate).not.toHaveBeenCalled();

    navigation.setDashboardReady();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/tasks');
  });

  it('preserves the order of multiple accepted links buffered during startup', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);

    navigation.receive('propr://open?path=%2Fplans');
    navigation.receive('propr://open?path=%2Ftasks');
    navigation.setDashboardReady();

    expect(navigate.mock.calls).toEqual([['/plans'], ['/tasks']]);
  });

  it('delivers a valid link received after the dashboard has loaded', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);
    navigation.setDashboardReady();

    expect(navigation.receiveWithState('propr://open?path=%2Ftasks%3Fstatus%3Dopen%23recent')).toEqual({
      path: '/tasks?status=open#recent',
      state: 'navigated',
    });
    expect(navigate).toHaveBeenCalledWith('/tasks?status=open#recent');
  });

  it('rejects an expanded canonical link and accepts one at the length limit', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);
    navigation.setDashboardReady();

    const rawPath = `/tasks/${'é '.repeat(300)}end`;
    const rawLink = `propr://open?path=${rawPath}`;
    const expandedCanonicalLink = new URL(rawLink).href;
    expect(rawLink.length).toBeLessThan(2_048);
    expect(expandedCanonicalLink.length).toBeGreaterThan(2_048);
    expect(navigation.receive(expandedCanonicalLink)).toBe(false);

    const canonicalPrefix = 'propr://open?path=%2Ftasks%2F';
    const suffix = 'a'.repeat(2_048 - canonicalPrefix.length);
    const boundaryCanonicalLink = `${canonicalPrefix}${suffix}`;
    expect(boundaryCanonicalLink).toHaveLength(2_048);
    expect(new URL(boundaryCanonicalLink).href).toBe(boundaryCanonicalLink);
    expect(navigation.receive(boundaryCanonicalLink)).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(`/tasks/${suffix}`);
  });

  it('does not route malformed or unsafe links before or after dashboard load', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);
    const rejected = [
      'not a URL',
      'propr://open?path=https%3A%2F%2Fevil.example',
      'propr://open?path=%2F%2Fevil.example',
      'propr://open?path=%2Ftasks%252F..%252Flogin',
      'propr://open?path=%2Ftasks%2523%2F%252e%252e%2Flogin',
      'propr://open?path=%2Ftasks%2523%2F%25252e%25252e%2Flogin',
      'propr://open?path=%2Ftasks%253F%2F%252e%252e%2Flogin',
      'propr://open?path=%2Ftasks%253F%2F%25252e%25252e%2Flogin',
      'propr://open?path=%2Ftasks%250Anext',
      'propr://open?path=%2Flogin%3Foauth_complete%3Dtrue',
      'propr://open?path=%2Ftasks%3Fflow%3Dattacker',
      'propr://open?path=%2Ftasks%3Ftunnel%3Dt-attacker.propr.dev',
    ];

    rejected.forEach(link => expect(navigation.receive(link), link).toBe(false));
    navigation.setDashboardReady();
    rejected.forEach(link => expect(navigation.receive(link), link).toBe(false));
    expect(navigate).not.toHaveBeenCalled();
  });
});
