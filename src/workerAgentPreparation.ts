import { AgentRegistry, logger } from '@propr/core';

export async function prepareAgentRegistryAtStartup(): Promise<AgentRegistry> {
    logger.info('Preparing agent Docker images and initializing agent registry...');
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(true);
    await registry.prepareImagesAndRefresh();
    const imageStatus = registry.getOperationalStatus().unifiedAgentImage;
    if (imageStatus.status !== 'ready') {
        throw new Error(imageStatus.error || `Agent image ${imageStatus.imageTag || 'unknown'} is unavailable`);
    }
    logger.info({
        agentCount: registry.getAllAgents().length,
        agents: registry.getAllAgents().map(a => ({ alias: a.config.alias, type: a.config.type, dockerImage: a.config.dockerImage })),
    }, 'Agent images prepared and registry initialized successfully');
    return registry;
}
