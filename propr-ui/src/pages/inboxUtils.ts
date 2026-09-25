import type { Notification } from '@propr/shared';
import { summaryBrowserPath, summaryHrefWithBranch } from '../utils/summaryBrowser';

/** System and indexing updates are kept apart from the linear activity feed. */
export function isSystemNotification(notification: Notification): boolean {
  return notification.kind === 'system_failure' || notification.kind === 'indexing';
}

export interface NotificationReference {
  label: string;
  title: string;
}

/** The PR or issue a notification is about, labelled like the task list reference chips. */
export function notificationReference(notification: Notification): NotificationReference | null {
  const { target } = notification;
  const prNumber = target.type === 'review' || target.type === 'pull_request' || target.type === 'task'
    ? target.prNumber
    : undefined;
  if (prNumber !== undefined) return { label: `PR #${prNumber}`, title: `Pull request #${prNumber}` };
  if (target.type !== 'task' || target.issueNumber === undefined) return null;
  return { label: `Issue #${target.issueNumber}`, title: `Issue #${target.issueNumber}` };
}

export interface ReviewOutcome {
  /** Lowest score across the review's reviewers, when any reported one. */
  score: number | null;
  issueCount: number;
  reviewerFailed: boolean;
}

/**
 * Reads the score and finding count from a review recap such as
 * "Score 6/10 · 2 issues found: …" or "Scores 6/10, 8/10 · 1 issue found".
 */
export function notificationReviewOutcome(notification: Notification): ReviewOutcome | null {
  if (notification.kind !== 'review') return null;
  const body = notification.body;
  const scoreText = /\bScores? ((?:\d+(?:\.\d+)?\/10(?:, )?)+)/.exec(body)?.[1] ?? '';
  const scores = [...scoreText.matchAll(/(\d+(?:\.\d+)?)\/10/g)].map(match => Number(match[1]));
  const issueCount = Number(/\b(\d+) issues? found\b/.exec(body)?.[1] ?? 0);
  return {
    score: scores.length > 0 ? Math.min(...scores) : null,
    issueCount,
    reviewerFailed: /\breviewers? failed\b/.test(body),
  };
}

export type NotificationStatusShape = 'circle' | 'diamond' | 'square' | 'triangle';

export interface NotificationStatus {
  shape: NotificationStatusShape;
  /** Background colour of the status mark. */
  className: string;
  label: string;
}

const STATUS = {
  failed: { shape: 'triangle', className: 'bg-red-500', label: 'Failed' },
  attention: { shape: 'square', className: 'bg-amber-500', label: 'Needs attention' },
  action: { shape: 'circle', className: 'bg-teal-500', label: 'Ready for you' },
  done: { shape: 'circle', className: 'bg-slate-400', label: 'Completed' },
} as const satisfies Record<string, NotificationStatus>;

/**
 * Review marks follow the quality shapes from the design guidelines: 9-10 teal
 * circle, 7-8 slate diamond, 5-6 amber square, 0-4 red triangle. Any finding
 * or failed reviewer is at least amber, because a human has to act on it.
 */
function reviewStatus(outcome: ReviewOutcome): NotificationStatus {
  const { score, issueCount, reviewerFailed } = outcome;
  const scoreLabel = score === null ? 'Review' : `Score ${score}/10`;
  const issues = issueCount > 0 ? ` · ${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}` : '';
  const label = `${scoreLabel}${issues}${reviewerFailed ? ' · reviewer failed' : ''}`;
  if (score !== null && score <= 4) return { ...STATUS.failed, label };
  if ((score !== null && score <= 6) || issueCount > 0 || reviewerFailed) return { ...STATUS.attention, label };
  if (score !== null && score <= 8) return { shape: 'diamond', className: 'bg-slate-500', label };
  return score === null ? { ...STATUS.done, label } : { ...STATUS.action, label };
}

/**
 * Status mark for a notification. Colour is kept for what needs a human:
 * failures red, blockers amber, work waiting on the user teal. Finished runs
 * (merges, fixes, completed tasks) stay quiet grey.
 */
export function notificationStatus(notification: Notification): NotificationStatus {
  if (notification.severity === 'error') return STATUS.failed;
  if (notification.severity === 'warning') return STATUS.attention;
  const review = notificationReviewOutcome(notification);
  if (review) return reviewStatus(review);
  if (notification.kind === 'plan') return STATUS.action;
  if (notification.kind === 'pull_request' && notification.metadata?.completionType === undefined) return STATUS.action;
  return STATUS.done;
}

export function notificationKindLabel(notification: Notification): string {
  switch (notification.kind) {
    case 'plan': return 'Plan ready';
    case 'review': return 'Review completed';
    case 'pull_request': {
      const completionType = notification.metadata?.completionType;
      if (completionType === 'fix') return 'Fix completed';
      if (completionType === 'merge') return 'Merge completed';
      if (completionType === 'switch') return 'Model switched';
      return 'PR ready';
    }
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
  if (notification.action?.type === 'navigate') {
    return notification.target.type === 'indexing'
      ? summaryHrefWithBranch(
        notification.action.href,
        notification.target.repository,
        notification.target.branch,
      )
      : notification.action.href;
  }
  switch (notification.target.type) {
    case 'plan': return `/studio/${encodeURIComponent(notification.target.draftId)}`;
    case 'task': return `/tasks/${encodeURIComponent(notification.target.taskId)}`;
    case 'review': return notification.target.taskId
      ? `/tasks/${encodeURIComponent(notification.target.taskId)}`
      : '/tasks';
    case 'pull_request': {
      const completedTaskId = notification.metadata?.completedImplementationTaskId;
      return notificationPullRequestUrl(notification)
        ?? (typeof completedTaskId === 'string' && completedTaskId
          ? `/tasks/${encodeURIComponent(completedTaskId)}`
          : '/repositories');
    }
    case 'indexing': {
      const [owner, repository] = notification.target.repository.split('/');
      return owner && repository
        ? summaryBrowserPath(owner, repository, notification.target.branch)
        : '/repositories';
    }
    case 'system_failure': return '/';
  }
}

/** Returns a trusted GitHub pull-request URL advertised by the event, if any. */
function isTrustedGithubUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && url.hostname === 'github.com'
    && url.username === ''
    && url.password === ''
    && (url.port === '' || url.port === '443')
    && url.search === ''
    && url.hash === '';
}

function notificationPullRequestIdentity(notification: Notification): {
  repository: string | null;
  prNumber: number | undefined;
} {
  const repository = notification.target.type === 'system_failure'
    ? null
    : notification.target.repository;
  switch (notification.target.type) {
    case 'task':
    case 'review':
    case 'pull_request': return { repository, prNumber: notification.target.prNumber };
    default: return { repository, prNumber: undefined };
  }
}

export function notificationPullRequestUrl(notification: Notification): string | null {
  if (notification.action?.type !== 'external_link') return null;
  try {
    const url = new URL(notification.action.href);
    if (!isTrustedGithubUrl(url)) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const { repository, prNumber } = notificationPullRequestIdentity(notification);
    if (repository !== null && `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
      return null;
    }
    if (prNumber !== undefined && Number(match[3]) !== prNumber) return null;
    return url.href;
  } catch {
    return null;
  }
}

export interface NotificationFollowupCommand {
  taskId: string;
  prNumber: number;
  commands: readonly string[];
}

/**
 * The only buttons an Inbox card offers: the common next command after a
 * finished review (/fix) or a finished PR run (/review, /ultrafix).
 */
export function notificationFollowupCommand(notification: Notification): NotificationFollowupCommand | null {
  if (!notification.actions.includes('follow_up')) return null;
  if (notification.target.type === 'review' && notification.target.taskId) {
    return {
      taskId: notification.target.taskId,
      prNumber: notification.target.prNumber,
      commands: ['/fix'],
    };
  }
  const completedTaskId = notification.metadata?.completedImplementationTaskId;
  if (notification.target.type === 'pull_request' && typeof completedTaskId === 'string' && completedTaskId) {
    return {
      taskId: completedTaskId,
      prNumber: notification.target.prNumber,
      commands: ['/review', '/ultrafix'],
    };
  }
  return null;
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

export function compareNewestFirst(left: Notification, right: Notification): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}

export function mergeNotifications(
  current: readonly Notification[],
  incoming: readonly Notification[],
): Notification[] {
  const byId = new Map(current.map(notification => [notification.id, notification]));
  for (const notification of incoming) byId.set(notification.id, notification);
  return [...byId.values()].sort(compareNewestFirst);
}

/**
 * Folds a fresh first page into a list that also holds older pages. Loaded
 * notifications inside the page's range that the server no longer returns were
 * dismissed elsewhere, so they are dropped; older pages are kept as they are.
 * `boundary` is the oldest notification the server returned, or null when the
 * page is the whole Inbox.
 */
export function replaceNotificationRange(
  current: readonly Notification[],
  incoming: readonly Notification[],
  boundary: Notification | null,
): Notification[] {
  const older = boundary
    ? current.filter(notification => compareNewestFirst(notification, boundary) > 0)
    : [];
  return mergeNotifications(older, incoming);
}
