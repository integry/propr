import { PreviewThumbnails } from '../components/PreviewMedia';
import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isNotificationPreviewEligible, type Notification } from '@propr/shared';
import {
  ChevronDown,
  Inbox,
  Loader2,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import NotificationActions from '../components/Inbox/NotificationActions';
import { ReferenceChip } from '../components/TaskList/ReferenceChips';
import {
  formatRelativeTime,
  notificationDisplayTitle,
  notificationHref,
  notificationKindLabel,
  notificationReference,
  notificationRepository,
  notificationStatus,
  repositoryParts,
  type NotificationStatusShape,
} from './inboxUtils';

// Separator dot between metadata items, as in the task context strip.
const Dot: React.FC = () => (
  <span className="flex-none text-slate-300" aria-hidden="true">·</span>
);

function DetailLink({
  notification,
  label,
  className,
  children,
  onOpen,
}: {
  notification: Notification;
  label: string;
  className: string;
  children: React.ReactNode;
  onOpen: (id: string) => void;
}) {
  const href = notificationHref(notification);
  const handleClick = () => onOpen(notification.id);
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} aria-label={label} className={className}>
        {children}
      </a>
    );
  }
  return <Link to={href} onClick={handleClick} aria-label={label} className={className}>{children}</Link>;
}

/** System rows have no better destination, so clicking expands the full message. */
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

const STATUS_SHAPE_CLASS: Record<NotificationStatusShape, string> = {
  circle: 'h-2 w-2 rounded-full',
  diamond: 'h-[7px] w-[7px] rotate-45 rounded-[1px]',
  square: 'h-2 w-2 rounded-[1px]',
  triangle: 'h-2.5 w-2.5 [clip-path:polygon(50%_0,100%_100%,0_100%)]',
};

/** Status mark whose colour and shape carry the notification's state. */
const StatusMark: React.FC<{ notification: Notification; unread: boolean }> = ({ notification, unread }) => {
  const status = notificationStatus(notification);
  const label = unread ? `Unread · ${status.label}` : status.label;
  return (
    <span className="inline-flex h-4 w-3 flex-none items-center justify-center" role="img" aria-label={label} title={status.label}>
      <span className={`${STATUS_SHAPE_CLASS[status.shape]} ${status.className}`} />
    </span>
  );
};

/** "integry/propr" in full on desktop; phones drop the owner rather than truncate the name. */
const RepositoryName: React.FC<{ repository: string }> = ({ repository }) => {
  const { owner, name } = repositoryParts(repository);
  return (
    <span className="min-w-0 truncate" title={repository}>
      {owner && <span className="hidden sm:inline">{owner}</span>}
      {name}
    </span>
  );
};

/*
 * Each row is one grid, so every element renders once and only moves between
 * layouts. Phones stack status, time and dismiss, the title and summary (two
 * lines each), then the PR chip and repository beside the commands. Desktop
 * clusters status · chip · repository · time on the left above the title and
 * summary; the fixed-width right rail holds only the preview, commands and
 * dismiss, so every row's text ends on the same edge.
 */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[auto_minmax(0,auto)_minmax(0,1fr)_16rem_2rem]';
const TEXT_SPAN = 'col-start-1 col-span-3 min-w-0 pl-[18px]';

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
  // The title link stretches over the whole row; commands and dismiss sit above it.
  const targetClass = 'text-left after:absolute after:inset-0 after:content-[""] focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-teal-500';
  const title = notificationDisplayTitle(notification);
  // System rows are grouped under the System heading, so their titles are not headings.
  const Title = inPlace ? 'div' : 'h3';

  return (
    <div
      className="relative overflow-hidden border-b border-slate-200"
      style={{ touchAction: canDismiss ? 'pan-y' : undefined }}
      {...swipe.handlers}
    >
      <article
        aria-label={notification.title}
        style={{ transform: `translate3d(${swipe.offset}px, 0, 0)` }}
        className={`relative ${ROW_GRID} min-w-0 items-center bg-white py-2 pl-4 pr-4 transition-transform hover:bg-slate-50 sm:pl-6 ${
          swipe.dragging ? 'duration-0' : 'duration-200 ease-out'
        }`}
      >
        <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-x-1.5 text-xs leading-5 text-slate-500">
          <StatusMark notification={notification} unread={unread} />
          <span className="min-w-0 truncate font-medium text-slate-700">{notificationKindLabel(notification)}</span>
        </span>
        <span className={`col-start-2 row-start-1 flex items-center gap-x-1.5 justify-self-end whitespace-nowrap pl-3 text-xs leading-5 text-slate-500 sm:col-start-3 sm:mr-0 sm:justify-self-start sm:pl-1.5 ${canDismiss ? 'mr-3' : ''}`}>
          <span className="hidden sm:inline"><Dot /></span>
          <time dateTime={notification.occurredAt} title={new Date(notification.occurredAt).toLocaleString()}>
            {formatRelativeTime(notification.occurredAt)}
          </time>
        </span>
        <Title className={`${TEXT_SPAN} row-start-2 mt-1 break-words text-sm leading-5 sm:mt-0.5 ${
          expanded ? '' : 'line-clamp-2 sm:line-clamp-1'
        } ${unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>
          {inPlace ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => { setExpanded(value => !value); onOpen(notification.id); }}
              className={targetClass}
            >
              {title}
            </button>
          ) : (
            <DetailLink notification={notification} onOpen={onOpen} label={notification.title} className={targetClass}>
              {title}
            </DetailLink>
          )}
        </Title>
        <p className={`${TEXT_SPAN} row-start-3 mt-0.5 break-words text-xs leading-4 text-slate-500 ${
          expanded ? 'whitespace-pre-line' : 'line-clamp-2 sm:line-clamp-1'
        }`}>
          {notification.body}
        </p>
        {/* Phones keep the chip and commands on one line, truncating the repository if they must; desktop grids both cells. */}
        <div className="col-start-1 col-span-3 row-start-4 mt-2 flex items-center gap-x-3 sm:contents">
          <span className="flex min-w-0 items-center gap-x-1.5 pl-[18px] text-xs leading-5 text-slate-500 sm:col-start-2 sm:row-start-1 sm:pl-1.5">
            {reference && (
              <>
                <span className="hidden sm:inline"><Dot /></span>
                <span className="flex-none"><ReferenceChip title={reference.title}>{reference.label}</ReferenceChip></span>
              </>
            )}
            <span className="hidden sm:inline"><Dot /></span>
            <RepositoryName repository={notificationRepository(notification)} />
          </span>
          <div className="relative z-10 ml-auto flex flex-none items-center justify-end gap-2 empty:hidden sm:col-start-4 sm:row-span-3 sm:row-start-1 sm:ml-0">
            {isNotificationPreviewEligible(notification) && (
              <PreviewThumbnails media={notification.previewMedia} limit={1} size="rail" />
            )}
            <NotificationActions
              notification={notification}
              mutationsEnabled={mutationsEnabled}
              onCommandSent={() => onDismiss(notification.id)}
            />
          </div>
        </div>
        {canDismiss && (
          <button
            type="button"
            onClick={dismiss}
            className="relative z-10 col-start-3 row-start-1 -my-1.5 -mr-2 flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 active:bg-slate-100 sm:col-start-5 sm:row-span-3 sm:row-start-1 sm:my-0 sm:mr-0 sm:h-6 sm:w-6 sm:justify-self-end sm:rounded sm:hover:bg-slate-100"
            aria-label={`Dismiss ${notification.title}`}
            title="Dismiss"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
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
  <div>
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
    <section aria-labelledby="inbox-system" className="border-b border-slate-200 bg-slate-50">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="inbox-system-list"
          onClick={() => setExpanded(value => !value)}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 sm:px-6"
        >
          <span id="inbox-system" className="text-[10px] font-bold uppercase tracking-wider">System</span>
          <span className="text-xs font-semibold">{notifications.length}</span>
          <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h2>
      <div id="inbox-system-list" hidden={!expanded} className="border-t border-slate-200 [&>div>div:last-child]:border-b-0">
        {expanded && <InboxList notifications={notifications} {...listProps} />}
      </div>
    </section>
  );
};

/** Offline and error notices shown above an already loaded list. */
export const InboxBanners: React.FC<{
  hasNotifications: boolean;
  isOnline: boolean;
  error: string | null;
}> = ({ hasNotifications, isOnline, error }) => {
  if (!hasNotifications) return null;
  return (
    <>
      {!isOnline && (
        <div role="status" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 sm:px-6">
          <WifiOff className="h-4 w-4 flex-none" aria-hidden="true" />
          You’re offline. Showing the notifications already loaded.
        </div>
      )}
      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 sm:px-6">
          {error} Retrying automatically.
        </div>
      )}
    </>
  );
};

export const InboxState: React.FC<{
  kind: 'loading' | 'empty' | 'error' | 'offline';
  message?: string;
  onRefresh: () => void;
}> = ({ kind, message, onRefresh }) => {
  const loading = kind === 'loading';
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center bg-white px-5 py-10 text-center">
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
