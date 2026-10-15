import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import { findIssueSubmission } from './taskSubmissionService.js';
import type { RetryRunEvidence, RetryRunReceipt } from './issueRetryRun.js';

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
 * unless publication begins within that window.
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
export type RetryRun = (
  | { request: IssueRetryRequest; triggerEventId: string; latestTriggerEventId?: string }
  /**
   * `trigger` is the latest admitted trigger, or null when there is none to run. An issue-only delivery,
   * which admits every trigger, learns it only while settling carried requests: null then means a carried
   * request's run consumed the latest trigger, so the delivery runs nothing more.
   */
  | { request: null; trigger?: { eventId: string } | null }
  | { deferred: IssueRetryRequest }
) & {
  /** Open requests an earlier dispatch already carried, whose consumption is still to be recorded. */
  carried?: CarriedRetryRequest[];
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
 * while its comment was still being posted is another's. Null when it has
 * none, or undefined when its baseline is gone from the history, so none can
 * be told apart as its own.
 */
export function retryRequestTrigger(request: IssueRetryRequest, events: TriggerLabelEvent[]): string | null | undefined {
  const start = request.afterEventId === null ? 0 : events.findIndex(event => String(event.id) === request.afterEventId) + 1;
  if (start === 0 && request.afterEventId !== null) return undefined;
  const published = events.slice(start).find(event => (request.actorId === null || event.actor?.id === request.actorId)
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

/** The issue's open requests, oldest first. */
export async function findIssueRetryRequests(database: Knex, issue: IssueKey): Promise<IssueRetryRequest[]> {
  const rows = await database(TABLE).where({ owed_issue: owedIssue(issue) }).orderBy('requested_at').select() as RequestRow[];
  return rows.map(parseRow);
}

/**
 * A reservation of the issue for a new request, or the earlier request it is
 * still owed, and whether that one is stranded until a follow-up restarts it.
 */
export type RetryReservation = { reserved: IssueRetryRequest } | { owed: IssueRetryRequest; stranded: boolean };

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
    await trx(TABLE).whereNull('owed_issue').where('recorded_at', '<', history.now - CLOSED_RETENTION_MS).delete();
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
type PublicationWrite = Pick<IssueRetryRequest, 'id' | 'publishedAt'>;

/**
 * Whether the write is still the issue's open publication, with its outcome
 * unrecorded: no later request took the issue over once it could no longer
 * land, and no restart began another write of the request.
 */
export async function issueRetryPublicationOpen(database: Knex, write: PublicationWrite): Promise<boolean> {
  const row = await database(TABLE).where({ id: write.id, publication: 'pending', published_at: write.publishedAt }).whereNotNull('owed_issue').first('id');
  return row !== undefined;
}

/**
 * Durable evidence of a trigger write's outcome that the route learned but
 * could not record with its request. It outlives the process that learned it
 * and any job carrying it, until a delivery's dispatch or a later follow-up
 * records the outcome. It names the write by its request and when the write
 * began, so it never confirms another write of a restarted request.
 */
export interface RetryOutcomeEvidence {
  save(write: PublicationWrite, publication: RetryPublicationOutcome): Promise<void>;
  read(write: PublicationWrite): Promise<RetryPublicationOutcome | null>;
  clear(write: PublicationWrite): Promise<void>;
}

interface EvidenceClient {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const evidenceKey = (write: PublicationWrite) => `issue:retry-outcome:${write.id}:${write.publishedAt}`;

/** Evidence kept in Redis without expiry: only recording the outcome it evidences drops it. */
export function redisRetryOutcomeEvidence(client: () => EvidenceClient | Promise<EvidenceClient>): RetryOutcomeEvidence {
  return {
    save: async (write, publication) => { await (await client()).set(evidenceKey(write), publication); },
    read: async write => {
      const publication = await (await client()).get(evidenceKey(write));
      return publication === 'possible' || publication === 'refused' ? publication : null;
    },
    clear: async write => { await (await client()).del(evidenceKey(write)); },
  };
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
  stores: RetryOutcomeStores, issue: IssueKey, history: TriggerHistory, refresh: () => Promise<TriggerLabelEvent[]>,
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
 */
export interface RunReceiptFence {
  /** The receipt the writer read; the write applies only while it is still the receipt. */
  observedEventId: string | null;
  /** The history the writer read, which orders its trigger against the receipt it read, if it shows both. */
  events?: TriggerLabelEvent[];
  /** Reads the issue's trigger history afresh. */
  history: () => Promise<TriggerLabelEvent[]>;
  /**
   * Whether the writer's own admission placed its trigger after the receipt it read: a dispatch admits only
   * triggers after the submission's consumed one, also when the history no longer shows that one.
   */
  admitted?: boolean;
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
      if (attempt > 0 || !fence.admitted) {
        let later = laterThan(events, triggerEventId, observed);
        if (later === undefined && !fresh) {
          events = await fence.history();
          fresh = true;
          later = laterThan(events, triggerEventId, observed);
        }
        if (later === undefined) {
          throw new Error(`Submission ${submissionId}'s dispatch receipt records trigger ${observed}, which the issue's history cannot order against trigger ${triggerEventId}`);
        }
        if (!later) return 'covered';
      }
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
  const placed = events && shows(events) ? events : await history();
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
 * triggers takes its own from that same history.
 */
export async function selectRetryRun(
  issue: IssueKey,
  { admitted, consumedEventId, runs }: RetryRunDelivery,
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
  const settled: CarriedRetryRequest[] = [];
  const withCarried = <Run extends RetryRun>(run: Run): Run => settled.length > 0 ? { ...run, carried: settled } : run;
  for (const request of open) {
    // The queue's record of a run outlives its children and any receipt, so it is consulted first.
    const recorded = await recordedRun(request, { runs, admitted }, { events, consumedEventId });
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
  if (!admitted) return withCarried(settled.length > 0 ? { request: null, ...issueTrigger(events, settled) } : { request: null });
  return withCarried({ request: null, trigger: unrequestedTrigger(events, admittedEvents, settled) });
}

/**
 * The trigger an issue-only delivery that settles carried requests runs:
 * none when its latest trigger is one a carried request's run consumed, as
 * that run was the trigger's; otherwise the latest, a later, independent
 * trigger, which runs as any other. A history that shows neither leaves the
 * delivery to run as any other.
 */
function issueTrigger(events: TriggerLabelEvent[], settled: CarriedRetryRequest[]): { trigger?: { eventId: string } | null } {
  const latest = events.at(-1);
  if (!latest?.id) return {};
  const eventId = String(latest.id);
  return { trigger: settled.some(held => held.runTriggerEventId === eventId) ? null : { eventId } };
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
 * consumed; null when it shows none.
 */
async function recordedRun(
  request: IssueRetryRequest, { runs, admitted }: Pick<RetryRunDelivery, 'runs' | 'admitted'>, history: Pick<TriggerHistory, 'events' | 'consumedEventId'>,
): Promise<CarriedRetryRequest | null> {
  if (request.publication === 'reserved' || !runs) return null;
  const run = await runs(request);
  if (!run) return null;
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
