import * as configManager from '@propr/core';
import {
  getIndexingQueue,
  getActiveRepositoryIndexingRuns,
  logger,
  publishIndexingStatus,
  recordSkippedIndexingRun,
  requestIndexingCancellation,
  updateRepositoryStatus,
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
  context: { repository: string; branch: string; runId: string | undefined }
): Promise<boolean | undefined> {
  const { repository, branch, runId } = context;
  let active = await job.getState() === 'active';
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
      return undefined;
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

    for (const job of matchingJobs) {
      // Runtime Redis keys and the worker both use the repository identity stored
      // on the job. The request spelling is only used for case-insensitive lookup.
      const jobRepository = job.data.repository;
      const jobBranch = configManager.normalizeSummarizationBranch(job.data.baseBranch);
      const runId = job.data.runId;
      const active = await prepareJobStop(job, deps, {
        repository: jobRepository,
        branch: jobBranch,
        runId,
      });
      if (active === undefined) continue;

      let transition = await deps.updateRepositoryStatus(jobRepository, 'idle', jobBranch, {
        ...(runId ? { runId } : {}),
      });
      // A job can become active before its producer/worker ownership write.
      // The history helper closes that race, but refuses a cancellation when
      // completed or failed history for this run already won.
      if (!transition.applied && runId && job.data.transitionAt) {
        transition = await deps.recordSkippedIndexingRun(jobRepository, jobBranch, {
          runId,
          transitionAt: job.data.transitionAt,
        });
      }
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
    if (cancelledActiveRuns.length + removedQueuedRuns.length === 0) {
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
