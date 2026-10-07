import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '../utils/logger.js';
import type { AgentType } from '../agents/types.js';
import { AGENT_EGRESS_PROXY_SUPPORT, AGENT_EGRESS_RESTRICTED_ENV, baseEgressAllowlist, compileEgressAllowlist } from './egressAllowlist.js';
import { EgressDenialRecorder, startEgressProxy, upstreamProxiesFromEnv, type EgressProxy, type EgressProxyStats } from './egressProxy.js';
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

function reportFor(context: NetworkEgressContext): NetworkEgressReport {
    const { policy } = context;
    return {
        mode: policy.mode, source: policy.source, ...(policy.note ? { note: policy.note } : {}), allow: policy.allow,
        restrictedContainers: context.restrictedContainers, fallbacks: context.fallbacks, refusals: context.refusals, ...context.recorder.stats(),
    };
}

const sortedUnique = (entries: readonly string[] | undefined): string[] => [...new Set(entries ?? [])].sort();

/** The same policy, whatever the order of its entries. */
export function sameNetworkPolicy(a: ResolvedNetworkPolicy, b: ResolvedNetworkPolicy): boolean {
    return a.mode === b.mode && a.source === b.source && (a.note ?? '') === (b.note ?? '')
        && JSON.stringify(sortedUnique(a.allow)) === JSON.stringify(sortedUnique(b.allow))
        && JSON.stringify(sortedUnique(a.instanceAllow)) === JSON.stringify(sortedUnique(b.instanceAllow));
}

/**
 * Runs `execute` with every agent container it starts subject to `policy`.
 *
 * Inside a scope that already applies the same policy (a job reusing another
 * job's agent helpers), `execute` joins that scope: its containers and
 * denials go into the enclosing record, `nested` is true, and the report is
 * the enclosing one so far, so the caller records nothing itself and a run
 * never gets two `network.egress` events. A nested scope with a different
 * policy gets its own record, since the enclosing one would misreport it.
 */
export async function executeWithNetworkPolicy<T>(
    policy: ResolvedNetworkPolicy,
    execute: () => Promise<T>,
): Promise<{ result: T; report: NetworkEgressReport; nested: boolean }> {
    const enclosing = networkEgressExecution.getStore();
    if (enclosing && sameNetworkPolicy(enclosing.policy, policy)) {
        // A failure is left for the enclosing scope to attach its report to.
        const result = await execute();
        return { result, report: reportFor(enclosing), nested: true };
    }
    if (enclosing) logger.debug({ enclosing: enclosing.policy, policy }, 'Nested network policy scope with a different policy keeps its own record');
    const context: NetworkEgressContext = { policy, recorder: new EgressDenialRecorder(), restrictedContainers: 0, fallbacks: [], refusals: [] };
    try {
        const result = await networkEgressExecution.run(context, execute);
        return { result, report: reportFor(context), nested: false };
    } catch (error) {
        // A failed run still reports the hosts it was denied. A primitive rejection cannot carry
        // the report; assigning to it would replace the original failure with a TypeError.
        if (error && typeof error === 'object') (error as { networkEgressReport?: NetworkEgressReport }).networkEgressReport = reportFor(context);
        throw error;
    }
}

export function networkEgressReportFromError(error: unknown): NetworkEgressReport | undefined {
    return (error as { networkEgressReport?: NetworkEgressReport } | undefined)?.networkEgressReport;
}

interface DockerEnvOption { index: number; length: 1 | 2; key: string; value?: string }

/**
 * Every `-e`/`--env` option: `-e K=V`, `--env K=V`, `--env=K=V`, `-eK=V`, and
 * the `-e K` form that copies the variable from the environment `docker`
 * itself runs in (the worker's).
 */
function dockerEnvOptions(args: string[]): DockerEnvOption[] {
    const options: DockerEnvOption[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const separate = arg === '-e' || arg === '--env';
        const entry = separate ? args[index + 1]
            : arg.startsWith('--env=') ? arg.slice('--env='.length)
            : /^-e[^-]/.test(arg) ? arg.slice(arg.startsWith('-e=') ? 3 : 2)
            : undefined;
        if (entry === undefined) continue;
        const equals = entry.indexOf('=');
        options.push({ index, length: separate ? 2 : 1, key: equals < 0 ? entry : entry.slice(0, equals), ...(equals < 0 ? {} : { value: entry.slice(equals + 1) }) });
        if (separate) index++;
    }
    return options;
}

/** The options before the wrapper's `--entrypoint` (all arguments without one), so the agent's own command is never read as options. */
function containerOptions(args: string[]): string[] {
    const entrypointIndex = args.indexOf('--entrypoint');
    return entrypointIndex < 0 ? args : args.slice(0, entrypointIndex);
}

/** A variable's value in the container: set explicitly, or copied from the worker's environment. */
function envValue(args: string[], key: string): string | undefined {
    const option = dockerEnvOptions(args).find(entry => entry.key === key);
    return option && (option.value ?? process.env[key]);
}

function withoutEnvOptions(args: string[], drop: (option: DockerEnvOption) => boolean): string[] {
    const removed = new Set(dockerEnvOptions(args).filter(drop).flatMap(option => option.length === 2 ? [option.index, option.index + 1] : [option.index]));
    return args.filter((_arg, index) => !removed.has(index));
}

/** Drops caller-supplied (or inherited) proxy variables so the run's proxy is the only one. */
function withoutProxyEnv(args: string[]): string[] {
    return withoutEnvOptions(args, option => PROXY_ENV_KEYS.has(option.key));
}

/** `git` reads http.proxy from GIT_CONFIG_* as well as from https_proxy. */
function withGitProxyConfig(args: string[]): string[] {
    const counts = dockerEnvOptions(args).filter(option => option.key === 'GIT_CONFIG_COUNT');
    const count = counts.length ? Number(counts.at(-1)!.value ?? process.env.GIT_CONFIG_COUNT ?? 0) : 0;
    if (!Number.isSafeInteger(count) || count < 0) return args;
    return [...withoutEnvOptions(args, option => option.key === 'GIT_CONFIG_COUNT'),
        '-e', `GIT_CONFIG_COUNT=${count + 1}`, '-e', `GIT_CONFIG_KEY_${count}=http.proxy`, '-e', `GIT_CONFIG_VALUE_${count}=${PROXY_URL}`];
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

/** Indices of every `--network`/`--net` option (either `--network x` or `--network=x`) and their values. */
function dockerRunNetworkOptions(args: string[]): Array<{ index: number; value: string; inline: boolean }> {
    return args.flatMap((arg, index) => {
        const match = /^--net(?:work)?(?:=(.*))?$/.exec(arg);
        if (!match) return [];
        return [match[1] !== undefined ? { index, value: match[1], inline: true } : { index, value: args[index + 1] ?? '', inline: false }];
    });
}

/** A `docker run` with a network: the default network, `bridge`, `host` and custom networks all reach the internet. */
function isNetworkedDockerRun(command: string, args: string[]): boolean {
    if (!/(?:^|\/)docker$/.test(command) || args[0] !== 'run') return false;
    const networks = dockerRunNetworkOptions(args);
    return !(networks.length > 0 && networks.every(option => option.value === 'none'));
}

/**
 * Synchronous check, so commands outside a restricted run start exactly as
 * before. Inside one, every `docker run` is subject to the policy unless it
 * already has no network (`--network none`) or its caller exempts it with a
 * reason: the default network, `bridge`, `host` and custom networks all reach
 * the internet. `exemptReason` is for containers that run only ProPR's own code.
 */
export function dockerRunNeedsNetworkPolicy(command: string, args: string[], exemptReason?: string): boolean {
    const context = networkEgressExecution.getStore();
    if (!context || context.policy.mode !== 'restricted' || !isNetworkedDockerRun(command, args)) return false;
    if (exemptReason) {
        logger.debug({ reason: exemptReason }, 'Container exempt from the restricted network policy');
        return false;
    }
    return true;
}

let unscopedPolicyResolver: (() => Promise<ResolvedNetworkPolicy>) | undefined;

/**
 * Registers how this process reads the instance policy (a worker does, at
 * startup). An agent container started outside any run's policy, by a code
 * path that never called {@link executeWithNetworkPolicy}, then runs under the
 * instance policy when it enforces restricted mode, instead of silently open.
 * `undefined` unregisters it.
 */
export function setUnscopedNetworkPolicyResolver(resolver: (() => Promise<ResolvedNetworkPolicy>) | undefined): void {
    unscopedPolicyResolver = resolver;
}

/** Synchronous pre-check for {@link resolveUnscopedNetworkPolicy}: only agent containers started outside any policy qualify. */
export function mayNeedUnscopedNetworkPolicy(command: string, args: string[], exemptReason?: string): boolean {
    return !!unscopedPolicyResolver && !exemptReason && !networkEgressExecution.getStore()
        && isNetworkedDockerRun(command, args) && envValue(containerOptions(args), 'PROPR_AGENT_TYPE') !== undefined;
}

/**
 * The enforced instance policy for an agent container started outside any
 * run's policy, or undefined when none applies. Reading the policy is strict:
 * an unreadable policy fails the container rather than opening it.
 */
export async function resolveUnscopedNetworkPolicy(command: string, args: string[], exemptReason?: string): Promise<ResolvedNetworkPolicy | undefined> {
    const resolver = unscopedPolicyResolver;
    if (!resolver || !mayNeedUnscopedNetworkPolicy(command, args, exemptReason)) return undefined;
    const policy = await resolver();
    return policy.mode === 'restricted' && policy.source === 'instance_enforced' ? policy : undefined;
}

/** Runs one `docker run` (its arguments after `docker`) and reports how it ended. */
export type EgressPreflightRunner = (args: string[]) => Promise<{ exitCode: number | null; stderr: string }>;

const defaultPreflightRunner: EgressPreflightRunner = args => new Promise(resolve => {
    execFile('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') { resolve({ exitCode: null, stderr: 'docker is not installed on the worker' }); return; }
        resolve({ exitCode: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0, stderr: String(stderr ?? '') });
    });
});

let socketMountPreflight: { runner: EgressPreflightRunner; verified?: Promise<boolean> } | undefined;

/**
 * Checks once per process, before the first restricted container starts,
 * that a container can see a run's proxy socket through the bind mount. On a
 * host whose Docker daemon does not share `PROPR_EGRESS_SOCKET_DIR` at
 * `HOST_PROPR_EGRESS_SOCKET_DIR`, or cannot bind-mount Unix sockets at all
 * (Docker Desktop file sharing), every restricted container would otherwise
 * have no network at all, with only a line on its own stderr to say why. The
 * check logs one actionable warning; the run itself still fails closed. A
 * worker enables it at startup; nothing runs without that.
 */
export function enableEgressSocketMountPreflight(runner: EgressPreflightRunner = defaultPreflightRunner): void {
    socketMountPreflight = { runner };
}

/** Unregisters the preflight (tests, shutdown). */
export function disableEgressSocketMountPreflight(): void {
    socketMountPreflight = undefined;
}

/** The throwaway container only tests the socket through the same mount the run gets. */
export function egressSocketMountPreflightArgs(image: string, hostDirectory: string): string[] {
    return ['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', '-v', `${hostDirectory}:${EGRESS_CONTAINER_SOCKET_DIR}:ro`, image,
        '-c', `test -S ${EGRESS_CONTAINER_SOCKET_DIR}/${SOCKET_NAME}`];
}

async function verifySocketMountOnce(image: string, hostDirectory: string): Promise<void> {
    const preflight = socketMountPreflight;
    if (!preflight) return;
    preflight.verified ??= (async () => {
        const roots = egressSocketRoots();
        const hint = `the Docker daemon must see the worker's PROPR_EGRESS_SOCKET_DIR (${roots.local}) at HOST_PROPR_EGRESS_SOCKET_DIR (${roots.host}), on a host that can bind-mount Unix sockets (Docker Desktop file sharing cannot). Until then every restricted container has no network at all and its run fails closed.`;
        try {
            const outcome = await preflight.runner(egressSocketMountPreflightArgs(image, hostDirectory));
            if (outcome.exitCode === 0) {
                logger.info({ image, hostDirectory }, 'Restricted network preflight: a container sees the egress proxy socket through its mount');
                return true;
            }
            logger.warn({ image, hostDirectory, exitCode: outcome.exitCode, stderr: outcome.stderr.trim().slice(-2000) },
                `Restricted network preflight failed: a container cannot see the egress proxy socket; ${hint}`);
        } catch (error) {
            logger.warn({ image, hostDirectory, error: (error as Error).message }, `Restricted network preflight could not run; if restricted containers have no network, ${hint}`);
        }
        return false;
    })();
    await preflight.verified;
}

export interface PreparedEgressRun { args: string[]; release(): Promise<void> }

/**
 * Applies the current run's network policy to one `docker run` of an agent
 * container. Returns undefined when nothing changes (open mode, no policy, a
 * container already without a network, or one exempted with a reason).
 */
export async function prepareDockerRunNetwork(command: string, args: string[], exemptReason?: string): Promise<PreparedEgressRun | undefined> {
    const context = networkEgressExecution.getStore();
    if (!context || !dockerRunNeedsNetworkPolicy(command, args, exemptReason)) return undefined;
    const entrypointIndex = args.indexOf('--entrypoint');
    const agentType = envValue(containerOptions(args), 'PROPR_AGENT_TYPE');
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
        // Traversable but not listable, so other local accounts cannot enumerate
        // run sockets; the container's own user only needs to reach a known path.
        await fs.mkdir(directory, { recursive: true, mode: 0o711 });
        await fs.chmod(roots.local, 0o711).catch(() => undefined);
        await fs.chmod(directory, 0o711);
        await fs.writeFile(path.join(directory, OWNER_FILE), JSON.stringify({
            instanceId: PROCESS_INSTANCE_ID, namespace: await egressProcessNamespace(), hostname: os.hostname(), pid: process.pid, createdAt: new Date().toISOString(),
        }));
        proxy = await startEgressProxy({
            socketPath: path.join(directory, SOCKET_NAME),
            allowlist: compileEgressAllowlist([...baseEgressAllowlist(agentType as AgentType), ...context.policy.allow]),
            // Only the administrator's own IP literals open loopback, private or link-local addresses.
            addressAllowlist: compileEgressAllowlist(context.policy.instanceAllow ?? []),
            recorder: context.recorder,
            // A worker that reaches the internet only through its own proxy chains through it.
            upstreamProxies: upstreamProxiesFromEnv(),
        });
    } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        ownedDirectories.delete(id);
        throw error;
    }
    activeProxies.set(id, proxy);
    context.restrictedContainers++;
    // The wrapper puts the image right after `--entrypoint /bin/bash`.
    try { await verifySocketMountOnce(args[entrypointIndex + 2], path.join(roots.host, id)); } catch { /* logged */ }

    // Non-essential traffic the agent would otherwise attempt and have denied, unless the caller decided.
    const quietEnv = (AGENT_EGRESS_RESTRICTED_ENV[agentType as AgentType] ?? [])
        .filter(([key]) => envValue(containerOptions(args), key) === undefined)
        .flatMap(([key, value]) => ['-e', `${key}=${value}`]);

    let rewritten = [...args];
    rewritten[scriptIndex] = `${EGRESS_BRIDGE_PRELUDE}\n${rewritten[scriptIndex]}`;
    // Whatever network the caller named (or the default it left implicit) is replaced by none.
    const networkArgs = new Set(dockerRunNetworkOptions(rewritten.slice(0, entrypointIndex)).flatMap(option => option.inline ? [option.index] : [option.index, option.index + 1]));
    const [, ...options] = withGitProxyConfig(withoutProxyEnv(rewritten.slice(0, entrypointIndex).filter((_arg, index) => !networkArgs.has(index))));
    rewritten = [
        'run', ...options,
        '--network', 'none',
        '-v', `${path.join(roots.host, id)}:${EGRESS_CONTAINER_SOCKET_DIR}:ro`,
        '-e', 'PROPR_NETWORK_MODE=restricted',
        ...[['HTTP_PROXY', PROXY_URL], ['HTTPS_PROXY', PROXY_URL], ['http_proxy', PROXY_URL], ['https_proxy', PROXY_URL], ['NO_PROXY', NO_PROXY], ['no_proxy', NO_PROXY]]
            .flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        ...quietEnv,
        ...rewritten.slice(entrypointIndex),
    ];
    let released: Promise<void> | undefined;
    return {
        args: rewritten,
        release: () => released ??= proxy.close()
            .catch(error => logger.warn({ error: (error as Error).message }, 'Failed to close egress proxy'))
            .finally(() => { activeProxies.delete(id); })
            // Cleanup never replaces the container's own result; the sweeper removes what is left.
            .then(() => fs.rm(directory, { recursive: true, force: true }))
            .catch(error => logger.warn({ directory, error: (error as Error).message }, 'Failed to remove egress proxy directory'))
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

/** This process exactly: a directory it wrote is its own, whatever its PID namespace or hostname. */
const PROCESS_INSTANCE_ID = randomUUID();
let processNamespace: Promise<string> | undefined;

/**
 * The PID namespace this process lives in, so the sweeper judges only PIDs it
 * can see: two containers (the worker and the indexing worker) may share a
 * hostname. On Linux that is the boot plus the PID namespace inode; elsewhere
 * one host is one namespace.
 */
export function egressProcessNamespace(): Promise<string> {
    return processNamespace ??= Promise.all([fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink('/proc/self/ns/pid')])
        .then(([boot, pidNamespace]) => `${boot.trim()}:${pidNamespace}`, () => `host:${os.hostname()}`);
}

function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Removes egress proxy directories whose owner is gone: one left by a dead
 * process in this PID namespace, one this process no longer serves, or any directory
 * not refreshed for {@link EGRESS_ORPHAN_MAX_AGE_MS}. Each sweep first touches
 * the directories this process still serves, so a live worker on another host
 * sharing the same root keeps its directories fresh however long its runs last,
 * and this process never removes its own.
 */
export async function sweepOrphanedEgressProxies(options: { now?: number; root?: string } = {}): Promise<{ removed: number }> {
    const root = options.root ?? egressSocketRoots().local;
    const now = options.now ?? Date.now();
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { return { removed: 0 }; }
    const namespace = await egressProcessNamespace();
    const touched = new Date(now);
    await Promise.all([...ownedDirectories].map(id => fs.utimes(path.join(root, id), touched, touched).catch(() => undefined)));
    let removed = 0;
    for (const id of entries) {
        if (ownedDirectories.has(id)) continue;
        const directory = path.join(root, id);
        try {
            const stat = await fs.stat(directory);
            if (!stat.isDirectory()) continue;
            let owner: { instanceId?: string; namespace?: string; pid?: number } = {};
            try { owner = JSON.parse(await fs.readFile(path.join(directory, OWNER_FILE), 'utf8')); } catch { /* incomplete directory */ }
            const own = owner.instanceId === PROCESS_INSTANCE_ID;
            // A PID means something only in the namespace it came from; a matching hostname is not enough.
            const sameNamespace = typeof owner.namespace === 'string' && owner.namespace === namespace;
            const orphaned = now - stat.mtimeMs > EGRESS_ORPHAN_MAX_AGE_MS
                || (own ? !ownedDirectories.has(id)
                    : sameNamespace && typeof owner.pid === 'number' && (owner.pid === process.pid || !processAlive(owner.pid)));
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
