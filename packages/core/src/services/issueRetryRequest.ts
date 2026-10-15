import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';

/**
 * The requester and posted instructions of a requested issue retry. The job
 * the route submits carries them, but a relabel delivery or poll that recovers
 * a failed submission cannot, so they are recorded durably per issue before
 * the trigger is written, and kept until a dispatch carries them into the run
 * or the request is known to be owed none. Elapsed time alone releases nothing.
 *
 * A request belongs only to the trigger it published: the first trigger the
 * route's GitHub identity labels after `afterEventId` (the latest trigger
 * event before the request), within the publication window that opens at
 * `publishedAt`, when its trigger write begins. `requestedAt` only times the
 * reservation, which expires unless publication begins within that window.
 *
 * A request is `reserved` until its trigger write is attempted, then `pending`
 * until the route records the write's outcome: `possible` (applied, or not
 * refused) lets recovery adopt it, and a refusal releases it. While it is
 * pending the outcome is unknown, and dispatch defers the request's trigger
 * rather than run it with or without the request.
 */
export interface IssueRetryRequest {
  id: number;
  requesterId: string;
  commentId: number | null;
  requestedAt: number;
  /** When its trigger write began, which opens its publication window; null while reserved. */
  publishedAt: number | null;
  afterEventId: string | null;
  actorId: number | null;
  publication: 'reserved' | 'pending' | 'possible' | 'refused';
}

export interface TriggerLabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id?: number } }

interface IssueKey { repoOwner: string; repoName: string; number: number }
type Octokit = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'request'>;
interface TimelineDeps { getOctokit?: () => Promise<Octokit>; processingLabels?: () => Promise<string[]> }
/**
 * The issue's trigger history as read at `now`, and the latest trigger its
 * submission consumed, when it has one.
 */
export interface TriggerHistory { events: TriggerLabelEvent[]; now: number; consumedEventId?: string | null }
interface SelectionDeps extends TimelineDeps { database?: Knex; now?: () => number }

/**
 * What a delivery runs for the issue's open request: the request on its own
 * trigger, nothing of its (the delivery's own trigger runs without it), or
 * nothing at all while a request that may own an admitted trigger cannot be
 * reconciled yet. `latestTriggerEventId` is the latest trigger the run
 * consumes. A delivery that admits triggers also learns, from the same
 * history, the latest admitted trigger it runs without a request.
 */
export type RetryRun =
  | { request: IssueRetryRequest; triggerEventId: string; latestTriggerEventId?: string }
  | { request: null; trigger?: { eventId: string } | null }
  | { deferred: IssueRetryRequest };

export interface RetryRunDelivery {
  /** The trigger events a submission admits as a fresh run; an issue-only run admits every one. */
  admitted?: (events: TriggerLabelEvent[]) => Promise<TriggerLabelEvent[]>;
}

// A trigger write whose response was lost lands within this; a first trigger
// after it is not the request's, so a request that was never published is owed nothing.
const PUBLICATION_WINDOW_MS = 10 * 60 * 1000;
// How long requests known to be owed nothing are kept for inspection.
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TABLE = 'issue_retry_request_states';

const owedIssue = (issue: IssueKey) => `${issue.repoOwner}/${issue.repoName}#${issue.number}`;

interface RequestRow {
  id: number; requester_id: string; comment_id: number | string | null; requested_at: number | string;
  published_at: number | string | null; after_event_id: string | null; actor_id: number | string | null; publication: string;
}

function parseRow(row: RequestRow): IssueRetryRequest {
  const publication = ['reserved', 'pending', 'possible', 'refused'].includes(row.publication) ? row.publication as IssueRetryRequest['publication'] : 'pending';
  return {
    id: Number(row.id), requesterId: row.requester_id, requestedAt: Number(row.requested_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    commentId: row.comment_id === null ? null : Number(row.comment_id),
    afterEventId: row.after_event_id, actorId: row.actor_id === null ? null : Number(row.actor_id), publication,
  };
}

/** The issue's trigger-label events, oldest first. */
export async function triggerLabelEvents(octokit: Octokit, issue: IssueKey, triggers: Set<string>): Promise<TriggerLabelEvent[]> {
  const events: TriggerLabelEvent[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: issue.repoOwner, repo: issue.repoName, issue_number: issue.number, per_page: 100, page,
    }) as { data: TriggerLabelEvent[] };
    events.push(...data.filter(item => item.event === 'labeled' && item.label && triggers.has(item.label.name)));
    if (data.length < 100) break;
  }
  return events;
}

/** Whether a trigger write of the request may still land at `time`, or while reserved, whether its write may still begin. */
const windowOpen = (request: IssueRetryRequest, time: number) => time <= (request.publishedAt ?? request.requestedAt) + PUBLICATION_WINDOW_MS;

/**
 * The trigger event the request published: null when it has none, or
 * undefined when its baseline is gone from the history, so none can be told
 * apart as its own.
 */
export function retryRequestTrigger(request: IssueRetryRequest, events: TriggerLabelEvent[]): string | null | undefined {
  const start = request.afterEventId === null ? 0 : events.findIndex(event => String(event.id) === request.afterEventId) + 1;
  if (start === 0 && request.afterEventId !== null) return undefined;
  const published = events.slice(start).find(event => request.actorId === null || event.actor?.id === request.actorId);
  const publishedAt = Date.parse(published?.created_at ?? '');
  if (!published?.id || !Number.isFinite(publishedAt) || !windowOpen(request, publishedAt)) return null;
  return String(published.id);
}

/**
 * Whether the request may still be owed a run: its trigger write is in
 * progress or may still land, or it published a trigger no dispatch has
 * consumed. A request whose write never landed within the publication window,
 * or whose trigger the submission consumed, is owed none.
 */
function mayBeOwed(request: IssueRetryRequest, { events, now, consumedEventId }: TriggerHistory): boolean {
  if (request.publication === 'refused') return false;
  if (request.publication === 'reserved') return windowOpen(request, now);
  const own = retryRequestTrigger(request, events);
  if (own === undefined) return true;
  if (own === null) return windowOpen(request, now);
  const consumed = consumedEventId ? events.findIndex(event => String(event.id) === consumedEventId) : -1;
  // Dispatch only runs past a request's admitted trigger by running the request.
  return consumed < events.findIndex(event => String(event.id) === own);
}

/** The issue's open requests, oldest first. */
export async function findIssueRetryRequests(database: Knex, issue: IssueKey): Promise<IssueRetryRequest[]> {
  const rows = await database(TABLE).where({ owed_issue: owedIssue(issue) }).orderBy('requested_at').select() as RequestRow[];
  return rows.map(parseRow);
}

/**
 * Reserves the issue for a new request, before anything of it is posted or
 * published, unless an earlier request may still be owed a run: a second
 * request could not then be told apart from it, and running either would
 * consume the other's trigger. Requests known to be owed nothing are released.
 * Null when the issue is still owed an earlier request.
 */
export async function reserveIssueRetryRequest(
  database: Knex,
  issue: IssueKey,
  request: Pick<IssueRetryRequest, 'requesterId' | 'requestedAt' | 'afterEventId'>,
  history: TriggerHistory,
): Promise<IssueRetryRequest | null> {
  return database.transaction(async trx => {
    // Only requests known to be owed nothing are ever discarded.
    await trx(TABLE).whereNull('owed_issue').where('recorded_at', '<', history.now - CLOSED_RETENTION_MS).delete();
    const open = await findIssueRetryRequests(trx, issue);
    if (open.some(held => mayBeOwed(held, history))) return null;
    if (open.length > 0) await trx(TABLE).whereIn('id', open.map(held => held.id)).update({ owed_issue: null, recorded_at: history.now });
    // The unique open slot refuses a concurrent reservation the read above could not see.
    const [id] = await trx(TABLE).insert({
      repo_owner: issue.repoOwner, repo_name: issue.repoName, issue_number: issue.number, owed_issue: owedIssue(issue),
      requester_id: request.requesterId, requested_at: request.requestedAt, after_event_id: request.afterEventId,
      publication: 'reserved', recorded_at: history.now,
    }) as number[];
    return { ...request, id: Number(id), commentId: null, actorId: null, publishedAt: null, publication: 'reserved' as const };
  });
}

/**
 * Records the posted request just before its trigger is written, opening its
 * publication window at `now` however long posting it took. The pending
 * request, carrying that window, is what the write's read-back and dispatch
 * match its trigger by. Null when the reservation was released meanwhile, so
 * the trigger must not be written.
 */
export async function beginIssueRetryPublication(
  database: Knex, request: IssueRetryRequest, posted: Pick<IssueRetryRequest, 'commentId' | 'actorId'>, now = Date.now(),
): Promise<IssueRetryRequest | null> {
  const updated = await database(TABLE).where({ id: request.id, publication: 'reserved' }).whereNotNull('owed_issue')
    .update({ comment_id: posted.commentId, actor_id: posted.actorId, published_at: now, publication: 'pending', recorded_at: now });
  return Number(updated) === 1 ? { ...request, ...posted, publishedAt: now, publication: 'pending' } : null;
}

/** Releases a reservation whose trigger was never written. */
export async function releaseIssueRetryReservation(database: Knex, request: IssueRetryRequest): Promise<void> {
  await database(TABLE).where({ id: request.id, publication: 'reserved' }).delete();
}

/**
 * Records the outcome of the request's trigger write: `possible` lets recovery
 * adopt it, and a refusal, which published no trigger of the request, releases
 * it whoever else labels the issue. Recording it again, or after it was
 * released, changes nothing.
 */
export async function recordIssueRetryPublication(
  database: Knex, request: Pick<IssueRetryRequest, 'id'>, publication: 'possible' | 'refused', now = Date.now(),
): Promise<void> {
  await database(TABLE).where({ id: request.id, publication: 'pending' }).whereNotNull('owed_issue')
    .update({ publication, recorded_at: now, ...(publication === 'refused' ? { owed_issue: null } : {}) });
}

/** Records that a dispatch carried the request into its run, which releases it. */
export async function consumeIssueRetryRequest(database: Knex, request: Pick<IssueRetryRequest, 'id'>, now = Date.now()): Promise<void> {
  await database(TABLE).where({ id: request.id }).update({ consumed_at: now, owed_issue: null, recorded_at: now });
}

/**
 * Selects the run a delivery dispatches, by the same rules for a direct job
 * and a recovering relabel or poll: an open request runs only on its own
 * trigger while that trigger is admitted, so a newer, independent trigger
 * does not strand it. One whose outcome is unknown, or whose trigger write may
 * still land, defers the delivery: dispatching another trigger would consume
 * its trigger, and dispatching its own would either drop its requester or
 * adopt a request that may have been refused.
 *
 * The open requests are read after the history, so one still reserved then
 * had written no trigger the history shows, and a delivery that admits
 * triggers takes its own from that same history.
 */
export async function selectRetryRun(
  issue: IssueKey,
  { admitted }: RetryRunDelivery,
  { getOctokit = getAuthenticatedOctokit, processingLabels = loadPrimaryProcessingLabels, database = db, now = Date.now }: SelectionDeps = {},
): Promise<RetryRun> {
  // An issue-only delivery consumes no trigger, so without a request it needs no history.
  if (!admitted && (await findIssueRetryRequests(database, issue)).length === 0) return { request: null };
  const events = await triggerLabelEvents(await getOctokit(), issue, new Set(await processingLabels()));
  const open = await findIssueRetryRequests(database, issue);
  const at = now();
  const admittedEvents = admitted ? await admitted(events) : events;
  const admissible = new Set(admittedEvents.map(event => String(event.id)));
  const latest = events.at(-1);
  for (const request of open) {
    const owed = owedRun(request, { events, admissible, now: at });
    if (owed === 'defer') return { deferred: request };
    // An issue owes one open request at a time, so no other request's trigger is consumed with it.
    if (owed !== null) return { request, triggerEventId: owed, latestTriggerEventId: latest?.id === undefined ? undefined : String(latest.id) };
  }
  if (!admitted) return { request: null };
  return { request: null, trigger: latest?.id && admittedEvents.at(-1) === latest ? { eventId: String(latest.id) } : null };
}

/**
 * The admitted trigger of its own a request is owed a run on, 'defer' while
 * its outcome is unknown or its trigger may still land, or null when it is
 * owed nothing by this delivery.
 */
function owedRun(
  request: IssueRetryRequest,
  { events, admissible, now }: Omit<TriggerHistory, 'consumedEventId'> & { admissible: Set<string> },
): string | 'defer' | null {
  if (request.publication === 'reserved' || request.publication === 'refused' || request.commentId === null) return null;
  const own = retryRequestTrigger(request, events);
  if (own === undefined) return 'defer';
  if (own !== null && admissible.has(own)) return request.publication === 'possible' ? own : 'defer';
  return own === null && windowOpen(request, now) ? 'defer' : null;
}
