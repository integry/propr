import type { Request, Response } from 'express';
import type { Queue } from 'bullmq';
import {
    loadAgentRuntimePackageState,
    loadAgents,
    requestAgentRuntimePackageBuild,
    saveAgentRuntimePackageState,
    validateAgentRuntimePackages,
    type AgentRuntimeBuildJobData
} from '@propr/core';

interface AgentRuntimeRoutesDeps {
    runtimeBuildQueue: Queue<AgentRuntimeBuildJobData>;
    services?: Partial<AgentRuntimeRouteServices>;
}

interface AgentRuntimeRouteServices {
    loadState: typeof loadAgentRuntimePackageState;
    loadAgents: typeof loadAgents;
    requestBuild: typeof requestAgentRuntimePackageBuild;
    saveState: typeof saveAgentRuntimePackageState;
    validate: typeof validateAgentRuntimePackages;
}

function canManageRuntime(req: Request): boolean {
    const configured = (process.env.PROPR_ADMIN_USERS || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    if (configured.length === 0) return true;
    const username = req.user?.username?.toLowerCase();
    return Boolean(username && configured.includes(username));
}

function requireRuntimeAdmin(req: Request, res: Response): boolean {
    if (canManageRuntime(req)) return true;
    res.status(403).json({ error: 'Only ProPR installation administrators may change agent runtime packages' });
    return false;
}

async function configuredBaseImages(loadConfiguredAgents: typeof loadAgents): Promise<string[]> {
    const agents = await loadConfiguredAgents();
    const images = agents.map(agent => agent.dockerImage).filter(Boolean);
    if (images.length === 0) {
        images.push(process.env.CLAUDE_DOCKER_IMAGE || 'propr/agent-claude:latest');
    }
    return [...new Set(images)].sort();
}

export function createAgentRuntimeRoutes({ runtimeBuildQueue, services: overrides }: AgentRuntimeRoutesDeps) {
    const services: AgentRuntimeRouteServices = {
        loadState: loadAgentRuntimePackageState,
        loadAgents,
        requestBuild: requestAgentRuntimePackageBuild,
        saveState: saveAgentRuntimePackageState,
        validate: validateAgentRuntimePackages,
        ...overrides
    };

    async function getRuntimePackages(_req: Request, res: Response): Promise<void> {
        try {
            res.json(await services.loadState());
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    async function validateRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        const result = services.validate(req.body?.packages);
        res.status(result.valid ? 200 : 400).json(result);
    }

    async function queueBuild(packages: unknown, res: Response): Promise<void> {
        let jobData: AgentRuntimeBuildJobData | undefined;
        try {
            jobData = await services.requestBuild(packages, await configuredBaseImages(services.loadAgents));
            await runtimeBuildQueue.add('build-agent-runtime', jobData, {
                jobId: jobData.buildId,
                removeOnComplete: 20,
                removeOnFail: 50
            });
            res.status(202).json(await services.loadState());
        } catch (error) {
            if (jobData) {
                const state = await services.loadState();
                if (state.buildId === jobData.buildId) {
                    await services.saveState({
                        ...state,
                        status: 'failed',
                        error: (error as Error).message,
                        updatedAt: new Date().toISOString()
                    });
                }
            }
            const validation = services.validate(packages);
            res.status(validation.valid ? 500 : 400).json({
                error: (error as Error).message,
                ...(validation.valid ? {} : { errors: validation.errors })
            });
        }
    }

    async function putRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        await queueBuild(req.body?.packages, res);
    }

    async function applyRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        const state = await services.loadState();
        await queueBuild(state.packages, res);
    }

    return { getRuntimePackages, validateRuntimePackages, putRuntimePackages, applyRuntimePackages };
}
