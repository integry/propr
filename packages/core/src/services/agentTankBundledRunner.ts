/**
 * Bundled Agent Tank transport.
 *
 * Runs `agent-tank --once --json --config <generated>` inside the unified
 * `propr/agent` image, with each enabled agent's credential directory
 * bind-mounted read-only at the same container path the agent runtime uses.
 * No host install, no daemon, no container networking to get wrong.
 *
 * Everything Docker-specific (image resolution, mounts, timeouts) and every
 * assumption about the Agent Tank config/output schema lives here, so the HTTP
 * transport stays readable and an upstream schema change is a local edit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import logger from '../utils/logger.js';
import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { loadAgents, resolveConfigPath, resolveCodexConfigPath } from '../config/configManager.js';
import { CONTAINER_CONFIG_PATHS } from '../agents/types.js';
import type { AgentConfig } from '../agents/types.js';
import { toAgentTankAgent, type AgentStatusResponse } from './agentTankTypes.js';

/**
 * A bundled refresh starts a container and drives interactive `/usage` calls
 * through a PTY, so it is slow by nature. Callers never block on it: the hot
 * path reads `getCachedBundledStatuses()` and a refresh happens out of band.
 */
const DEFAULT_REFRESH_TIMEOUT_MS = 120_000;
/**
 * Provider usage windows move on the order of minutes, so a 60s snapshot is
 * plenty fresh for a capacity gauge while keeping container churn near zero.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;
/**
 * Past this age a snapshot is too stale to subtract for a per-call delta: two
 * LLM calls could both read the same snapshot and report a bogus zero delta, or
 * a very old snapshot could attribute unrelated consumption to this call. We
 * would rather record no delta than a wrong one.
 */
const DELTA_FRESHNESS_MS = 90_000;

const CONTAINER_CONFIG_FILE = '/tmp/propr-agent-tank/config.json';

/**
 * Agent Tank only knows these three providers (`SUPPORTED_PROVIDERS` upstream).
 * OpenCode and Vibe have no usage endpoint to read, so including them would
 * make the whole run exit non-zero on an "Unsupported agent provider" error.
 */
const BUNDLED_SUPPORTED_TANK_AGENTS = new Set(['claude', 'codex', 'agy']);

interface CachedSnapshot {
    agents: Record<string, AgentStatusResponse>;
    capturedAt: number;
}

/** One entry of the generated Agent Tank `agents` array. */
export interface BundledAgentTankEntry {
    /** Agent Tank provider key (`claude`, `codex`, `agy`). */
    provider: string;
    /** Container path holding that provider's credentials. */
    configPath: string;
}

let cached: CachedSnapshot | undefined;
// Coalesces concurrent refresh requests onto a single container run. Without
// this, the sidebar poll and a task's post-call probe could each spawn one.
let inFlight: Promise<Record<string, AgentStatusResponse> | undefined> | undefined;

function timeoutMs(): number {
    const parsed = Number.parseInt(process.env.AGENT_TANK_BUNDLED_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_TIMEOUT_MS;
}

function cacheTtlMs(): number {
    const parsed = Number.parseInt(process.env.AGENT_TANK_BUNDLED_CACHE_TTL_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

/**
 * Resolve the host path that holds this agent's credentials.
 *
 * Codex has its own resolver because its portable `~/.codex` default has to be
 * mapped through the launcher's host mapping rather than expanded against the
 * backend container's HOME. Reusing the agent runtime's own resolvers is what
 * guarantees bundled Agent Tank inspects exactly the credentials the agent
 * itself would use - not a lookalike directory.
 */
function hostCredentialPath(agent: AgentConfig): string | undefined {
    try {
        return agent.type === 'codex'
            ? resolveCodexConfigPath(agent.configPath)
            : resolveConfigPath(agent.configPath);
    } catch (error) {
        logger.debug({ agentAlias: agent.alias, error: (error as Error).message },
            'Skipping agent for bundled Agent Tank: credential path is unavailable');
        return undefined;
    }
}

/**
 * ONE OF TWO PLACES that know the Agent Tank config file schema (the other is
 * `parseBundledAgentTankOutput`). Verified against integry/agent-tank
 * `src/agent-config.js`: each entry takes `provider` (claude | codex | agy), an
 * optional `id`, and a `configPath` that is handed to the CLI as its config
 * home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). If upstream
 * renames keys, change only this function.
 */
export function buildBundledAgentTankConfig(entries: BundledAgentTankEntry[]): string {
    return JSON.stringify({
        agents: entries.map(entry => ({
            provider: entry.provider,
            // Pin the id to the provider key so the output map is keyed exactly
            // like the HTTP `/status` response every downstream consumer parses.
            id: entry.provider,
            configPath: entry.configPath,
        })),
        // `--once` already skips the HTTP server; disabling Docker bridge
        // detection stops Agent Tank from shelling out to a `docker` binary that
        // deliberately does not exist inside the agent image.
        dockerAccess: false,
    }, null, 2);
}

/**
 * ONE OF TWO PLACES that know the Agent Tank output schema. Upstream
 * `--once --json` prints `watcher.getStatus()`, a bare map keyed by agent id;
 * we also accept an `{ agents: {...} }` envelope so a minor upstream wrapper
 * change does not break the integration.
 */
export function parseBundledAgentTankOutput(stdout: string): Record<string, AgentStatusResponse> {
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    // `--once --json` may be preceded by banner lines; start at the first brace
    // rather than assuming the whole buffer parses.
    const start = trimmed.indexOf('{');
    if (start < 0) return {};
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Bundled Agent Tank produced unparseable JSON');
        return {};
    }
    const source = (parsed.agents && typeof parsed.agents === 'object')
        ? parsed.agents as Record<string, unknown>
        : parsed;
    const agents: Record<string, AgentStatusResponse> = {};
    for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const status = value as Partial<AgentStatusResponse>;
        agents[key] = {
            name: typeof status.name === 'string' ? status.name : key,
            usage: (status.usage && typeof status.usage === 'object')
                ? status.usage as Record<string, unknown>
                : {},
            metadata: status.metadata,
            lastUpdated: status.lastUpdated,
            error: typeof status.error === 'string' ? status.error : null,
        };
    }
    return agents;
}

/**
 * Resolve the image to run Agent Tank in: the exact one the agent registry is
 * already using, so bundled Agent Tank always matches the CLI versions the
 * agents actually run with.
 */
async function resolveAgentImage(): Promise<string> {
    try {
        const { AgentRegistry } = await import('../agents/AgentRegistry.js');
        const configured = AgentRegistry.getInstance().getAllAgents()[0]?.config.dockerImage;
        if (configured) return configured;
    } catch (error) {
        logger.debug({ error: (error as Error).message },
            'Agent registry unavailable for bundled Agent Tank; falling back to the configured image name');
    }
    return process.env.AGENT_DOCKER_IMAGE || 'propr/agent:latest';
}

/** Build the mount list and config entries for every eligible enabled agent. */
async function collectBundledAgents(): Promise<{ mounts: string[]; entries: BundledAgentTankEntry[] }> {
    const agents = (await loadAgents()).filter(agent => agent.enabled);
    const mounts: string[] = [];
    const entries: BundledAgentTankEntry[] = [];
    const seen = new Set<string>();

    for (const agent of agents) {
        const provider = toAgentTankAgent(agent.type);
        if (!BUNDLED_SUPPORTED_TANK_AGENTS.has(provider)) continue;
        // Agent Tank tracks a provider, not a ProPR alias. If two aliases share a
        // provider we can only report one; the first enabled one wins, matching
        // how the sidebar already groups by provider.
        if (seen.has(provider)) continue;
        const hostPath = hostCredentialPath(agent);
        const containerConfigPath = CONTAINER_CONFIG_PATHS[agent.type];
        if (!hostPath || !containerConfigPath || !fs.existsSync(hostPath)) continue;
        seen.add(provider);
        // Read-only: usage inspection must never be able to mutate or corrupt the
        // credentials the real agent runs depend on.
        mounts.push('-v', `${hostPath}:${containerConfigPath}:ro`);
        entries.push({ provider, configPath: containerConfigPath });
    }

    return { mounts, entries };
}

/**
 * True when at least one enabled agent is an Agent Tank provider with readable
 * credentials, i.e. when bundled mode would actually report something. Used by
 * the detection banner so a fresh install with no usable agent is not nagged to
 * enable a feature that would show an empty sidebar.
 */
export async function canRunBundledAgentTank(): Promise<boolean> {
    try {
        const { entries } = await collectBundledAgents();
        return entries.length > 0;
    } catch (error) {
        logger.debug({ error: (error as Error).message },
            'Could not determine bundled Agent Tank eligibility');
        return false;
    }
}

async function runBundledAgentTank(): Promise<Record<string, AgentStatusResponse> | undefined> {
    let configDir: string | undefined;
    try {
        const { mounts, entries } = await collectBundledAgents();
        if (entries.length === 0) {
            logger.debug('Bundled Agent Tank skipped: no enabled agent has a readable credential directory');
            return {};
        }

        const image = await resolveAgentImage();

        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-tank-'));
        const configFile = path.join(configDir, 'config.json');
        fs.writeFileSync(configFile, buildBundledAgentTankConfig(entries), { mode: 0o600 });

        const result = await executeDockerCommand('docker', [
            'run', '--rm',
            // No inbound/outbound needs beyond the provider APIs the CLIs call;
            // we do not add --network none because `/usage` for some providers
            // hits the provider API.
            '--name', `propr-agent-tank-${randomBytes(6).toString('hex')}`,
            '-e', 'PROPR_AGENT_TYPE=agent-tank',
            '-v', `${configFile}:${CONTAINER_CONFIG_FILE}:ro`,
            ...mounts,
            image,
            'agent-tank', '--once', '--json', '--config', CONTAINER_CONFIG_FILE,
        ], { timeout: timeoutMs() });

        if (result.exitCode !== 0) {
            logger.warn({ exitCode: result.exitCode, stderr: (result.stderr || '').slice(0, 500) },
                'Bundled Agent Tank run failed');
            return undefined;
        }
        return parseBundledAgentTankOutput(result.stdout || '');
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Bundled Agent Tank run threw');
        return undefined;
    } finally {
        // Best-effort: the temp file holds no secrets, but leaving one per probe
        // would slowly fill the container's tmp.
        if (configDir) {
            try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}

/** Cache-only read. Safe on the hot path: never spawns a container. */
export function getCachedBundledStatuses(
    options: { maxAgeMs?: number } = {}
): Record<string, AgentStatusResponse> | undefined {
    if (!cached) return undefined;
    const maxAge = options.maxAgeMs ?? cacheTtlMs();
    return Date.now() - cached.capturedAt <= maxAge ? cached.agents : undefined;
}

/** Cache-only read bounded by the delta freshness window. */
export function getBundledStatusesForDelta(): Record<string, AgentStatusResponse> | undefined {
    return getCachedBundledStatuses({ maxAgeMs: DELTA_FRESHNESS_MS });
}

/**
 * Return a fresh snapshot, reusing the cache when it is young enough and
 * coalescing concurrent callers onto one container run.
 */
export async function refreshBundledStatuses(
    options: { force?: boolean } = {}
): Promise<Record<string, AgentStatusResponse> | undefined> {
    if (!options.force) {
        const fresh = getCachedBundledStatuses();
        if (fresh) return fresh;
    }
    if (inFlight) return inFlight;

    inFlight = runBundledAgentTank()
        .then(agents => {
            // Only replace the cache on success: a transient container failure
            // should not blank out a perfectly good recent snapshot.
            if (agents) cached = { agents, capturedAt: Date.now() };
            return agents;
        })
        .finally(() => { inFlight = undefined; });
    return inFlight;
}

/** Fire-and-forget refresh used by hot paths that must not await a container. */
export function scheduleBundledRefresh(): void {
    void refreshBundledStatuses().catch(() => { /* best-effort by design */ });
}

/** Test seam. */
export function clearBundledAgentTankCache(): void {
    cached = undefined;
    inFlight = undefined;
}
