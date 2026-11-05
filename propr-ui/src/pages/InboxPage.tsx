import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InboxClearAllButton } from '../components/Inbox/InboxClearAllButton';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import InboxSplitWorkspace from './Inbox/InboxSplitWorkspace';
import TriageVerdictCard from './Inbox/TriageVerdictCard';
import { useInboxTriage } from './Inbox/useInboxTriage';
import { InboxBanners, InboxList, InboxState, InboxSystemSection } from './InboxPageComponents';
import { isSystemNotification } from './inboxUtils';
import { useInboxNotifications, type InboxNotificationsState } from './useInboxNotifications';

/** The whole-page state that replaces the list, or null to show the list. */
function inboxState(inbox: InboxNotificationsState): 'loading' | 'empty' | 'error' | 'offline' | null {
  if (inbox.notifications.length > 0) return null;
  // Reads are skipped while offline, so a first page that has not settled
  // (never started, or still pending when the connection dropped) is offline,
  // not loading; reconnecting loads it.
  if (!inbox.isOnline && (inbox.initialLoading || inbox.error)) return 'offline';
  if (inbox.initialLoading) return 'loading';
  if (inbox.error) return 'error';
  return inbox.hasMore ? null : 'empty';
}

/** Whether a read of the list is in flight, so another page must wait for it. */
const readingPage = (inbox: InboxNotificationsState): boolean =>
  inbox.initialLoading || inbox.refreshing || inbox.loadingMore || inbox.clearing;

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

  const { selected, select, closePane, isSplitViewport } = useInboxTriage({
    queue: activity,
    notifications: inbox.notifications,
    dismiss,
    open: inbox.open,
    mutationsEnabled: listProps.mutationsEnabled,
    loaded: !inbox.initialLoading && inbox.error === null,
    hasMore: inbox.hasMore,
    loadMore: readingPage(inbox) ? null : inbox.loadMore,
  });

  const showState = inboxState(inbox);

  const canClearAll = inbox.notifications.length > 0 && inbox.mutationsEnabled;

  const queue = showState ? (
    <InboxState kind={showState} message={inbox.error ?? undefined} onRefresh={() => void inbox.refresh()} />
  ) : (
    <>
      <InboxList
        notifications={activity}
        {...listProps}
        {...(isSplitViewport ? { selectedId: selected?.id ?? null, onSelect: select, compact: selected !== null } : {})}
      />
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
  );

  return (
    <div className={`w-full min-w-0 bg-white ${isSplitViewport ? 'flex h-full min-h-0 flex-col' : 'min-h-full'}`}>
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

      {isSplitViewport ? (
        <InboxSplitWorkspace
          list={queue}
          onClose={closePane}
          verdict={selected && (
            <TriageVerdictCard
              key={selected.id}
              notification={selected}
              mutationsEnabled={listProps.mutationsEnabled}
              onDismiss={id => void inbox.dismiss(id)}
              onCommandSent={inbox.dismiss}
              paneControls={(
                <button
                  type="button"
                  onClick={closePane}
                  aria-label="Close triage verdict"
                  title="Close (Esc)"
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            />
          )}
        />
      ) : queue}
    </div>
  );
};

export default InboxPage;
