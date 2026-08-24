import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { InboxGroupSection, InboxState } from './InboxPageComponents';
import { INBOX_GROUPS, notificationGroup } from './inboxUtils';
import { useInboxNotifications } from './useInboxNotifications';

const InboxPage: React.FC = () => {
  useDocumentTitle('Inbox');
  const location = useLocation();
  const navigate = useNavigate();
  const processedIntentsRef = useRef(new Set<string>());
  const inbox = useInboxNotifications();
  const dismiss = inbox.dismiss;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('intent') !== 'dismiss') return;
    const notificationId = params.get('notification');
    params.delete('intent');
    params.delete('notification');
    const nextSearch = params.toString();
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`, { replace: true });
    if (!notificationId || processedIntentsRef.current.has(notificationId)) return;
    processedIntentsRef.current.add(notificationId);
    void dismiss(notificationId);
  }, [dismiss, location.hash, location.pathname, location.search, navigate]);

  const grouped = useMemo(() => INBOX_GROUPS.map(group => ({
    group,
    notifications: inbox.notifications.filter(notification => notificationGroup(notification) === group),
  })).filter(section => section.notifications.length > 0), [inbox.notifications]);

  const showState = inbox.initialLoading && inbox.notifications.length === 0
    ? 'loading'
    : inbox.notifications.length === 0 && inbox.error
      ? (inbox.isOnline ? 'error' : 'offline')
      : inbox.notifications.length === 0 && !inbox.hasMore
        ? 'empty'
        : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-6 sm:py-7">
      <div className="mb-4 flex items-start justify-between gap-3 sm:mb-6">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-950 sm:text-2xl">Inbox</h1>
          <p className="mt-1 text-sm leading-5 text-slate-500">Plans, tasks, reviews, and system updates in one place.</p>
        </div>
        <button
          type="button"
          onClick={() => void inbox.refresh()}
          disabled={inbox.refreshing || inbox.initialLoading}
          className="inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
          aria-label="Refresh Inbox"
        >
          <RefreshCw className={`h-4 w-4 ${inbox.refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span className="hidden min-[360px]:inline">Refresh</span>
        </button>
      </div>

      {!inbox.isOnline && inbox.notifications.length > 0 && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <WifiOff className="h-4 w-4 flex-none" aria-hidden="true" />
          You’re offline. Showing the notifications already loaded.
        </div>
      )}
      {inbox.error && inbox.notifications.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {inbox.error} Use Refresh to try again.
        </div>
      )}

      {showState ? (
        <InboxState kind={showState} message={inbox.error ?? undefined} onRefresh={() => void inbox.refresh()} />
      ) : (
        <div className="space-y-6">
          {grouped.map(section => (
            <InboxGroupSection
              key={section.group}
              group={section.group}
              notifications={section.notifications}
              onDismiss={id => void inbox.dismiss(id)}
              onOpen={inbox.open}
            />
          ))}
          {inbox.hasMore && (
            <button
              type="button"
              onClick={() => void inbox.loadMore()}
              disabled={inbox.loadingMore}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
            >
              {inbox.loadingMore && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {inbox.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default InboxPage;
