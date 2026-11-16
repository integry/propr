import {
  PLUGIN_PROPR_LIMITS, PLUGIN_REPOSITORY_PATTERN, PluginDeliveryError, PluginSdkError,
  type PluginContext, type PluginJsonValue, type PluginSettingValues, type RepositoryEvent,
} from '@propr/shared';
import { eventName } from './eventSelection.js';
import { addPullRequest, deleteLink, findLink, readLink, withTicketLock, writeLink, type TrackerLink } from './trackerLinks.js';

/**
 * What the issue tracker plugins (Linear, Jira) share: starting work from a
 * ticket by creating one GitHub issue for it, and the sync-back of ProPR's
 * progress to the ticket. Uses SDK types only.
 *
 * Ticket text is untrusted. It becomes the GitHub issue's title and body and
 * nothing else: the repository comes from the plugin's mapping, the only
 * label from its settings and the model from ProPR's own routing. The body
 * quotes it inert (no HTML, no hidden `<!-- … -->` marker ProPR reads, no
 * @-mention, no line a command could start on). It is never logged, never
 * returned to Activity and never sent anywhere else. Comments posted back to
 * the ticket are fixed text with numbers, coded values and GitHub links only:
 * never code, logs, prompt text or tool output.
 */

/** The longest ticket title and description taken into an issue. */
export const TICKET_LIMITS = { titleChars: 200, descriptionChars: 20_000 } as const;

/** A ticket as a tracker plugin read it from its service's webhook. */
export interface Ticket {
  /** The service's id of the ticket, the de-duplication key. */
  id: string;
  /** The human key, such as `ENG-123`. */
  key: string;
  url: string | null;
  title: string;
  description: string;
  /** The service scope state moves are resolved in (a Linear team id). */
  scope: string | null;
}

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g;

/** The issue title: the ticket key and its title, on one line, without `<` and `>`, cut to the limit. */
export function trackerIssueTitle(ticket: Pick<Ticket, 'key' | 'title'>): string {
  const title = ticket.title.replace(CONTROL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  const capped = title.length > TICKET_LIMITS.titleChars ? `${title.slice(0, TICKET_LIMITS.titleChars - 1).trimEnd()}…` : title;
  return `${ticket.key}: ${capped || 'Untitled ticket'}`.slice(0, PLUGIN_PROPR_LIMITS.titleChars);
}

/**
 * Untrusted text as inert GitHub Markdown: every line quoted (so no line is a
 * command or a heading of ProPR's own), `&`, `<` and `>` written as entities
 * (so no HTML and no hidden `<!-- … -->` marker), and `@` mentions broken
 * with a word joiner so nobody is notified.
 */
export function inertQuote(text: string, limit: number = TICKET_LIMITS.descriptionChars): string {
  const plain = text.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  const capped = plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
  return capped
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, '$1@⁠')
    .split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}

/** A link target: an `https://` URL without spaces or Markdown brackets; null otherwise. */
const safeUrl = (url: string | null): string | null => (url && /^https:\/\/[^\s()<>[\]]+$/.test(url) ? url : null);

/** The issue body: where it came from, the ticket's description quoted inert, the link back. */
export function trackerIssueBody(service: string, ticket: Ticket): string {
  const link = safeUrl(ticket.url);
  return [
    `Started from ${service} ticket ${ticket.key}. The ticket's description, as written there:`,
    '',
    ticket.description.trim() ? inertQuote(ticket.description) : '> (The ticket has no description.)',
    '',
    link ? `${service} ticket: [${ticket.key}](${link})` : `${service} ticket: ${ticket.key}`,
    '',
    `_Created by the ProPR ${service} plugin. The repository comes from the plugin's mapping and the label from its settings; the ticket's text chooses neither, nor the model. Removing the trigger label or closing the ticket does not stop the work._`,
  ].join('\n');
}

/** `ctx.propr.createIssue` refusals that prove no issue was created. */
const NOT_CREATED = new Set(['permission_denied', 'repository_not_allowed', 'invalid_input', 'not_found']);

export type StartOutcome = 'created' | 'duplicate';
export interface StartResult { [key: string]: PluginJsonValue; outcome: StartOutcome; repository: string; issue: number | null; url: string | null }

/**
 * Create the GitHub issue for a ticket, once. A ticket that already has a
 * link (created, or being created by an attempt that may have succeeded)
 * creates nothing. A creation that fails in a way that may still have
 * created the issue fails the delivery permanently and keeps the pending
 * link, so it is never tried again. `after` runs under the same per-ticket
 * lock once the ticket has its issue (on a repeat too, so a step a failed
 * attempt left undone is done by its retry).
 */
export async function startFromTicket(ctx: PluginContext, input: { service: string; ticket: Ticket; repository: string; label: string }, after?: (link: TrackerLink) => Promise<void>): Promise<StartResult> {
  return withTicketLock(input.ticket.id, async () => {
    const started = await createOnce(ctx, input);
    // Still under the ticket's lock, so a concurrent delivery cannot do it too: what follows the creation (the comment with the issue link).
    const link = after ? await readLink(ctx, input.ticket.id) : undefined;
    if (link?.s === 'created') await after!(link);
    return started;
  });
}

async function createOnce(ctx: PluginContext, input: { service: string; ticket: Ticket; repository: string; label: string }): Promise<StartResult> {
  const { ticket, repository, label, service } = input;
  const seen = await readLink(ctx, ticket.id);
  if (seen) {
    if (seen.s === 'pending') ctx.log.warn(`${ticket.key} was handed to ProPR before, but creating its issue was interrupted; nothing is created again. Check ${seen.r} for the issue`, { ticket: ticket.key, repository: seen.r });
    return { outcome: 'duplicate', repository: seen.r, issue: seen.n ?? null, url: null };
  }
  if (!(await writeLink(ctx, { t: ticket.id, k: ticket.key, s: 'pending', r: repository, ...(ticket.scope ? { g: ticket.scope } : {}) }))) {
    throw new PluginDeliveryError('The plugin cannot remember another ticket right now; the delivery is retried later', { retryAfterMs: 10 * 60_000 });
  }
  let created: { number: number; url: string };
  try {
    created = await ctx.propr.createIssue(repository, { title: trackerIssueTitle(ticket), body: trackerIssueBody(service, ticket), labels: [label] });
  } catch (error) {
    if (error instanceof PluginSdkError && NOT_CREATED.has(error.code)) {
      await deleteLink(ctx, ticket.id);
      throw new PluginDeliveryError(`The issue for ${ticket.key} was not created in ${repository}: ${error.message}`, { permanent: true });
    }
    throw new PluginDeliveryError(`Creating the issue for ${ticket.key} in ${repository} failed and it may have been created anyway; it is not retried, so a ticket creates at most one issue. Check the repository`, { permanent: true });
  }
  await writeLink(ctx, { t: ticket.id, k: ticket.key, s: 'created', r: repository, n: created.number, ...(ticket.scope ? { g: ticket.scope } : {}) });
  ctx.log.info(`Created issue #${created.number} in ${repository} for ${ticket.key}`, { ticket: ticket.key, repository, issue: created.number });
  return { outcome: 'created', repository, issue: created.number, url: created.url };
}

/** The sync-back events, each switched on or off in the plugin's settings. */
export const SYNC_KINDS = ['issue_created', 'task_started', 'pull_request_opened', 'review_goal_reached', 'pull_request_merged', 'pull_request_closed', 'task_failed'] as const;
export type SyncKind = typeof SYNC_KINDS[number];
/** The journal events the tracker plugins subscribe to for the sync-back. */
export const SYNC_SUBSCRIPTIONS = ['task.started', 'task.failed', 'pull_request.opened', 'pull_request.review_scored', 'pull_request.merged', 'pull_request.closed'] as const;

const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const code = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,64}$/.test(value) ? value : null);

/** Whether a scored review reached its goal: the payload says so, or the score is at least the goal. */
function goalReached(payload: Record<string, unknown>): boolean {
  if (payload.goalReached === true) return true;
  if (payload.goalReached === false) return false;
  const score = finite(payload.score); const goal = finite(payload.goal);
  return score !== null && goal !== null && score >= goal;
}

/** The sync-back kind of a journal event, or null for one that is not a sync-back (a follow-up starting, a review below its goal). */
export function syncKind(event: Pick<RepositoryEvent, 'domain' | 'type' | 'payload'>): SyncKind | null {
  switch (eventName(event)) {
    case 'task.started': return event.payload.kind === 'implementation' ? 'task_started' : null;
    case 'task.failed': return 'task_failed';
    case 'pull_request.opened': return 'pull_request_opened';
    case 'pull_request.review_scored': return goalReached(event.payload) ? 'review_goal_reached' : null;
    case 'pull_request.merged': return 'pull_request_merged';
    case 'pull_request.closed': return 'pull_request_closed';
    default: return null;
  }
}

/** The sync-back kinds switched on in a list setting; unknown entries are dropped. */
export function switchedOn(settings: PluginSettingValues, key: string): SyncKind[] {
  const value = settings[key];
  return Array.isArray(value) ? SYNC_KINDS.filter(kind => value.includes(kind)) : [];
}

/** The issue number a ProPR branch names (`<issue>/…` or `<issue>-…`), or null. */
export const branchIssueNumber = (headRef: string): number | null => integer(Number(/^(\d{1,9})[/-]/.exec(headRef)?.[1]));

/**
 * The ticket link an event is about: by its issue (an implementation task),
 * by a pull request already found for a ticket, or by the issue number the
 * pull request's branch names (which is then remembered). Null for an event
 * about no ticket.
 */
export async function eventLink(ctx: PluginContext, event: RepositoryEvent): Promise<{ link: TrackerLink; pullRequest: number | null } | null> {
  if (!PLUGIN_REPOSITORY_PATTERN.test(event.repository)) return null;
  const pullRequest = integer(event.prNumber) ?? (event.domain === 'task' ? integer(event.payload.prNumber) : null);
  const issue = integer(event.issueNumber) ?? (event.domain === 'task' ? integer(event.payload.issueNumber) : null);
  const found = await findLink(ctx, event.repository, { issue, pullRequest });
  if (found) return { link: found, pullRequest };
  if (pullRequest === null || event.domain !== 'pull_request') return null;
  let headRef: string;
  try {
    headRef = (await ctx.propr.getPullRequest(event.repository, pullRequest)).headRef;
  } catch (error) {
    if (error instanceof PluginSdkError && (error.code === 'not_found' || error.code === 'permission_denied' || error.code === 'repository_not_allowed')) return null;
    throw error;
  }
  const fromBranch = branchIssueNumber(headRef);
  const link = fromBranch === null ? undefined : await findLink(ctx, event.repository, { issue: fromBranch });
  if (!link) return null;
  return { link: await addPullRequest(ctx, link, pullRequest), pullRequest };
}

/** The sync-back step key of an event: the same for a repeated delivery, so no update is posted twice. */
export function syncStep(kind: SyncKind, event: RepositoryEvent, pullRequest: number | null): string {
  const task = event.domain === 'task' ? code(event.entityId) ?? code(event.payload.taskId) ?? String(event.seq) : null;
  switch (kind) {
    case 'issue_created': return 'created';
    case 'task_started': return `started:${task}`;
    case 'task_failed': return `failed:${task}:${integer(event.payload.attempts) ?? 0}`;
    default: return `${kind}#${pullRequest ?? 0}`;
  }
}

const issueLink = (repository: string, number: number) => `[${repository}#${number}](https://github.com/${repository}/issues/${number})`;
const pullLink = (repository: string, number: number | null) => (number === null ? 'its pull request' : `pull request [${repository}#${number}](https://github.com/${repository}/pull/${number})`);
const shown = (value: number) => Math.round(value * 10) / 10;

/**
 * The comment of a sync-back kind: fixed text, numbers, coded values and
 * GitHub links built from the repository name. Nothing else reaches it.
 */
export function syncComment(kind: SyncKind, link: Pick<TrackerLink, 'r' | 'n'>, event: Pick<RepositoryEvent, 'payload'> | null, pullRequest: number | null): string {
  const repository = PLUGIN_REPOSITORY_PATTERN.test(link.r) ? link.r : 'the repository';
  const issue = link.n ? issueLink(repository, link.n) : 'its GitHub issue';
  const p = event?.payload ?? {};
  switch (kind) {
    case 'issue_created': return `ProPR created GitHub issue ${issue} for this ticket. Its task starts from there; progress is posted here.`;
    case 'task_started': return `ProPR started working on this ticket (${issue}).`;
    case 'pull_request_opened': return `ProPR opened ${pullLink(repository, pullRequest)} for this ticket.`;
    case 'review_goal_reached': {
      const score = finite(p.score); const goal = finite(p.goal);
      const detail = score === null ? '' : ` (score ${shown(score)}${goal === null ? '' : `, goal ${shown(goal)}`})`;
      return `The review of ${pullLink(repository, pullRequest)} reached its goal${detail}.`;
    }
    case 'pull_request_merged': return `${pullLink(repository, pullRequest).replace(/^p/, 'P')} was merged.`;
    case 'pull_request_closed': return `${pullLink(repository, pullRequest).replace(/^p/, 'P')} was closed without merging.`;
    case 'task_failed': {
      const failure = code(p.failureCategory) ?? code(p.terminalReason);
      return `A ProPR task for this ticket failed${failure ? ` (${failure})` : ''}. The details are in ProPR, on ${issue}.`;
    }
  }
}
