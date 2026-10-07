import logger from '../../utils/logger.js';
import { getAgentDefinition, type StoredAgentDefinition } from './agentDefinitionStore.js';
import { createAgentRunCostGate } from './agentRunCostGate.js';
import {
  listDueDeferredRuns,
  listUndispatchedRetriedRuns,
  markRetriedAgentRunDispatched,
  redeferAgentRun,
  transitionAgentRun,
  transitionDeferredAgentRun,
  type StoredAgentRun,
} from './agentRunStore.js';
import { enqueueAgentRunPhase, type AgentRunGate, type AgentRunTriggerDependencies } from './agentRunTrigger.js';

/**
 * The consumer of deferred agent runs. The cost gate defers a run by storing
 * `deferred_until`; nothing else picks it up again. The daemon calls
 * `retryDueDeferredAgentRuns` periodically, which re-evaluates every due run
 * through the gate with the run's own deferral count:
 *
 * - proceed: the run moves to `queued` and its report phase is enqueued;
 * - defer: the run stays `deferred` with the new retry time and one more deferral;
 * - skip (including the deferral limit): the run is `skipped` with the reason.
 *
 * Every write is a compare-and-set on the deferred run and the retry time it
 * was evaluated at, so a run cancelled while it is evaluated stays cancelled,
 * overlapping retries never enqueue or count a deferral twice, and an older
 * evaluation never queues or skips a run another retry has re-deferred.
 *
 * A run moved to `queued` keeps its `deferred_until` until its report phase is
 * enqueued. Each call first re-enqueues queued runs still carrying it, so a
 * retry interrupted between the two (the daemon exited) is still dispatched.
 * The job id is deterministic and the worker skips a run that is no longer
 * `queued`, so dispatching again is safe.
 */

export const DEFAULT_DEFERRED_AGENT_RUN_BATCH_SIZE = 50;
export const DEFAULT_DEFERRED_AGENT_RUN_RETRY_INTERVAL_MS = 60_000;

export interface DeferredAgentRunRetryDependencies extends Pick<AgentRunTriggerDependencies, 'database' | 'now' | 'enqueue'> {
  gate?: AgentRunGate;
  batchSize?: number;
  /** The run's live definition; a deleted or disabled agent no longer runs. */
  loadDefinition?: (run: StoredAgentRun) => Promise<StoredAgentDefinition | undefined>;
}

export interface DeferredAgentRunRetryResult {
  queued: number;
  /** Admitted runs whose interrupted dispatch was completed. */
  redispatched: number;
  deferred: number;
  skipped: number;
  failed: number;
}

type RetryOutcome = keyof DeferredAgentRunRetryResult | null;

async function retryDeferredRun(
  run: StoredAgentRun,
  gate: AgentRunGate,
  deps: DeferredAgentRunRetryDependencies & { loadDefinition: NonNullable<DeferredAgentRunRetryDependencies['loadDefinition']> },
): Promise<RetryOutcome> {
  const storeDeps = { database: deps.database, now: deps.now };
  // Every move out of `deferred` is fenced by the retry time evaluated here, so
  // an older evaluation never overrides a deferral another retry has persisted.
  const evaluatedDeferredUntil = run.deferredUntil!;
  const definition = await deps.loadDefinition(run);
  if (!definition?.enabled) {
    const skipReason = 'The agent was disabled or deleted while this run was deferred, so the run was skipped.';
    return await transitionDeferredAgentRun(run.id, evaluatedDeferredUntil, 'skipped', { skipReason }, storeDeps) ? 'skipped' : null;
  }

  // The worker executes the snapshot taken when the run was accepted, so the
  // gate checks the agent the run will actually use.
  const decision = (await gate({ definition: run.definitionSnapshot ?? definition, trigger: run.trigger, triggerSource: run.triggerSource, run }))
    ?? { action: 'proceed' as const };
  if (decision.action === 'skip') {
    return await transitionDeferredAgentRun(run.id, evaluatedDeferredUntil, 'skipped', { skipReason: decision.reason }, storeDeps) ? 'skipped' : null;
  }
  if (decision.action === 'defer') {
    return await redeferAgentRun(run.id, evaluatedDeferredUntil, decision.until, decision.reason, storeDeps) ? 'deferred' : null;
  }

  const queued = await transitionDeferredAgentRun(run.id, evaluatedDeferredUntil, 'queued', {}, storeDeps);
  if (!queued) return null;
  try {
    await enqueueAgentRunPhase(queued, 'report', deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId: run.id, err: error }, 'Failed to enqueue a deferred agent run');
    await transitionAgentRun(run.id, ['queued'], 'failed', { failureReason: `Failed to enqueue the agent run on the job queue: ${message}` }, storeDeps);
    return 'failed';
  }
  await markRetriedAgentRunDispatched(run.id, evaluatedDeferredUntil, storeDeps);
  return 'queued';
}

/**
 * Completes the dispatch of an admitted run whose retry was interrupted after
 * it was queued. An enqueue failure leaves the obligation for the next call.
 */
async function redispatchRetriedRun(run: StoredAgentRun, deps: DeferredAgentRunRetryDependencies): Promise<void> {
  await enqueueAgentRunPhase(run, 'report', deps);
  await markRetriedAgentRunDispatched(run.id, run.deferredUntil!, { database: deps.database, now: deps.now });
}

/**
 * Dispatches admitted runs left undispatched, then re-evaluates the deferred
 * runs that are due. A run whose evaluation throws stays deferred and is
 * retried on the next call.
 */
export async function retryDueDeferredAgentRuns(deps: DeferredAgentRunRetryDependencies = {}): Promise<DeferredAgentRunRetryResult> {
  const {
    now = Date.now,
    batchSize = DEFAULT_DEFERRED_AGENT_RUN_BATCH_SIZE,
    gate = createAgentRunCostGate({ now }),
    loadDefinition = run => getAgentDefinition(run.definitionId, run.ownerId, { database: deps.database }),
  } = deps;
  const result: DeferredAgentRunRetryResult = { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 };
  const undispatched = await listUndispatchedRetriedRuns(batchSize, { database: deps.database });
  for (const run of undispatched) {
    try {
      await redispatchRetriedRun(run, { ...deps, now });
      result.redispatched += 1;
    } catch (error) {
      logger.error({ runId: run.id, err: error }, 'Could not dispatch an admitted deferred agent run; retrying on the next pass');
    }
  }
  const due = await listDueDeferredRuns(now(), batchSize, { database: deps.database });
  for (const run of due) {
    try {
      const outcome = await retryDeferredRun(run, gate, { ...deps, now, loadDefinition });
      if (outcome) result[outcome] += 1;
    } catch (error) {
      logger.error({ runId: run.id, err: error }, 'Could not retry a deferred agent run; it stays deferred');
    }
  }
  if (due.length > 0 || undispatched.length > 0) logger.info({ due: due.length, ...result }, 'Retried due deferred agent runs');
  return result;
}

/**
 * Runs `retryDueDeferredAgentRuns` now and then every `intervalMs`, never
 * overlapping itself. The cost gate is created once so its "usage unknown"
 * log stays once per provider. Returns a function that stops the retries.
 */
export function startDeferredAgentRunRetry(
  { intervalMs = DEFAULT_DEFERRED_AGENT_RUN_RETRY_INTERVAL_MS, retry }: {
    intervalMs?: number;
    retry?: () => Promise<unknown>;
  } = {},
): () => Promise<void> {
  const gate = createAgentRunCostGate();
  const run = retry ?? (() => retryDueDeferredAgentRuns({ gate }));
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running) return;
    running = run().then(() => undefined, (error: unknown) => {
      logger.error({ err: error }, 'Deferred agent run retry failed');
    }).finally(() => { running = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
