import { Job, type JobsOptions, type Queue } from 'bullmq';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { repositoryStorageLifecycle } from '../storage/lifecycle.js';
import type { IssueRetryRequest } from './issueRetryRequest.js';

/**
 * The queue's record that it accepted a requested retry's run: it is written
 * in the same Redis transaction as the run's children, and only for children
 * the queue then holds carrying the request, so it exists if and only if they
 * were accepted, whatever became of the dispatch that added them or of the
 * children since. A child that has finished may be removed, or trimmed with
 * the queue's finished jobs, but the record has no expiry: only recording the
 * request consumed drops it. It names the request's comment, and the trigger
 * the submission's dispatch receipt records for the run.
 */
export interface RetryRunReceipt { receiptEventId: string | null }

type RunRequest = Pick<IssueRetryRequest, 'id' | 'commentId' | 'requesterId'>;

/** The queue a request's run is recorded with: its client, and its key namespace. */
export interface RetryRunQueue { client: Promise<unknown> | unknown; toKey(type: string): string }

interface RunRecordClient {
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}

const runKey = (queue: RetryRunQueue, request: Pick<IssueRetryRequest, 'id'>) => queue.toKey(`retry-run:${request.id}`);
// The record's field for the whole run, written once every child is accepted, and a field per accepted child.
const RUN_FIELD = 'run';
const childField = (jobId: string) => `child:${jobId}`;

/** The record's entry for the run, or for one of its children. */
export function retryRunEntry(request: Pick<IssueRetryRequest, 'commentId'>, receiptEventId: string | null = null): string {
  return JSON.stringify({ commentId: request.commentId, receiptEventId });
}

/** The record of a run the queue accepted whole for the request, its children `childJobIds`: its key, and its fields. */
export function retryRunRecord(
  queue: RetryRunQueue, request: Pick<IssueRetryRequest, 'id' | 'commentId'>, childJobIds: string[], receiptEventId: string | null,
): { key: string; fields: Record<string, string> } {
  const child = retryRunEntry(request);
  return {
    key: runKey(queue, request),
    fields: { ...Object.fromEntries(childJobIds.map(jobId => [childField(jobId), child])), [RUN_FIELD]: retryRunEntry(request, receiptEventId) },
  };
}

/** Parses a record entry as the request's own: one another request once held under this ID, before the request records were reset, is not. */
function ownEntry(entry: string | undefined, request: Pick<IssueRetryRequest, 'commentId'>): RetryRunReceipt | null {
  if (entry === undefined) return null;
  let run: { commentId?: unknown; receiptEventId?: unknown };
  try { run = JSON.parse(entry) as typeof run; } catch { return null; }
  if (run.commentId !== request.commentId) return null;
  return { receiptEventId: typeof run.receiptEventId === 'string' ? run.receiptEventId : null };
}

export interface RetryRunEvidence {
  /** The run the queue accepted for the request, or null when it accepted none, or not every child of it. */
  read(request: Pick<IssueRetryRequest, 'id' | 'commentId'>): Promise<RetryRunReceipt | null>;
  /** Drops the record once the request is recorded consumed. */
  clear(request: Pick<IssueRetryRequest, 'id'>): Promise<void>;
}

/** The run records kept with the queue `queueOf` returns. */
export function queueRetryRunEvidence(queueOf: () => RetryRunQueue | Promise<RetryRunQueue>): RetryRunEvidence {
  return {
    read: async request => {
      const queue = await queueOf();
      const record = await (await queue.client as RunRecordClient).hgetall(runKey(queue, request)) ?? {};
      return ownEntry(record[RUN_FIELD], request);
    },
    clear: async request => {
      const queue = await queueOf();
      await (await queue.client as RunRecordClient).del(runKey(queue, request));
    },
  };
}

/** A child job of a requested retry's run, as its dispatch builds it. */
export interface RetryRunChild { name: string; data: IssueJobData; opts: JobsOptions & { jobId: string } }

const carriesRequest = (data: Partial<IssueJobData> | undefined, request: RunRequest) =>
  data?.retryCommentId === request.commentId && data?.retryRequesterId === request.requesterId;

/**
 * Runs after the children's adds, in their transaction: Redis applies every
 * command of a MULTI even when one before it fails or returns an error code,
 * so the record is written from what the queue then holds, not from the adds'
 * replies. A child is accepted when the record already names it, or its job
 * carries the request's comment and requester, and only then is it recorded;
 * the run itself is recorded once every child is. Returns how many are.
 *
 * KEYS: the record, then each child's job. ARGV: the comment ID, the
 * requester, the run's entry, a child's entry, then each child's job ID.
 */
const RECORD_RUN = `
local count = #KEYS - 1
local accepted = 0
for i = 1, count do
  local field = 'child:' .. ARGV[4 + i]
  local carries = redis.call('HGET', KEYS[1], field) == ARGV[4]
  if not carries then
    local data = redis.call('HGET', KEYS[i + 1], 'data')
    if data then
      local ok, job = pcall(cjson.decode, data)
      carries = ok and type(job) == 'table' and job.retryRequesterId == ARGV[2]
        and type(job.retryCommentId) == 'number' and job.retryCommentId == tonumber(ARGV[1])
    end
    if carries then redis.call('HSET', KEYS[1], field, ARGV[4]) end
  end
  if carries then accepted = accepted + 1 end
end
if accepted == count then redis.call('HSET', KEYS[1], 'run', ARGV[3]) end
return accepted
`;

interface RunTransaction {
  eval(script: string, numKeys: number, ...args: Array<string | number>): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
  /** The commands queued so far, the MULTI included, on an ioredis transaction. */
  length?: number;
}

type RunQueue = Pick<Queue, 'client' | 'toKey' | 'getJob' | 'jobsOpts'>;

/**
 * Adds a requested retry's children and the record of its run in one Redis
 * transaction, so the record exists exactly when they were accepted, even if
 * the reply is lost. Their IDs are the request's own, so an add never takes
 * another request's child for this one's: a child already under one of them
 * must carry this request, or nothing is recorded for it and the request stays
 * owed. Children an earlier, partly accepted transaction recorded are not
 * added again, as they may have run and been removed since.
 */
export async function enqueueIssueRetryRun(
  queue: RunQueue, request: RunRequest, children: RetryRunChild[],
  { receiptEventId, use = run => repositoryStorageLifecycle.use(run) }: {
    receiptEventId: string | null;
    /** The storage barrier the queue's producers join, which the production queue's adds take. */
    use?: <T>(run: () => Promise<T>) => Promise<T>;
  },
): Promise<void> {
  if (request.commentId === null) throw new Error(`Retry request ${request.id} has no posted comment to run`);
  const key = runKey(queue, request);
  const client = await queue.client;
  const record = await (client as unknown as RunRecordClient).hgetall(key) ?? {};
  if (ownEntry(record[RUN_FIELD], request)) return;
  const childEntry = retryRunEntry(request);
  const pending = children.filter(child => record[childField(child.opts.jobId)] !== childEntry);
  for (const child of pending) {
    const existing = await queue.getJob(child.opts.jobId);
    if (existing && !carriesRequest(existing.data as Partial<IssueJobData>, request)) {
      throw new Error(`Child job ${child.opts.jobId} carries another request's run, so retry request ${request.id}'s run was not added`);
    }
  }
  await use(async () => {
    const transaction = client.multi() as unknown as RunTransaction;
    // Each add is queued on the transaction as it is built, so it is awaited before the transaction runs:
    // one that cannot be built rejects here, and nothing is sent.
    await Promise.all(pending.map(child => new Job(queue as unknown as Queue, child.name, child.data, { ...queue.jobsOpts, ...child.opts }, child.opts.jobId)
      .addJob(transaction as never)));
    const jobIds = children.map(child => child.opts.jobId);
    transaction.eval(RECORD_RUN, 1 + jobIds.length, key, ...jobIds.map(jobId => queue.toKey(jobId)),
      String(request.commentId), request.requesterId, retryRunEntry(request, receiptEventId), childEntry, ...jobIds);
    if (transaction.length !== undefined && transaction.length !== pending.length + 2) {
      throw new Error(`Retry request ${request.id}'s run was not queued as built, so it was not added`);
    }
    const results = await transaction.exec();
    if (!results) throw new Error(`Retry request ${request.id}'s run was not added`);
    const [recordError, accepted] = results.at(-1)!;
    if (recordError) throw recordError;
    if (accepted !== children.length) {
      const failures = results.slice(0, -1).map(([error, result]) => error?.message ?? (typeof result === 'number' && result < 0 ? `code ${result}` : null))
        .filter(failure => failure !== null);
      throw new Error(`The queue accepted ${String(accepted)} of ${children.length} children of retry request ${request.id}'s run${failures.length > 0 ? ` (${failures.join('; ')})` : ''}`);
    }
  });
}
