import type { AgentConfig } from '../types.js';
import { redactSecrets } from '../../utils/secretRedaction.js';
import { MachinesClient, MachinesHttpError, type MachinesApi } from './fly/api.js';
import { flyConfig, type FlyConfig } from './fly/config.js';
import { FLY_MACHINES_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME } from './runtimeSelection.js';
import { spritesCliVersionRefusal, spritesProvidedCliVersion } from './sprites/spritesCliVersions.js';

/**
 * Readiness of a remote agent runtime for one agent, without launching a Sprite
 * or Machine: the runtime token is accepted by its API, and the CLI version
 * (Sprites) or agent image (Fly Machines) the run would use resolves. The
 * Settings health check reports this instead of preparing a local Docker
 * image the remote runtime never uses.
 */
export interface RemoteRuntimeReadiness {
    runtime: typeof SPRITES_AGENT_RUNTIME | typeof FLY_MACHINES_AGENT_RUNTIME;
    ready: boolean;
    /** Why the runtime cannot run this agent, when not ready. */
    error?: string;
    /** What a run would use, e.g. "Sprites, claude CLI 2.1.330". */
    detail?: string;
}

export interface RemoteRuntimeReadinessDeps {
    listSprites?: (token: string) => Promise<unknown>;
    machines?: (config: FlyConfig) => Pick<MachinesApi, 'list'>;
}

const SPRITES_AGENT_TYPES = ['claude', 'codex', 'antigravity'];
const FLY_AGENT_TYPES = ['claude', 'codex'];

function statusOf(error: unknown): number | undefined {
    const status = (error as { statusCode?: unknown; status?: unknown })?.statusCode ?? (error as { status?: unknown })?.status;
    if (typeof status === 'number') return status;
    return error instanceof MachinesHttpError ? error.status : undefined;
}

function tokenFailure(service: string, variable: string, error: unknown): string {
    const status = statusOf(error);
    if (status === 401 || status === 403) return `The ${service} API refused ${variable} (HTTP ${status}). Set a valid token on the worker and API, then check again.`;
    return `Could not reach the ${service} API: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
}

async function spritesReadiness(config: AgentConfig, environment: NodeJS.ProcessEnv, deps: RemoteRuntimeReadinessDeps): Promise<RemoteRuntimeReadiness> {
    const runtime = SPRITES_AGENT_RUNTIME;
    if (!SPRITES_AGENT_TYPES.includes(config.type)) return { runtime, ready: false, error: `The Sprites runtime does not run ${config.type} agents.` };
    let version: string | undefined;
    try {
        const refusal = spritesCliVersionRefusal(config);
        if (refusal) return { runtime, ready: false, error: refusal };
        version = spritesProvidedCliVersion(config.type);
    } catch (error) {
        return { runtime, ready: false, error: `Could not resolve the Sprites CLI version: ${(error as Error).message}` };
    }
    const token = environment.PROPR_SPRITES_TOKEN?.trim() || environment.SPRITES_TOKEN?.trim();
    if (!token) return { runtime, ready: false, error: 'Set PROPR_SPRITES_TOKEN to run agents on Sprites.' };
    const list = deps.listSprites ?? (async (value: string) => {
        process.env.SPRITES_CLIENT_SIGNALS ??= '0';
        const { SpritesClient } = await import('@fly/sprites');
        return new SpritesClient(value).listSprites({ maxResults: 1 });
    });
    try { await list(token); }
    catch (error) { return { runtime, ready: false, error: tokenFailure('Sprites', 'PROPR_SPRITES_TOKEN', error) }; }
    return { runtime, ready: true, detail: `Sprites, ${config.type} CLI ${version ?? 'pinned'}` };
}

async function flyReadiness(config: AgentConfig, environment: NodeJS.ProcessEnv, deps: RemoteRuntimeReadinessDeps): Promise<RemoteRuntimeReadiness> {
    const runtime = FLY_MACHINES_AGENT_RUNTIME;
    if (!FLY_AGENT_TYPES.includes(config.type)) return { runtime, ready: false, error: `Fly Machines does not run ${config.type} agents.` };
    if (config.cliVersionType && config.cliVersionType !== 'default') {
        return { runtime, ready: false, error: 'Fly Machines uses the CLI version in PROPR_FLY_IMAGE. Select the default CLI version for this agent.' };
    }
    let fly: FlyConfig;
    try { fly = flyConfig(environment); }
    catch (error) { return { runtime, ready: false, error: (error as Error).message }; }
    const api = deps.machines?.(fly) ?? new MachinesClient(fly);
    try { await api.list?.(''); }
    catch (error) { return { runtime, ready: false, error: tokenFailure('Fly Machines', 'PROPR_FLY_API_TOKEN', error) }; }
    return { runtime, ready: true, detail: `Fly Machines, image ${fly.image}` };
}

/** Readiness for agents on Sprites or Fly Machines; undefined for any other runtime (Docker keeps its image checks). */
export async function checkRemoteRuntimeReadiness(
    config: AgentConfig, runtime: string, environment: NodeJS.ProcessEnv = process.env, deps: RemoteRuntimeReadinessDeps = {},
): Promise<RemoteRuntimeReadiness | undefined> {
    if (runtime === SPRITES_AGENT_RUNTIME) return spritesReadiness(config, environment, deps);
    if (runtime === FLY_MACHINES_AGENT_RUNTIME) return flyReadiness(config, environment, deps);
    return undefined;
}
