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
    runtimeBuildQueue?: Queue<AgentRuntimeBuildJobData>;
    getRuntimeBuildQueue?: () => Queue<AgentRuntimeBuildJobData> | undefined;
    services?: Partial<AgentRuntimeRouteServices>;
}

type RuntimePackageStateResponse = AgentRuntimePackageState & { canManage: boolean };
const DEFAULT_RUNTIME_PACKAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

class RuntimePackageRequestTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'RuntimePackageRequestTimeoutError';
    }
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

function requireAuthenticatedRuntimeReader(req: Request, res: Response): boolean {
    if (req.user?.username) return true;
    res.status(401).json({ error: 'Authentication required' });
    return false;
}

function runtimeStateResponse(state: AgentRuntimePackageState, req: Request): RuntimePackageStateResponse {
    const canManage = canManageRuntime(req);
    return { ...(canManage ? state : { ...state, buildLog: undefined, error: undefined }), canManage };
}

function runtimePackageRequestTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNTIME_PACKAGE_REQUEST_TIMEOUT_MS;
}

async function withRuntimePackageRequestTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
    const timeoutMs = runtimePackageRequestTimeoutMs();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => reject(new RuntimePackageRequestTimeoutError(operation, timeoutMs)), timeoutMs);
            })
        ]);
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

function sendRuntimePackageError(error: unknown, res: Response): void {
    if (error instanceof RuntimePackageRequestTimeoutError) {
        res.status(504).json({ error: error.message });
        return;
    }
    res.status(500).json({ error: (error as Error).message });
}

async function configuredBaseImages(loadConfiguredAgents: typeof loadAgents): Promise<string[]> {
    const agents = await loadConfiguredAgents();
    const images = agents.map(agent => agent.dockerImage).filter(Boolean);
    if (images.length === 0) {
        images.push(process.env.AGENT_DOCKER_IMAGE || 'propr/agent:latest');
    }
    return [...new Set(images)].sort();
}

export function createAgentRuntimeRoutes({ runtimeBuildQueue, getRuntimeBuildQueue, services: overrides }: AgentRuntimeRoutesDeps) {
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
        if (!requireAuthenticatedRuntimeReader(req, res)) return;
        try {
            res.json(runtimeStateResponse(await services.loadState(), req));
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
            const result = await withRuntimePackageRequestTimeout(
                'Agent runtime package availability validation',
                services.validateAvailability(syntax.packages, images)
            );
            res.status(result.valid ? 200 : 400).json(result);
        } catch (error) {
            sendRuntimePackageError(error, res);
        }
    }

    async function searchRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const query = typeof req.query.q === 'string' ? req.query.q : '';
            const images = await configuredBaseImages(services.loadAgents);
            res.json(await withRuntimePackageRequestTimeout(
                'Agent runtime package search',
                services.search(query, images)
            ));
        } catch (error) {
            sendRuntimePackageError(error, res);
        }
    }

    async function queueBuild(packages: unknown, req: Request, res: Response): Promise<void> {
        let jobData: AgentRuntimeBuildJobData | undefined;
        let syntax: ReturnType<AgentRuntimeRouteServices['validate']> | undefined;
        try {
            syntax = services.validate(packages);
            if (!syntax.valid) {
                res.status(400).json({ error: syntax.errors.join('; '), errors: syntax.errors });
                return;
            }
            const images = await configuredBaseImages(services.loadAgents);
            const availability = await withRuntimePackageRequestTimeout(
                'Agent runtime package availability validation',
                services.validateAvailability(syntax.packages, images)
            );
            if (!availability.valid) {
                res.status(400).json({ error: availability.errors.join('; '), ...availability });
                return;
            }
            jobData = await services.requestBuild(availability.packages, images);
            const queue = getRuntimeBuildQueue?.() || runtimeBuildQueue;
            if (!queue) throw new Error('Agent runtime build queue is not initialized');
            await queue.add('build-agent-runtime', jobData, {
                jobId: jobData.buildId,
                removeOnComplete: 20,
                removeOnFail: 50
            });
            res.status(202).json(runtimeStateResponse(await services.loadState(), req));
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
            sendRuntimePackageError(error, res);
        }
    }

    async function putRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        await queueBuild(req.body?.packages, req, res);
    }

    async function applyRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const state = await services.loadState();
            await queueBuild(state.packages, req, res);
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
