import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

interface UltrafixIdentity {
    owner: string;
    repo: string;
    pr: number;
}

interface TerminalSweepDeps {
    listKeys: (redis: Redis) => Promise<string[]>;
    parseKey: (key: string) => UltrafixIdentity | null;
    resume: (identity: UltrafixIdentity, redis: Redis, logger: Logger) => Promise<boolean>;
    createLogger: () => Logger;
    warn: (error: Error) => void;
}

export async function sweepTerminalUltrafixFinalizations(
    redis: Redis,
    deps: TerminalSweepDeps,
): Promise<void> {
    let keys: string[];
    try {
        keys = await deps.listKeys(redis);
    } catch (error) {
        deps.warn(error as Error);
        return;
    }

    for (const key of keys) {
        const identity = deps.parseKey(key);
        if (!identity) continue;
        const log = deps.createLogger();
        try {
            if (await deps.resume(identity, redis, log)) {
                log.info(identity, 'Recovered successful Ultrafix terminal finalization');
            }
        } catch (error) {
            deps.warn(error as Error);
        }
    }
}

export async function scheduleTerminalUltrafixFinalizationSweep(
    redis: Redis,
    deps: TerminalSweepDeps,
    intervalMs = 60_000,
): Promise<NodeJS.Timeout> {
    await sweepTerminalUltrafixFinalizations(redis, deps);
    const interval = setInterval(() => {
        void sweepTerminalUltrafixFinalizations(redis, deps);
    }, intervalMs);
    interval.unref();
    return interval;
}
