import React, { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '../contexts/AuthContext';
import { useSocket } from '../contexts/useSocket';
import { navigateToUiPath } from '../config/runtimeMode';
import { useDesktop } from './DesktopContext';
import { normalizeScopedDesktopTaskTransition } from './scopedTaskEvents';

/** Feeds native notifications from the already-authenticated, scoped task stream. */
export const DesktopTaskNotificationAdapter: React.FC = () => {
  const desktop = useDesktop();
  const user = useCurrentUser();
  const userId = user?.id;
  const { isConnected, onTaskUpdate } = useSocket();
  const notifications = desktop?.notifications;
  const scope = useMemo(
    () => notifications && userId ? notifications.scopeFor(userId) : null,
    [notifications, userId],
  );
  const scopeKey = scope
    ? `${scope.profileId}\0${scope.transportScope}\0${scope.userId}`
    : null;
  const [activatedScopeKey, setActivatedScopeKey] = useState<string | null>(null);

  useEffect(() => {
    if (!notifications) return;
    return notifications.bridge.onNavigate(path => navigateToUiPath(path));
  }, [notifications]);

  useEffect(() => {
    if (!notifications || !scope) return;
    let current = true;
    setActivatedScopeKey(null);
    void notifications.bridge.get(scope).then(() => {
      if (current) setActivatedScopeKey(scopeKey);
    }).catch(() => undefined);
    return () => {
      current = false;
      void notifications.bridge.clear(scope).catch(() => undefined);
    };
  }, [notifications, scope, scopeKey]);

  useEffect(() => {
    if (!notifications || !scope || !isConnected || activatedScopeKey !== scopeKey) return;
    return onTaskUpdate(payload => {
      const transition = normalizeScopedDesktopTaskTransition(payload);
      if (!transition) return;
      void notifications.bridge.publish(scope, transition).catch(() => undefined);
    });
  }, [activatedScopeKey, isConnected, notifications, onTaskUpdate, scope, scopeKey]);

  return null;
};
