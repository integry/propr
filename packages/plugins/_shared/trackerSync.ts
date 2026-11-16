import { PluginDeliveryError, PluginSdkError, type PluginContext, type PluginEventInput, type PluginSettingValues, type RepositoryEvent } from '@propr/shared';
import { findTicketByIssue, findTicketByPullRequest, readProgress, updateProgress, withPullRequest, type TicketRecord } from './trackerRecords.js';

/**
 * Sync-back for issue tracker plugins (Linear, Jira): which ProPR events
 * update a ticket handed to ProPR, and how. Each event is switched on or off
 * in a list setting; the two state moves (pull request opened, merged) are on
 * when their state setting is set. Every action is done at most once per
 * ticket: its marker is recorded in the ticket's progress once it succeeded,
 * so a redelivered event does nothing again, and an action that failed is
 * tried again with the redelivery while the others are not repeated. A move
 * a later move has overtaken (the opening move of a pull request already
 * merged, retried by hand) is never made: it would undo the later state.
 *
 * Messages are built here from identifiers, numbers and coded values only:
 * never code, logs, prompt text, tool output or free-text reasons.
 */

export const TRACKER_SYNC_EVENTS = ['task.started', 'pull_request.opened', 'review.goal_reached', 'pull_request.merged', 'pull_request.closed', 'task.failed'] as const;
export type TrackerSyncEvent = typeof TRACKER_SYNC_EVENTS[number];
export type TrackerMove = 'opened' | 'merged';

/** One sentence, optionally followed by a link (a GitHub issue or pull request). */
export interface SyncMessage { sentence: string; link: { label: string; url: string } | null }
/** `supersededBy`: the marker of the later move that makes this one obsolete once done. */
export type SyncAction = { kind: 'comment'; marker: string; message: SyncMessage } | { kind: 'move'; marker: string; move: TrackerMove; supersededBy: string | null };
export interface SyncPlan { ticket: TicketRecord; event: TrackerSyncEvent; actions: SyncAction[] }
export type SyncOutcome = { plan: SyncPlan; skipped: null } | { plan: null; skipped: 'not_tracked' | 'not_a_sync_event' | 'switched_off' | 'done' };

export interface SyncSettings {
  /** The sync-back events switched on. */
  events: readonly string[];
  /** Whether each state move is configured. */
  moves: Readonly<Record<TrackerMove, boolean>>;
}

/** The sync-back events a list setting switches on; unset means all of them. */
export function syncEventsSetting(settings: PluginSettingValues, key: string): string[] {
  const value = settings[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [...TRACKER_SYNC_EVENTS];
}

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);
/** A coded value (`timed_out`, a task id) that is safe to show: short, letters, digits, `_`, `-` and `.`. */
const coded = (value: unknown, max = 40): string | null => (typeof value === 'string' && new RegExp(`^[A-Za-z0-9_.-]{1,${max}}$`).test(value) ? value : null);
const score = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null);

async function issueLink(ctx: PluginContext, repository: string, number: number): Promise<SyncMessage['link']> {
  try {
    const issue = await ctx.propr.getIssue(repository, number);
    return /^https:\/\//.test(issue.url) ? { label: `${repository}#${number}`, url: issue.url } : null;
  } catch { return null; }
}

async function pullLink(ctx: PluginContext, repository: string, number: number): Promise<SyncMessage['link']> {
  try {
    const pull = await ctx.propr.getPullRequest(repository, number);
    return /^https:\/\//.test(pull.url) ? { label: `${repository}#${number}`, url: pull.url } : null;
  } catch { return null; }
}

/**
 * The ticket of a pull request: linked earlier (from the task that opened it),
 * or found from its head branch, which ProPR names `<issue number>/…`. Only
 * tickets this plugin handed over are found; a link found is remembered. The
 * branch is read for every event that syncs back, not only the opening: an
 * opening delivery whose lookup failed until its retries ran out wrote no
 * link, and the merge or close would otherwise never reach the ticket.
 */
async function ticketOfPullRequest(ctx: PluginContext, repository: string, pr: number): Promise<TicketRecord | undefined> {
  const linked = await findTicketByPullRequest(ctx, repository, pr);
  if (linked) return linked;
  let head = '';
  try { head = (await ctx.propr.getPullRequest(repository, pr)).headRef; } catch (error) { throw lookupFailure(error, pr); }
  const issue = positive(Number(/^(\d{1,9})\//.exec(head)?.[1]));
  const ticket = issue ? await findTicketByIssue(ctx, repository, issue) : undefined;
  if (ticket) await linkPullRequest(ctx, ticket, pr);
  return ticket;
}

/**
 * A failed read of the pull request is not "no ticket": the delivery fails so
 * it is retried, otherwise the link is never written and the ticket misses
 * this and every later update. A refusal (permission, repository) is not
 * retried; anything else (ProPR or GitHub unavailable) is.
 */
function lookupFailure(error: unknown, pr: number): PluginDeliveryError {
  const permanent = error instanceof PluginSdkError && error.code !== 'unavailable';
  return new PluginDeliveryError(`ProPR could not read pull request #${pr} to find its ticket${permanent ? ` (${error.code}); it is not retried` : '; it is retried'}`, { permanent });
}

/** Link a pull request to its ticket, keeping the ticket's earlier ones: one still open syncs back when it merges or closes. */
async function linkPullRequest(ctx: PluginContext, ticket: TicketRecord, pr: number): Promise<void> {
  await updateProgress(ctx, ticket.t, progress => {
    const pulls = withPullRequest(progress, pr);
    return pulls ? { t: ticket.t, p: pulls, d: progress.d } : undefined;
  });
}

interface Step { event: TrackerSyncEvent; ticket: TicketRecord; marker: string; message: () => Promise<SyncMessage>; move: TrackerMove | null; supersededBy?: string }

/** The step of a task event: started, failed, or completed having opened the ticket's pull request. */
async function taskStep(ctx: PluginContext, event: RepositoryEvent): Promise<Step | null> {
  const payload = event.payload as { taskId?: unknown; kind?: unknown; issueNumber?: unknown; prNumber?: unknown; pullRequest?: unknown; failureCategory?: unknown };
  const issue = positive(event.issueNumber ?? payload.issueNumber);
  const pr = positive(event.prNumber ?? payload.prNumber);
  const task = coded(payload.taskId, 64) ?? 'task';
  const ticket = issue ? await findTicketByIssue(ctx, event.repository, issue) : pr ? await findTicketByPullRequest(ctx, event.repository, pr) : undefined;
  if (!ticket || !ticket.n) return null;
  const number = ticket.n;
  if (event.type === 'started' && payload.kind === 'implementation') {
    return { event: 'task.started', ticket, marker: `started:${task}`, move: null, message: async () => ({ sentence: 'ProPR started working on this ticket.', link: await issueLink(ctx, ticket.r, number) }) };
  }
  if (event.type === 'failed') {
    const category = coded(payload.failureCategory);
    return { event: 'task.failed', ticket, marker: `failed:${task}`, move: null, message: async () => ({ sentence: `ProPR's task for this ticket failed${category ? ` (${category})` : ''}. ProPR shows the details.`, link: await issueLink(ctx, ticket.r, number) }) };
  }
  if (event.type === 'completed' && payload.pullRequest === 'opened' && pr) {
    await linkPullRequest(ctx, ticket, pr);
    return openedStep(ctx, ticket, event.repository, pr);
  }
  return null;
}

const openedStep = (ctx: PluginContext, ticket: TicketRecord, repository: string, pr: number): Step => ({
  event: 'pull_request.opened', ticket, marker: `opened:${pr}`, move: 'opened',
  // Once the merge moved the ticket, the opening move (a failed delivery retried by hand) would move it back.
  supersededBy: `merged:${pr}:move`,
  message: async () => ({ sentence: 'ProPR opened a pull request for this ticket.', link: await pullLink(ctx, repository, pr) }),
});

type PullStep = Omit<Step, 'ticket' | 'message'> & { message: (link: () => Promise<SyncMessage['link']>) => Promise<SyncMessage> };

/** What a pull request event syncs back, before its ticket is looked up: null for one that never does. */
function pullRequestStepOf(event: RepositoryEvent, pr: number): PullStep | null {
  switch (event.type) {
    case 'merged': return { event: 'pull_request.merged', marker: `merged:${pr}`, move: 'merged', message: async link => ({ sentence: 'The pull request for this ticket was merged.', link: await link() }) };
    case 'closed': return { event: 'pull_request.closed', marker: `closed:${pr}`, move: null, message: async link => ({ sentence: 'The pull request for this ticket was closed without merging.', link: await link() }) };
    case 'review_scored': {
      const payload = event.payload as { goalReached?: unknown; score?: unknown; goal?: unknown };
      if (payload.goalReached !== true) return null;
      const [value, goal] = [score(payload.score), score(payload.goal)];
      const detail = value === null ? '' : `: score ${value}${goal === null ? '' : ` (goal ${goal})`}`;
      return { event: 'review.goal_reached', marker: `goal:${pr}`, move: null, message: async link => ({ sentence: `The review of the pull request for this ticket reached its goal${detail}.`, link: await link() }) };
    }
    default: return null;
  }
}

/** The step of a pull request event about a ticket's pull request. */
async function pullRequestStep(ctx: PluginContext, event: RepositoryEvent): Promise<Step | null> {
  const pr = positive(event.prNumber);
  if (!pr) return null;
  const step = event.type === 'opened' ? null : pullRequestStepOf(event, pr);
  if (event.type !== 'opened' && !step) return null;
  const ticket = await ticketOfPullRequest(ctx, event.repository, pr);
  if (!ticket) return null;
  if (!step) return openedStep(ctx, ticket, event.repository, pr);
  return { ...step, ticket, message: () => step.message(() => pullLink(ctx, event.repository, pr)) };
}

/**
 * What one event does to the ticket it is about: the comment (when its event
 * is switched on) and the state move (when configured), each not yet done.
 * Null, with the reason, when the event is about no ticket this plugin handed
 * over, is not a sync-back event, is switched off or was done already.
 */
export async function planSync(ctx: PluginContext, input: PluginEventInput, settings: SyncSettings): Promise<SyncOutcome> {
  const { event } = input;
  const step = event.domain === 'task' ? await taskStep(ctx, event) : event.domain === 'pull_request' ? await pullRequestStep(ctx, event) : null;
  if (!step) return { plan: null, skipped: event.domain === 'task' || event.domain === 'pull_request' ? 'not_tracked' : 'not_a_sync_event' };
  const done = (await readProgress(ctx, step.ticket.t)).d;
  const actions: SyncAction[] = [];
  const comment = `${step.marker}:comment`;
  if (settings.events.includes(step.event) && !done.includes(comment)) actions.push({ kind: 'comment', marker: comment, message: await step.message() });
  const move = `${step.marker}:move`;
  const superseded = !!step.supersededBy && done.includes(step.supersededBy);
  if (step.move && settings.moves[step.move] && !done.includes(move) && !superseded) actions.push({ kind: 'move', marker: move, move: step.move, supersededBy: step.supersededBy ?? null });
  if (!actions.length) return { plan: null, skipped: settings.events.includes(step.event) || (step.move && settings.moves[step.move]) ? 'done' : 'switched_off' };
  return { plan: { ticket: step.ticket, event: step.event, actions }, skipped: null };
}

/**
 * Whether a planned move has been overtaken since it was planned: read again
 * just before the tracker is changed, so a merge synced while this delivery
 * posted its comment or read the ticket is not undone. (A merge landing
 * between this read and the tracker's own update is not prevented.)
 */
export async function moveSuperseded(ctx: PluginContext, ticket: TicketRecord, action: Extract<SyncAction, { kind: 'move' }>): Promise<boolean> {
  return !!action.supersededBy && (await readProgress(ctx, ticket.t)).d.includes(action.supersededBy);
}

/** Record that an action was done, so a redelivery does not repeat it. */
export async function markSyncDone(ctx: PluginContext, ticket: TicketRecord, marker: string): Promise<void> {
  await updateProgress(ctx, ticket.t, progress => (progress.d.includes(marker) ? undefined : { ...progress, d: [...progress.d, marker] }));
}
