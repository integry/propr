import * as configManager from '@propr/core';
import {
  getIndexingQueue,
  getActiveRepositoryIndexingRuns,
  logger,
  publishIndexingStatus,
  recordSkippedIndexingRun,
  requestIndexingCancellation,
  updateRepositoryStatus,
  type RepositoryStatusTransition,
  type IndexingJobData,
} from '@propr/core';
import { publishIndexingRunBestEffort } from './indexingStatusPublication.js';

export interface StopIndexingResult {
  success: boolean;
  message?: string;
  cancelledActiveRuns: IndexingStopTransition[];
  removedQueuedRuns: IndexingStopTransition[];
}

export interface IndexingStopTransition {
  branch: string;
  transitionAt: string;
  runId: string;
}

interface StopIndexingDeps {
  getIndexingQueue: typeof getIndexingQueue;
  getActiveRepositoryIndexingRuns: typeof getActiveRepositoryIndexingRuns;
  requestIndexingCancellation: typeof requestIndexingCancellation;
  updateRepositoryStatus: typeof updateRepositoryStatus;
  recordSkippedIndexingRun: typeof recordSkippedIndexingRun;
  publishIndexingStatus: typeof publishIndexingStatus;
}

const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed', 'unknown']);

async function prepareJobStop(
  job: { getState(): Promise<string>; remove(): Promise<void> },
  deps: StopIndexingDeps,
  context: { repository: string; branch: string; runId: string | undefined },
  persistTerminal: () => Promise<void>
): Promise<boolean | undefined> {
  const { repository, branch, runId } = context;
  const initialState = await job.getState();
  let active = initialState === 'active';
  if (TERMINAL_QUEUE_STATES.has(initialState)) return undefined;
  // The durable owner transition is recovery evidence. Keep the BullMQ job
  // intact until this succeeds; a worker that starts concurrently will reject
  // its stale ownership write after this run has become terminal.
  await persistTerminal();
  if (active) {
    await deps.requestIndexingCancellation(repository, branch, runId);
    return true;
  }
  try {
    await job.remove();
    return false;
  } catch (error) {
    const state = await job.getState();
    active = state === 'active';
    if (TERMINAL_QUEUE_STATES.has(state)) {
      logger.debug({ repository, branch, runId, error },
        'Indexing job reached a terminal queue state while stop raced with startup');
      return false;
    }
    if (active) {
      await deps.requestIndexingCancellation(repository, branch, runId);
      return true;
    }
    throw new Error(
      `Could not remove indexing job for ${repository} (${branch}); queue state is still ${state}`,
      { cause: error }
    );
  }
}

async function persistJobStop(
  job: { data: IndexingJobData },
  deps: StopIndexingDeps,
  repository: string,
  branch: string
): Promise<RepositoryStatusTransition> {
  const runId = job.data.runId;
  let transition = await deps.updateRepositoryStatus(repository, 'idle', branch, {
    ...(runId ? { runId } : {}),
  });
  // A job can appear before its producer/worker ownership write. Preserve a
  // run-scoped terminal record, unless completed/failed history already won.
  if (!transition.applied && runId && job.data.transitionAt) {
    transition = await deps.recordSkippedIndexingRun(repository, branch, {
      runId,
      transitionAt: job.data.transitionAt,
    });
  }
  return transition;
}

export async function stopIndexingJob(
  repository: string,
  branch?: string,
  overrides: Partial<StopIndexingDeps> = {}
): Promise<StopIndexingResult> {
  const deps: StopIndexingDeps = {
    getIndexingQueue,
    getActiveRepositoryIndexingRuns,
    requestIndexingCancellation,
    updateRepositoryStatus,
    recordSkippedIndexingRun,
    publishIndexingStatus,
    ...overrides,
  };
  try {
    const queue = await deps.getIndexingQueue();
    const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    const matchingJobs = jobs.filter((job: { data: IndexingJobData }) => {
      if (job.data.repository.toLowerCase() !== repository.toLowerCase()) return false;
      return branch === undefined || configManager.normalizeSummarizationBranch(job.data.baseBranch)
        === configManager.normalizeSummarizationBranch(branch);
    });
    const cancelledActiveRuns: IndexingStopTransition[] = [];
    const removedQueuedRuns: IndexingStopTransition[] = [];
    let preparedQueueJobs = 0;

    for (const job of matchingJobs) {
      // Runtime Redis keys and the worker both use the repository identity stored
      // on the job. The request spelling is only used for case-insensitive lookup.
      const jobRepository = job.data.repository;
      const jobBranch = configManager.normalizeSummarizationBranch(job.data.baseBranch);
      const runId = job.data.runId;
      let transition: RepositoryStatusTransition | undefined;
      const active = await prepareJobStop(job, deps, {
        repository: jobRepository,
        branch: jobBranch,
        runId,
      }, async () => {
        transition = await persistJobStop(job, deps, jobRepository, jobBranch);
      });
      if (active === undefined) continue;
      preparedQueueJobs++;
      if (!transition) throw new Error('Indexing stop did not persist its terminal transition');
      if (!transition.applied) continue;
      await publishIndexingRunBestEffort({
        publisher: deps.publishIndexingStatus,
        repository: jobRepository,
        branch: jobBranch,
        phase: 'idle',
        transition,
      });
      const stoppedRun = {
        branch: jobBranch,
        runId: transition.runId,
        transitionAt: transition.transitionAt,
      };
      if (active) cancelledActiveRuns.push(stoppedRun);
      else removedQueuedRuns.push(stoppedRun);
    }

    let message: string | undefined;
    if (cancelledActiveRuns.length + removedQueuedRuns.length === 0
        && preparedQueueJobs === 0) {
      const normalizedBranch = branch === undefined
        ? undefined
        : configManager.normalizeSummarizationBranch(branch);
      const durableRuns = await deps.getActiveRepositoryIndexingRuns(
        repository,
        normalizedBranch
      );
      for (const run of durableRuns) {
        const transition = await deps.updateRepositoryStatus(
          run.fullName,
          'idle',
          run.branch,
          { runId: run.runId }
        );
        if (!transition.applied) continue;
        await publishIndexingRunBestEffort({
          publisher: deps.publishIndexingStatus,
          repository: run.fullName,
          branch: run.branch,
          phase: 'idle',
          transition,
        });
        cancelledActiveRuns.push({
          branch: run.branch,
          runId: transition.runId,
          transitionAt: transition.transitionAt,
        });
      }
      if (cancelledActiveRuns.length > 0) {
        message = `Stopped ${cancelledActiveRuns.length} orphaned durable indexing run(s)`;
      } else if (matchingJobs.length === 0) {
        message = 'No queued or durable active indexing run matched the request';
      }
    }

    return {
      success: true,
      ...(message === undefined ? {} : { message }),
      cancelledActiveRuns,
      removedQueuedRuns
    };
  } catch (error) {
    logger.error({ error }, 'Error stopping indexing job');
    return {
      success: false,
      message: (error as Error).message,
      cancelledActiveRuns: [],
      removedQueuedRuns: [],
    };
  }
}
