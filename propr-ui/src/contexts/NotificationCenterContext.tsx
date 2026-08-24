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

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

interface NotificationCenterValue {
  unreadCount: number | null;
  badgeEnabled: boolean;
  commitUnreadCount: (count: number) => void;
  commitBadgeEnabled: (enabled: boolean) => void;
  refreshUnreadCount: () => Promise<void>;
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
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [badgeEnabled, setBadgeEnabled] = useState(true);
  const generationRef = useRef(0);
  const preferenceGenerationRef = useRef(0);
  const unreadCountRef = useRef(unreadCount);
  const badgeEnabledRef = useRef(badgeEnabled);
  unreadCountRef.current = unreadCount;
  badgeEnabledRef.current = badgeEnabled;

  const commitUnreadCount = useCallback((count: number) => {
    generationRef.current += 1;
    const safeCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    setUnreadCount(safeCount);
    unreadCountRef.current = safeCount;
    void updateInstalledBadge(safeCount, badgeEnabledRef.current);
  }, []);

  const commitBadgeEnabled = useCallback((enabled: boolean) => {
    preferenceGenerationRef.current += 1;
    badgeEnabledRef.current = enabled;
    setBadgeEnabled(enabled);
    void updateInstalledBadge(unreadCountRef.current ?? 0, enabled);
  }, []);

  const refreshUnreadCount = useCallback(async () => {
    const generation = ++generationRef.current;
    const response = await getNotificationUnreadCount();
    if (generation !== generationRef.current) return;
    setUnreadCount(response.unreadCount);
    unreadCountRef.current = response.unreadCount;
    void updateInstalledBadge(response.unreadCount, badgeEnabledRef.current);
  }, []);

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
    return () => { preferenceGenerationRef.current += 1; };
  }, [commitBadgeEnabled, commitUnreadCount, identityKey, refreshUnreadCount]);

  useEffect(() => {
    if (identityKey === null) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshUnreadCount().catch(() => undefined);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, 60_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [identityKey, refreshUnreadCount]);

  const value = useMemo(() => ({
    unreadCount,
    badgeEnabled,
    commitUnreadCount,
    commitBadgeEnabled,
    refreshUnreadCount,
  }), [badgeEnabled, commitBadgeEnabled, commitUnreadCount, refreshUnreadCount, unreadCount]);

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
