import crypto from 'node:crypto';
import { ErrorCode, Queue, QueueEvents, type Job } from 'bullmq';
import { AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS } from './agentImageBuildLock.js';
import type { AgentCliVersionMatrix } from './version/versionService.js';

export const AGENT_IMAGE_PREPARATION_QUEUE_NAME = 'agent-image-preparation';
// A configuration refresh can prepare both a base and a runtime image, each
// with a lease wait and a 20-minute build, plus pulls and inspection overhead.
// The lease-wait allowance also covers queueing behind other preparations.
const AGENT_IMAGE_PREPARATION_TIMEOUT_MS = 2 * (AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS + 20 * 60_000) + 15 * 60_000;
// Each completion wait is a short probe so job-state re-evaluation and the
// no-worker check run promptly; only an attached, progressing preparation may
// consume the full lease/build budget above.
const AGENT_IMAGE_PREPARATION_POLL_INTERVAL_MS = 30_000;
const AGENT_IMAGE_PREPARATION_READY_TIMEOUT_MS = 30_000;
const PENDING_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];

export interface AgentImagePreparationJobData {
    imageTag: string;
    requestedAt: string;
    versions?: AgentCliVersionMatrix;
    contentHash?: string;
}

const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

// Producer commands must reject during a Redis outage so API requests and
// registry recovery settle into their bounded failure paths instead of
// pending indefinitely. Blocking event connections require unlimited
// per-request retries and are configured separately.
const producerConnection = { ...connection, maxRetriesPerRequest: 5 };
const eventsConnection = { ...connection, maxRetriesPerRequest: null };

type PreparationOptions = Pick<AgentImagePreparationJobData, 'versions' | 'contentHash'>;

export function agentImagePreparationJobId(imageTag: string, options: PreparationOptions = {}): string {
    // Explicit builds must not join a refresh that resolves the worker's
    // mutable configuration when it eventually starts executing.
    const identity = options.versions || options.contentHash
        ? JSON.stringify([imageTag, Object.entries(options.versions ?? {}).sort(), options.contentHash])
        : imageTag;
    return `prepare-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function createAgentImagePreparationQueue(): Queue<AgentImagePreparationJobData> {
    return new Queue<AgentImagePreparationJobData>(AGENT_IMAGE_PREPARATION_QUEUE_NAME, {
        connection: producerConnection,
        defaultJobOptions: {
            attempts: 1,
            removeOnComplete: { age: 60 * 60, count: 100 },
            removeOnFail: { age: 60 * 60, count: 100 },
        },
    });
}

let requestQueue: Queue<AgentImagePreparationJobData> | undefined;
let requestEvents: QueueEvents | undefined;

function getRequestQueue(): Queue<AgentImagePreparationJobData> {
    requestQueue ??= createAgentImagePreparationQueue();
    return requestQueue;
}

// Both connections reconnect forever and BullMQ holds commands until the
// initial connection is ready; `maxRetriesPerRequest` does not bound that
// wait. Bound only this caller's wait so a Redis outage rejects into the
// registry's recovery backoff. Instances stay cached and can become ready for
// a later request.
async function waitUntilReadyWithin(
    resource: { waitUntilReady(): Promise<unknown> },
    description: string,
): Promise<void> {
    const readiness = resource.waitUntilReady();
    readiness.catch(() => {});
    let readyTimer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            readiness,
            new Promise<never>((_resolve, reject) => {
                readyTimer = setTimeout(() => reject(new Error(
                    `Agent image preparation ${description} for the ${AGENT_IMAGE_PREPARATION_QUEUE_NAME} queue `
                    + `were not ready within ${AGENT_IMAGE_PREPARATION_READY_TIMEOUT_MS}ms`,
                )), AGENT_IMAGE_PREPARATION_READY_TIMEOUT_MS);
                readyTimer.unref?.();
            }),
        ]);
    } finally {
        if (readyTimer) clearTimeout(readyTimer);
    }
}

async function getRequestEvents(): Promise<QueueEvents> {
    requestEvents ??= new QueueEvents(AGENT_IMAGE_PREPARATION_QUEUE_NAME, { connection: eventsConnection });
    const events = requestEvents;
    await waitUntilReadyWithin(events, 'events');
    return events;
}

async function waitForPreparation(job: Job<AgentImagePreparationJobData>): Promise<void> {
    const events = await getRequestEvents();
    const deadline = Date.now() + AGENT_IMAGE_PREPARATION_TIMEOUT_MS;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(`Agent image preparation job ${job.id} did not finish within `
                + `${Math.round(AGENT_IMAGE_PREPARATION_TIMEOUT_MS / 60_000)} minutes`);
        }
        try {
            await job.waitUntilFinished(events, Math.min(AGENT_IMAGE_PREPARATION_POLL_INTERVAL_MS, remaining));
            return;
        } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Job wait ')
                || !error.message.includes('timed out before finishing')) throw error;
            const state = await job.getState();
            // Queue/lease waiting is not a preparation failure. Reattach to
            // live jobs; for a terminal race, read the actual completion result.
            if (!PENDING_STATES.includes(state) && state !== 'completed' && state !== 'failed') throw error;
            // A job nobody consumes would otherwise keep callers (and the
            // registry's recovery circuit) waiting until the overall deadline.
            if (state !== 'active' && PENDING_STATES.includes(state) && await getRequestQueue().getWorkersCount() === 0) {
                throw new Error(`Agent image preparation job ${job.id} is ${state} but no worker is consuming `
                    + `the ${AGENT_IMAGE_PREPARATION_QUEUE_NAME} queue`);
            }
        }
    }
}

/**
 * Enqueue one worker-owned preparation for an image and await its result.
 * BullMQ's deterministic job ID coalesces concurrent API callers and the
 * worker is the only process that owns the Docker preparation operation.
 */
export async function enqueueAgentImagePreparation(
    imageTag: string,
    options: PreparationOptions = {},
): Promise<void> {
    const queue = getRequestQueue();
    await waitUntilReadyWithin(queue, 'producer connections');
    const jobId = agentImagePreparationJobId(imageTag, options);
    const existing = await queue.getJob(jobId);
    let job = existing;
    if (job) {
        const state = await job.getState();
        if (state === 'completed' || state === 'failed') {
            // BullMQ atomically verifies the terminal state and moves the same
            // job to waiting. A stale caller cannot remove another request.
            try {
                await job.retry(state);
            } catch (error) {
                const code = (error as { code?: number }).code;
                if (code !== ErrorCode.JobNotInState && code !== ErrorCode.JobNotExist) throw error;
                job = await queue.getJob(jobId);
            }
        } else if (state === 'unknown') {
            job = undefined;
        }
    }
    job ??= await queue.add('prepare-unified-agent-image', {
        imageTag,
        requestedAt: new Date().toISOString(),
        ...options,
    }, { jobId });
    await waitForPreparation(job);
}

export async function closeAgentImagePreparationQueue(): Promise<void> {
    await requestEvents?.close();
    await requestQueue?.close();
    requestEvents = undefined;
    requestQueue = undefined;
}
