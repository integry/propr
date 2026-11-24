/**
 * The API and worker side of idle shutdown (issue #3770): the daemon decides
 * the instance is idle and publishes on {@link IDLE_SHUTDOWN_CHANNEL}; every
 * other control-plane process then runs its own graceful shutdown (stop
 * accepting work, close queues and connections) and exits with code 0.
 */

import { Redis } from 'ioredis';
import { IDLE_SHUTDOWN_CHANNEL } from '@propr/shared';

export interface IdleShutdownMessage {
    shutdownAt: string;
    reason: string;
}

export function parseIdleShutdownMessage(raw: string): IdleShutdownMessage | null {
    try {
        const value = JSON.parse(raw) as Partial<IdleShutdownMessage>;
        return typeof value.shutdownAt === 'string' ? { shutdownAt: value.shutdownAt, reason: typeof value.reason === 'string' ? value.reason : 'idle' } : null;
    } catch {
        return null;
    }
}

/**
 * Subscribe on a dedicated connection and call `onShutdown` once. The default
 * handler sends this process SIGTERM, so the existing graceful shutdown path
 * runs unchanged. Returns a function that closes the subscription.
 */
export function startIdleShutdownListener(options: {
    onShutdown?: (message: IdleShutdownMessage) => void;
    redis?: Redis;
    log?: { info(obj: object, msg: string): void };
} = {}): () => Promise<void> {
    const subscriber = options.redis ?? new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });
    let fired = false;
    const onShutdown = options.onShutdown ?? (() => { process.kill(process.pid, 'SIGTERM'); });
    subscriber.on('message', (channel: string, raw: string) => {
        if (channel !== IDLE_SHUTDOWN_CHANNEL || fired) return;
        const message = parseIdleShutdownMessage(raw);
        if (!message) return;
        fired = true;
        options.log?.info({ ...message }, 'Idle shutdown requested by the daemon; shutting down gracefully');
        onShutdown(message);
    });
    void Promise.resolve().then(() => subscriber.subscribe(IDLE_SHUTDOWN_CHANNEL)).catch(() => undefined);
    return async () => {
        await subscriber.quit().catch(() => undefined);
    };
}
