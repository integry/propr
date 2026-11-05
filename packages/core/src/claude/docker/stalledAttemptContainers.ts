import logger from '../../utils/logger.js';
import { runDocker, stopDockerContainer } from './dockerContainerControl.js';

export interface StalledAttemptContainer { id: string; name: string; }

/**
 * Stops the still-running containers of a queue job's earlier attempt. BullMQ
 * redelivers a job whose worker stopped renewing its lock (typically a worker
 * restart), but the agent containers that attempt started run on the host
 * Docker daemon and outlive the worker; left alone, the redelivered attempt
 * runs a duplicate agent beside them. A container belongs to the job when its
 * exact task label is the job ID (PR comment and merge tasks) or contains the
 * job's correlation ID (issue tasks embed it in their task ID).
 *
 * Follow-up comment jobs are exempt: their handoff recovery serializes the
 * redelivered attempt behind the earlier attempt's agent and adopts its
 * worktree, and it reads an exited agent as finished — stopping a still-live
 * agent here would publish its half-finished output as a completed follow-up.
 */
export async function stopStalledAttemptContainers(
    job: { jobId?: string; correlationId?: string; jobName?: string },
    deps: { list?: (args: string[], timeout: number) => Promise<string>; stop?: typeof stopDockerContainer } = {},
): Promise<StalledAttemptContainer[]> {
    const { jobId, correlationId, jobName } = job;
    const { list = runDocker, stop = stopDockerContainer } = deps;
    if (jobName === 'processPullRequestComment') return [];
    const ownsCorrelation = !!correlationId && correlationId.length >= 16;
    if (!jobId && !ownsCorrelation) return [];
    let listing: string;
    try {
        listing = await list(['ps', '--filter', 'label=propr.task.id', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "propr.task.id"}}'], 10_000);
    } catch (error) {
        logger.warn({ jobId, error: (error as Error).message }, 'Could not list containers of a stalled job attempt');
        return [];
    }
    const stale = listing.split('\n').map(line => line.trim().split('\t')).filter(([id, name, taskId]) =>
        id && name && taskId && (taskId === jobId || (ownsCorrelation && taskId.includes(correlationId!))));
    const stopped: StalledAttemptContainer[] = [];
    for (const [id, name, taskId] of stale) {
        const outcome = await stop(id, 20);
        if (outcome.success) stopped.push({ id, name });
        logger.warn({ jobId, containerId: id, containerName: name, taskId, stopped: outcome.success, error: outcome.error },
            'Stopped a container left running by an earlier attempt of a redelivered job');
    }
    return stopped;
}
