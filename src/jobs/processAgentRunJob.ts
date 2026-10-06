import type { Job } from 'bullmq';
import type { AgentRunState } from '@propr/shared';
import { logger, transitionAgentRun, type AgentRunJobData, type JobResult } from '@propr/core';

/**
 * Placeholder agent run processors so the job names are dispatched instead of
 * falling into `Unknown job type`. The report phase (issue 7) and the acting
 * phase (issue 10) replace them. The run is failed explicitly so it does not
 * stay `queued` or `acting` forever.
 */
async function failNotImplemented(job: Job<AgentRunJobData>, from: AgentRunState): Promise<never> {
    const message = `Not implemented: agent run ${job.data.phase} phase`;
    try {
        await transitionAgentRun(job.data.runId, [from], 'failed', { failureReason: message });
    } catch (error) {
        logger.error({ runId: job.data.runId, err: error }, 'Could not mark agent run failed');
    }
    throw new Error(message);
}

export async function processAgentRunJob(job: Job<AgentRunJobData>): Promise<JobResult> {
    return failNotImplemented(job, 'queued');
}

export async function processAgentActionJob(job: Job<AgentRunJobData>): Promise<JobResult> {
    return failNotImplemented(job, 'acting');
}
