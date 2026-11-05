import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getDesktopSocketConfigurationKey, subscribeDesktopConnectionScope } from '../api/apiClient';
import { useOptionalSocket } from './useSocket';

/** Join the activity stream before mounting readers, closing the bootstrap gap
 * with one read instead of an immediate read followed by an acknowledgment read.
 * A failed/old socket must never prevent the HTTP-only application from loading.
 */
export function SocketBootstrap({ children, fallback, disabled, identity }: {
  children: ReactNode;
  fallback: ReactNode;
  disabled: boolean;
  identity: string;
}) {
  const socket = useOptionalSocket();
  const configuration = useSyncExternalStore(subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey, getDesktopSocketConfigurationKey);
  const scope = `${configuration}\0${identity}`;
  const [releasedScope, setReleasedScope] = useState<string | null>(null);
  const { subscribeToActivity, unsubscribeFromActivity, activityReady } = socket ?? {};

  useEffect(() => {
    if (disabled) return;
    subscribeToActivity?.();
    return () => unsubscribeFromActivity?.();
  }, [disabled, subscribeToActivity, unsubscribeFromActivity]);

  useEffect(() => {
    if (disabled || releasedScope === scope) return;
    if (activityReady) {
      setReleasedScope(scope);
      return;
    }
    const timer = window.setTimeout(() => setReleasedScope(scope), 1500);
    return () => window.clearTimeout(timer);
  }, [activityReady, disabled, releasedScope, scope]);

  // Once mounted, readers keep their state through an outage and own recovery.
  return disabled || !socket || releasedScope === scope ? children : fallback;
}
