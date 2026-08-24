import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notification } from '@propr/shared';
import {
  dismissNotification,
  listNotifications,
  markNotificationRead,
} from '../api/notificationApi';
import { useNotificationCenter } from '../contexts/NotificationCenterContext';
import { useToast } from '../components/ui/useToast';
import { mergeNotifications } from './inboxUtils';

const PAGE_SIZE = 25;

export interface InboxNotificationsState {
  notifications: Notification[];
  initialLoading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  isOnline: boolean;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  open: (id: string) => void;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'The Inbox could not be loaded.';
}

export function useInboxNotifications(): InboxNotificationsState {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const requestGenerationRef = useRef(0);
  const notificationsRef = useRef(notifications);
  const dismissingRef = useRef(new Set<string>());
  const hiddenIdsRef = useRef(new Set<string>());
  const { unreadCount, commitUnreadCount, refreshUnreadCount } = useNotificationCenter();
  const { addToast } = useToast();
  notificationsRef.current = notifications;

  const loadFirstPage = useCallback(async (isRefresh: boolean) => {
    const generation = ++requestGenerationRef.current;
    if (isRefresh) setRefreshing(true);
    else setInitialLoading(true);
    setError(null);
    try {
      const response = await listNotifications({ limit: PAGE_SIZE });
      if (generation !== requestGenerationRef.current) return;
      setNotifications(mergeNotifications(
        [],
        response.notifications.filter(notification => !hiddenIdsRef.current.has(notification.id)),
      ));
      setNextCursor(response.nextCursor);
      commitUnreadCount(response.unreadCount);
    } catch (loadError) {
      if (generation === requestGenerationRef.current) setError(messageFrom(loadError));
    } finally {
      if (generation === requestGenerationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [commitUnreadCount]);

  useEffect(() => {
    void loadFirstPage(false);
    return () => { requestGenerationRef.current += 1; };
  }, [loadFirstPage]);

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  const refresh = useCallback(() => loadFirstPage(true), [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || refreshing || initialLoading) return;
    const cursor = nextCursor;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listNotifications({ cursor, limit: PAGE_SIZE });
      if (generation !== requestGenerationRef.current) return;
      setNotifications(current => mergeNotifications(
        current,
        response.notifications.filter(notification => !hiddenIdsRef.current.has(notification.id)),
      ));
      setNextCursor(response.nextCursor);
      commitUnreadCount(response.unreadCount);
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setLoadingMore(false);
    }
  }, [commitUnreadCount, initialLoading, loadingMore, nextCursor, refreshing]);

  const dismiss = useCallback(async (id: string) => {
    if (dismissingRef.current.has(id)) return;
    dismissingRef.current.add(id);
    hiddenIdsRef.current.add(id);
    const removed = notificationsRef.current.find(notification => notification.id === id);
    const priorUnreadCount = unreadCount;
    setNotifications(current => current.filter(notification => notification.id !== id));
    if (removed?.readAt === null && priorUnreadCount !== null) {
      commitUnreadCount(Math.max(0, priorUnreadCount - 1));
    }
    try {
      const response = await dismissNotification(id);
      commitUnreadCount(response.unreadCount);
    } catch (dismissError) {
      hiddenIdsRef.current.delete(id);
      if (removed) setNotifications(current => mergeNotifications(current, [removed]));
      if (priorUnreadCount !== null) commitUnreadCount(priorUnreadCount);
      addToast({
        type: 'error',
        message: `Couldn't dismiss the notification. ${messageFrom(dismissError)}`,
      });
    } finally {
      dismissingRef.current.delete(id);
      void refreshUnreadCount().catch(() => undefined);
    }
  }, [addToast, commitUnreadCount, refreshUnreadCount, unreadCount]);

  const open = useCallback((id: string) => {
    const current = notificationsRef.current.find(notification => notification.id === id);
    if (!current || current.readAt !== null) return;
    const priorUnreadCount = unreadCount;
    setNotifications(items => items.map(notification => notification.id === id
      ? { ...notification, readAt: notification.occurredAt }
      : notification));
    if (priorUnreadCount !== null) commitUnreadCount(Math.max(0, priorUnreadCount - 1));
    void markNotificationRead(id).then(response => {
      setNotifications(items => items.map(notification => notification.id === id
        ? response.notification
        : notification));
      commitUnreadCount(response.unreadCount);
    }).catch(readError => {
      setNotifications(items => items.map(notification => notification.id === id
        ? current
        : notification));
      if (priorUnreadCount !== null) commitUnreadCount(priorUnreadCount);
      addToast({
        type: 'error',
        message: `Couldn't mark the notification read. ${messageFrom(readError)}`,
      });
    }).finally(() => {
      void refreshUnreadCount().catch(() => undefined);
    });
  }, [addToast, commitUnreadCount, refreshUnreadCount, unreadCount]);

  return {
    notifications,
    initialLoading,
    refreshing,
    loadingMore,
    error,
    isOnline,
    hasMore: nextCursor !== null,
    refresh,
    loadMore,
    dismiss,
    open,
  };
}
