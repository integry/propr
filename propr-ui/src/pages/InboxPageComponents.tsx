import { PreviewThumbnails } from '../components/PreviewMedia';
import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isNotificationPreviewEligible, type Notification } from '@propr/shared';
import {
  ChevronDown,
  Inbox,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import NotificationActions from '../components/Inbox/NotificationActions';
import {
  formatRelativeTime,
  notificationHref,
  notificationIndicatorClass,
  notificationKindLabel,
  notificationReference,
  notificationRepository,
} from './inboxUtils';

// Separator dot between metadata items, as in the task context strip.
const Dot: React.FC = () => (
  <span className="text-gray-300" aria-hidden="true">·</span>
);

function DetailLink({
  notification,
  className,
  children,
  onOpen,
}: {
  notification: Notification;
  className: string;
  children: React.ReactNode;
  onOpen: (id: string) => void;
}) {
  const href = notificationHref(notification);
  const handleClick = () => onOpen(notification.id);
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} className={className}>
        {children}
      </a>
    );
  }
  return <Link to={href} onClick={handleClick} className={className}>{children}</Link>;
}

/** System cards have no better destination, so clicking expands the full message. */
function expandsInPlace(notification: Notification): boolean {
  return notification.target.type === 'system_failure';
}

const SWIPE_DISMISS_THRESHOLD = 96;

function useSwipeToDismiss(enabled: boolean, onDismiss: () => void) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    horizontal: boolean | null;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const finish = (commit: boolean, deltaX = 0) => {
    const wasHorizontal = gestureRef.current?.horizontal === true;
    gestureRef.current = null;
    setDragging(false);
    if (wasHorizontal) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 250);
    }
    if (commit) {
      setOffset(Math.sign(deltaX) * Math.max(window.innerWidth, 480));
      onDismiss();
    } else {
      setOffset(0);
    }
  };

  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        horizontal: null,
      };
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      if (gesture.horizontal === null && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 8) {
        gesture.horizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.15;
        if (!gesture.horizontal) {
          finish(false);
          return;
        }
        // Capture only once the gesture is a swipe so taps still reach links and buttons.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
      }
      if (gesture.horizontal) {
        event.preventDefault();
        setOffset(deltaX);
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (gesture?.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - gesture.startX;
      finish(gesture.horizontal === true && Math.abs(deltaX) >= SWIPE_DISMISS_THRESHOLD, deltaX);
    },
    onPointerCancel: () => finish(false),
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { offset, dragging, handlers };
}

export const InboxCard: React.FC<{
  notification: Notification;
  onDismiss: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
  mutationsEnabled: boolean;
}> = ({ notification, onDismiss, onOpen, mutationsEnabled }) => {
  const unread = notification.readAt === null;
  const canDismiss = mutationsEnabled && notification.actions.includes('dismiss');
  const [expanded, setExpanded] = useState(false);
  const dismiss = () => { void onDismiss(notification.id); };
  const swipe = useSwipeToDismiss(canDismiss, dismiss);
  const inPlace = expandsInPlace(notification);
  const reference = notificationReference(notification);
  // A button may only hold phrasing content, so in-place cards keep the title
  // as text; the article is still named by it.
  const Title = inPlace ? 'span' : 'h3';

  const content = (
    <>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pr-8 text-xs">
        {unread && <span className={`h-2 w-2 rounded-full ${notificationIndicatorClass(notification)}`} role="img" aria-label="Unread" />}
        <span className="font-medium text-gray-700">{notificationKindLabel(notification)}</span>
        <Dot />
        <span className="min-w-0 truncate text-gray-500">{notificationRepository(notification)}</span>
        {reference && (
          <>
            <Dot />
            <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700" title={reference.title}>
              {reference.label}
            </span>
          </>
        )}
        <Dot />
        <time dateTime={notification.occurredAt} title={new Date(notification.occurredAt).toLocaleString()} className="text-gray-500">
          {formatRelativeTime(notification.occurredAt)}
        </time>
      </div>
      <Title className={`mt-1.5 block break-words text-sm leading-5 ${unread ? 'font-semibold text-slate-950' : 'font-medium text-slate-800'}`}>
        {notification.title}
      </Title>
      <p className={`mt-0.5 break-words text-sm leading-5 text-slate-600 ${expanded ? '' : 'line-clamp-2'}`}>{notification.body}</p>
      {isNotificationPreviewEligible(notification) && <PreviewThumbnails media={notification.previewMedia} limit={1} />}
    </>
  );
  const contentClass = 'block w-full min-w-0 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500';

  return (
    <div
      className="relative"
      style={{ touchAction: canDismiss ? 'pan-y' : undefined }}
      {...swipe.handlers}
    >
      <article
        aria-label={notification.title}
        style={{ transform: `translate3d(${swipe.offset}px, 0, 0)` }}
        className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-transform ${
          swipe.dragging ? 'duration-0' : 'duration-200 ease-out'
        }`}
      >
        {inPlace ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => { setExpanded(value => !value); onOpen(notification.id); }}
            className={contentClass}
          >
            {content}
          </button>
        ) : (
          <DetailLink notification={notification} onOpen={onOpen} className={contentClass}>
            {content}
          </DetailLink>
        )}
        {canDismiss && (
          <button
            type="button"
            onClick={dismiss}
            className="absolute right-1.5 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            aria-label={`Dismiss ${notification.title}`}
            title="Dismiss"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <NotificationActions
          notification={notification}
          mutationsEnabled={mutationsEnabled}
          onCommandSent={() => onDismiss(notification.id)}
          className="px-4 pb-3"
        />
      </article>
    </div>
  );
};

interface InboxListProps {
  notifications: Notification[];
  onDismiss: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
  mutationsEnabled: boolean;
}

export const InboxList: React.FC<InboxListProps> = ({ notifications, ...cardProps }) => (
  <div className="space-y-2">
    {notifications.map(notification => (
      <InboxCard key={notification.id} notification={notification} {...cardProps} />
    ))}
  </div>
);

/** System updates sit below the activity feed, collapsed until the operator expands them. */
export const InboxSystemSection: React.FC<InboxListProps> = ({ notifications, ...listProps }) => {
  const [expanded, setExpanded] = useState(false);
  if (notifications.length === 0) return null;
  return (
    <section aria-labelledby="inbox-system" className="rounded-xl border border-slate-200 bg-slate-50">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="inbox-system-list"
          onClick={() => setExpanded(value => !value)}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <span id="inbox-system" className="text-xs font-bold uppercase tracking-widest">System</span>
          <span className="text-xs font-semibold">{notifications.length}</span>
          <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h2>
      <div id="inbox-system-list" hidden={!expanded} className="px-2 pb-2">
        {expanded && <InboxList notifications={notifications} {...listProps} />}
      </div>
    </section>
  );
};

export const InboxState: React.FC<{
  kind: 'loading' | 'empty' | 'error' | 'offline';
  message?: string;
  onRefresh: () => void;
}> = ({ kind, message, onRefresh }) => {
  const loading = kind === 'loading';
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      {loading ? <Loader2 className="h-8 w-8 animate-spin text-teal-600" /> : <Inbox className="h-9 w-9 text-slate-300" />}
      <h2 className="mt-4 text-base font-semibold text-slate-800">
        {kind === 'empty' ? 'You’re all caught up' : kind === 'offline' ? 'Inbox unavailable offline' : kind === 'error' ? 'Couldn’t load your Inbox' : 'Loading Inbox'}
      </h2>
      <p className="mt-1 max-w-sm text-sm leading-5 text-slate-500">
        {message ?? (kind === 'empty' ? 'New operational updates will appear here.' : 'Fetching your latest notifications…')}
      </p>
      {!loading && kind !== 'empty' && (
        <button type="button" onClick={onRefresh} className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700">
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      )}
    </div>
  );
};
