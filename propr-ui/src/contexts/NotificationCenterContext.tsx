/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getNotificationPreferences, getNotificationUnreadCount } from '../api/notificationApi';
import { useCurrentUser } from './AuthContext';
import { useDemoMode } from './DemoModeContext';
import { useSocket } from './useSocket';

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Fallback cadence for the badge, armed only while the websocket is unavailable. */
const DISCONNECTED_FALLBACK_INTERVAL_MS = 60_000;

interface NotificationCenterValue {
  unreadCount: number | null;
  badgeEnabled: boolean;
  commitUnreadCount: (count: number) => void;
  commitBadgeEnabled: (enabled: boolean) => void;
  refreshUnreadCount: () => Promise<void>;
  isActiveIdentity: () => boolean;
}

const NotificationCenterContext = createContext<NotificationCenterValue | null>(null);

async function updateInstalledBadge(count: number, enabled: boolean): Promise<void> {
  const badgeNavigator = navigator as BadgeNavigator;
  try {
    if (!enabled || count === 0) await badgeNavigator.clearAppBadge?.();
    else await badgeNavigator.setAppBadge?.(Math.min(count, 99));
  } catch {
    // Badging is an optional installed-app capability and must never block Inbox use.
  }
}

export const NotificationCenterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const user = useCurrentUser();
  const { isDemoMode } = useDemoMode();
  const { isConnected, onNotificationUpdate } = useSocket();
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [badgeEnabled, setBadgeEnabled] = useState(false);
  const activeRef = useRef(true);
  const generationRef = useRef(0);
  const previousConnectedRef = useRef<boolean | null>(null);
  const preferenceGenerationRef = useRef(0);
  const unreadCountRef = useRef(unreadCount);
  const badgeEnabledRef = useRef(badgeEnabled);
  unreadCountRef.current = unreadCount;
  badgeEnabledRef.current = badgeEnabled;

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const commitUnreadCount = useCallback((count: number) => {
    if (!activeRef.current) return;
    generationRef.current += 1;
    const safeCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    setUnreadCount(safeCount);
    unreadCountRef.current = safeCount;
    void updateInstalledBadge(safeCount, badgeEnabledRef.current);
  }, []);

  const commitBadgeEnabled = useCallback((enabled: boolean) => {
    if (!activeRef.current) return;
    preferenceGenerationRef.current += 1;
    badgeEnabledRef.current = enabled;
    setBadgeEnabled(enabled);
    void updateInstalledBadge(unreadCountRef.current ?? 0, enabled);
  }, []);

  const refreshUnreadCount = useCallback(async () => {
    if (!activeRef.current) return;
    const generation = ++generationRef.current;
    const response = await getNotificationUnreadCount();
    if (!activeRef.current || generation !== generationRef.current) return;
    setUnreadCount(response.unreadCount);
    unreadCountRef.current = response.unreadCount;
    void updateInstalledBadge(response.unreadCount, badgeEnabledRef.current);
  }, []);

  const isActiveIdentity = useCallback(() => activeRef.current, []);

  const identityKey = user ? `user:${user.id}` : isDemoMode ? 'demo' : null;

  useEffect(() => {
    commitBadgeEnabled(false);
    const preferenceGeneration = preferenceGenerationRef.current;
    if (identityKey === null) {
      commitUnreadCount(0);
      return;
    }
    void refreshUnreadCount().catch(() => undefined);
    void getNotificationPreferences()
      .then(preferences => {
        if (preferenceGeneration !== preferenceGenerationRef.current) return;
        commitBadgeEnabled(preferences.badgeEnabled);
      })
      .catch(() => undefined);
    return () => {
      generationRef.current += 1;
      preferenceGenerationRef.current += 1;
    };
  }, [commitBadgeEnabled, commitUnreadCount, identityKey, refreshUnreadCount]);

  useEffect(() => {
    if (identityKey === null) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshUnreadCount().catch(() => undefined);
      }
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [identityKey, refreshUnreadCount]);

  useEffect(() => {
    if (identityKey === null || !isConnected) return;
    // Every notification change moves this number, so no filtering is needed:
    // the server scopes the event to this user's room. A hidden tab issues
    // nothing and the visibility handler above reconciles on return.
    return onNotificationUpdate(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshUnreadCount().catch(() => undefined);
    });
  }, [identityKey, isConnected, onNotificationUpdate, refreshUnreadCount]);

  useEffect(() => {
    // Reconnect reconciliation: a badge that is wrong after a dropped socket is
    // worse than one request, so read once per connect transition. The identity
    // effect above covers a session that was connected from the start.
    const previous = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (identityKey === null || previous !== false || !isConnected) return;
    void refreshUnreadCount().catch(() => undefined);
  }, [identityKey, isConnected, refreshUnreadCount]);

  useEffect(() => {
    // Fallback polling only while the websocket is unavailable.
    if (identityKey === null || isConnected) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshUnreadCount().catch(() => undefined);
    }, DISCONNECTED_FALLBACK_INTERVAL_MS);
    return () => { window.clearInterval(interval); };
  }, [identityKey, isConnected, refreshUnreadCount]);

  const value = useMemo(() => ({
    unreadCount,
    badgeEnabled,
    commitUnreadCount,
    commitBadgeEnabled,
    refreshUnreadCount,
    isActiveIdentity,
  }), [badgeEnabled, commitBadgeEnabled, commitUnreadCount, isActiveIdentity, refreshUnreadCount, unreadCount]);

  return (
    <NotificationCenterContext.Provider value={value}>
      {children}
    </NotificationCenterContext.Provider>
  );
};

export function useNotificationCenter(): NotificationCenterValue {
  const value = useContext(NotificationCenterContext);
  if (!value) throw new Error('useNotificationCenter must be used within NotificationCenterProvider');
  return value;
}
