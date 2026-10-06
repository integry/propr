import logger from '../../utils/logger.js';
import { getAgentDefinition, type StoredAgentDefinition } from './agentDefinitionStore.js';
import { createAgentRunCostGate } from './agentRunCostGate.js';
import { listDueDeferredRuns, redeferAgentRun, transitionAgentRun, type StoredAgentRun } from './agentRunStore.js';
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
 * Every write is a compare-and-set on the deferred run, so a run cancelled
 * while it is evaluated stays cancelled, and overlapping retries never enqueue
 * or count a deferral twice.
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
  const definition = await deps.loadDefinition(run);
  if (!definition?.enabled) {
    const skipReason = 'The agent was disabled or deleted while this run was deferred, so the run was skipped.';
    return await transitionAgentRun(run.id, ['deferred'], 'skipped', { skipReason }, storeDeps) ? 'skipped' : null;
  }

  // The worker executes the snapshot taken when the run was accepted, so the
  // gate checks the agent the run will actually use.
  const decision = (await gate({ definition: run.definitionSnapshot ?? definition, trigger: run.trigger, triggerSource: run.triggerSource, run }))
    ?? { action: 'proceed' as const };
  if (decision.action === 'skip') {
    return await transitionAgentRun(run.id, ['deferred'], 'skipped', { skipReason: decision.reason }, storeDeps) ? 'skipped' : null;
  }
  if (decision.action === 'defer') {
    return await redeferAgentRun(run.id, run.deferredUntil!, decision.until, decision.reason, storeDeps) ? 'deferred' : null;
  }

  const queued = await transitionAgentRun(run.id, ['deferred'], 'queued', {}, storeDeps);
  if (!queued) return null;
  try {
    await enqueueAgentRunPhase(queued, 'report', deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId: run.id, err: error }, 'Failed to enqueue a deferred agent run');
    await transitionAgentRun(run.id, ['queued'], 'failed', { failureReason: `Failed to enqueue the agent run on the job queue: ${message}` }, storeDeps);
    return 'failed';
  }
  return 'queued';
}

/**
 * Re-evaluates the deferred runs that are due. A run whose evaluation throws
 * stays deferred and is retried on the next call.
 */
export async function retryDueDeferredAgentRuns(deps: DeferredAgentRunRetryDependencies = {}): Promise<DeferredAgentRunRetryResult> {
  const {
    now = Date.now,
    batchSize = DEFAULT_DEFERRED_AGENT_RUN_BATCH_SIZE,
    gate = createAgentRunCostGate({ now }),
    loadDefinition = run => getAgentDefinition(run.definitionId, run.ownerId, { database: deps.database }),
  } = deps;
  const result: DeferredAgentRunRetryResult = { queued: 0, deferred: 0, skipped: 0, failed: 0 };
  const due = await listDueDeferredRuns(now(), batchSize, { database: deps.database });
  for (const run of due) {
    try {
      const outcome = await retryDeferredRun(run, gate, { ...deps, now, loadDefinition });
      if (outcome) result[outcome] += 1;
    } catch (error) {
      logger.error({ runId: run.id, err: error }, 'Could not retry a deferred agent run; it stays deferred');
    }
  }
  if (due.length > 0) logger.info({ due: due.length, ...result }, 'Retried due deferred agent runs');
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
