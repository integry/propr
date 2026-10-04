import type { NotificationEvent } from './notifications.js';

export type NotificationLinkSource = Pick<NotificationEvent, 'target' | 'action' | 'metadata'>;

/** GitHub remains a secondary destination, independent of the primary entity link. */
export function notificationPullRequestUrl(notification: NotificationLinkSource): string | null {
  const { target, action } = notification;
  if (target.type !== 'task' && target.type !== 'review' && target.type !== 'pull_request') return null;
  if (target.prNumber === undefined) return null;
  const [owner, repository] = target.repository.split('/');
  if (!owner || !repository) return null;
  const canonical = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pull/${target.prNumber}`;
  if (action?.type !== 'external_link') return canonical;
  try {
    const url = new URL(action.href);
    const expected = new URL(canonical);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname.replace(/\/$/, '').toLowerCase() === expected.pathname.toLowerCase()
      ? url.href : null;
  } catch {
    return null;
  }
}

/** One primary destination for Inbox (including mobile) and push click-through. */
export function notificationHref(notification: NotificationLinkSource): string {
  const { target, metadata, action } = notification;
  const goalId = metadata?.goalId;
  if ((target.type === 'task' || target.type === 'pull_request')
    && typeof goalId === 'string' && goalId.trim()) {
    return `/goals/${encodeURIComponent(goalId)}`;
  }
  switch (target.type) {
    case 'plan': return `/studio/${encodeURIComponent(target.draftId)}`;
    case 'task': return `/tasks/${encodeURIComponent(target.taskId)}`;
    case 'review':
      if (target.taskId) return `/tasks/${encodeURIComponent(target.taskId)}`;
      break;
    case 'pull_request': {
      const taskId = metadata?.completedImplementationTaskId;
      if (typeof taskId === 'string' && taskId.trim()) return `/tasks/${encodeURIComponent(taskId)}`;
      break;
    }
    case 'indexing': {
      const [owner, repository] = target.repository.split('/');
      if (!owner || !repository) return '/repositories';
      const path = `/summaries/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const href = action?.type === 'navigate' ? action.href : path;
      const url = new URL(href, 'https://propr.invalid');
      const rawBranch = target.branch ?? '';
      let start = 0;
      let end = rawBranch.length;
      // Trim only ASCII whitespace in linear time, without regex backtracking.
      const whitespace = ' \t\n\r\f\v';
      while (start < end && whitespace.includes(rawBranch[start])) start++;
      while (end > start && whitespace.includes(rawBranch[end - 1])) end--;
      const branch = rawBranch.slice(start, end);
      if (branch && url.pathname === path && !url.searchParams.has('branch')) {
        url.searchParams.append('branch', branch);
        return `${url.pathname}${url.search}${url.hash}`;
      }
      return href;
    }
    case 'system_failure': return action?.type === 'navigate' ? action.href : '/';
  }
  return action?.type === 'navigate' ? action.href
    : notificationPullRequestUrl(notification) ?? '/repositories';
}
