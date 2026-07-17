import type { Request, Response } from 'express';
import type { Queue } from 'bullmq';
import {
    loadAgentRuntimePackageState,
    loadAgents,
    requestAgentRuntimePackageBuild,
    saveAgentRuntimePackageState,
    searchAgentRuntimePackages,
    validateAgentRuntimePackageAvailability,
    validateAgentRuntimePackages,
    type AgentRuntimeBuildJobData,
    type AgentRuntimePackageState
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
    search: typeof searchAgentRuntimePackages;
    validate: typeof validateAgentRuntimePackages;
    validateAvailability: typeof validateAgentRuntimePackageAvailability;
}

function canManageRuntime(req: Request): boolean {
    const configured = (process.env.PROPR_ADMIN_USERS || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    const username = req.user?.username?.toLowerCase();
    if (configured.length === 0) {
        return Boolean(username && /^(1|true|yes)$/i.test(process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER || ''));
    }
    return Boolean(username && configured.includes(username));
}

function requireRuntimeAdmin(req: Request, res: Response): boolean {
    if (canManageRuntime(req)) return true;
    res.status(403).json({ error: 'Only ProPR installation administrators may change agent runtime packages' });
    return false;
}

function redactRuntimeStateForUser(state: AgentRuntimePackageState, req: Request): AgentRuntimePackageState {
    if (canManageRuntime(req)) return state;
    return { ...state, buildLog: undefined, error: undefined };
}

async function configuredBaseImages(loadConfiguredAgents: typeof loadAgents): Promise<string[]> {
    const agents = await loadConfiguredAgents();
    const images = agents.map(agent => agent.dockerImage).filter(Boolean);
    if (images.length === 0) {
        images.push(process.env.AGENT_DOCKER_IMAGE || 'propr/agent:latest');
    }
    return [...new Set(images)].sort();
}

export function createAgentRuntimeRoutes({ runtimeBuildQueue, services: overrides }: AgentRuntimeRoutesDeps) {
    const services: AgentRuntimeRouteServices = {
        loadState: loadAgentRuntimePackageState,
        loadAgents,
        requestBuild: requestAgentRuntimePackageBuild,
        saveState: saveAgentRuntimePackageState,
        search: searchAgentRuntimePackages,
        validate: validateAgentRuntimePackages,
        validateAvailability: validateAgentRuntimePackageAvailability,
        ...overrides
    };

    async function getRuntimePackages(req: Request, res: Response): Promise<void> {
        try {
            res.json(redactRuntimeStateForUser(await services.loadState(), req));
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    async function validateRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const syntax = services.validate(req.body?.packages);
            if (!syntax.valid) {
                res.status(400).json(syntax);
                return;
            }
            const images = await configuredBaseImages(services.loadAgents);
            const result = await services.validateAvailability(syntax.packages, images);
            res.status(result.valid ? 200 : 400).json(result);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    async function searchRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const query = typeof req.query.q === 'string' ? req.query.q : '';
            const images = await configuredBaseImages(services.loadAgents);
            res.json(await services.search(query, images));
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    async function queueBuild(packages: unknown, res: Response): Promise<void> {
        let jobData: AgentRuntimeBuildJobData | undefined;
        let syntax: ReturnType<AgentRuntimeRouteServices['validate']> | undefined;
        try {
            syntax = services.validate(packages);
            if (!syntax.valid) {
                res.status(400).json({ error: syntax.errors.join('; '), errors: syntax.errors });
                return;
            }
            const images = await configuredBaseImages(services.loadAgents);
            const availability = await services.validateAvailability(syntax.packages, images);
            if (!availability.valid) {
                res.status(400).json({ error: availability.errors.join('; '), ...availability });
                return;
            }
            jobData = await services.requestBuild(availability.packages, images);
            await runtimeBuildQueue.add('build-agent-runtime', jobData, {
                jobId: jobData.buildId,
                removeOnComplete: 20,
                removeOnFail: 50
            });
            res.status(202).json(await services.loadState());
        } catch (error) {
            if (jobData) {
                try {
                    const state = await services.loadState();
                    if (state.buildId === jobData.buildId) {
                        await services.saveState({
                            ...state,
                            status: 'failed',
                            error: (error as Error).message,
                            updatedAt: new Date().toISOString()
                        });
                    }
                } catch {
                    /* Preserve the original queue/validation error response. */
                }
            }
            res.status(syntax?.valid === false ? 400 : 500).json({
                error: (error as Error).message,
                ...(syntax?.valid === false ? { errors: syntax.errors } : {})
            });
        }
    }

    async function putRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        await queueBuild(req.body?.packages, res);
    }

    async function applyRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const state = await services.loadState();
            await queueBuild(state.packages, res);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    return {
        getRuntimePackages,
        searchRuntimePackages,
        validateRuntimePackages,
        putRuntimePackages,
        applyRuntimePackages
    };
}
