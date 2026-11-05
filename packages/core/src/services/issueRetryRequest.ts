import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import { findIssueSubmission } from './taskSubmissionService.js';
import type { RetryRunEvidence, RetryRunReceipt } from './issueRetryRun.js';
import type { RetryOutcomeEvidence } from './issueRetryOutcomeEvidence.js';

export { redisRetryOutcomeEvidence, type RetryOutcomeEvidence } from './issueRetryOutcomeEvidence.js';

/**
 * The requester and posted instructions of a requested issue retry. The job
 * the route submits carries them, but a relabel delivery or poll that recovers
 * a failed submission cannot, so they are recorded durably per issue before
 * the trigger is written, and kept until a dispatch carries them into the run
 * or the request is known to be owed none. Elapsed time alone releases nothing.
 *
 * A request belongs only to the trigger it published: the first trigger the
 * route's GitHub identity labels after `afterEventId` (the latest trigger
 * event read just before its trigger write began, after its comment was
 * posted), within the publication window that opens at `publishedAt`, when
 * that write begins. `requestedAt` only times the reservation, which expires
 * unless publication begins within that window; it is read before the
 * reservation is taken, so it does not order requests, `id` does.
 *
 * A request is `reserved` until its trigger write is attempted, then `pending`
 * until the route records the write's outcome: `possible` (applied, or not
 * refused) lets recovery adopt it, and a refusal releases it. An outcome the
 * route cannot record is kept as durable evidence of that write, which a
 * delivery's dispatch or a later follow-up records. While it is pending
 * without either, the outcome is unknown, and dispatch defers the request's
 * trigger rather than run it with or without the request.
 *
 * A request still owed once its write can no longer land is stranded: its
 * outcome may have been lost with the process that learned it, when neither
 * store could keep it and nothing tells its own trigger from another the same
 * identity wrote, or every
 * delivery may have come before its trigger was visible. A later follow-up
 * restarts it: a fresh trigger write, after a fresh baseline, that recovery
 * can tell apart. A restarted request stays owed until a run carries it, so
 * the trigger it may already have published never runs without it.
 *
 * A run carries a request on its own trigger, and its dispatch records that
 * trigger, or a later one, as the submission's consumed trigger before it
 * records the request consumed. A request whose own trigger that receipt
 * reached was carried, even if recording its consumption failed. Whatever
 * either receipt records, the queue keeps its own record of every request
 * whose children it accepted, written with them, which recording the request
 * consumed retires rather than drops: a request with that record was
 * carried, and never runs again, however long recording its consumption
 * takes, whichever trigger a restart published since, and however stale the
 * dispatch that would add its children again.
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
  /** When a follow-up restarted its stranded publication; null unless restarted. */
  resumedAt: number | null;
}

/**
 * A label event of the issue. `orderingOnly` marks a receipt kept only to order triggers against, as its label
 * is not a processing label now: it is never admitted as a trigger, nor taken for a request's own.
 */
export interface TriggerLabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id?: number }; orderingOnly?: true }

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
export type RetryRun = (
  | { request: IssueRetryRequest; triggerEventId: string; latestTriggerEventId?: string }
  /**
   * `trigger` is the latest admitted trigger, or null when there is none to run. An issue-only delivery,
   * which admits every trigger, learns it only while settling carried requests: null then means a carried
   * request's run consumed the latest trigger, so the delivery runs nothing more.
   */
  | { request: null; trigger?: { eventId: string } | null }
  /**
   * `unordered` when it is deferred because the queue's record shows another dispatch accepted its run through
   * a trigger no history this delivery read shows, so whether any trigger is later than that run's is unknown.
   * No request is deferred, but the whole delivery, when no history it read shows the trigger the submission's
   * dispatch receipt records: none of its triggers is known to come after it.
   */
  | { deferred: IssueRetryRequest | null; unordered?: true }
) & {
  /** Open requests an earlier dispatch already carried, whose consumption is still to be recorded. */
  carried?: CarriedRetryRequest[];
  /**
   * The history the run was selected on, which shows the submission's consumed trigger, if it has one: the
   * dispatch receipt its run records is ordered on it.
   */
  events?: TriggerLabelEvent[];
};

/**
 * An open request a run carried, and the trigger the submission's dispatch
 * receipt must still record for it before it is recorded consumed, when the
 * queue's record of its run shows a run the receipt does not.
 */
export type CarriedRetryRequest = IssueRetryRequest & {
  receiptEventId?: string;
  /** The latest trigger the history shows the run consumed, when it shows any. */
  runTriggerEventId?: string;
  /** The queue's record of the run, whose trigger, not the delivery's, the submission's dispatch receipt records. */
  run?: RetryRunReceipt;
};

export interface RetryRunDelivery {
  /** The trigger events a submission admits as a fresh run; an issue-only run admits every one. */
  admitted?: (events: TriggerLabelEvent[]) => Promise<TriggerLabelEvent[]>;
  /** The latest trigger the submission's dispatch receipt records as consumed. */
  consumedEventId?: string | null;
  /** The run the queue accepted for the request, by its own record, or null when it accepted none. */
  runs?: (request: IssueRetryRequest) => Promise<RetryRunReceipt | null>;
  /**
   * The run the queue accepted for a request recorded consumed since, by its retired record, or null when it
   * accepted none. An issue-only delivery has no receipt, so these records are what show the triggers those
   * runs consumed.
   */
  accepted?: (request: IssueRetryRequest) => Promise<RetryRunReceipt | null>;
}

// A trigger write whose response was lost lands within this; a first trigger
// after it is not the request's, so a request that was never published is owed nothing.
const PUBLICATION_WINDOW_MS = 10 * 60 * 1000;
// How long requests known to be owed nothing are kept for inspection, but for each issue's latest consumed one.
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TABLE = 'issue_retry_request_states';

const owedIssue = (issue: IssueKey) => `${issue.repoOwner}/${issue.repoName}#${issue.number}`;

interface RequestRow {
  id: number; requester_id: string; comment_id: number | string | null; requested_at: number | string;
  published_at: number | string | null; after_event_id: string | null; actor_id: number | string | null; publication: string;
  resumed_at?: number | string | null;
}

function parseRow(row: RequestRow): IssueRetryRequest {
  const publication = ['reserved', 'pending', 'possible', 'refused'].includes(row.publication) ? row.publication as IssueRetryRequest['publication'] : 'pending';
  return {
    id: Number(row.id), requesterId: row.requester_id, requestedAt: Number(row.requested_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    commentId: row.comment_id === null ? null : Number(row.comment_id),
    afterEventId: row.after_event_id, actorId: row.actor_id === null ? null : Number(row.actor_id), publication,
    resumedAt: row.resumed_at === null || row.resumed_at === undefined ? null : Number(row.resumed_at),
  };
}

/**
 * The issue's trigger-label events, oldest first. The label events of
 * `retained`, the receipts triggers are ordered against, such as a
 * submission's consumed trigger or the trigger an accepted run consumed
 * through, are kept whatever their label: a trigger is ordered against them,
 * also once their label is no longer a processing label. Such an event is
 * only ordering evidence, never a trigger itself, and is marked `orderingOnly`.
 */
export async function triggerLabelEvents(octokit: Octokit, issue: IssueKey, triggers: Set<string>, retained: Array<string | null | undefined> = []): Promise<TriggerLabelEvent[]> {
  const receipts = new Set(retained.filter((eventId): eventId is string => Boolean(eventId)));
  const events: TriggerLabelEvent[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: issue.repoOwner, repo: issue.repoName, issue_number: issue.number, per_page: 100, page,
    }) as { data: TriggerLabelEvent[] };
    const kept = data.filter(item => item.event === 'labeled' && item.label && (triggers.has(item.label.name) || receipts.has(String(item.id))));
    events.push(...kept.map(item => triggers.has(item.label!.name) ? item : { ...item, orderingOnly: true as const }));
    if (data.length < 100) break;
  }
  return events;
}

/** Whether a trigger write of the request may still land at `time`, or while reserved, whether its write may still begin. */
const windowOpen = (request: IssueRetryRequest, time: number) => time <= (request.publishedAt ?? request.requestedAt) + PUBLICATION_WINDOW_MS;

/**
 * Whether a trigger event GitHub stamped at `time` lies in the request's
 * publication interval: from the second its trigger write began, as GitHub
 * stamps events to the second, until that write can no longer land.
 */
function inPublicationInterval(request: IssueRetryRequest, time: number): boolean {
  const opened = request.publishedAt ?? request.requestedAt;
  return time >= Math.floor(opened / 1000) * 1000 && windowOpen(request, time);
}

/**
 * The trigger event the request published: the first its identity labelled
 * after its baseline within its publication interval, so a trigger labelled
 * while its comment was still being posted is another's. A receipt kept
 * only to order on is never its own, as the route confirms its write on
 * processing labels alone. Null when it has none, or undefined when its
 * baseline is gone from the history, so none can be told apart as its own.
 */
export function retryRequestTrigger(request: IssueRetryRequest, events: TriggerLabelEvent[]): string | null | undefined {
  const start = request.afterEventId === null ? 0 : events.findIndex(event => String(event.id) === request.afterEventId) + 1;
  if (start === 0 && request.afterEventId !== null) return undefined;
  const published = events.slice(start).find(event => !event.orderingOnly && (request.actorId === null || event.actor?.id === request.actorId)
    && inPublicationInterval(request, Date.parse(event.created_at ?? '')));
  return published?.id ? String(published.id) : null;
}

/**
 * Whether a dispatch durably carried the request: its write was applied, and
 * the submission's dispatch receipt consumed its own trigger or a later one.
 * Dispatch runs past a request's own admitted trigger only by running it: a
 * restarted request defers every other trigger, and an ordinary one runs on
 * its own whenever that is admitted. A trigger that is merely not admitted,
 * or a receipt the history no longer shows, proves nothing.
 */
function carried(request: IssueRetryRequest, { events, consumedEventId }: Pick<TriggerHistory, 'events' | 'consumedEventId'>): boolean {
  if (request.publication !== 'possible' || request.commentId === null || !consumedEventId) return false;
  const own = retryRequestTrigger(request, events);
  if (typeof own !== 'string') return false;
  const consumed = events.findIndex(event => String(event.id) === consumedEventId);
  return consumed !== -1 && consumed >= events.findIndex(event => String(event.id) === own);
}

/**
 * Whether the request may still be owed a run: its trigger write is in
 * progress or may still land, or it published a trigger no dispatch has
 * consumed. A request whose write never landed within the publication window,
 * or whose trigger the submission consumed, is owed none. A restarted request
 * may own the trigger its lost write published, so it is owed until a run
 * carries it.
 */
function mayBeOwed(request: IssueRetryRequest, { events, now, consumedEventId }: TriggerHistory): boolean {
  if (carried(request, { events, consumedEventId })) return false;
  if (request.resumedAt !== null) return true;
  if (request.publication === 'refused') return false;
  if (request.publication === 'reserved') return windowOpen(request, now);
  const own = retryRequestTrigger(request, events);
  if (own === undefined) return true;
  if (own === null) return windowOpen(request, now);
  const consumed = consumedEventId ? events.findIndex(event => String(event.id) === consumedEventId) : -1;
  // Dispatch only runs past a request's admitted trigger by running the request.
  return consumed < events.findIndex(event => String(event.id) === own);
}

/**
 * Whether an owed request is stranded: its trigger write can no longer land,
 * or a restart's write was refused, and still no run has carried it. A
 * delivery may yet run one whose outcome was recorded, but none is due: its
 * outcome may never be recorded, or every delivery may have come early. A
 * restart, which a later follow-up makes, recovers it either way.
 */
function stranded(request: IssueRetryRequest, history: TriggerHistory): boolean {
  if (request.publication === 'reserved' || request.commentId === null || !mayBeOwed(request, history)) return false;
  return request.publication === 'refused' || !windowOpen(request, history.now);
}

/**
 * Requests are ordered by `id`, the sequence their reservations were inserted
 * in: an issue's requests are reserved one at a time, through its unique open
 * slot, so a request with a greater `id` was reserved, and so ran, after one
 * with a lesser. `requestedAt` is read before the reservation, which may wait
 * on a claim or be suspended, so a later reservation can carry an earlier
 * `requestedAt`; it is kept as provenance, and orders nothing.
 */
const RESERVATION_ORDER = 'id';

/** The issue's open requests, oldest reservation first. */
export async function findIssueRetryRequests(database: Knex, issue: IssueKey): Promise<IssueRetryRequest[]> {
  const rows = await database(TABLE).where({ owed_issue: owedIssue(issue) }).orderBy(RESERVATION_ORDER).select() as RequestRow[];
  return rows.map(parseRow);
}

/**
 * The issue's requests a dispatch recorded consumed, oldest reservation first:
 * the latest reserved is never discarded, earlier ones may be.
 */
async function findConsumedIssueRetryRequests(database: Knex, issue: IssueKey): Promise<IssueRetryRequest[]> {
  const rows = await database(TABLE).where({ repo_owner: issue.repoOwner, repo_name: issue.repoName, issue_number: issue.number })
    .whereNull('owed_issue').whereNotNull('consumed_at').orderBy(RESERVATION_ORDER).select() as RequestRow[];
  return rows.map(parseRow);
}

/**
 * A reservation of the issue for a new request, or the earlier request it is
 * still owed, and whether that one is stranded until a follow-up restarts it.
 */
export type RetryReservation = { reserved: IssueRetryRequest } | { owed: IssueRetryRequest; stranded: boolean };

/**
 * Discards the requests of every issue known to be owed nothing that were
 * closed before `cutoff`, except each issue's latest consumed request, which
 * is kept however old: an issue-only delivery, which has no receipt, finds
 * the trigger its run consumed only through it, by the queue's retired record
 * of that run, so without it the trigger would run again as any other. The
 * latest is the latest reserved, by `id`, as `latestConsumedRun` selects it:
 * a request reserved later ran later, whatever its `requestedAt`.
 */
async function discardClosedRequests(trx: Knex, cutoff: number): Promise<void> {
  const sameIssue = `later.repo_owner = ${TABLE}.repo_owner and later.repo_name = ${TABLE}.repo_name and later.issue_number = ${TABLE}.issue_number`;
  const laterRequest = `later.${RESERVATION_ORDER} > ${TABLE}.${RESERVATION_ORDER}`;
  await trx(TABLE).whereNull('owed_issue').where('recorded_at', '<', cutoff).where(discarded => discarded.whereNull('consumed_at')
    .orWhereExists(trx(`${TABLE} as later`).select(trx.raw('1')).whereRaw(sameIssue).whereNotNull('later.consumed_at').whereRaw(laterRequest))).delete();
}

/**
 * Reserves the issue for a new request, before anything of it is posted or
 * published, unless an earlier request may still be owed a run: a second
 * request could not then be told apart from it, and running either would
 * consume the other's trigger. Requests known to be owed nothing are released.
 */
export async function reserveIssueRetryRequest(
  database: Knex,
  issue: IssueKey,
  request: Pick<IssueRetryRequest, 'requesterId' | 'requestedAt' | 'afterEventId'>,
  history: TriggerHistory,
): Promise<RetryReservation> {
  return database.transaction(async trx => {
    // Only requests known to be owed nothing are ever discarded.
    await discardClosedRequests(trx, history.now - CLOSED_RETENTION_MS);
    const open = await findIssueRetryRequests(trx, issue);
    const owed = open.find(held => mayBeOwed(held, history));
    if (owed) return { owed, stranded: stranded(owed, history) };
    if (open.length > 0) await trx(TABLE).whereIn('id', open.map(held => held.id)).update({ owed_issue: null, recorded_at: history.now });
    // The unique open slot refuses a concurrent reservation the read above could not see.
    const [id] = await trx(TABLE).insert({
      repo_owner: issue.repoOwner, repo_name: issue.repoName, issue_number: issue.number, owed_issue: owedIssue(issue),
      requester_id: request.requesterId, requested_at: request.requestedAt, after_event_id: request.afterEventId,
      publication: 'reserved', recorded_at: history.now,
    }) as number[];
    return { reserved: { ...request, id: Number(id), commentId: null, actorId: null, publishedAt: null, publication: 'reserved' as const, resumedAt: null } };
  });
}

/**
 * Records the posted request just before its trigger is written, opening its
 * publication window at `now` however long posting it took, after
 * `afterEventId`, the latest trigger event read once its comment was posted:
 * a trigger labelled while the comment was being posted, even in the second
 * the write begins, is another's. The pending request, carrying that
 * baseline and window, is what the write's read-back and dispatch match its
 * trigger by. Null when the reservation was released meanwhile, so the
 * trigger must not be written.
 */
export async function beginIssueRetryPublication(
  database: Knex, request: IssueRetryRequest, posted: Pick<IssueRetryRequest, 'commentId' | 'actorId' | 'afterEventId'>, now = Date.now(),
): Promise<IssueRetryRequest | null> {
  const updated = await database(TABLE).where({ id: request.id, publication: 'reserved' }).whereNotNull('owed_issue').update({
    comment_id: posted.commentId, actor_id: posted.actorId, after_event_id: posted.afterEventId, published_at: now, publication: 'pending', recorded_at: now,
  });
  return Number(updated) === 1 ? { ...request, ...posted, publishedAt: now, publication: 'pending' } : null;
}

/**
 * Restarts a stranded request's publication just before its fresh trigger
 * write: its baseline moves to `afterEventId`, the latest trigger event now,
 * and its window opens at `now`, so its own trigger is the first its identity
 * labels after the trigger it may already have published. Null when the
 * request changed meanwhile, so the trigger must not be written.
 */
export async function restartIssueRetryPublication(
  database: Knex, request: IssueRetryRequest, afterEventId: string | null, now = Date.now(),
): Promise<IssueRetryRequest | null> {
  const updated = await database(TABLE).where({ id: request.id, publication: request.publication, published_at: request.publishedAt }).whereNotNull('owed_issue')
    .update({ after_event_id: afterEventId, published_at: now, publication: 'pending', resumed_at: now, recorded_at: now });
  return Number(updated) === 1 ? { ...request, afterEventId, publishedAt: now, publication: 'pending', resumedAt: now } : null;
}

/** Releases a reservation whose trigger was never written. */
export async function releaseIssueRetryReservation(database: Knex, request: IssueRetryRequest): Promise<void> {
  await database(TABLE).where({ id: request.id, publication: 'reserved' }).delete();
}

/** A trigger write's outcome: applied or not refused, or refused by GitHub. */
export type RetryPublicationOutcome = 'possible' | 'refused';

/**
 * Records the outcome of the request's trigger write: `possible` lets recovery
 * adopt it, and a refusal, which published no trigger of the request, releases
 * it whoever else labels the issue, unless it was restarted: then it may own
 * the trigger its lost write published, and stays stranded for a restart.
 * Recording it again, after it was released, or for an earlier write of a
 * restarted request, changes nothing, and false is returned: the write is no
 * longer the issue's open publication.
 */
export async function recordIssueRetryPublication(
  database: Knex, request: Pick<IssueRetryRequest, 'id' | 'publishedAt' | 'resumedAt'>, publication: RetryPublicationOutcome, now = Date.now(),
): Promise<boolean> {
  const releases = publication === 'refused' && request.resumedAt === null;
  const updated = await database(TABLE).where({ id: request.id, publication: 'pending', published_at: request.publishedAt }).whereNotNull('owed_issue')
    .update({ publication, recorded_at: now, ...(releases ? { owed_issue: null } : {}) });
  return Number(updated) === 1;
}

/** A trigger write of a request: the request, and when the write began. */
export type PublicationWrite = Pick<IssueRetryRequest, 'id' | 'publishedAt'>;

/**
 * Whether the write is still the issue's open publication, with its outcome
 * unrecorded: no later request took the issue over once it could no longer
 * land, and no restart began another write of the request. Given a clock,
 * also whether its publication window is still open, so a trigger it adds
 * now may still be told apart as its own.
 */
export async function issueRetryPublicationOpen(database: Knex, write: PublicationWrite, now?: () => number): Promise<boolean> {
  const row = await database(TABLE).where({ id: write.id, publication: 'pending', published_at: write.publishedAt }).whereNotNull('owed_issue').first('id');
  // The clock is read once the record is, so a slow query does not leave the window taken for open.
  return row !== undefined && (now === undefined || (write.publishedAt !== null && now() <= write.publishedAt + PUBLICATION_WINDOW_MS));
}

/**
 * The request records, the outcome evidence kept for writes they could not
 * record, and the queue's records of the runs it accepted.
 */
export interface RetryOutcomeStores { database: Knex; evidence: RetryOutcomeEvidence; runs?: RetryRunEvidence }

/** Records the outcome of the request's trigger write, then drops its evidence, which is kept if recording fails. */
export async function confirmIssueRetryPublication(
  { database, evidence }: RetryOutcomeStores, request: Pick<IssueRetryRequest, 'id' | 'publishedAt' | 'resumedAt'>,
  publication: RetryPublicationOutcome, now = Date.now(),
): Promise<boolean> {
  const recorded = await recordIssueRetryPublication(database, request, publication, now);
  await evidence.clear(request);
  return recorded;
}

const eventPosition = (events: TriggerLabelEvent[], eventId: string | null | undefined) =>
  eventId ? events.findIndex(event => String(event.id) === eventId) : -1;

/**
 * The latest trigger a run the queue's record shows carried the request
 * consumed, as the history shows it: the later of the trigger its run's
 * dispatch recorded with it and the request's own, which a restart may have
 * published since. None when the history shows neither.
 */
function runTrigger(request: IssueRetryRequest, run: RetryRunReceipt, events: TriggerLabelEvent[]): string | undefined {
  const own = retryRequestTrigger(request, events);
  return [run.receiptEventId, typeof own === 'string' ? own : null]
    .filter((eventId): eventId is string => eventPosition(events, eventId) !== -1)
    .sort((a, b) => eventPosition(events, b) - eventPosition(events, a))[0];
}

/**
 * The trigger the submission's dispatch receipt must still record for a
 * request the queue's record shows a run carried: the latest its run
 * consumed, so none of them runs again without it. None when the receipt
 * already records it, or no longer shows in the history.
 */
export function carriedReceipt(
  request: IssueRetryRequest, run: RetryRunReceipt, { events, consumedEventId }: Pick<TriggerHistory, 'events' | 'consumedEventId'>,
): string | undefined {
  const target = runTrigger(request, run, events);
  if (target === undefined || (consumedEventId && eventPosition(events, consumedEventId) === -1)) return undefined;
  return eventPosition(events, consumedEventId) < eventPosition(events, target) ? target : undefined;
}

/**
 * Records the evidenced outcome of each of the issue's requests whose trigger
 * write's outcome is still unrecorded, so a refusal releases its request and
 * an applied write lets recovery adopt it, whatever process learned it. A
 * request the queue's record shows a run carried is recorded consumed, after
 * the submission's dispatch receipt records the trigger that record names,
 * unless it already records it or a later one, so neither a restart nor a
 * later follow-up takes it for one never run. `refresh` reads the history
 * afresh, to order a receipt another dispatch recorded since `history`.
 */
export async function reconcileIssueRetryOutcomes(
  stores: RetryOutcomeStores, issue: IssueKey, history: TriggerHistory, refresh: RunReceiptFence['history'],
): Promise<void> {
  for (const request of await findIssueRetryRequests(stores.database, issue)) {
    const run = request.publication === 'reserved' ? null : await stores.runs?.read(request);
    if (run) {
      const submission = await findIssueSubmission({ ...issue } as Parameters<typeof findIssueSubmission>[0], stores.database);
      if (submission) {
        const { eventId, events } = await acceptedRunTrigger(request, run, { events: history.events, history: refresh });
        await recordIssueRetryRunReceipt(stores.database, submission.id, eventId,
          { observedEventId: submission.retry_event_id ?? null, events, history: refresh });
      }
      await consumeIssueRetryRequest(stores, request, history.now);
      continue;
    }
    if (request.publication !== 'pending' || request.publishedAt === null) continue;
    const publication = await stores.evidence.read(request);
    if (publication) await confirmIssueRetryPublication(stores, request, publication, history.now);
  }
}

/**
 * What a write of the submission's dispatch receipt is fenced on: the receipt
 * its writer read before deciding what its run consumed, and the issue's
 * trigger history, which orders the run's trigger against a receipt. Another
 * dispatch may have recorded a later receipt since, from a history the
 * writer's own predates, so a conflict is ordered on the history read afresh.
 * Only a history that shows both orders them: a writer's own admission of its
 * trigger never stands in for that.
 */
export interface RunReceiptFence {
  /** The receipt the writer read; the write applies only while it is still the receipt. */
  observedEventId: string | null;
  /** The history the writer read, which orders its trigger against the receipt it read, if it shows both. */
  events?: TriggerLabelEvent[];
  /**
   * Reads the issue's trigger history afresh, keeping the triggers `retained` names, which it is to order,
   * whatever their label now.
   */
  history: (retained: Array<string | null | undefined>) => Promise<TriggerLabelEvent[]>;
}

/** Whether the receipt records the trigger itself, or a later one: 'recorded' when the write advanced it, 'covered' when it already did. */
export type RunReceiptWrite = 'recorded' | 'covered';

// How often a receipt write that meets a newer receipt orders it afresh before it gives up, leaving it to a later one.
const RECEIPT_WRITE_ATTEMPTS = 3;

/** Whether `eventId` comes after `receiptEventId` in the history, or undefined when the history does not show both. */
function laterThan(events: TriggerLabelEvent[] | undefined, eventId: string, receiptEventId: string): boolean | undefined {
  const [at, receipt] = [eventPosition(events ?? [], eventId), eventPosition(events ?? [], receiptEventId)];
  return at === -1 || receipt === -1 ? undefined : at > receipt;
}

/**
 * Records the submission's dispatch receipt, as a dispatch that enqueued a
 * run records it: dispatched, and through `triggerEventId`. The receipt is a
 * watermark: no trigger at or before it is admitted again, so it only ever
 * advances. The write applies only while the receipt is still the one its
 * writer read, and only for a trigger after it; a receipt another dispatch
 * recorded since is ordered against the trigger on the history read afresh,
 * which shows them both, and the write is retried on it when the trigger is
 * later, or left as it is when it already records the trigger or a later one.
 * A receipt the history cannot order the trigger against is neither
 * overwritten nor taken to cover it: the write fails, and its caller keeps
 * what it would settle for a later reconciliation.
 */
export async function recordIssueRetryRunReceipt(
  database: Knex, submissionId: string, triggerEventId: string | undefined, fence: RunReceiptFence,
): Promise<RunReceiptWrite> {
  let observed = fence.observedEventId;
  let { events } = fence;
  let fresh = false;
  for (let attempt = 0; attempt < RECEIPT_WRITE_ATTEMPTS; attempt++) {
    if (observed !== null) {
      // A recorded receipt already shows the submission dispatched; only a later trigger advances it.
      if (!triggerEventId || observed === triggerEventId) return 'covered';
      let later = laterThan(events, triggerEventId, observed);
      if (later === undefined && !fresh) {
        events = await fence.history([observed, triggerEventId]);
        fresh = true;
        later = laterThan(events, triggerEventId, observed);
      }
      if (later === undefined) {
        throw new Error(`Submission ${submissionId}'s dispatch receipt records trigger ${observed}, which the issue's history cannot order against trigger ${triggerEventId}`);
      }
      if (!later) return 'covered';
    }
    const updated = await database('task_submissions').where({ id: submissionId })
      .where(fenced => { if (observed === null) fenced.whereNull('retry_event_id'); else fenced.where({ retry_event_id: observed }); })
      .update({ dispatch_complete: true, state: 'queued', error: null, ...(triggerEventId ? { retry_event_id: triggerEventId } : {}) });
    if (Number(updated) === 1) return 'recorded';
    const current = await database('task_submissions').where({ id: submissionId }).first('retry_event_id') as { retry_event_id: string | null } | undefined;
    if (!current) throw new Error(`Submission ${submissionId} is gone, so its dispatch receipt was not recorded`);
    // Another dispatch recorded a receipt since it was read, from a history this one's may predate.
    observed = current.retry_event_id ?? null;
    events = undefined;
    fresh = false;
  }
  throw new Error(`Submission ${submissionId}'s dispatch receipt kept changing, so trigger ${triggerEventId ?? '(none)'} was not recorded`);
}

/**
 * The latest trigger the request's accepted run consumed, which the
 * submission's dispatch receipt must record: the queue's record of the run
 * names the trigger its dispatch recorded with it, whichever dispatch that
 * was, and however stale the caller's own selection is. It is placed on the
 * caller's history, or, when that does not show it, as when another dispatch
 * accepted the run from a later history, on the history read afresh, which
 * is returned with it. A trigger no history shows is still the run's.
 */
export async function acceptedRunTrigger(
  request: IssueRetryRequest, run: RetryRunReceipt, { events, history }: Pick<RunReceiptFence, 'events' | 'history'>,
): Promise<{ eventId: string | undefined; events: TriggerLabelEvent[] }> {
  const shows = (read: TriggerLabelEvent[]) => run.receiptEventId === null || eventPosition(read, run.receiptEventId) !== -1;
  const placed = events && shows(events) ? events : await history([run.receiptEventId]);
  return { eventId: shows(placed) ? runTrigger(request, run, placed) : run.receiptEventId!, events: placed };
}

/**
 * Records that a dispatch carried the request into its run, which releases it,
 * then retires the queue's record of its run, which is kept as it is if
 * recording fails. The retired record stays as the request's tombstone, so a
 * dispatch that selected the request before it was released adds nothing.
 */
export async function consumeIssueRetryRequest(
  { database, runs }: RetryOutcomeStores, request: Pick<IssueRetryRequest, 'id' | 'commentId'>, now = Date.now(),
): Promise<void> {
  await database(TABLE).where({ id: request.id }).update({ consumed_at: now, owed_issue: null, recorded_at: now });
  // Once released, the request is never selected again; a record left unretired still fences its run.
  await runs?.retire(request).catch(() => undefined);
}

// How often a selection reads the history afresh for a receipt or run another dispatch recorded from a later one, before it defers.
const SELECTION_HISTORY_READS = 3;

/**
 * Selects the run a delivery dispatches, by the same rules for a direct job
 * and a recovering relabel or poll: an open request runs only on its own
 * trigger while that trigger is admitted, so a newer, independent trigger
 * does not strand it. One whose outcome is unknown, or whose trigger write may
 * still land, defers the delivery: dispatching another trigger would consume
 * its trigger, and dispatching its own would either drop its requester or
 * adopt a request that may have been refused. One the submission's dispatch
 * receipt, or the queue's record of its run, shows an earlier run carried is
 * reported for its consumption to be recorded, and owes this delivery
 * nothing; nor does its trigger, which that run consumed, run without it.
 *
 * The open requests are read after the history, so one still reserved then
 * had written no trigger the history shows, and a delivery that admits
 * triggers takes its own from that same history. A run another dispatch
 * accepted meanwhile, from a later history, may have consumed triggers past
 * the latest this one shows, so the selection is made again on the history
 * read afresh, and deferred while no history read shows that run's trigger.
 * So is a selection on a history that does not show the trigger the
 * submission's dispatch receipt records, such as one GitHub answered from
 * before it: none of the triggers it shows is known to come after it.
 *
 * Each history is read keeping the receipts it is ordered on, whatever their
 * label now: the submission's consumed trigger, and the triggers the queue's
 * records show accepted runs of open requests, and the latest consumed one,
 * consumed through. A processing label configured since does not hide them,
 * so a later trigger under it is ordered after them rather than deferred for
 * good. They order triggers, and are never admitted as triggers themselves.
 */
export async function selectRetryRun(
  issue: IssueKey,
  delivery: RetryRunDelivery,
  { getOctokit = getAuthenticatedOctokit, processingLabels = loadPrimaryProcessingLabels, database = db, now = Date.now }: SelectionDeps = {},
): Promise<RetryRun> {
  // An issue-only delivery consumes no trigger, so without a request, or a consumed one's run, it needs no history.
  if (!delivery.admitted && (await findIssueRetryRequests(database, issue)).length === 0
    && (!delivery.accepted || (await findConsumedIssueRetryRequests(database, issue)).length === 0)) return { request: null };
  const octokit = await getOctokit();
  const triggers = new Set(await processingLabels());
  let unordered: IssueRetryRequest | null = null;
  for (let read = 0; read < SELECTION_HISTORY_READS; read++) {
    // Read before the history, so a run accepted since, from a later history, is the one left unordered.
    const receipts = await orderingReceipts(issue, delivery, database);
    const events = await triggerLabelEvents(octokit, issue, triggers, receipts);
    const selected = await selectOnHistory(issue, delivery, events, { database, now });
    if (!('unorderedRun' in selected)) return { ...selected, events };
    unordered = selected.unorderedRun;
  }
  return { deferred: unordered, unordered: true };
}

/**
 * The receipts a selection's history is ordered on: the submission's consumed
 * trigger, and the trigger the queue's record of each open request's accepted
 * run names, and, for an issue-only delivery, that of the latest consumed
 * request whose run it accepted, as `consumedRunTriggers` orders on it. A
 * record that cannot be read fails the selection, as reading it there would.
 */
async function orderingReceipts(issue: IssueKey, { consumedEventId, runs, accepted }: RetryRunDelivery, database: Knex): Promise<Array<string | null | undefined>> {
  const receipts = [consumedEventId, (await latestConsumedRun(issue, accepted, database))?.run.receiptEventId];
  for (const request of runs ? await findIssueRetryRequests(database, issue) : []) {
    if (request.publication !== 'reserved') receipts.push((await runs!(request))?.receiptEventId);
  }
  return receipts;
}

/**
 * The run selected on the history `events`, or the open request whose run the
 * queue's record shows accepted through a trigger `events` does not show: no
 * selection on them can tell which triggers that run consumed. Null in its
 * place when `events` does not show the submission's consumed trigger, which
 * no selection on them can order any trigger against.
 */
async function selectOnHistory(
  issue: IssueKey, { admitted, consumedEventId, runs, accepted }: RetryRunDelivery, events: TriggerLabelEvent[],
  { database, now }: { database: Knex; now: () => number },
): Promise<RetryRun | { unorderedRun: IssueRetryRequest | null }> {
  if (consumedEventId && eventPosition(events, consumedEventId) === -1) return { unorderedRun: null };
  const open = await findIssueRetryRequests(database, issue);
  const at = now();
  // A receipt kept under a label no longer configured orders triggers, but is never admitted as one.
  const admittedEvents = (admitted ? await admitted(events) : events).filter(event => !event.orderingOnly);
  const admissible = new Set(admittedEvents.map(event => String(event.id)));
  const latest = events.at(-1);
  const settled: CarriedRetryRequest[] = [];
  const withCarried = <Run extends RetryRun>(run: Run): Run => settled.length > 0 ? { ...run, carried: settled } : run;
  for (const request of open) {
    // The queue's record of a run outlives its children and any receipt, so it is consulted first.
    const recorded = await recordedRun(request, { runs, admitted }, { events, consumedEventId });
    if (recorded === 'unordered') return { unorderedRun: request };
    if (recorded) {
      settled.push(recorded);
      continue;
    }
    const owed = owedRun(request, { events, admissible, now: at, consumedEventId });
    if (owed === 'carried') {
      settled.push(request);
      continue;
    }
    if (owed === 'defer') return withCarried({ deferred: request });
    // An issue owes one open request at a time, so no other request's trigger is consumed with it.
    if (owed !== null) return withCarried({ request, triggerEventId: owed, latestTriggerEventId: latest?.id === undefined ? undefined : String(latest.id) });
  }
  if (admitted) return withCarried({ request: null, trigger: unrequestedTrigger(events, admittedEvents, settled) });
  const consumed = await consumedRunTriggers(issue, accepted, events, database);
  if (!Array.isArray(consumed)) return { unorderedRun: consumed };
  const ran = [...settled.map(held => held.runTriggerEventId), ...consumed];
  return withCarried(ran.length > 0 || settled.length > 0 ? { request: null, ...issueTrigger(events, admittedEvents, ran) } : { request: null });
}

/**
 * The latest trigger a consumed request's run consumed, as its retired record
 * names it, for an issue-only delivery, which has no receipt: the latest
 * consumed request's whose run the queue accepted, as an issue's requests
 * run one at a time, each through the latest trigger when its run was
 * accepted. Or that request, when its record names a trigger the history does
 * not show, so its run cannot be ordered against the delivery's trigger.
 */
async function consumedRunTriggers(
  issue: IssueKey, accepted: RetryRunDelivery['accepted'], events: TriggerLabelEvent[], database: Knex,
): Promise<string[] | IssueRetryRequest> {
  const latest = await latestConsumedRun(issue, accepted, database);
  if (!latest) return [];
  if (latest.run.receiptEventId !== null && eventPosition(events, latest.run.receiptEventId) === -1) return latest.request;
  const consumed = runTrigger(latest.request, latest.run, events);
  return consumed === undefined ? [] : [consumed];
}

/**
 * The latest consumed request whose run the queue accepted, by its retired
 * record, with that run: the latest reserved, as retention keeps it, since
 * an issue's requests are reserved, and run, one after another.
 */
async function latestConsumedRun(
  issue: IssueKey, accepted: RetryRunDelivery['accepted'], database: Knex,
): Promise<{ request: IssueRetryRequest; run: RetryRunReceipt } | null> {
  for (const request of accepted ? (await findConsumedIssueRetryRequests(database, issue)).reverse() : []) {
    const run = await accepted!(request);
    if (run) return { request, run };
  }
  return null;
}

/**
 * The trigger an issue-only delivery runs once a request's run consumed
 * triggers, as a carried request's run or a consumed one's retired record
 * shows: none when its latest trigger is one such a run consumed, or comes
 * before one, as that run was the trigger's; otherwise the latest, a later,
 * independent trigger, which runs as any other. A receipt kept only to order
 * on is never that trigger. A history that shows neither leaves the delivery
 * to run as any other.
 */
function issueTrigger(events: TriggerLabelEvent[], triggers: TriggerLabelEvent[], ran: Array<string | undefined>): { trigger?: { eventId: string } | null } {
  const latest = triggers.at(-1);
  if (!latest?.id) return events.length > 0 ? { trigger: null } : {};
  const eventId = String(latest.id);
  const consumedThrough = Math.max(-1, ...ran.map(ranId => eventPosition(events, ranId)));
  return { trigger: consumedThrough >= events.indexOf(latest) ? null : { eventId } };
}

/**
 * The trigger a delivery runs without a request: the latest, if admitted,
 * unless a carried request's run consumed it, which the submission's receipt
 * does not record yet; that runs nothing more.
 */
function unrequestedTrigger(events: TriggerLabelEvent[], admittedEvents: TriggerLabelEvent[], settled: CarriedRetryRequest[]): { eventId: string } | null {
  const latest = events.at(-1);
  if (!latest?.id || admittedEvents.at(-1) !== latest) return null;
  const eventId = String(latest.id);
  return settled.some(held => held.receiptEventId === eventId) ? null : { eventId };
}

/**
 * The request as carried, when the queue's record shows it accepted the
 * request's run, with the trigger a submission's dispatch receipt must still
 * record for it, or, for an issue-only delivery, the latest trigger the run
 * consumed; null when it shows none. 'unordered' when the record names a
 * trigger the history does not show, as when another dispatch accepted the
 * run from a later history: the request's own, earlier trigger would then
 * stand in for the run's, and a trigger between them would run again.
 */
async function recordedRun(
  request: IssueRetryRequest, { runs, admitted }: Pick<RetryRunDelivery, 'runs' | 'admitted'>, history: Pick<TriggerHistory, 'events' | 'consumedEventId'>,
): Promise<CarriedRetryRequest | 'unordered' | null> {
  if (request.publication === 'reserved' || !runs) return null;
  const run = await runs(request);
  if (!run) return null;
  if (run.receiptEventId !== null && eventPosition(history.events, run.receiptEventId) === -1) return 'unordered';
  if (admitted) return { ...request, run, receiptEventId: carriedReceipt(request, run, history) };
  const consumed = runTrigger(request, run, history.events);
  return consumed === undefined ? request : { ...request, runTriggerEventId: consumed };
}

/**
 * The admitted trigger of its own a request is owed a run on, 'defer' while
 * its outcome is unknown or its trigger may still land, 'carried' once the
 * dispatch receipt shows a run consumed its own trigger, or null when it is
 * owed nothing by this delivery. A restarted request runs only on its fresh
 * trigger, and defers every other: one may be its lost write's.
 */
function owedRun(
  request: IssueRetryRequest,
  { events, admissible, now, consumedEventId }: TriggerHistory & { admissible: Set<string> },
): string | 'defer' | 'carried' | null {
  if (request.publication === 'reserved' || request.commentId === null) return null;
  if (carried(request, { events, consumedEventId })) return 'carried';
  if (request.resumedAt !== null) {
    const fresh = retryRequestTrigger(request, events);
    return typeof fresh === 'string' && admissible.has(fresh) && request.publication === 'possible' ? fresh : 'defer';
  }
  if (request.publication === 'refused') return null;
  const own = retryRequestTrigger(request, events);
  if (own === undefined) return 'defer';
  if (own !== null && admissible.has(own)) return request.publication === 'possible' ? own : 'defer';
  return own === null && windowOpen(request, now) ? 'defer' : null;
}
