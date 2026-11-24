/**
 * In-process activity a process cannot see from shared stores: open Web UI
 * (Socket.IO) sessions and in-flight MCP and HTTP requests in the API. Each
 * API process publishes its counts to Redis with a short TTL so the daemon's
 * idle detector can sum them; a process that died stops counting once its
 * key expires.
 */

import { IDLE_ACTIVITY_REDIS_PREFIX } from '@propr/shared';

export interface IdleActivity {
    uiSessions: number;
    mcpRequests: number;
    httpRequests: number;
    /** Last time a request started (epoch ms), or 0. */
    lastRequestAt: number;
    publishedAt: number;
}

export const IDLE_ACTIVITY_TTL_SECONDS = 60;
export const IDLE_ACTIVITY_PUBLISH_INTERVAL_MS = 15_000;

/** A record with any missing or invalid field is malformed (null): it is not evidence of idleness. */
export function parseIdleActivity(raw: string | null): IdleActivity | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<IdleActivity> | null;
        if (!value || typeof value !== 'object') return null;
        const fields = [value.uiSessions, value.mcpRequests, value.httpRequests, value.lastRequestAt, value.publishedAt];
        if (!fields.every(field => typeof field === 'number' && Number.isFinite(field) && field >= 0)) return null;
        return {
            uiSessions: Math.floor(value.uiSessions!),
            mcpRequests: Math.floor(value.mcpRequests!),
            httpRequests: Math.floor(value.httpRequests!),
            lastRequestAt: value.lastRequestAt!,
            publishedAt: value.publishedAt!,
        };
    } catch {
        return null;
    }
}

/** Counts requests in flight by kind; sessions come from a live getter. */
export class IdleActivityTracker {
    private mcp = 0;
    private http = 0;
    private lastRequestAt = 0;
    private sessions: () => number = () => 0;
    private changeListener: (() => void) | null = null;
    private quiescedFor: string | null = null;
    private readonly drainWaiters = new Set<() => void>();

    /** Called when a request starts or a session opens, so the publisher can refresh at once. */
    onChange(listener: (() => void) | null): void {
        this.changeListener = listener;
    }

    /** Signal a change the tracker cannot see itself, e.g. a new Socket.IO session. */
    notify(): void {
        try {
            this.changeListener?.();
        } catch {
            // Activity reporting never affects request handling.
        }
    }

    /** Use the Socket.IO server's live client count. */
    setSessionCounter(counter: () => number): void {
        this.sessions = counter;
    }

    /** Count a request until the returned function is called (idempotent). */
    begin(kind: 'mcp' | 'http'): () => void {
        if (kind === 'mcp') this.mcp += 1; else this.http += 1;
        this.lastRequestAt = Date.now();
        // Only the first request of a burst needs an eager publish.
        if (this.mcp + this.http === 1) this.notify();
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            if (kind === 'mcp') this.mcp = Math.max(0, this.mcp - 1); else this.http = Math.max(0, this.http - 1);
            if (this.mcp + this.http === 0) for (const waiter of [...this.drainWaiters]) waiter();
        };
    }

    /** A request that was turned away still shows someone wants the instance. */
    touch(): void {
        this.lastRequestAt = Date.now();
        this.notify();
    }

    /**
     * Idle drain, first phase: stop admitting requests (the middleware answers
     * 503) so nothing new can produce work while the daemon re-checks.
     */
    quiesce(intentId: string): void {
        this.quiescedFor = intentId;
    }

    /** Admit requests again (the drain was aborted). */
    resume(): void {
        this.quiescedFor = null;
    }

    get quiescedIntent(): string | null {
        return this.quiescedFor;
    }

    /** Resolves true once no request is in flight, or false after `timeoutMs`. */
    waitForDrain(timeoutMs: number): Promise<boolean> {
        if (this.mcp + this.http === 0) return Promise.resolve(true);
        return new Promise(resolve => {
            const done = (drained: boolean) => {
                clearTimeout(timer);
                this.drainWaiters.delete(onDrained);
                resolve(drained);
            };
            const onDrained = () => done(true);
            const timer = setTimeout(() => done(false), timeoutMs);
            timer.unref?.();
            this.drainWaiters.add(onDrained);
        });
    }

    snapshot(now: number = Date.now()): IdleActivity {
        let uiSessions = 0;
        try {
            uiSessions = Math.max(0, this.sessions());
        } catch {
            uiSessions = 0;
        }
        return { uiSessions, mcpRequests: this.mcp, httpRequests: this.http, lastRequestAt: this.lastRequestAt, publishedAt: now };
    }
}

/** Process-wide tracker for the API. */
export const idleActivity = new IdleActivityTracker();

interface ActivityRedis {
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

export function idleActivityKey(role: string, id: string): string {
    return `${IDLE_ACTIVITY_REDIS_PREFIX}${role}:${id}`;
}

export interface IdleActivityPublisher {
    /** Publish now; resolves false when the record could not be written. */
    publish: () => Promise<boolean>;
    stop: () => Promise<void>;
}

/**
 * Publish the tracker on an interval. `stop` removes the key, so a cleanly
 * stopped process does not linger as activity. A failed write is not hidden:
 * the record goes stale and the daemon reads that as unavailable.
 */
export function startIdleActivityPublisher(
    redis: ActivityRedis,
    options: { role: string; id: string; tracker?: IdleActivityTracker; intervalMs?: number },
): IdleActivityPublisher {
    const tracker = options.tracker ?? idleActivity;
    const key = idleActivityKey(options.role, options.id);
    const publish = () => redis.set(key, JSON.stringify(tracker.snapshot()), 'EX', IDLE_ACTIVITY_TTL_SECONDS).then(() => true, () => false);
    void publish();
    tracker.onChange(() => { void publish(); });
    const timer = setInterval(() => { void publish(); }, options.intervalMs ?? IDLE_ACTIVITY_PUBLISH_INTERVAL_MS);
    timer.unref?.();
    return {
        publish,
        stop: async () => {
            clearInterval(timer);
            tracker.onChange(null);
            await redis.del(key).catch(() => undefined);
        },
    };
}
