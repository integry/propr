import { randomBytes } from 'node:crypto';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import logger from '../../utils/logger.js';
import type { AgentRunOptions } from './dockerRuntime.js';
import { FlyMachinesClient, type FetchLike } from './flyMachinesApi.js';
import { flyPrivateNetworkEnabled, resolveFlyMachinesConfig, type FlyMachinesConfig } from './flyMachinesConfig.js';
import { FlyMachineRunHandle } from './flyMachinesRunHandle.js';
import type { AgentRunHandle, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export const FLY_MACHINES_RUNTIME_KIND = 'fly-machines';

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const PREWARM_TIMEOUT_MS = 10 * 60_000;

/**
 * What a Fly Machine run can do. No bind mounts: the workspace arrives through
 * the clone transport and credentials as uploaded per-run copies. No egress
 * allowlist, so restricted runs are refused. ProPR MCP is reached over the
 * org private network (`<app>.internal`) when the control plane runs on Fly,
 * else at a reachable URL with the run's grant token.
 */
export function flyMachinesCapabilities(environment: NodeJS.ProcessEnv = process.env): AgentRuntimeCapabilities {
    return Object.freeze({
        supportsBindMounts: false,
        supportsFileUpload: true,
        supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: flyPrivateNetworkEnabled(environment),
        supportsMcpReachableUrl: true,
        reattach: false,
        workspaceTransports: Object.freeze(['clone'] as const),
    });
}

export interface FlyPrewarmResult {
    image: string;
    machineId: string;
    /** Create request until the Machine started or exited: the image pull plus boot. */
    pullMs: number;
}

export interface FlyMachinesRuntimeOptions {
    environment?: NodeJS.ProcessEnv;
    fetch?: FetchLike;
    pollIntervalMs?: number;
    now?: () => number;
}

/**
 * Runs each agent on its own ephemeral Fly Machine booted from the
 * `propr/agent` OCI image (or `PROPR_FLY_IMAGE`), with the image's own
 * entrypoints. Configuration is read when a run starts, so selecting the
 * runtime without configuring it fails the run with a message naming the
 * missing variables.
 */
export class FlyMachinesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = FLY_MACHINES_RUNTIME_KIND;
    readonly capabilities: AgentRuntimeCapabilities;
    private readonly environment: NodeJS.ProcessEnv;
    private readonly prewarmed = new Map<string, Promise<FlyPrewarmResult | undefined>>();

    constructor(private readonly options: FlyMachinesRuntimeOptions = {}) {
        this.environment = options.environment ?? process.env;
        this.capabilities = flyMachinesCapabilities(this.environment);
        let config: FlyMachinesConfig | undefined;
        try { config = resolveFlyMachinesConfig(this.environment); } catch { /* reported when a run starts */ }
        if (config?.prewarm && config.image) void this.prewarm(config.image);
    }

    private resolve(): { config: FlyMachinesConfig; client: FlyMachinesClient } {
        const config = resolveFlyMachinesConfig(this.environment);
        return { config, client: new FlyMachinesClient(config, this.options.fetch) };
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        const { config, client } = this.resolve();
        if (spec.mcpGrant?.network) {
            logger.debug({ run: spec.name, network: spec.mcpGrant.network }, 'Fly Machines join the org private network; the Docker network name is not used');
        }
        return new FlyMachineRunHandle(spec, options, {
            client, config, pollIntervalMs: this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, now: this.options.now ?? Date.now,
        });
    }

    /**
     * Pull `image` onto a host in the configured region ahead of the first
     * run: a throwaway Machine that exits at once (`/bin/true`) and destroys
     * itself. Measures the pull. Best effort and once per image per process;
     * a failure is logged, never thrown.
     */
    prewarm(image?: string): Promise<FlyPrewarmResult | undefined> {
        let resolved: { config: FlyMachinesConfig; client: FlyMachinesClient };
        try { resolved = this.resolve(); } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Fly Machines pre-warm skipped');
            return Promise.resolve(undefined);
        }
        const target = image ?? resolved.config.image;
        if (!target) return Promise.resolve(undefined);
        let pending = this.prewarmed.get(target);
        if (!pending) {
            pending = this.prewarmImage(target, resolved);
            this.prewarmed.set(target, pending);
        }
        return pending;
    }

    private async prewarmImage(image: string, { config, client }: { config: FlyMachinesConfig; client: FlyMachinesClient }): Promise<FlyPrewarmResult | undefined> {
        const now = this.options.now ?? Date.now;
        const started = now();
        try {
            const machine = await client.createMachine({
                name: `propr-prewarm-${randomBytes(4).toString('hex')}`,
                ...(config.region ? { region: config.region } : {}),
                skip_service_registration: true,
                config: {
                    image, init: { exec: ['/bin/true'] }, env: {}, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
                    metadata: { propr_prewarm: '1' }, auto_destroy: true, restart: { policy: 'no' },
                },
            });
            for (const deadline = started + PREWARM_TIMEOUT_MS; now() < deadline;) {
                const current = await client.getMachine(machine.id);
                if (!current || !['created', 'starting'].includes(current.state ?? '')) break;
                await client.waitForState(machine.id, 'started', 30, machine.instance_id).catch(() => false);
            }
            const result = { image, machineId: machine.id, pullMs: now() - started };
            logger.info({ ...result, region: machine.region }, 'Fly Machines image pre-warmed');
            await client.destroyMachine(machine.id).catch(() => undefined);
            return result;
        } catch (error) {
            logger.warn({ image, error: (error as Error).message }, 'Fly Machines pre-warm failed');
            this.prewarmed.delete(image);
            return undefined;
        }
    }
}
