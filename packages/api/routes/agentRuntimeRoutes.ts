import type { Request, Response } from 'express';
import type { Queue } from 'bullmq';
import {
    agentRuntimeUsage,
    describeAgentRuntimePackageRuntimes,
    describeRemoteAgentRuntimePackageInstall,
    AGENT_IMAGE_PACKAGE_BASE,
    loadAgentRuntimePackageState,
    loadEffectiveAgentBaseImages,
    remoteAgentRuntimeConfigured,
    remoteAgentRuntimePackageInstall,
    remoteAgentRuntimePackageTargets,
    requestAgentRuntimePackageBuild,
    saveAgentRuntimePackageState,
    searchAgentRuntimePackages,
    validateAgentRuntimePackageAvailability,
    validateAgentRuntimePackages,
    validateAgentRuntimePackagesWithIndex,
    verifyAgentRuntimePackageProfile,
    warmAgentRuntimePackageCatalog,
    type AgentRuntimeBuildJobData,
    type AgentRuntimePackageRuntimeState,
    type AgentRuntimePackageState,
    type AgentRuntimePackageTarget,
    type AgentRuntimeUsage,
    type AgentRuntimePackageVerificationResult
} from '@propr/core';

interface AgentRuntimeRoutesDeps {
    runtimeBuildQueue?: Queue<AgentRuntimeBuildJobData>;
    getRuntimeBuildQueue?: () => Queue<AgentRuntimeBuildJobData> | undefined;
    services?: Partial<AgentRuntimeRouteServices>;
}

type RuntimePackageStateResponse = AgentRuntimePackageState & { canManage: boolean; warnings?: string[]; runtimes?: AgentRuntimePackageRuntimeState[] };
const DEFAULT_RUNTIME_PACKAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

class RuntimePackageRequestTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'RuntimePackageRequestTimeoutError';
    }
}

interface AgentRuntimeRouteServices {
    loadState: typeof loadAgentRuntimePackageState;
    loadBaseImages: typeof loadEffectiveAgentBaseImages;
    /** How remote runtimes apply the packages when no agent runs on Docker; undefined when Docker is in use. */
    remoteInstall: () => Promise<string | undefined>;
    /** Whether any agent, the instance default or the worker's published default selects a remote runtime. */
    remoteConfigured: () => Promise<boolean>;
    /** The runtimes in use, decided like `remoteInstall`; Settings shows each one's package state. */
    runtimeUsage: () => Promise<AgentRuntimeUsage>;
    /** Index checks for the remote runtimes in use, each against the apt sources it installs from. */
    remoteTargets: () => Promise<AgentRuntimePackageTarget[]>;
    requestBuild: typeof requestAgentRuntimePackageBuild;
    saveState: typeof saveAgentRuntimePackageState;
    search: typeof searchAgentRuntimePackages;
    validate: typeof validateAgentRuntimePackages;
    validateAvailability: typeof validateAgentRuntimePackageAvailability;
    /** Docker-free check against the agent image's Debian package index. */
    validateWithIndex: typeof validateAgentRuntimePackagesWithIndex;
    verify: typeof verifyAgentRuntimePackageProfile;
    warmCatalog: typeof warmAgentRuntimePackageCatalog;
}

function requireRuntimeAdmin(req: Request, res: Response): boolean {
    if (req.authorization?.permissions.includes('instance.manage_runtime')) return true;
    res.status(403).json({ error: 'Only ProPR installation administrators may change agent runtime packages' });
    return false;
}

/** Docker availability results carry no runtime name; on an instance with remote runtimes too, errors name Docker. */
function nameDockerErrors<T extends { errors: string[] }>(result: T): T {
    return { ...result, errors: result.errors.map(error => `Docker: ${error}`) };
}

type AvailabilityResult = Awaited<ReturnType<typeof validateAgentRuntimePackagesWithIndex>>;

function mergeAvailability(first: AvailabilityResult, second: AvailabilityResult): AvailabilityResult {
    const unavailable = new Map<string, string[]>();
    for (const entry of [...first.availability, ...second.availability]) unavailable.set(entry.package, [...(unavailable.get(entry.package) ?? []), ...entry.unavailableOn]);
    const errors = [...first.errors, ...second.errors];
    return { valid: errors.length === 0, packages: first.packages, errors, sources: [...first.sources, ...second.sources],
        availability: first.packages.map(spec => ({ package: spec, available: !unavailable.get(spec)?.length, unavailableOn: unavailable.get(spec) ?? [] })),
        warnings: [...first.warnings, ...second.warnings] };
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

const DOCKER_UNREACHABLE = /cannot connect to the docker daemon|is the docker daemon running|error during connect|spawn docker ENOENT|docker: (?:command )?not found/i;

function dockerUnreachable(error: unknown): boolean {
    for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
        if (DOCKER_UNREACHABLE.test(current.message)) return true;
    }
    return false;
}

// The effective images are computed the same way the registry computes them
// (bundle tag from CLI versions + content hash) rather than read from saved
// agent configs, which can hold stale dockerImage values the registry would
// overwrite on its next refresh.
async function configuredBaseImages(loadBaseImages: typeof loadEffectiveAgentBaseImages): Promise<string[]> {
    const images = (await loadBaseImages()).filter(Boolean);
    if (images.length === 0) {
        images.push(process.env.AGENT_DOCKER_IMAGE || 'propr/agent:latest');
    }
    return [...new Set(images)].sort();
}

export function createAgentRuntimeRoutes({ runtimeBuildQueue, getRuntimeBuildQueue, services: overrides }: AgentRuntimeRoutesDeps) {
    const services: AgentRuntimeRouteServices = {
        loadState: loadAgentRuntimePackageState,
        loadBaseImages: loadEffectiveAgentBaseImages,
        remoteInstall: () => remoteAgentRuntimePackageInstall(),
        remoteConfigured: () => remoteAgentRuntimeConfigured(),
        runtimeUsage: () => agentRuntimeUsage(),
        remoteTargets: () => remoteAgentRuntimePackageTargets(),
        requestBuild: requestAgentRuntimePackageBuild,
        saveState: saveAgentRuntimePackageState,
        search: searchAgentRuntimePackages,
        validate: validateAgentRuntimePackages,
        validateAvailability: validateAgentRuntimePackageAvailability,
        validateWithIndex: validateAgentRuntimePackagesWithIndex,
        verify: verifyAgentRuntimePackageProfile,
        warmCatalog: warmAgentRuntimePackageCatalog,
        ...overrides
    };

    // Each runtime in use is checked against the apt sources it installs from: Docker against the agent
    // images (with Docker), Fly Machines against the agent image's Debian index, and Sprites against the
    // Sprite base image's (Ubuntu) index; errors name the runtime. Without Docker (only remote runtimes,
    // or no reachable daemon while a remote runtime is selected) Docker's own check uses the agent image's
    // index. An index that cannot be fetched passes the list with a warning; apt is the safety net.
    async function checkWithIndex(packages: string[], targets: AgentRuntimePackageTarget[] = []) {
        return withRuntimePackageRequestTimeout('Agent runtime package availability validation', services.validateWithIndex(packages, undefined, targets));
    }

    async function checkAvailability(packages: string[]): Promise<AvailabilityResult> {
        const targets = await services.remoteTargets().catch(() => []);
        if (await services.remoteInstall()) return checkWithIndex(packages, targets);
        const images = await configuredBaseImages(services.loadBaseImages);
        let docker: AvailabilityResult;
        try {
            docker = { warnings: [], ...await withRuntimePackageRequestTimeout(
                'Agent runtime package availability validation',
                services.validateAvailability(packages, images)
            ) };
        } catch (error) {
            if (dockerUnreachable(error) && await services.remoteConfigured().catch(() => false)) {
                return checkWithIndex(packages, targets.length ? [{ runtimes: ['Docker'], base: AGENT_IMAGE_PACKAGE_BASE }, ...targets] : []);
            }
            throw error;
        }
        if (targets.length === 0) return docker;
        return mergeAvailability(nameDockerErrors(docker), await checkWithIndex(packages, targets));
    }

    /** The state with `appliedBy` and the per-runtime states recomputed from the runtimes in use now. */
    async function stateResponse(state: AgentRuntimePackageState, warnings: string[] = []): Promise<RuntimePackageStateResponse> {
        const usage = await services.runtimeUsage().catch(() => undefined);
        const appliedBy = usage ? describeRemoteAgentRuntimePackageInstall(usage) : await services.remoteInstall().catch(() => state.appliedBy);
        return {
            ...state, appliedBy: state.activePackages.length || state.packages.length ? appliedBy : undefined, canManage: true,
            ...(usage && { runtimes: describeAgentRuntimePackageRuntimes(state, usage) }),
            ...(warnings.length > 0 && { warnings }),
        };
    }

    async function getRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            // An admin loading the runtime state is about to search/validate
            // packages; warm the catalog off the request path so their first
            // search does not wait on a container running apt-get update.
            void services.remoteInstall()
                .then(async remote => { if (!remote) await services.warmCatalog(await configuredBaseImages(services.loadBaseImages)); })
                .catch(() => { /* Best-effort warm-up only. */ });
            res.json(await stateResponse(await services.loadState()));
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
            const result = await checkAvailability(syntax.packages);
            res.status(result.valid ? 200 : 400).json(result);
        } catch (error) {
            sendRuntimePackageError(error, res);
        }
    }

    async function searchRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const query = typeof req.query.q === 'string' ? req.query.q : '';
            // The catalog is read from the agent images, which need Docker.
            if (await services.remoteInstall()) {
                res.json({ query, suggestions: [], sources: [] });
                return;
            }
            const images = await configuredBaseImages(services.loadBaseImages);
            res.json(await withRuntimePackageRequestTimeout(
                'Agent runtime package search',
                services.search(query, images)
            ));
        } catch (error) {
            if (dockerUnreachable(error) && await services.remoteConfigured().catch(() => false)) {
                res.json({ query: typeof req.query.q === 'string' ? req.query.q : '', suggestions: [], sources: [] });
                return;
            }
            sendRuntimePackageError(error, res);
        }
    }

    async function queueBuild(packages: unknown, res: Response): Promise<void> {
        let jobData: AgentRuntimeBuildJobData | undefined;
        let warnings: string[] = [];
        let syntax: ReturnType<AgentRuntimeRouteServices['validate']> | undefined;
        try {
            syntax = services.validate(packages);
            if (!syntax.valid) {
                res.status(400).json({ error: syntax.errors.join('; '), errors: syntax.errors });
                return;
            }
            const availability = await checkAvailability(syntax.packages);
            if (!availability.valid) {
                res.status(400).json({ error: availability.errors.join('; '), ...availability });
                return;
            }
            const images = await configuredBaseImages(services.loadBaseImages);
            jobData = await services.requestBuild(availability.packages, images);
            warnings = availability.warnings;
            const queue = getRuntimeBuildQueue?.() || runtimeBuildQueue;
            if (!queue) throw new Error('Agent runtime build queue is not initialized');
            await queue.add('build-agent-runtime', jobData, {
                jobId: jobData.buildId,
                removeOnComplete: 20,
                removeOnFail: 50
            });
            res.status(202).json(await stateResponse(await services.loadState(), warnings));
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

    async function verifyRuntimePackages(req: Request, res: Response): Promise<void> {
        if (!requireRuntimeAdmin(req, res)) return;
        try {
            const state = await services.loadState();
            const images = await configuredBaseImages(services.loadBaseImages);
            const result: AgentRuntimePackageVerificationResult = await withRuntimePackageRequestTimeout(
                'Agent runtime package verification',
                services.verify(state, images, { validateAvailability: services.validateAvailability })
            );
            res.json(result);
        } catch (error) {
            sendRuntimePackageError(error, res);
        }
    }

    return {
        getRuntimePackages,
        searchRuntimePackages,
        validateRuntimePackages,
        putRuntimePackages,
        applyRuntimePackages,
        verifyRuntimePackages
    };
}
