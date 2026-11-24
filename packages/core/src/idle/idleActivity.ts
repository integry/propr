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

export function parseIdleActivity(raw: string | null): IdleActivity | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<IdleActivity>;
        const count = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) && field > 0 ? Math.floor(field) : 0);
        return {
            uiSessions: count(value.uiSessions),
            mcpRequests: count(value.mcpRequests),
            httpRequests: count(value.httpRequests),
            lastRequestAt: count(value.lastRequestAt),
            publishedAt: typeof value.publishedAt === 'number' ? value.publishedAt : 0,
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
        };
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

/**
 * Publish the tracker on an interval. Returns a stop function that removes
 * the key, so a cleanly stopped process does not linger as activity.
 */
export function startIdleActivityPublisher(
    redis: ActivityRedis,
    options: { role: string; id: string; tracker?: IdleActivityTracker; intervalMs?: number },
): () => Promise<void> {
    const tracker = options.tracker ?? idleActivity;
    const key = idleActivityKey(options.role, options.id);
    const publish = () => redis.set(key, JSON.stringify(tracker.snapshot()), 'EX', IDLE_ACTIVITY_TTL_SECONDS).catch(() => undefined);
    void publish();
    tracker.onChange(() => { void publish(); });
    const timer = setInterval(() => { void publish(); }, options.intervalMs ?? IDLE_ACTIVITY_PUBLISH_INTERVAL_MS);
    timer.unref?.();
    return async () => {
        clearInterval(timer);
        tracker.onChange(null);
        await redis.del(key).catch(() => undefined);
    };
}
