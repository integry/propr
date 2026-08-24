import type { Notification } from '@propr/shared';

export const INBOX_GROUPS = [
  'Needs attention',
  'Ready for review',
  'Completed',
  'System',
] as const;

export type InboxGroup = (typeof INBOX_GROUPS)[number];

export function notificationGroup(notification: Notification): InboxGroup {
  switch (notification.kind) {
    case 'plan': return 'Ready for review';
    case 'review': return 'Completed';
    case 'pull_request': return 'Needs attention';
    case 'indexing':
    case 'system_failure': return 'System';
    case 'task': return notification.severity === 'success' ? 'Completed' : 'Needs attention';
  }
}

export function notificationKindLabel(notification: Notification): string {
  switch (notification.kind) {
    case 'plan': return 'Plan ready';
    case 'review': return 'Review completed';
    case 'pull_request': return 'PR attention';
    case 'system_failure': return 'System failure';
    case 'indexing': return notification.severity === 'warning'
      ? 'Indexing stalled'
      : 'Indexing failed';
    case 'task':
      if (notification.severity === 'success') return 'Implementation completed';
      if (notification.severity === 'warning') return 'Task stalled';
      return 'Task failed';
  }
}

export function notificationRepository(notification: Notification): string {
  return notification.target.type === 'system_failure'
    ? `System · ${notification.target.component}`
    : notification.target.repository;
}

export function notificationHref(notification: Notification): string {
  if (notification.action) return notification.action.href;
  switch (notification.target.type) {
    case 'plan': return `/studio/${encodeURIComponent(notification.target.draftId)}`;
    case 'task': return `/tasks/${encodeURIComponent(notification.target.taskId)}`;
    case 'review': return notification.target.taskId
      ? `/tasks/${encodeURIComponent(notification.target.taskId)}`
      : '/tasks';
    case 'pull_request': return '/repositories';
    case 'indexing': {
      const [owner, repository] = notification.target.repository.split('/');
      return owner && repository
        ? `/summaries/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
        : '/repositories';
    }
    case 'system_failure': return '/';
  }
}

export function formatRelativeTime(timestamp: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1_000));
  if (elapsedSeconds < 60) return 'just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function mergeNotifications(
  current: readonly Notification[],
  incoming: readonly Notification[],
): Notification[] {
  const byId = new Map(current.map(notification => [notification.id, notification]));
  for (const notification of incoming) byId.set(notification.id, notification);
  return [...byId.values()].sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
  ));
}
