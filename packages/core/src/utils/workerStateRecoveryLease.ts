import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

type RecoveryLeaseRedis = Pick<InstanceType<typeof Redis>, 'eval'>;

const RECOVERY_LEASE_TTL_MS = 30_000;
const RECOVERY_LEASE_RENEWAL_MS = 10_000;
const RECOVERY_LEASE_RETRY_MS = 10;

const ACQUIRE_READER_SCRIPT = `
-- worker-state-recovery:acquire-reader
if redis.call('exists', KEYS[2]) == 1 then
    return 0
end
if redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
    return 1
end
return 0
`;

const ACQUIRE_WRITER_INTENT_SCRIPT = `
-- worker-state-recovery:acquire-writer-intent
if redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
    return 1
end
return 0
`;

const ACQUIRE_WRITER_SCRIPT = `
-- worker-state-recovery:acquire-writer
if redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
    return 1
end
return 0
`;

const RENEW_SCRIPT = `
-- worker-state-recovery:renew
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('pexpire', KEYS[1], ARGV[2])
return 1
`;

const FINISH_READER_SCRIPT = `
-- worker-state-recovery:finish-reader
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('pexpire', KEYS[1], ARGV[2])
if redis.call('exists', KEYS[2]) == 1 then
    return 2
end
return 1
`;

const RELEASE_SCRIPT = `
-- worker-state-recovery:release
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
return redis.call('del', KEYS[1])
`;

function waitForLeaseRetry(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, RECOVERY_LEASE_RETRY_MS));
}

function recoveryProtocolKeys(taskKey: string): { leaseKey: string; writerIntentKey: string } {
    const identity = createHash('sha256').update(taskKey).digest('hex');
    const base = `worker:task-recovery:${identity}`;
    return { leaseKey: `${base}:lease`, writerIntentKey: `${base}:writer` };
}

class RecoveryLease {
    private renewalTimer: NodeJS.Timeout | undefined;
    private renewalError: Error | undefined;
    private released = false;

    private constructor(
        private readonly redis: RecoveryLeaseRedis,
        private readonly key: string,
        private readonly token: string,
    ) {
        this.scheduleRenewal();
    }

    static async acquire(
        redis: RecoveryLeaseRedis,
        key: string,
        script: string,
        additionalKey = key,
    ): Promise<RecoveryLease> {
        const token = randomUUID();
        while (true) {
            const acquired = await redis.eval(
                script,
                2,
                key,
                additionalKey,
                token,
                RECOVERY_LEASE_TTL_MS,
            );
            if (Number(acquired) === 1) return new RecoveryLease(redis, key, token);
            await waitForLeaseRetry();
        }
    }

    async assertOwned(): Promise<void> {
        if (this.renewalError) throw this.renewalError;
        const renewed = await this.redis.eval(
            RENEW_SCRIPT,
            1,
            this.key,
            this.token,
            RECOVERY_LEASE_TTL_MS,
        );
        if (Number(renewed) !== 1) throw this.lostOwnershipError();
    }

    async finishReader(writerIntentKey: string): Promise<'return' | 'retry'> {
        if (this.renewalError) throw this.renewalError;
        const result = await this.redis.eval(
            FINISH_READER_SCRIPT,
            2,
            this.key,
            writerIntentKey,
            this.token,
            RECOVERY_LEASE_TTL_MS,
        );
        if (Number(result) === 0) throw this.lostOwnershipError();
        return Number(result) === 2 ? 'retry' : 'return';
    }

    async release(): Promise<void> {
        this.released = true;
        if (this.renewalTimer) clearTimeout(this.renewalTimer);
        await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.token);
    }

    private scheduleRenewal(): void {
        this.renewalTimer = setTimeout(() => {
            void this.assertOwned()
                .catch(error => { this.renewalError = error as Error; })
                .finally(() => { if (!this.released && !this.renewalError) this.scheduleRenewal(); });
        }, RECOVERY_LEASE_RENEWAL_MS);
        this.renewalTimer.unref();
    }

    private lostOwnershipError(): Error {
        return new Error(`Lost task recovery lease ownership: ${this.key}`);
    }
}

export type TaskRecoveryLease = Pick<RecoveryLease, 'assertOwned'>;

async function acquireTaskRecoveryReadLease(
    redis: RecoveryLeaseRedis,
    taskKey: string,
): Promise<{ lease: RecoveryLease; writerIntentKey: string }> {
    const { leaseKey, writerIntentKey } = recoveryProtocolKeys(taskKey);
    const lease = await RecoveryLease.acquire(
        redis,
        leaseKey,
        ACQUIRE_READER_SCRIPT,
        writerIntentKey,
    );
    return { lease, writerIntentKey };
}

export async function withTaskRecoveryReadLease<T>(
    redis: RecoveryLeaseRedis,
    taskKey: string,
    operation: (lease: TaskRecoveryLease) => Promise<T>,
): Promise<T> {
    while (true) {
        const { lease, writerIntentKey } = await acquireTaskRecoveryReadLease(redis, taskKey);
        try {
            const result = await operation(lease);
            if (await lease.finishReader(writerIntentKey) === 'return') return result;
        } finally {
            await lease.release();
        }
    }
}

/**
 * Serializes an ordinary task-key mutation with recovery without replaying a
 * mutation when a recovery writer queues after it acquired the lease.
 */
export async function withTaskRecoveryMutationLease<T>(
    redis: RecoveryLeaseRedis,
    taskKey: string,
    operation: (lease: TaskRecoveryLease) => Promise<T>,
): Promise<T> {
    const { lease } = await acquireTaskRecoveryReadLease(redis, taskKey);
    try {
        await lease.assertOwned();
        const result = await operation(lease);
        await lease.assertOwned();
        return result;
    } finally {
        await lease.release();
    }
}

export async function withTaskRecoveryWriteLease<T>(
    redis: RecoveryLeaseRedis,
    taskKey: string,
    operation: (lease: TaskRecoveryLease) => Promise<T>,
): Promise<T> {
    const { leaseKey, writerIntentKey } = recoveryProtocolKeys(taskKey);
    const intent = await RecoveryLease.acquire(
        redis,
        writerIntentKey,
        ACQUIRE_WRITER_INTENT_SCRIPT,
    );
    try {
        const lease = await RecoveryLease.acquire(redis, leaseKey, ACQUIRE_WRITER_SCRIPT);
        try {
            await intent.assertOwned();
            const result = await operation(lease);
            await lease.assertOwned();
            await intent.assertOwned();
            return result;
        } finally {
            await lease.release();
        }
    } finally {
        await intent.release();
    }
}
