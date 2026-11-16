import { PLUGIN_REPOSITORY_PATTERN, type PluginSettingValues, type RepositoryEvent } from '@propr/shared';
import { eventName } from './eventSelection.js';

/**
 * Event-to-message formatting shared by the chat notification plugins
 * (Slack, Discord, Microsoft Teams). It turns a journal event into a neutral
 * notification (a title, facts and links) that each plugin renders in its
 * service's format. Uses SDK types only.
 *
 * Every word of a notification is either fixed text written here or a value
 * from an allowlist: numbers, identifiers, coded states (short, without
 * spaces) and links built from the repository name. Free text (the Ultrafix
 * reason, the epic queue's blocked reason, titles), code, logs, prompt text,
 * tool output and credentials never reach a message.
 */

/** The journal events the chat plugins subscribe to. */
export const NOTIFICATION_SUBSCRIPTIONS = [
  'pull_request.opened', 'pull_request.review_scored', 'pull_request.ultrafix_ended', 'pull_request.merged', 'pull_request.closed',
  'task.failed', 'epic_queue.blocked', 'epic_queue.completed',
] as const;

/**
 * What an administrator selects in the `events` setting. A scored review is
 * one of two choices: below the threshold, or at or above it.
 */
export const NOTIFICATION_KINDS = [
  'pull_request.opened', 'review.below_threshold', 'review.at_or_above_threshold', 'pull_request.ultrafix_ended',
  'pull_request.merged', 'pull_request.closed', 'task.failed', 'epic_queue.blocked', 'epic_queue.completed',
] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** The setting keys every chat plugin's manifest defines. */
export const NOTIFICATION_SETTINGS = {
  events: 'events', reviewThreshold: 'reviewThreshold', proprUrl: 'proprUrl', repositoryDestinations: 'repositoryDestinations',
} as const;
/** The review threshold when neither the setting nor the review's own goal gives one. */
export const DEFAULT_REVIEW_THRESHOLD = 80;

export type NotificationTone = 'success' | 'failure' | 'warning' | 'info';
export interface NotificationFact { label: string; value: string }
export interface NotificationLink { label: string; url: string }
export interface Notification {
  kind: NotificationKind;
  /** The journal event name, such as `pull_request.merged`. */
  event: string;
  tone: NotificationTone;
  /** One line, such as `Pull request #12 merged in acme/api`. */
  title: string;
  facts: NotificationFact[];
  /** The pull request, the issue and the task in the ProPR UI, as far as the event names them. */
  links: NotificationLink[];
  repository: string;
}

/** A coded value (a state, a model or a category): short, without spaces. Anything else, prose included, is left out. */
const CODE = /^[A-Za-z0-9._:/@+-]{1,64}$/;
const code = (value: unknown): string | null => (typeof value === 'string' && CODE.test(value) ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const score = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

const ULTRAFIX_OUTCOMES: Record<string, { text: string; tone: NotificationTone }> = {
  goal_reached: { text: 'reached its goal', tone: 'success' },
  cycles_exhausted: { text: 'used all its cycles', tone: 'warning' },
  style_findings_only: { text: 'ended with style findings only', tone: 'warning' },
  stopped: { text: 'was stopped', tone: 'warning' },
  failed: { text: 'failed', tone: 'failure' },
};
const TASK_KINDS: Record<string, string> = {
  implementation: 'Implementation task', 'follow-up': 'Follow-up task', review: 'Review task', 'merge-conflict': 'Merge conflict task', automation: 'Automation run',
};

const textList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** The selected notification kinds of the `events` setting; unknown entries are dropped. */
export function selectedKinds(settings: PluginSettingValues): NotificationKind[] {
  return textList(settings[NOTIFICATION_SETTINGS.events]).filter((kind): kind is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(kind));
}

/** The threshold a scored review is compared with: the setting, else the review's goal, else `DEFAULT_REVIEW_THRESHOLD`. */
export function reviewThreshold(settings: PluginSettingValues, event: Pick<RepositoryEvent, 'payload'>): number {
  const setting = settings[NOTIFICATION_SETTINGS.reviewThreshold];
  if (typeof setting === 'number' && Number.isFinite(setting)) return setting;
  return score(event.payload.goal) ?? DEFAULT_REVIEW_THRESHOLD;
}

/** The notification kind of an event, or null for an event no kind covers (or a review without a score). */
export function notificationKind(settings: PluginSettingValues, event: Pick<RepositoryEvent, 'domain' | 'type' | 'payload'>): NotificationKind | null {
  const name = eventName(event);
  if (name === 'pull_request.review_scored') {
    const value = score(event.payload.score);
    if (value === null) return null;
    return value < reviewThreshold(settings, event) ? 'review.below_threshold' : 'review.at_or_above_threshold';
  }
  return (NOTIFICATION_KINDS as readonly string[]).includes(name) ? name as NotificationKind : null;
}

/**
 * The ProPR UI base URL of the `proprUrl` setting: an `http(s)://` URL without
 * credentials, query or fragment, with no trailing slash. Null when unset or
 * not acceptable (messages then carry no ProPR links).
 */
export function proprBaseUrl(settings: PluginSettingValues): string | null {
  const value = settings[NOTIFICATION_SETTINGS.proprUrl];
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function links(event: RepositoryEvent, settings: PluginSettingValues): NotificationLink[] {
  const repository = PLUGIN_REPOSITORY_PATTERN.test(event.repository) ? event.repository : null;
  const base = repository ? `https://github.com/${repository}` : null;
  const result: NotificationLink[] = [];
  const pr = integer(event.prNumber) ?? (event.domain === 'task' ? integer(event.payload.prNumber) : null);
  const issue = integer(event.issueNumber) ?? (event.domain === 'task' ? integer(event.payload.issueNumber) : null);
  if (base && pr !== null) result.push({ label: `Pull request #${pr}`, url: `${base}/pull/${pr}` });
  if (event.domain === 'epic_queue') {
    // The queue's epic issue, and the issue it is blocked at.
    const head = event.type === 'blocked' ? integer(event.payload.headIssue) : null;
    if (base && head !== null) result.push({ label: `Issue #${head}`, url: `${base}/issues/${head}` });
    if (base && issue !== null && issue !== head) result.push({ label: `Epic #${issue}`, url: `${base}/issues/${issue}` });
  } else if (base && issue !== null) result.push({ label: `Issue #${issue}`, url: `${base}/issues/${issue}` });
  const propr = proprBaseUrl(settings);
  const task = event.domain === 'task' ? code(event.entityId) ?? code(event.payload.taskId) : null;
  if (propr && task) result.push({ label: 'Task in ProPR', url: `${propr}/tasks/${encodeURIComponent(task)}` });
  return result;
}

const repositoryName = (event: RepositoryEvent) => (PLUGIN_REPOSITORY_PATTERN.test(event.repository) ? event.repository : 'a repository');

function describe(kind: NotificationKind, event: RepositoryEvent, settings: PluginSettingValues): Pick<Notification, 'tone' | 'title' | 'facts'> {
  const p = event.payload;
  const repository = repositoryName(event);
  const pr = integer(event.prNumber);
  const subject = pr === null ? 'A pull request' : `Pull request #${pr}`;
  const facts: NotificationFact[] = [];
  const fact = (label: string, value: string | number | null) => { if (value !== null) facts.push({ label, value: String(value) }); };
  switch (kind) {
    case 'pull_request.opened':
      fact('Base branch', code(p.baseRef));
      if (p.draft === true) fact('Draft', 'yes');
      return { tone: 'info', title: `${subject} opened in ${repository}`, facts };
    case 'review.below_threshold':
    case 'review.at_or_above_threshold': {
      const threshold = reviewThreshold(settings, event);
      const below = kind === 'review.below_threshold';
      fact('Score', score(p.score));
      fact('Threshold', threshold);
      fact('Review cycle', integer(p.cycle));
      fact('Reviewer model', code(p.reviewerModel));
      return { tone: below ? 'warning' : 'success', title: `${subject} in ${repository} scored ${score(p.score)}, ${below ? 'below' : 'at or above'} ${threshold}`, facts };
    }
    case 'pull_request.ultrafix_ended': {
      const outcome = ULTRAFIX_OUTCOMES[String(p.outcome)];
      fact('Outcome', code(p.outcome));
      fact('Final score', score(p.finalScore));
      return { tone: outcome?.tone ?? 'info', title: `Ultrafix on ${pr === null ? 'a pull request' : `pull request #${pr}`} in ${repository} ${outcome?.text ?? 'ended'}`, facts };
    }
    case 'pull_request.merged':
      return { tone: 'success', title: `${subject} merged in ${repository}`, facts };
    case 'pull_request.closed':
      return { tone: 'info', title: `${subject} closed without merging in ${repository}`, facts };
    case 'task.failed': {
      fact('Failure', code(p.failureCategory) ?? code(p.terminalReason));
      fact('Agent', code(p.agent));
      fact('Model', code(p.model));
      fact('Attempts', integer(p.attempts));
      const minutes = integer(p.durationMs);
      if (minutes !== null) fact('Duration', `${Math.max(1, Math.round(minutes / 60_000))} min`);
      return { tone: 'failure', title: `${TASK_KINDS[String(p.kind)] ?? 'A task'} failed in ${repository}`, facts };
    }
    case 'epic_queue.blocked':
      fact('Blocked at issue', integer(p.headIssue));
      return { tone: 'warning', title: `An epic queue is blocked in ${repository}`, facts };
    case 'epic_queue.completed':
      return { tone: 'success', title: `An epic queue completed in ${repository}`, facts };
  }
}

/** The notification of an event, or null when the event is not one the `events` setting selects. */
export function buildNotification(event: RepositoryEvent, settings: PluginSettingValues): Notification | null {
  const kind = notificationKind(settings, event);
  if (!kind || !selectedKinds(settings).includes(kind)) return null;
  return { kind, event: eventName(event), repository: repositoryName(event), ...describe(kind, event, settings), links: links(event, settings) };
}
