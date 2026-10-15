import { Job, type JobsOptions, type Queue } from 'bullmq';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import { repositoryStorageLifecycle } from '../storage/lifecycle.js';
import type { IssueRetryRequest } from './issueRetryRequest.js';

/**
 * The queue's record that it accepted a requested retry's run: it is written
 * in the same Redis transaction as the run's children, and only for children
 * the queue then holds carrying the request, in a state it runs or ran them
 * from, so it exists if and only if they were accepted, whatever became of
 * the dispatch that added them or of the children since. A child that has
 * finished may be removed, or trimmed with the queue's finished jobs, but the
 * record has no expiry, and is never dropped: recording the request consumed
 * retires it, which keeps it as the request's tombstone. Either way it fences
 * every later add of the request's children, in the add's own transaction,
 * so a dispatch that selected the request before another accepted its run,
 * however long it was suspended, never adds them again. It names the
 * request's comment, and the latest trigger the run consumed, which a
 * submission's dispatch receipt records.
 */
export interface RetryRunReceipt { receiptEventId: string | null }

type RunRequest = Pick<IssueRetryRequest, 'id' | 'commentId' | 'requesterId'>;

/** The queue a request's run is recorded with: its client, and its key namespace. */
export interface RetryRunQueue { client: Promise<unknown> | unknown; toKey(type: string): string }

interface RunRecordClient {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
}

const runKey = (queue: RetryRunQueue, request: Pick<IssueRetryRequest, 'id'>) => queue.toKey(`retry-run:${request.id}`);
// The record's field for the whole run, written once every child is accepted, a field per accepted child,
// and the field that retires the record once the request is recorded consumed.
const RUN_FIELD = 'run';
const CONSUMED_FIELD = 'consumed';
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
  /**
   * The run the queue accepted for the request and that is still to be recorded consumed, or null when it
   * accepted none, not every child of it, or the record is retired.
   */
  read(request: Pick<IssueRetryRequest, 'id' | 'commentId'>): Promise<RetryRunReceipt | null>;
  /**
   * The run the queue accepted for the request, whether or not the record is retired since, or null when it
   * accepted none: the receipt of whichever dispatch's transaction accepted it.
   */
  accepted(request: Pick<IssueRetryRequest, 'id' | 'commentId'>): Promise<RetryRunReceipt | null>;
  /** Retires the record once the request is recorded consumed, keeping it as the tombstone that fences any later add of its run. */
  retire(request: Pick<IssueRetryRequest, 'id' | 'commentId'>): Promise<void>;
}

/** The run records kept with the queue `queueOf` returns. */
export function queueRetryRunEvidence(queueOf: () => RetryRunQueue | Promise<RetryRunQueue>): RetryRunEvidence {
  return {
    read: async request => {
      const queue = await queueOf();
      const record = await (await queue.client as RunRecordClient).hgetall(runKey(queue, request)) ?? {};
      return ownEntry(record[CONSUMED_FIELD], request) ? null : ownEntry(record[RUN_FIELD], request);
    },
    accepted: async request => {
      const queue = await queueOf();
      return ownEntry((await (await queue.client as RunRecordClient).hgetall(runKey(queue, request)) ?? {})[RUN_FIELD], request);
    },
    retire: async request => {
      const queue = await queueOf();
      await (await queue.client as RunRecordClient).hset(runKey(queue, request), { [CONSUMED_FIELD]: retryRunEntry(request) });
    },
  };
}

/** A child job of a requested retry's run, as its dispatch builds it. */
export interface RetryRunChild { name: string; data: IssueJobData; opts: JobsOptions & { jobId: string } }

const carriesRequest = (data: Partial<IssueJobData> | undefined, request: RunRequest) =>
  data?.retryCommentId === request.commentId && data?.retryRequesterId === request.requesterId;

// A field no BullMQ job has, on a child ID the fence holds within the transaction.
const FENCE_FIELD = 'propr:fenced';
// The queue's states a job is runnable, running or finished in: its lists, then its sorted sets.
const STATE_LISTS = ['wait', 'paused', 'active'];
const STATE_SETS = ['prioritized', 'delayed', 'waiting-children', 'completed', 'failed'];
const STATE_COUNT = STATE_LISTS.length + STATE_SETS.length;

/**
 * KEYS: the record, then each child's job, then the queue's state keys. ARGV:
 * the comment ID, the requester, a child's entry, the run's entry, then each
 * child's job ID.
 */
const RUN_SCRIPT_PRELUDE = `
local count = #KEYS - 1 - ${STATE_COUNT}
local function own(entry)
  if not entry then return false end
  local ok, run = pcall(cjson.decode, entry)
  return ok and type(run) == 'table' and type(run.commentId) == 'number' and run.commentId == tonumber(ARGV[1])
end
local function carries(jobKey)
  local data = redis.call('HGET', jobKey, 'data')
  if not data then return false end
  local ok, job = pcall(cjson.decode, data)
  return ok and type(job) == 'table' and job.retryRequesterId == ARGV[2]
    and type(job.retryCommentId) == 'number' and job.retryCommentId == tonumber(ARGV[1])
end
local function held(jobId)
  for s = 1, ${STATE_COUNT} do
    local key = KEYS[1 + count + s]
    if s <= ${STATE_LISTS.length} then
      if redis.call('LPOS', key, jobId) then return true end
    elseif redis.call('ZSCORE', key, jobId) then return true end
  end
  return false
end
local accepted = own(redis.call('HGET', KEYS[1], 'run')) or own(redis.call('HGET', KEYS[1], '${CONSUMED_FIELD}'))
`;

/**
 * Runs before the children's adds, in their transaction, so what it reads is
 * what they meet: an add is not conditional, but BullMQ ignores the add of a
 * job ID it already holds. A child whose run the record shows accepted, or
 * retired, by whichever dispatch, is fenced: its ID, if free, is held for the
 * transaction, so its add is ignored, however stale the dispatch that built
 * it. A child job carrying the request that the queue holds in no state, as
 * an add that failed after writing its job leaves it, can never run, so it is
 * dropped for its add to replace it. Returns how many adds it fenced.
 */
const FENCE_RUN = `${RUN_SCRIPT_PRELUDE}
local fenced = 0
for i = 1, count do
  local jobKey, jobId = KEYS[i + 1], ARGV[4 + i]
  if accepted or redis.call('HGET', KEYS[1], 'child:' .. jobId) == ARGV[3] then
    fenced = fenced + 1
    if redis.call('EXISTS', jobKey) == 0 then
      redis.call('HSET', jobKey, '${FENCE_FIELD}', ARGV[3])
      redis.call('PEXPIRE', jobKey, 60000)
    end
  elseif carries(jobKey) and not held(jobId) then
    redis.call('DEL', jobKey)
  end
end
return fenced
`;

/**
 * Runs after the children's adds, in their transaction: Redis applies every
 * command of a MULTI even when one before it fails or returns an error code,
 * so the record is written from what the queue then holds, not from the adds'
 * replies. It first releases the IDs the fence held. A child is accepted when
 * the record already names it, or its job carries the request's comment and
 * requester and the queue holds it in a state it runs or ran it from: a job
 * an add wrote but never queued is not. Only then is it recorded; the run
 * itself is recorded once every child is. Returns how many are, and whether
 * the record already showed the run accepted, or retired, before.
 */
const RECORD_RUN = `${RUN_SCRIPT_PRELUDE}
for i = 1, count do
  if redis.call('HEXISTS', KEYS[i + 1], '${FENCE_FIELD}') == 1 then redis.call('DEL', KEYS[i + 1]) end
end
if accepted then return { count, 1 } end
local recorded = 0
for i = 1, count do
  local field = 'child:' .. ARGV[4 + i]
  local child = redis.call('HGET', KEYS[1], field) == ARGV[3]
  if not child and carries(KEYS[i + 1]) and held(ARGV[4 + i]) then
    redis.call('HSET', KEYS[1], field, ARGV[3])
    child = true
  end
  if child then recorded = recorded + 1 end
end
if recorded == count then redis.call('HSET', KEYS[1], 'run', ARGV[4]) end
return { recorded, 0 }
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
 * added again, as they may have run and been removed since; nor is any child
 * of a run the record shows accepted or retired when the transaction runs,
 * whatever this dispatch read before. Returns whether this transaction
 * accepted the run, or false when the queue had already accepted it.
 */
export async function enqueueIssueRetryRun(
  queue: RunQueue, request: RunRequest, children: RetryRunChild[],
  { receiptEventId, use = run => repositoryStorageLifecycle.use(run) }: {
    receiptEventId: string | null;
    /** The storage barrier the queue's producers join, which the production queue's adds take. */
    use?: <T>(run: () => Promise<T>) => Promise<T>;
  },
): Promise<boolean> {
  if (request.commentId === null) throw new Error(`Retry request ${request.id} has no posted comment to run`);
  const key = runKey(queue, request);
  const client = await queue.client;
  const record = await (client as unknown as RunRecordClient).hgetall(key) ?? {};
  if (ownEntry(record[RUN_FIELD], request) || ownEntry(record[CONSUMED_FIELD], request)) return false;
  const childEntry = retryRunEntry(request);
  const pending = children.filter(child => record[childField(child.opts.jobId)] !== childEntry);
  for (const child of pending) {
    const existing = await queue.getJob(child.opts.jobId);
    if (existing && !carriesRequest(existing.data as Partial<IssueJobData>, request)) {
      throw new Error(`Child job ${child.opts.jobId} carries another request's run, so retry request ${request.id}'s run was not added`);
    }
  }
  const states = [...STATE_LISTS, ...STATE_SETS].map(state => queue.toKey(state));
  const scriptArgs = (jobIds: string[], runEntry: string) => [1 + jobIds.length + states.length, key, ...jobIds.map(jobId => queue.toKey(jobId)), ...states,
    String(request.commentId), request.requesterId, childEntry, runEntry, ...jobIds] as const;
  return use(async () => {
    const transaction = client.multi() as unknown as RunTransaction;
    transaction.eval(FENCE_RUN, ...scriptArgs(pending.map(child => child.opts.jobId), childEntry));
    // Each add is queued on the transaction as it is built, so it is awaited before the transaction runs:
    // one that cannot be built rejects here, and nothing is sent.
    await Promise.all(pending.map(child => new Job(queue as unknown as Queue, child.name, child.data, { ...queue.jobsOpts, ...child.opts }, child.opts.jobId)
      .addJob(transaction as never)));
    transaction.eval(RECORD_RUN, ...scriptArgs(children.map(child => child.opts.jobId), retryRunEntry(request, receiptEventId)));
    if (transaction.length !== undefined && transaction.length !== pending.length + 3) {
      throw new Error(`Retry request ${request.id}'s run was not queued as built, so it was not added`);
    }
    const results = await transaction.exec();
    if (!results) throw new Error(`Retry request ${request.id}'s run was not added`);
    const [recordError, recorded] = results.at(-1)!;
    if (recordError) throw recordError;
    const [accepted, earlier] = recorded as [number, number];
    if (accepted !== children.length) {
      const failures = results.slice(0, -1).map(([error, result]) => error?.message ?? (typeof result === 'number' && result < 0 ? `code ${result}` : null))
        .filter(failure => failure !== null);
      throw new Error(`The queue accepted ${String(accepted)} of ${children.length} children of retry request ${request.id}'s run${failures.length > 0 ? ` (${failures.join('; ')})` : ''}`);
    }
    return earlier === 0;
  });
}
