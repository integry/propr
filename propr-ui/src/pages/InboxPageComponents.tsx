import React from 'react';
import { Link } from 'react-router-dom';
import type { Notification } from '@propr/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Inbox,
  Loader2,
  RefreshCw,
  ServerCrash,
} from 'lucide-react';
import NotificationActions from '../components/Inbox/NotificationActions';
import type { InboxGroup } from './inboxUtils';
import {
  formatRelativeTime,
  notificationHref,
  notificationKindLabel,
  notificationRepository,
} from './inboxUtils';

const GROUP_ICON: Record<InboxGroup, React.FC<{ className?: string }>> = {
  'Needs attention': CircleAlert,
  'Ready for review': AlertTriangle,
  Completed: CheckCircle2,
  System: ServerCrash,
};

const GROUP_STYLE: Record<InboxGroup, string> = {
  'Needs attention': 'text-red-700 bg-red-50 border-red-100',
  'Ready for review': 'text-amber-700 bg-amber-50 border-amber-100',
  Completed: 'text-emerald-700 bg-emerald-50 border-emerald-100',
  System: 'text-slate-700 bg-slate-100 border-slate-200',
};

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

export const InboxCard: React.FC<{
  notification: Notification;
  onDismiss: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  mutationsEnabled: boolean;
}> = ({ notification, onDismiss, onOpen, onChanged, mutationsEnabled }) => {
  const unread = notification.readAt === null;
  return (
    <article className={`relative overflow-hidden rounded-xl border shadow-sm transition-colors ${
      unread ? 'border-teal-200 bg-teal-50/40' : 'border-slate-200 bg-white'
    }`}>
      {unread && <span className="absolute inset-y-0 left-0 w-1 bg-teal-500" aria-hidden="true" />}
      <DetailLink
        notification={notification}
        onOpen={onOpen}
        className="block min-w-0 px-4 pb-2 pt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
      >
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {unread && (
                <span className="inline-flex items-center gap-1 font-semibold text-teal-700">
                  <span className="h-2 w-2 rounded-full bg-teal-500" aria-hidden="true" />
                  Unread
                </span>
              )}
              <span className="font-medium text-slate-600">{notificationRepository(notification)}</span>
              <span className="text-slate-300" aria-hidden="true">·</span>
              <time dateTime={notification.occurredAt} title={new Date(notification.occurredAt).toLocaleString()} className="text-slate-500">
                {formatRelativeTime(notification.occurredAt)}
              </time>
            </div>
            <div className="mt-2 inline-flex rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              {notificationKindLabel(notification)}
            </div>
            <h3 className={`mt-2 break-words text-sm leading-5 ${unread ? 'font-semibold text-slate-950' : 'font-medium text-slate-800'}`}>
              {notification.title}
            </h3>
            <p className="mt-1 break-words text-sm leading-5 text-slate-600">{notification.body}</p>
          </div>
          <ChevronRight className="mt-1 h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
        </div>
      </DetailLink>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5">
        <DetailLink
          notification={notification}
          onOpen={onOpen}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-teal-700 hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          View details
        </DetailLink>
        <NotificationActions
          notification={notification}
          mutationsEnabled={mutationsEnabled}
          onDismiss={() => onDismiss(notification.id)}
          onChanged={onChanged}
        />
      </div>
    </article>
  );
};

export const InboxGroupSection: React.FC<{
  group: InboxGroup;
  notifications: Notification[];
  onDismiss: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  mutationsEnabled: boolean;
}> = ({ group, notifications, onDismiss, onOpen, onChanged, mutationsEnabled }) => {
  const Icon = GROUP_ICON[group];
  const headingId = `inbox-${group.replace(/ /g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={headingId}>
      <div className={`mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 ${GROUP_STYLE[group]}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
        <h2 id={headingId} className="text-xs font-bold uppercase tracking-wider">
          {group}
        </h2>
        <span className="ml-auto text-xs font-semibold">{notifications.length}</span>
      </div>
      <div className="space-y-3">
        {notifications.map(notification => (
          <InboxCard
            key={notification.id}
            notification={notification}
            onDismiss={onDismiss}
            onOpen={onOpen}
            onChanged={onChanged}
            mutationsEnabled={mutationsEnabled}
          />
        ))}
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
