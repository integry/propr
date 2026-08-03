import * as configManager from '@propr/core';
import {
  getIndexingQueue,
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
  requestIndexingCancellation: typeof requestIndexingCancellation;
  updateRepositoryStatus: typeof updateRepositoryStatus;
  recordSkippedIndexingRun: typeof recordSkippedIndexingRun;
  publishIndexingStatus: typeof publishIndexingStatus;
}

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
    active = await job.getState() === 'active';
    if (!active) {
      logger.debug({ repository, branch, runId, error },
        'Indexing job reached a terminal queue state while stop raced with startup');
      return undefined;
    }
    await deps.requestIndexingCancellation(repository, branch, runId);
    return true;
  }
}

export async function stopIndexingJob(
  repository: string,
  branch?: string,
  overrides: Partial<StopIndexingDeps> = {}
): Promise<StopIndexingResult> {
  const deps: StopIndexingDeps = {
    getIndexingQueue,
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
      const jobBranch = configManager.normalizeSummarizationBranch(job.data.baseBranch);
      const runId = job.data.runId;
      const active = await prepareJobStop(job, deps, {
        repository,
        branch: jobBranch,
        runId,
      });
      if (active === undefined) continue;

      let transition = await deps.updateRepositoryStatus(repository, 'idle', jobBranch, {
        ...(runId ? { runId } : {}),
      });
      // A job can become active before its producer/worker ownership write.
      // The history helper closes that race, but refuses a cancellation when
      // completed or failed history for this run already won.
      if (!transition.applied && runId && job.data.transitionAt) {
        transition = await deps.recordSkippedIndexingRun(repository, jobBranch, {
          runId,
          transitionAt: job.data.transitionAt,
        });
      }
      if (!transition.applied) continue;
      await publishIndexingRunBestEffort({
        publisher: deps.publishIndexingStatus,
        repository,
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

    return { success: true, cancelledActiveRuns, removedQueuedRuns };
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
