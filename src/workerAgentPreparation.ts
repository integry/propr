import { setTimeout } from 'node:timers/promises';
import { DelayedError, type Job } from 'bullmq';
import { AgentRegistry, logger, ensureAgentBundleImage, type AgentImagePreparationJobData } from '@propr/core';

export async function prepareAgentRegistryAtStartup(): Promise<AgentRegistry> {
    logger.info('Preparing agent Docker images and initializing agent registry...');
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(true);
    try {
        await registry.prepareImagesAndRefresh();
    } catch (error) {
        logger.error({ error }, 'Startup image preparation failed; waiting for registry recovery');
    }
    const imageStatus = registry.getOperationalStatus().unifiedAgentImage;
    if (imageStatus.status !== 'ready') {
        logger.error({ imageStatus }, 'Task capacity unavailable; image preparation consumer remains available');
    }
    // Owner retries are bounded by the registry backoff/circuit. Queued
    // preparation and config recovery can also establish readiness; polling
    // here adds a throttled inspect-only check so an image prepared by another
    // process still clears this failure, and never starts another build.
    while (!registry.isInitialized() || registry.getOperationalStatus().unifiedAgentImage.status !== 'ready') {
        await setTimeout(1_000);
        await registry.inspectAgentImageAvailability();
    }
    logger.info({
        agentCount: registry.getAllAgents().length,
        agents: registry.getAllAgents().map(a => ({ alias: a.config.alias, type: a.config.type, dockerImage: a.config.dockerImage })),
    }, 'Agent images prepared and registry initialized successfully');
    return registry;
}

export async function processAgentImagePreparationJob(job: Job<AgentImagePreparationJobData>): Promise<void> {
    logger.info({ imageTag: job.data.imageTag }, 'Preparing unified agent image in the worker-owned path');
    const workerRegistry = AgentRegistry.getInstance();
    workerRegistry.setImagePreparationOwner(true);
    if (job.data.versions && job.data.contentHash) {
        const result = await ensureAgentBundleImage(job.data.versions, job.data.contentHash);
        if (!result.success) throw new Error(result.error || `Agent image ${job.data.imageTag} is unavailable`);
        await workerRegistry.refresh();
        return;
    }
    const previous = workerRegistry.getOperationalStatus().unifiedAgentImage;
    if (!previous.circuitBreakerOpen && (previous.retryCount ?? 0) > 0 && previous.nextRetryAt) {
        const deadline = Date.parse(previous.nextRetryAt);
        if (deadline > Date.now()) {
            // Preserve the owner's retry deadline without occupying the consumer
            // that also serves explicit operator builds.
            await job.moveToDelayed(deadline, job.token);
            throw new DelayedError();
        }
    }
    await workerRegistry.recoverImagesAndRefresh();
    const status = workerRegistry.getOperationalStatus().unifiedAgentImage;
    if (status.status !== 'ready') {
        throw new Error(status.error || `Unified agent image ${status.imageTag || job.data.imageTag} is unavailable`);
    }
}
