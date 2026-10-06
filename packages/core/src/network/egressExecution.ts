import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '../utils/logger.js';
import type { AgentType } from '../agents/types.js';
import { AGENT_EGRESS_PROXY_SUPPORT, baseEgressAllowlist, compileEgressAllowlist } from './egressAllowlist.js';
import { EgressDenialRecorder, startEgressProxy, type EgressProxy, type EgressProxyStats } from './egressProxy.js';
import type { AgentNetworkMode, ResolvedNetworkPolicy } from './networkPolicy.js';

/**
 * Restricted networking for agent containers, without privileges: the
 * container runs with `--network none`, so its only way out is a Unix socket,
 * bind-mounted from the worker, behind which a per-container allowlist proxy
 * listens. A small bridge inside the container exposes that socket as
 * `127.0.0.1:${EGRESS_CONTAINER_PROXY_PORT}`, which the standard proxy
 * variables point at.
 */

export const EGRESS_CONTAINER_SOCKET_DIR = '/run/propr-egress';
export const EGRESS_CONTAINER_PROXY_PORT = 3128;
const SOCKET_NAME = 'proxy.sock';
const OWNER_FILE = 'owner.json';
/** Directories left by a worker on another host are removed only after this long. */
export const EGRESS_ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const PROXY_URL = `http://127.0.0.1:${EGRESS_CONTAINER_PROXY_PORT}`;
const NO_PROXY = 'localhost,127.0.0.1,::1';
const PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);

/** Worker-side directory for run sockets, and the same directory as the Docker daemon sees it. */
export function egressSocketRoots(env: NodeJS.ProcessEnv = process.env): { local: string; host: string } {
    const local = path.resolve(env.PROPR_EGRESS_SOCKET_DIR || '/tmp/propr-egress');
    return { local, host: env.HOST_PROPR_EGRESS_SOCKET_DIR ? path.resolve(env.HOST_PROPR_EGRESS_SOCKET_DIR) : local };
}

export interface NetworkEgressFallback { agentType: string; reason: string }

/** One run's network record: what was asked for, what each container got, and every denied host. */
export interface NetworkEgressReport extends EgressProxyStats {
    mode: AgentNetworkMode;
    source: ResolvedNetworkPolicy['source'];
    note?: string;
    /** Instance and repository additions to the built-in base list. */
    allow: string[];
    restrictedContainers: number;
    /** Containers that ran with open networking although the run asked for restricted. */
    fallbacks: NetworkEgressFallback[];
    /** Containers refused because restricted mode is enforced and their agent cannot use the proxy. */
    refusals: NetworkEgressFallback[];
}

interface NetworkEgressContext {
    policy: ResolvedNetworkPolicy;
    recorder: EgressDenialRecorder;
    restrictedContainers: number;
    fallbacks: NetworkEgressFallback[];
    refusals: NetworkEgressFallback[];
}

const networkEgressExecution = new AsyncLocalStorage<NetworkEgressContext>();
const activeProxies = new Map<string, EgressProxy>();
/** Directories this process owns, from before the proxy listens until it is released. */
const ownedDirectories = new Set<string>();

export class NetworkPolicyError extends Error {
    constructor(message: string) { super(message); this.name = 'NetworkPolicyError'; }
}

/** Runs `execute` with every agent container it starts subject to `policy`. */
export async function executeWithNetworkPolicy<T>(
    policy: ResolvedNetworkPolicy,
    execute: () => Promise<T>,
): Promise<{ result: T; report: NetworkEgressReport }> {
    const context: NetworkEgressContext = { policy, recorder: new EgressDenialRecorder(), restrictedContainers: 0, fallbacks: [], refusals: [] };
    const report = (): NetworkEgressReport => ({
        mode: policy.mode, source: policy.source, ...(policy.note ? { note: policy.note } : {}), allow: policy.allow,
        restrictedContainers: context.restrictedContainers, fallbacks: context.fallbacks, refusals: context.refusals, ...context.recorder.stats(),
    });
    try {
        const result = await networkEgressExecution.run(context, execute);
        return { result, report: report() };
    } catch (error) {
        // A failed run still reports the hosts it was denied.
        (error as { networkEgressReport?: NetworkEgressReport }).networkEgressReport = report();
        throw error;
    }
}

export function networkEgressReportFromError(error: unknown): NetworkEgressReport | undefined {
    return (error as { networkEgressReport?: NetworkEgressReport } | undefined)?.networkEgressReport;
}

function envValue(args: string[], key: string): string | undefined {
    for (let index = 0; index < args.length - 1; index++) {
        if (['-e', '--env'].includes(args[index]) && args[index + 1].startsWith(`${key}=`)) return args[index + 1].slice(key.length + 1);
    }
    return undefined;
}

/** Drops caller-supplied proxy variables so the run's proxy is the only one. */
function withoutProxyEnv(args: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < args.length; index++) {
        if (['-e', '--env'].includes(args[index]) && PROXY_ENV_KEYS.has((args[index + 1] ?? '').split('=')[0])) { index++; continue; }
        result.push(args[index]);
    }
    return result;
}

/** `git` reads http.proxy from GIT_CONFIG_* as well as from https_proxy. */
function withGitProxyConfig(args: string[]): string[] {
    const countIndex = args.findIndex((arg, index) => arg.startsWith('GIT_CONFIG_COUNT=') && ['-e', '--env'].includes(args[index - 1]));
    const count = countIndex >= 0 ? Number(args[countIndex].slice('GIT_CONFIG_COUNT='.length)) : 0;
    if (!Number.isSafeInteger(count) || count < 0) return args;
    const result = [...args];
    if (countIndex >= 0) result.splice(countIndex - 1, 2);
    return [...result, '-e', `GIT_CONFIG_COUNT=${count + 1}`, '-e', `GIT_CONFIG_KEY_${count}=http.proxy`, '-e', `GIT_CONFIG_VALUE_${count}=${PROXY_URL}`];
}

/**
 * Starts the in-container TCP-to-socket bridge before the wrapper runs. Its
 * output is discarded so it can never mix with the agent's JSON stdout. If the
 * socket is missing (the worker's socket directory is not shared with the
 * Docker host), say so: the run then has no network at all.
 */
export const EGRESS_BRIDGE_PRELUDE = `
if [ -S "${EGRESS_CONTAINER_SOCKET_DIR}/${SOCKET_NAME}" ]; then
    node -e 'const net=require("net");net.createServer(c=>{const u=net.connect("${EGRESS_CONTAINER_SOCKET_DIR}/${SOCKET_NAME}");c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c)}).listen(${EGRESS_CONTAINER_PROXY_PORT},"127.0.0.1")' </dev/null >/dev/null 2>&1 &
    for _propr_egress_wait in $(seq 1 100); do
        (exec 3<>/dev/tcp/127.0.0.1/${EGRESS_CONTAINER_PROXY_PORT}) 2>/dev/null && break
        sleep 0.05
    done
    unset _propr_egress_wait
else
    echo "ProPR restricted network: egress proxy socket ${EGRESS_CONTAINER_SOCKET_DIR}/${SOCKET_NAME} is missing; set PROPR_EGRESS_SOCKET_DIR and HOST_PROPR_EGRESS_SOCKET_DIR to a directory shared with the Docker host" >&2
fi
`.trim();

/** Synchronous check, so commands outside a restricted run start exactly as before. */
export function dockerRunNeedsNetworkPolicy(command: string, args: string[]): boolean {
    const context = networkEgressExecution.getStore();
    if (!context || context.policy.mode !== 'restricted' || !/(?:^|\/)docker$/.test(command) || args[0] !== 'run') return false;
    const networkIndex = args.indexOf('--network');
    return networkIndex >= 0 && args[networkIndex + 1] === 'bridge';
}

export interface PreparedEgressRun { args: string[]; release(): Promise<void> }

/**
 * Applies the current run's network policy to one `docker run` of an agent
 * container. Returns undefined when nothing changes (open mode, no policy, or
 * a container that is not an agent container on the bridge network).
 */
export async function prepareDockerRunNetwork(command: string, args: string[]): Promise<PreparedEgressRun | undefined> {
    const context = networkEgressExecution.getStore();
    if (!context || !dockerRunNeedsNetworkPolicy(command, args)) return undefined;
    const networkIndex = args.indexOf('--network');
    const agentType = envValue(args, 'PROPR_AGENT_TYPE');
    const entrypointIndex = args.indexOf('--entrypoint');
    const scriptIndex = entrypointIndex < 0 ? 0 : args.indexOf('-lc', entrypointIndex) + 1;
    const support = agentType ? AGENT_EGRESS_PROXY_SUPPORT[agentType as AgentType] : undefined;
    const fallbackReason = !support ? 'container does not identify a supported agent'
        : !support.supported ? support.note
        : scriptIndex <= 0 || entrypointIndex < 0 ? 'container is not started through the ProPR wrapper'
        : undefined;
    if (fallbackReason) {
        if (context.policy.source === 'instance_enforced') {
            context.refusals.push({ agentType: agentType ?? 'unknown', reason: fallbackReason });
            throw new NetworkPolicyError(`Restricted networking is enforced on this instance, but the ${agentType ?? 'unknown'} agent cannot run behind the egress proxy: ${fallbackReason}`);
        }
        context.fallbacks.push({ agentType: agentType ?? 'unknown', reason: fallbackReason });
        logger.warn({ agentType, reason: fallbackReason }, 'Restricted networking unavailable for agent container; running with open networking');
        return undefined;
    }

    const id = randomUUID();
    const roots = egressSocketRoots();
    const directory = path.join(roots.local, id);
    ownedDirectories.add(id);
    let proxy: EgressProxy;
    try {
        await fs.mkdir(directory, { recursive: true, mode: 0o755 });
        await fs.chmod(directory, 0o755);
        await fs.writeFile(path.join(directory, OWNER_FILE), JSON.stringify({ hostname: os.hostname(), pid: process.pid, createdAt: new Date().toISOString() }));
        proxy = await startEgressProxy({
            socketPath: path.join(directory, SOCKET_NAME),
            allowlist: compileEgressAllowlist([...baseEgressAllowlist(agentType as AgentType), ...context.policy.allow]),
            recorder: context.recorder,
        });
    } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        ownedDirectories.delete(id);
        throw error;
    }
    activeProxies.set(id, proxy);
    context.restrictedContainers++;

    let rewritten = [...args];
    rewritten[networkIndex + 1] = 'none';
    rewritten[scriptIndex] = `${EGRESS_BRIDGE_PRELUDE}\n${rewritten[scriptIndex]}`;
    const [, ...options] = withGitProxyConfig(withoutProxyEnv(rewritten.slice(0, entrypointIndex)));
    rewritten = [
        'run', ...options,
        '-v', `${path.join(roots.host, id)}:${EGRESS_CONTAINER_SOCKET_DIR}:ro`,
        '-e', 'PROPR_NETWORK_MODE=restricted',
        ...[['HTTP_PROXY', PROXY_URL], ['HTTPS_PROXY', PROXY_URL], ['http_proxy', PROXY_URL], ['https_proxy', PROXY_URL], ['NO_PROXY', NO_PROXY], ['no_proxy', NO_PROXY]]
            .flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        ...rewritten.slice(entrypointIndex),
    ];
    let released: Promise<void> | undefined;
    return {
        args: rewritten,
        release: () => released ??= proxy.close()
            .catch(error => logger.warn({ error: (error as Error).message }, 'Failed to close egress proxy'))
            .finally(() => { activeProxies.delete(id); })
            .then(() => fs.rm(directory, { recursive: true, force: true }))
            .finally(() => { ownedDirectories.delete(id); }),
    };
}

/** Closes every proxy this process still holds (worker shutdown). */
export async function closeAllEgressProxies(): Promise<void> {
    const proxies = [...activeProxies];
    activeProxies.clear();
    const { local } = egressSocketRoots();
    await Promise.allSettled(proxies.map(async ([id, proxy]) => {
        await proxy.close();
        await fs.rm(path.join(local, id), { recursive: true, force: true });
        ownedDirectories.delete(id);
    }));
}

function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Removes egress proxy directories whose owner is gone: one left by a dead
 * process on this host, one this process no longer serves, or any directory
 * older than {@link EGRESS_ORPHAN_MAX_AGE_MS}. Directories from live workers on
 * other hosts sharing the same root are left alone.
 */
export async function sweepOrphanedEgressProxies(options: { now?: number; root?: string } = {}): Promise<{ removed: number }> {
    const root = options.root ?? egressSocketRoots().local;
    const now = options.now ?? Date.now();
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { return { removed: 0 }; }
    let removed = 0;
    for (const id of entries) {
        const directory = path.join(root, id);
        try {
            const stat = await fs.stat(directory);
            if (!stat.isDirectory()) continue;
            let owner: { hostname?: string; pid?: number } = {};
            try { owner = JSON.parse(await fs.readFile(path.join(directory, OWNER_FILE), 'utf8')); } catch { /* incomplete directory */ }
            const local = owner.hostname === os.hostname();
            const orphaned = now - stat.mtimeMs > EGRESS_ORPHAN_MAX_AGE_MS
                || (local && typeof owner.pid === 'number' && (owner.pid === process.pid ? !ownedDirectories.has(id) : !processAlive(owner.pid)));
            if (!orphaned) continue;
            await fs.rm(directory, { recursive: true, force: true });
            removed++;
        } catch (error) {
            logger.debug({ directory, error: (error as Error).message }, 'Could not inspect egress proxy directory');
        }
    }
    if (removed) logger.info({ removed, root }, 'Removed orphaned egress proxy directories');
    return { removed };
}

/** Sweeps at startup and then periodically; `close` also closes this process's proxies (worker shutdown). */
export function startEgressProxySweeper(intervalMs = 10 * 60_000): { close(): Promise<void> } {
    const sweep = (): void => {
        void sweepOrphanedEgressProxies().catch(error => logger.warn({ error: (error as Error).message }, 'Egress proxy sweep failed'));
    };
    sweep();
    const timer = setInterval(sweep, intervalMs);
    timer.unref?.();
    return {
        async close() {
            clearInterval(timer);
            await closeAllEgressProxies();
        },
    };
}
