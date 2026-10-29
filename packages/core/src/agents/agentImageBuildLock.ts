import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { claimOwnerGone, currentClaimOwner, isClaimOwner, systemClaimOwnerProbe, type ClaimOwner, type ClaimOwnerProbe } from '../storage/claimOwner.js';

export const AGENT_IMAGE_BUILD_LOCK_KEY = 'propr:agent-image-build:slot';
export const AGENT_IMAGE_BUILD_LOCK_LEASE_MS = 45 * 60 * 1000;
export const AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;
/** How often a waiter re-checks whether the same holder is still alive. */
const OWNER_PROBE_INTERVAL_MS = 15_000;
const WAIT_WARNING_AFTER_MS = 10_000;
const WAIT_WARNING_INTERVAL_MS = 60_000;
/** How long shutdown lets an aborted build settle before releasing its slot anyway. */
const SHUTDOWN_SETTLE_MS = 5_000;

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;
const INSPECT_LOCK_SCRIPT = `
return {redis.call('get', KEYS[1]), redis.call('pttl', KEYS[1])}
`;
const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

export interface AgentImageBuildLockClient {
    set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
    eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface AgentImageBuildLockLogger {
    warn(details: object, message: string): void;
}

export interface AgentImageBuildLockOptions {
    client?: AgentImageBuildLockClient;
    leaseMs?: number;
    acquireTimeoutMs?: number;
    pollIntervalMs?: number;
    token?: string;
    /** Identity recorded with the slot; defaults to this process. */
    owner?: ClaimOwner;
    ownerProbe?: ClaimOwnerProbe;
    ownerProbeIntervalMs?: number;
    waitWarningAfterMs?: number;
    waitWarningIntervalMs?: number;
    logger?: AgentImageBuildLockLogger;
}

/** The current slot value, as recorded by the process that holds it. */
export interface AgentImageBuildSlotHolder {
    /** The exact stored value; reclaim and release compare against it. */
    value: string;
    token: string;
    /** Absent for a slot written before owners were recorded. */
    owner?: ClaimOwner;
    /** Remaining lease, when Redis reports one. */
    remainingLeaseMs?: number;
}

interface ActiveSlot {
    client: AgentImageBuildLockClient;
    value: string;
    settled: Promise<unknown>;
}

const activeSlots = new Set<ActiveSlot>();
const shutdownController = new AbortController();

let redisClient: Redis | null = null;

function getRedisClient(): AgentImageBuildLockClient {
    if (!redisClient) {
        redisClient = new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
            enableReadyCheck: false,
            lazyConnect: true,
        });
        redisClient.on('error', error => {
            logger.error({ error: error.message }, 'Agent image build lock Redis error');
        });
    }
    return redisClient as unknown as AgentImageBuildLockClient;
}

function sleep(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

function shutdownError(): Error {
    return new Error('Agent image build was interrupted because the worker is shutting down');
}

export function parseAgentImageBuildSlotValue(value: string): Pick<AgentImageBuildSlotHolder, 'token' | 'owner'> {
    try {
        const parsed = JSON.parse(value) as { token?: unknown; owner?: unknown };
        if (parsed && typeof parsed.token === 'string') {
            return { token: parsed.token, owner: isClaimOwner(parsed.owner) ? parsed.owner : undefined };
        }
    } catch {
        // A bare token from a release that did not record owners.
    }
    return { token: value };
}

export function describeAgentImageBuildSlotHolder(holder: AgentImageBuildSlotHolder): string {
    const who = holder.owner
        ? `${holder.owner.host} pid ${holder.owner.pid}`
        : `an unidentified holder (token ${holder.token})`;
    if (holder.remainingLeaseMs === undefined) return who;
    return `${who}, lease expires in ${Math.ceil(holder.remainingLeaseMs / 60_000)}m`;
}

export async function inspectAgentImageBuildSlot(client: AgentImageBuildLockClient = getRedisClient()): Promise<AgentImageBuildSlotHolder | null> {
    const [value, pttl] = await client.eval(INSPECT_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY) as [string | null, number];
    if (typeof value !== 'string') return null;
    const ttl = Number(pttl);
    return { value, ...parseAgentImageBuildSlotValue(value), remainingLeaseMs: ttl >= 0 ? ttl : undefined };
}

const SLOT_HINT_CACHE_MS = 5_000;
let slotHintCache: { at: number; hint: Promise<string | undefined> } | null = null;

async function readSlotHint(timeoutMs: number): Promise<string | undefined> {
    // A short-lived connection that never retries: an inspect-only process
    // must not keep reconnecting to Redis just to annotate its status.
    const client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        lazyConnect: true,
        enableReadyCheck: false,
        maxRetriesPerRequest: 0,
        connectTimeout: timeoutMs,
        retryStrategy: () => null,
    });
    client.on('error', () => {});
    let timer: NodeJS.Timeout | undefined;
    try {
        const holder = await Promise.race([
            inspectAgentImageBuildSlot(client as unknown as AgentImageBuildLockClient),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
        ]);
        return holder ? `waiting for build slot held by ${describeAgentImageBuildSlotHolder(holder)}` : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
        client.disconnect();
    }
}

/**
 * Status hint for a process that only inspects images (the API): names the
 * current build-slot holder so an image that is not ready yet does not look
 * idle while a worker waits for, or builds under, the slot. Never throws.
 */
export function describeAgentImageBuildSlotWait(timeoutMs = 1_000): Promise<string | undefined> {
    if (!slotHintCache || Date.now() - slotHintCache.at > SLOT_HINT_CACHE_MS) {
        slotHintCache = { at: Date.now(), hint: readSlotHint(timeoutMs) };
    }
    return slotHintCache.hint;
}

/**
 * Only proof that the recorded process is gone reclaims the slot; the
 * compare-and-delete cannot remove a newer holder, so of several concurrent
 * reclaimers at most one deletes and the SET NX race picks one winner.
 */
async function reclaimFromGoneOwner(
    options: { client: AgentImageBuildLockClient; ownerProbe: ClaimOwnerProbe; logger: AgentImageBuildLockLogger },
    holder: AgentImageBuildSlotHolder,
    owner: ClaimOwner,
): Promise<boolean> {
    if (!await claimOwnerGone(owner, options.ownerProbe)) return false;
    const deleted = await options.client.eval(RELEASE_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY, holder.value);
    if (Number(deleted) === 1) {
        options.logger.warn(
            { holder: owner, remainingLeaseMs: holder.remainingLeaseMs },
            `Reclaimed the agent image build slot from ${describeAgentImageBuildSlotHolder(holder)}, which is no longer running`,
        );
    }
    return true;
}

async function acquireLock(options: {
    client: AgentImageBuildLockClient;
    value: string;
    leaseMs: number;
    acquireTimeoutMs: number;
    pollIntervalMs: number;
    ownerProbe: ClaimOwnerProbe;
    ownerProbeIntervalMs: number;
    waitWarningAfterMs: number;
    waitWarningIntervalMs: number;
    logger: AgentImageBuildLockLogger;
}): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + options.acquireTimeoutMs;
    let nextWarningAt = startedAt + options.waitWarningAfterMs;
    let probedValue: string | undefined;
    let nextProbeAt = 0;
    while (true) {
        if (shutdownController.signal.aborted) throw shutdownError();
        const acquired = await options.client.set(
            AGENT_IMAGE_BUILD_LOCK_KEY,
            options.value,
            'PX',
            options.leaseMs,
            'NX',
        );
        if (acquired === 'OK') return;
        const now = Date.now();
        if (now >= nextProbeAt || now >= nextWarningAt) {
            const holder = await inspectAgentImageBuildSlot(options.client);
            if (holder?.owner && (holder.value !== probedValue || now >= nextProbeAt)) {
                probedValue = holder.value;
                nextProbeAt = now + options.ownerProbeIntervalMs;
                if (await reclaimFromGoneOwner(options, holder, holder.owner)) continue;
            } else if (now >= nextProbeAt) {
                nextProbeAt = now + options.ownerProbeIntervalMs;
            }
            if (holder && now >= nextWarningAt) {
                nextWarningAt = now + options.waitWarningIntervalMs;
                options.logger.warn(
                    { holder: holder.owner ?? holder.token, remainingLeaseMs: holder.remainingLeaseMs, waitedMs: now - startedAt },
                    `Waiting for the agent image build slot held by ${describeAgentImageBuildSlotHolder(holder)}`,
                );
            }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(`Timed out waiting for the ProPR agent image build slot after ${options.acquireTimeoutMs}ms`);
        }
        await sleep(Math.min(options.pollIntervalMs, remaining));
    }
}

async function releaseLock(client: AgentImageBuildLockClient, value: string): Promise<void> {
    await client.eval(RELEASE_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY, value);
}

/**
 * Runs one heavyweight image build while holding the installation-wide Redis
 * lease. The slot records this process as its owner so a waiter can reclaim it
 * once that process is provably gone; the lease is longer than the Docker build
 * timeout and is renewed while work runs, and its TTL remains the last resort.
 * `work` receives a signal that aborts when the worker shuts down.
 */
export async function withAgentImageBuildSlot<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: AgentImageBuildLockOptions = {},
): Promise<T> {
    const client = options.client || getRedisClient();
    const leaseMs = options.leaseMs ?? AGENT_IMAGE_BUILD_LOCK_LEASE_MS;
    const token = options.token || crypto.randomUUID();
    const value = JSON.stringify({ token, owner: options.owner ?? currentClaimOwner() });
    await acquireLock({
        client,
        value,
        leaseMs,
        acquireTimeoutMs: options.acquireTimeoutMs ?? AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? LOCK_POLL_INTERVAL_MS,
        ownerProbe: options.ownerProbe ?? systemClaimOwnerProbe,
        ownerProbeIntervalMs: options.ownerProbeIntervalMs ?? OWNER_PROBE_INTERVAL_MS,
        waitWarningAfterMs: options.waitWarningAfterMs ?? WAIT_WARNING_AFTER_MS,
        waitWarningIntervalMs: options.waitWarningIntervalMs ?? WAIT_WARNING_INTERVAL_MS,
        logger: options.logger ?? logger,
    });

    let leaseLost = false;
    const renewTimer = setInterval(() => {
        void client.eval(RENEW_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY, value, String(leaseMs))
            .then(result => {
                if (Number(result) !== 1) {
                    leaseLost = true;
                    logger.error('Agent image build lock lease was lost while building');
                }
            })
            .catch(error => {
                leaseLost = true;
                logger.error({ error: (error as Error).message }, 'Could not renew agent image build lock lease');
            });
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    renewTimer.unref?.();

    const running = work(shutdownController.signal);
    const slot: ActiveSlot = { client, value, settled: running.catch(() => undefined) };
    activeSlots.add(slot);
    try {
        const result = await running;
        if (leaseLost) throw new Error('Agent image build lock lease was lost during the Docker build');
        return result;
    } finally {
        clearInterval(renewTimer);
        activeSlots.delete(slot);
        try {
            await releaseLock(client, value);
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Could not release agent image build lock; it will expire automatically');
        }
    }
}

/**
 * Capacity is deliberately checked inside the lease, immediately before the
 * Docker build. This prevents two independent worker queues from both seeing
 * the same free space and starting competing heavyweight builds.
 */
export function runAgentImageBuild<T>(
    assertCapacity: () => Promise<void>,
    build: (signal: AbortSignal) => Promise<T>,
    options: AgentImageBuildLockOptions = {},
): Promise<T> {
    return withAgentImageBuildSlot(async signal => {
        await assertCapacity();
        return build(signal);
    }, options);
}

/**
 * Graceful-shutdown step: stops waiting for the slot, aborts in-flight builds
 * and releases any slot this process holds, so a stop/restart does not leave
 * the next worker waiting on a dead holder. Later acquisitions are refused.
 */
export async function abortAgentImageBuildsForShutdown(settleMs = SHUTDOWN_SETTLE_MS): Promise<void> {
    shutdownController.abort(shutdownError());
    const slots = [...activeSlots];
    if (slots.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        Promise.all(slots.map(slot => slot.settled)),
        new Promise(resolve => { timer = setTimeout(resolve, settleMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    await Promise.all(slots.map(async slot => {
        try {
            await releaseLock(slot.client, slot.value);
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Could not release agent image build lock during shutdown');
        }
    }));
}

export async function closeAgentImageBuildLock(): Promise<void> {
    await abortAgentImageBuildsForShutdown();
    const client = redisClient;
    redisClient = null;
    if (client) await client.quit();
}
