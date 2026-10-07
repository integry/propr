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
import { randomBytes } from 'node:crypto';
import logger from '../utils/logger.js';
import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { loadAgents, resolveConfigPath, resolveCodexConfigPath } from '../config/configManager.js';
import { CONTAINER_CONFIG_PATHS } from '../agents/types.js';
import type { AgentConfig } from '../agents/types.js';
import { toAgentTankAgent, type AgentStatusResponse } from './agentTankTypes.js';

/**
 * A bundled refresh starts a container and drives interactive `/usage` calls
 * through a PTY, so it is slow by nature. Capacity reads use the cache; per-call
 * measurements await a bounded refresh without delaying model execution.
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

/** Carries the generated config into the container (see `CONFIG_BOOTSTRAP`). */
const CONFIG_ENV_VAR = 'PROPR_AGENT_TANK_CONFIG';

/**
 * Materialize the generated config *inside* the container instead of
 * bind-mounting it from this process's filesystem.
 *
 * The backend normally runs in its own container and drives the host Docker
 * daemon, so a backend-local pathname is not a usable bind source: the daemon
 * resolves bind sources on the host, where the generated file does not exist,
 * and would hand Agent Tank an empty directory instead of its config. No file
 * mode or directory permission can bridge two filesystem namespaces. Every
 * other mount in the run is a credential directory whose path already went
 * through the deployment's host mapping (`resolveConfigPath` /
 * `resolveCodexConfigPath`); the generated config has no such mapping, so it
 * travels in the run itself and the container writes it as the user that reads
 * it. The config holds provider keys and container paths only - no secrets - so
 * an environment variable is a safe carrier. The `--rm` container takes the
 * file with it, so there is nothing host-side left to clean up.
 */
const CONFIG_BOOTSTRAP = [
    'set -e',
    'umask 077',
    'mkdir -p "$(dirname "$1")"',
    `printf %s "$${CONFIG_ENV_VAR}" > "$1"`,
    'node /home/node/agent-tank-runtime.mjs "$1"',
    'exec agent-tank --once --json --config "$1"',
].join('; ');

/**
 * Agent Tank only knows these three providers (`SUPPORTED_PROVIDERS` upstream).
 * OpenCode and Vibe have no usage endpoint to read, so including them would
 * make the whole run exit non-zero on an "Unsupported agent provider" error.
 */
const BUNDLED_SUPPORTED_TANK_AGENTS = new Set(['claude', 'codex', 'agy']);

/**
 * One Agent Tank run: the per-provider snapshots plus which configured account
 * each one actually describes.
 */
interface BundledRunResult {
    agents: Record<string, AgentStatusResponse>;
    /**
     * Provider key -> the alias of the enabled agent whose credentials were
     * mounted for that provider. Agent Tank knows only providers, so this is the
     * ONLY record of which configured account the numbers belong to: the
     * generated id is the provider key, so two accounts of the same provider are
     * indistinguishable from the snapshot itself.
     */
    aliases: Record<string, string>;
}

interface CachedSnapshot extends BundledRunResult {
    capturedAt: number;
}

/** One entry of the generated Agent Tank `agents` array. */
export interface BundledAgentTankEntry {
    /** Agent Tank provider key (`claude`, `codex`, `agy`). */
    provider: string;
    /** ProPR alias of the agent whose credentials are mounted for that provider. */
    alias: string;
    /** Container path holding that provider's credentials. */
    configPath: string;
}

/** A generated config entry together with the bind source that feeds it. */
interface BundledCredentialSource {
    /**
     * Credential directory as the *Docker daemon* sees it - the deployment's
     * host mapping, which is not necessarily a path in this process's
     * filesystem (see `credentialSourceIsUsable`).
     */
    hostPath: string;
    entry: BundledAgentTankEntry;
}

let cached: CachedSnapshot | undefined;
// Coalesces concurrent refresh requests onto a single container run. Without
// this, the sidebar poll and a task's post-call probe could each spawn one.
let inFlight: Promise<BundledRunResult | undefined> | undefined;

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
 * Whether this process and the Docker daemon share one filesystem namespace.
 *
 * The backend normally runs in its own container against the host daemon, so
 * the two namespaces are different and a host pathname says nothing about what
 * this process can stat.
 */
function backendSharesHostFilesystem(): boolean {
    const flag = process.env.PROPR_CONTAINERIZED?.trim().toLowerCase();
    if (flag === '1' || flag === 'true') return false;
    if (flag === '0' || flag === 'false') return true;
    return !fs.existsSync('/.dockerenv');
}

/**
 * Decide whether a resolved host credential path may be used as a bind source.
 *
 * A local `existsSync` hit is good news in either namespace. A miss only means
 * anything when this process shares the daemon's filesystem: inside the backend
 * container a credential directory that went through the deployment's host
 * mapping (`HOST_CODEX_DIR`, a non-identity `*_CONFIG_PATH`, a managed root that
 * is not mounted here) is perfectly valid for the daemon and simply invisible to
 * us. Discarding it there would silently disable bundled mode - and suppress the
 * detection banner's bundled offer - for a correctly configured install. What we
 * cannot see, the daemon checks for us: credentials are mounted with
 * `--mount type=bind`, which refuses to start the container when the source is
 * missing on the host instead of inventing an empty directory the way `-v` does.
 */
function credentialSourceIsUsable(agent: AgentConfig, hostPath: string): boolean {
    if (fs.existsSync(hostPath)) return true;
    if (backendSharesHostFilesystem()) {
        logger.debug({ agentAlias: agent.alias },
            'Skipping agent for bundled Agent Tank: credential directory does not exist');
        return false;
    }
    logger.debug({ agentAlias: agent.alias },
        'Bundled Agent Tank credential directory is not visible to the backend; letting the Docker daemon resolve it');
    return true;
}

/**
 * Render one `--mount` field, quoting the way Docker's CSV parser expects when
 * the value contains a comma or quote (a path may legally contain either, and
 * an unquoted comma would be read as the start of another field).
 */
function mountField(key: string, value: string): string {
    return /[",]/.test(value)
        ? `"${key}=${value.replace(/"/g, '""')}"`
        : `${key}=${value}`;
}

/**
 * Read-only bind mounts for every credential source.
 *
 * `--mount` rather than `-v` deliberately: usage inspection must never mutate
 * the credentials the real agent runs depend on, and a missing source must fail
 * the run rather than be created as an empty directory that Agent Tank would
 * report as "no usage" for a perfectly healthy account.
 */
function buildCredentialMountArgs(sources: BundledCredentialSource[]): string[] {
    return sources.flatMap(source => ['--mount', [
        'type=bind',
        mountField('source', source.hostPath),
        mountField('target', source.entry.configPath),
        'readonly',
    ].join(',')]);
}

/**
 * Host paths the daemon refused because they do not exist.
 *
 * This is the namespace-correct existence check the backend cannot perform
 * itself, read back out of the daemon's error so one unauthenticated agent
 * drops out of the run instead of taking every other agent's usage with it.
 */
export function missingBindSources(stderr: string): string[] {
    return [...stderr.matchAll(/bind source path does not exist:[ \t]*(.*?)\.?[ \t]*$/gm)]
        .map(match => match[1])
        .filter(Boolean);
}

/**
 * ONE OF TWO PLACES that know the Agent Tank config file schema (the other is
 * `parseBundledAgentTankOutput`). Verified against integry/agent-tank
 * `src/agent-config.js`: each entry takes `provider` (claude | codex | agy), an
 * optional `id`, and a `configPath` that is handed to the CLI as its config
 * home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). If upstream
 * renames keys, change only this function.
 *
 * There is no place in this schema for the ProPR alias, which is why the alias
 * of the account each entry was built from is tracked separately (see
 * `BundledRunResult.aliases`) instead of being recovered from the output.
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

/** Build the credential sources for every eligible enabled agent. */
async function collectBundledAgents(): Promise<BundledCredentialSource[]> {
    const agents = (await loadAgents()).filter(agent => agent.enabled);
    const sources: BundledCredentialSource[] = [];
    const seen = new Set<string>();

    for (const agent of agents) {
        const provider = toAgentTankAgent(agent.type);
        if (!BUNDLED_SUPPORTED_TANK_AGENTS.has(provider)) continue;
        // Agent Tank tracks a provider, not a ProPR alias. If two aliases share a
        // provider we can only report one; the first enabled one wins, matching
        // how the sidebar already groups by provider. Which alias won is recorded
        // on the entry so an alias-specific reader cannot mistake this account's
        // usage for another account of the same provider.
        if (seen.has(provider)) continue;
        const hostPath = hostCredentialPath(agent);
        const containerConfigPath = CONTAINER_CONFIG_PATHS[agent.type];
        if (!hostPath || !containerConfigPath) continue;
        if (!credentialSourceIsUsable(agent, hostPath)) continue;
        seen.add(provider);
        sources.push({
            hostPath,
            entry: { provider, alias: agent.alias, configPath: containerConfigPath },
        });
    }

    return sources;
}

/**
 * True when at least one enabled agent is an Agent Tank provider with readable
 * credentials, i.e. when bundled mode would actually report something. Used by
 * the detection banner so a fresh install with no usable agent is not nagged to
 * enable a feature that would show an empty sidebar.
 */
export async function canRunBundledAgentTank(): Promise<boolean> {
    try {
        return (await collectBundledAgents()).length > 0;
    } catch (error) {
        logger.debug({ error: (error as Error).message },
            'Could not determine bundled Agent Tank eligibility');
        return false;
    }
}

async function runBundledAgentTank(): Promise<BundledRunResult | undefined> {
    try {
        let sources = await collectBundledAgents();
        if (sources.length === 0) {
            logger.debug('Bundled Agent Tank skipped: no enabled agent has a usable credential directory');
            return { agents: {}, aliases: {} };
        }

        const image = await resolveAgentImage();

        // The daemon reports missing bind sources one run at a time and each
        // retry drops at least one, so this many attempts is always enough.
        const maxAttempts = sources.length;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const entries = sources.map(source => source.entry);
            const aliases = Object.fromEntries(entries.map(entry => [entry.provider, entry.alias]));

            const result = await executeDockerCommand('docker', [
                'run', '--rm',
                // No inbound/outbound needs beyond the provider APIs the CLIs call;
                // we do not add --network none because `/usage` for some providers
                // hits the provider API.
                '--name', `propr-agent-tank-${randomBytes(6).toString('hex')}`,
                '-e', 'PROPR_AGENT_TYPE=agent-tank',
                '-e', `${CONFIG_ENV_VAR}=${buildBundledAgentTankConfig(entries)}`,
                ...buildCredentialMountArgs(sources),
                image,
                // `sh -c <script> <$0> <$1>`: the config path is passed as an
                // argument rather than interpolated, so the script itself stays a
                // fixed string.
                'sh', '-c', CONFIG_BOOTSTRAP, 'propr-agent-tank', CONTAINER_CONFIG_FILE,
                // A usage probe runs around agent calls, possibly inside a capped
                // run, but spends nothing: a run stopped at its cap still reads usage.
            ], {
                timeout: timeoutMs(), costCapExempt: true,
                // Read-only credential mounts and ProPR's own probe, never repository or agent code.
                networkPolicyExempt: 'Agent Tank usage probe runs only ProPR code and reads provider usage APIs',
            });

            if (result.exitCode === 0) {
                return { agents: parseBundledAgentTankOutput(result.stdout || ''), aliases };
            }

            const stderr = result.stderr || '';
            const missing = new Set(missingBindSources(stderr));
            const remaining = sources.filter(source => !missing.has(source.hostPath));
            if (remaining.length === sources.length) {
                logger.warn({ exitCode: result.exitCode, stderr: stderr.slice(0, 500) },
                    'Bundled Agent Tank run failed');
                return undefined;
            }
            logger.warn({ missingCredentialSources: [...missing] },
                'Bundled Agent Tank credential directories are missing on the Docker host; inspecting the remaining agents');
            if (remaining.length === 0) return { agents: {}, aliases: {} };
            sources = remaining;
        }
        return undefined;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Bundled Agent Tank run threw');
        return undefined;
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
 * Cache-only read for an alias-specific question: "how much capacity is left on
 * the account configured as `alias`?".
 *
 * Only one alias per provider is inspected per run (see `collectBundledAgents`),
 * so a snapshot describes exactly one configured account. Answering for a
 * different alias of the same provider would hand out another account's usage,
 * so the cached provenance - not the snapshot's `name`, which is pinned to the
 * provider key - decides whether we can answer at all.
 */
export function getBundledStatusForAlias(
    alias: string,
    options: { maxAgeMs?: number } = {}
): AgentStatusResponse | undefined {
    if (!cached) return undefined;
    const maxAge = options.maxAgeMs ?? DELTA_FRESHNESS_MS;
    if (Date.now() - cached.capturedAt > maxAge) return undefined;
    const provider = Object.entries(cached.aliases)
        .find(([, snapshotAlias]) => snapshotAlias === alias)?.[0];
    if (!provider) {
        logger.debug({ alias, inspectedAliases: Object.values(cached.aliases) },
            'No bundled Agent Tank snapshot belongs to this alias');
        return undefined;
    }
    return cached.agents[provider];
}

/**
 * Return a fresh snapshot, reusing the cache when it is young enough and
 * coalescing concurrent callers onto one container run.
 */
export async function refreshBundledStatuses(
    options: { force?: boolean; phase?: 'pre-call' | 'post-call' } = {}
): Promise<Record<string, AgentStatusResponse> | undefined> {
    if (options.phase) {
        // A run already in flight may have read provider usage before the call
        // ended. Wait for it, then start a new run for the post-call measurement.
        // Bound the entire wait, including that earlier run and any bind retries.
        const precedingRun = inFlight;
        let expired = false;
        const refresh = async () => {
            if (options.phase === 'pre-call') {
                return getBundledStatusesForDelta() ?? refreshBundledStatuses({ force: true });
            }
            if (precedingRun) await precedingRun;
            if (expired) return undefined;
            return refreshBundledStatuses({ force: true });
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                refresh(),
                new Promise<undefined>(resolve => {
                    timer = setTimeout(() => { expired = true; resolve(undefined); }, timeoutMs());
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    if (!options.force) {
        const fresh = getCachedBundledStatuses();
        if (fresh) return fresh;
    }
    if (!inFlight) {
        inFlight = runBundledAgentTank()
            .then(result => {
                // Only replace the cache on success: a transient container failure
                // should not blank out a perfectly good recent snapshot.
                if (result) cached = { ...result, capturedAt: Date.now() };
                return result;
            })
            .finally(() => { inFlight = undefined; });
    }
    return (await inFlight)?.agents;
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
