import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';

export const AGENT_IMAGE_BUILD_LOCK_KEY = 'propr:agent-image-build:slot';
export const AGENT_IMAGE_BUILD_LOCK_LEASE_MS = 45 * 60 * 1000;
export const AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
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

export interface AgentImageBuildLockOptions {
    client?: AgentImageBuildLockClient;
    leaseMs?: number;
    acquireTimeoutMs?: number;
    pollIntervalMs?: number;
    token?: string;
}

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

async function acquireLock(options: {
    client: AgentImageBuildLockClient;
    token: string;
    leaseMs: number;
    acquireTimeoutMs: number;
    pollIntervalMs: number;
}): Promise<void> {
    const deadline = Date.now() + options.acquireTimeoutMs;
    while (true) {
        const acquired = await options.client.set(
            AGENT_IMAGE_BUILD_LOCK_KEY,
            options.token,
            'PX',
            options.leaseMs,
            'NX',
        );
        if (acquired === 'OK') return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(`Timed out waiting for the ProPR agent image build slot after ${options.acquireTimeoutMs}ms`);
        }
        await sleep(Math.min(options.pollIntervalMs, remaining));
    }
}

async function releaseLock(client: AgentImageBuildLockClient, token: string): Promise<void> {
    await client.eval(RELEASE_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY, token);
}

/**
 * Runs one heavyweight image build while holding the installation-wide Redis
 * lease. The lease is longer than the Docker build timeout and is renewed
 * while work runs; its TTL still permits recovery after process death.
 */
export async function withAgentImageBuildSlot<T>(
    work: () => Promise<T>,
    options: AgentImageBuildLockOptions = {},
): Promise<T> {
    const client = options.client || getRedisClient();
    const leaseMs = options.leaseMs ?? AGENT_IMAGE_BUILD_LOCK_LEASE_MS;
    const token = options.token || crypto.randomUUID();
    await acquireLock({
        client,
        token,
        leaseMs,
        acquireTimeoutMs: options.acquireTimeoutMs ?? AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? LOCK_POLL_INTERVAL_MS,
    });

    let leaseLost = false;
    const renewTimer = setInterval(() => {
        void client.eval(RENEW_LOCK_SCRIPT, 1, AGENT_IMAGE_BUILD_LOCK_KEY, token, String(leaseMs))
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

    try {
        const result = await work();
        if (leaseLost) throw new Error('Agent image build lock lease was lost during the Docker build');
        return result;
    } finally {
        clearInterval(renewTimer);
        try {
            await releaseLock(client, token);
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
    build: () => Promise<T>,
    options: AgentImageBuildLockOptions = {},
): Promise<T> {
    return withAgentImageBuildSlot(async () => {
        await assertCapacity();
        return build();
    }, options);
}

export async function closeAgentImageBuildLock(): Promise<void> {
    const client = redisClient;
    redisClient = null;
    if (client) await client.quit();
}
