import { describe, expect, it, vi } from 'vitest';
import { DesktopDeepLinkInbox, DesktopDeepLinkNavigation } from './desktop-deep-link';

describe('desktop open deep-link navigation', () => {
  it('preserves a startup-buffered link until the dashboard is ready', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);

    expect(navigation.receive('propr://open?path=%2Ftasks', 'profile-a')).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    navigation.setDashboardReady('profile-a');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/tasks');
  });

  it('preserves the order of multiple accepted links buffered during startup', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);

    navigation.receive('propr://open?path=%2Fplans', 'profile-a');
    navigation.receive('propr://open?path=%2Ftasks', 'profile-a');
    navigation.setDashboardReady('profile-a');

    expect(navigate.mock.calls).toEqual([['/plans'], ['/tasks']]);
  });

  it('delivers a valid link received after the dashboard has loaded', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);
    navigation.setDashboardReady('profile-a');

    expect(navigation.receive('propr://open?path=%2Ftasks%3Fstatus%3Dopen%23recent', 'profile-a')).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/tasks?status=open#recent');
  });

  it('rejects an expanded canonical link and accepts one at the length limit', () => {
    const navigate = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate);
    navigation.setDashboardReady('profile-a');

    const rawPath = `/tasks/${'é '.repeat(300)}end`;
    const rawLink = `propr://open?path=${rawPath}`;
    const expandedCanonicalLink = new URL(rawLink).href;
    expect(rawLink.length).toBeLessThan(2_048);
    expect(expandedCanonicalLink.length).toBeGreaterThan(2_048);
    expect(navigation.receive(expandedCanonicalLink, 'profile-a')).toBe(false);

    const canonicalPrefix = 'propr://open?path=%2Ftasks%2F';
    const suffix = 'a'.repeat(2_048 - canonicalPrefix.length);
    const boundaryCanonicalLink = `${canonicalPrefix}${suffix}`;
    expect(boundaryCanonicalLink).toHaveLength(2_048);
    expect(new URL(boundaryCanonicalLink).href).toBe(boundaryCanonicalLink);
    expect(navigation.receive(boundaryCanonicalLink, 'profile-a')).toBe(true);
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

    rejected.forEach(link => expect(navigation.receive(link, 'profile-a'), link).toBe(false));
    navigation.setDashboardReady('profile-a');
    rejected.forEach(link => expect(navigation.receive(link, 'profile-a'), link).toBe(false));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects a queued route when a different profile becomes active', () => {
    const navigate = vi.fn();
    const reject = vi.fn();
    const navigation = new DesktopDeepLinkNavigation(navigate, reject);

    expect(navigation.receive('propr://open?path=%2Ftasks', 'profile-a')).toBe(true);
    navigation.setDashboardReady('profile-b');

    expect(navigate).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledOnce();
  });
});

describe('desktop deep-link inbox', () => {
  it('delivers values received before a consumer subscribes exactly once', () => {
    const inbox = new DesktopDeepLinkInbox();
    const first = vi.fn();
    const second = vi.fn();
    inbox.receive('propr://connect?api=https%3A%2F%2Ffirst.example');

    const unsubscribe = inbox.subscribe(first);
    expect(first).toHaveBeenCalledOnce();
    unsubscribe();
    const unsubscribeSecond = inbox.subscribe(second);
    expect(second).not.toHaveBeenCalled();

    inbox.receive('propr://connect?api=https%3A%2F%2Fsecond.example');
    expect(second).toHaveBeenCalledOnce();
    unsubscribeSecond();
  });

  it('fails closed when a competing consumer subscribes', () => {
    const inbox = new DesktopDeepLinkInbox();
    const first = vi.fn();
    const unsubscribe = inbox.subscribe(first);

    expect(() => inbox.subscribe(vi.fn())).toThrow('already has a consumer');
    inbox.receive('propr://connect?api=https%3A%2F%2Fonly.example');
    expect(first).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
