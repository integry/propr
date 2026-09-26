import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InboxClearAllButton } from '../components/Inbox/InboxClearAllButton';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { InboxBanners, InboxList, InboxState, InboxSystemSection } from './InboxPageComponents';
import { isSystemNotification } from './inboxUtils';
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

  const [activity, system] = useMemo(() => [
    inbox.notifications.filter(notification => !isSystemNotification(notification)),
    inbox.notifications.filter(isSystemNotification),
  ], [inbox.notifications]);
  const listProps = {
    onDismiss: inbox.dismiss,
    onOpen: inbox.open,
    mutationsEnabled: inbox.mutationsEnabled && !inbox.clearing,
  };

  const showState = inbox.initialLoading && inbox.notifications.length === 0
    ? 'loading'
    : inbox.notifications.length === 0 && inbox.error
      ? (inbox.isOnline ? 'error' : 'offline')
      : inbox.notifications.length === 0 && !inbox.hasMore
        ? 'empty'
        : null;

  const canClearAll = inbox.notifications.length > 0 && inbox.mutationsEnabled;

  return (
    <div className="min-h-full w-full min-w-0 bg-white">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2 sm:px-6">
        <h1 className="min-w-0 text-xl font-bold text-slate-950 sm:text-2xl">Inbox</h1>
        {canClearAll && (
          <InboxClearAllButton
            onConfirm={() => void inbox.clearAll()}
            disabled={inbox.clearing || inbox.refreshing || inbox.loadingMore}
          />
        )}
      </div>

      <InboxBanners hasNotifications={inbox.notifications.length > 0} isOnline={inbox.isOnline} error={inbox.error} />

      {showState ? (
        <InboxState kind={showState} message={inbox.error ?? undefined} onRefresh={() => void inbox.refresh()} />
      ) : (
        <>
          <InboxList notifications={activity} {...listProps} />
          {inbox.hasMore && (
            <button
              type="button"
              onClick={() => void inbox.loadMore()}
              disabled={inbox.loadingMore || inbox.clearing}
              className="flex min-h-11 w-full items-center justify-center gap-2 border-b border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
            >
              {inbox.loadingMore && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {inbox.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          <InboxSystemSection notifications={system} {...listProps} />
        </>
      )}
    </div>
  );
};

export default InboxPage;
