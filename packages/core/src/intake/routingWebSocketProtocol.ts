/**
 * Wire-protocol primitives for {@link RoutingWebSocketIntakeService}: the minimal
 * transport interfaces, the relay frame/delivery shapes, and the pure helpers
 * (frame decoding, URL derivation, payload extraction, dedupe bookkeeping) that
 * the service composes. Kept separate from the service so the orchestration class
 * stays focused on connection lifecycle and dispatch.
 */

import { SUPPORTED_WEBHOOK_EVENTS, type WebhookEventType } from '../webhook/webhookHandler.js';

/** Raw frame payload types `ws` can surface on a 'message' event. */
export type RawData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * The minimal slice of the `ws` WebSocket API the intake service relies on.
 * Declared locally so the service compiles without `@types/ws`; the runtime
 * instance is supplied by the `ws` package via a lazy import.
 */
export interface MinimalWebSocket {
    on(event: 'open', listener: () => void): void;
    on(event: 'message', listener: (data: RawData) => void): void;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'pong', listener: () => void): void;
    /** Send a text frame back to the relay (ACK / pong). */
    send(data: string): void;
    ping(): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    readonly readyState: number;
}

export type WebSocketCtor = new (address: string, options?: Record<string, unknown>) => MinimalWebSocket;

/** Minimal `fetch` shape used to pull payloads; matches the global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** WebSocket.OPEN — the numeric readyState for an open connection. */
export const WS_OPEN = 1;

/** Schemes the routing origin may be configured with. */
export const ALLOWED_ROUTING_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

/** Default ceiling for the delivery-id dedupe set. */
export const DEFAULT_MAX_DEDUPE_ENTRIES = 10_000;

/** Default ceiling for the cached installation-token map. */
export const DEFAULT_MAX_TOKEN_ENTRIES = 5_000;

/** Default timeout for pulling a delivery payload over HTTP. */
export const DEFAULT_PULL_TIMEOUT_MS = 15_000;

/** Normalize any `RawData` frame the `ws` package can emit into a UTF-8 string. */
export function rawDataToString(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    // Fragmented frames arrive as an array of Buffer chunks.
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    // ArrayBuffer (or a typed-array view) — wrap without copying the bytes.
    return Buffer.from(data).toString('utf8');
}

/**
 * Bounded, insertion-ordered set of recently-seen delivery ids. Used to drop
 * duplicate deliveries without unbounded memory growth: once the cap is reached,
 * the oldest entries are evicted. Backed by a `Set`, which preserves insertion
 * order so eviction is simply "remove the first key".
 */
export class BoundedDeliverySet {
    private readonly ids = new Set<string>();
    private readonly maxEntries: number;

    /**
     * `maxEntries` is clamped to a minimum of 1: a cap of 0 or a negative number
     * would evict every id the instant it is added, silently disabling dedupe.
     */
    constructor(maxEntries: number) {
        this.maxEntries = Math.max(1, Math.floor(maxEntries));
    }

    has(id: string): boolean {
        return this.ids.has(id);
    }

    add(id: string): void {
        this.ids.add(id);
        while (this.ids.size > this.maxEntries) {
            const oldest = this.ids.values().next().value as string | undefined;
            if (oldest === undefined) break;
            this.ids.delete(oldest);
        }
    }

    delete(id: string): void {
        this.ids.delete(id);
    }

    get size(): number {
        return this.ids.size;
    }
}

/**
 * Tracks delivery ids across their lifecycle to make ACKing safe under
 * redelivery. A delivery is "in flight" while its payload is being resolved and
 * dispatched, and "accepted" once dispatch has succeeded. The two states are
 * deliberately separate: a redelivery that arrives while the first attempt is
 * still in flight must NOT be ACKed (the first attempt may yet fail), whereas a
 * redelivery of an already-accepted delivery is safely re-ACKed without
 * reprocessing. The accepted set is bounded so memory cannot grow without limit.
 */
export class DeliveryTracker {
    private readonly inFlight = new Set<string>();
    private readonly accepted: BoundedDeliverySet;

    constructor(maxAcceptedEntries: number) {
        this.accepted = new BoundedDeliverySet(maxAcceptedEntries);
    }

    isAccepted(id: string): boolean {
        return this.accepted.has(id);
    }

    isInFlight(id: string): boolean {
        return this.inFlight.has(id);
    }

    /** Mark a delivery as being processed. */
    begin(id: string): void {
        this.inFlight.add(id);
    }

    /** Mark a delivery as durably accepted (and no longer in flight). */
    accept(id: string): void {
        this.inFlight.delete(id);
        this.accepted.add(id);
    }

    /** Release a failed delivery so a later redelivery is retried. */
    fail(id: string): void {
        this.inFlight.delete(id);
    }
}

/**
 * Bounded, insertion-ordered map of installation id -> access token. Re-setting a
 * key refreshes its recency; once the cap is reached the oldest entry is evicted,
 * so a long-running multi-tenant daemon cannot accumulate stale tokens forever.
 */
export class BoundedTokenCache {
    private readonly tokens = new Map<string, string>();
    private readonly maxEntries: number;

    /**
     * `maxEntries` is clamped to a minimum of 1: a cap of 0 or a negative number
     * would evict every token the instant it is cached, silently disabling the
     * fallback credential path used for payload pulls.
     */
    constructor(maxEntries: number) {
        this.maxEntries = Math.max(1, Math.floor(maxEntries));
    }

    set(key: string, value: string): void {
        this.tokens.delete(key);
        this.tokens.set(key, value);
        while (this.tokens.size > this.maxEntries) {
            const oldest = this.tokens.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.tokens.delete(oldest);
        }
    }

    get(key: string): string | undefined {
        return this.tokens.get(key);
    }
}

/** A GitHub delivery descriptor carried inside an `event` frame. */
export interface RoutingDelivery {
    /** Unique delivery id (also the GitHub `X-GitHub-Delivery`). */
    deliveryId?: string;
    /** GitHub event type, e.g. `issues`, `pull_request`, `check_run`. */
    eventType?: string;
    /** Alternate field name some relays use for the event type. */
    event?: string;
    /** Installation the delivery belongs to (for token lookup). */
    installationId?: number | string;
    /** Installation access token to authenticate a payload pull. */
    installationToken?: string;
    /** Payload wrapper. `rawPayload` carries the inline GitHub webhook body. */
    payload?: { rawPayload?: unknown } | null;
}

/** A frame received from the routing relay. */
export interface RoutingFrame {
    type?: string;
    /** Monotonic sequence the relay expects echoed back in the ACK. */
    sequence?: number;
    /** Present on `event` frames. */
    delivery?: RoutingDelivery;
    /** Present on `token` frames. */
    installationId?: number | string;
    token?: string;
    /** Present on `error` frames. */
    message?: string;
    code?: string;
    deliveryId?: string;
}

export function isSupportedEventType(value: string): value is WebhookEventType {
    return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Convert a routing origin to the `ws://`/`wss://` connect URL. `http(s)` are
 * mapped to `ws(s)` so a single `PROPR_ROUTING_URL` works for both the socket
 * and the HTTP payload-pull path.
 */
export function buildConnectUrl(routingUrl: string): string {
    const url = new URL(routingUrl);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/connect`;
    return url.toString();
}

/** Convert a routing origin to its HTTP(S) form for payload pulls. */
export function toHttpOrigin(routingUrl: string): string {
    const url = new URL(routingUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.toString().replace(/\/+$/, '');
}

/** Minimal logger slice the payload-pull helper needs (debug-level only). */
export interface PullLogger {
    debug(obj: Record<string, unknown>, msg: string): void;
}

/** Inputs for {@link pullDeliveryPayload}. Grouped to stay within max-params. */
export interface PullDeliveryPayloadOptions {
    /** Routing origin (ws/wss/http/https); converted to its HTTP(S) form. */
    routingUrl: string;
    /** Delivery id to pull (`/v1/delivery/:deliveryId`). */
    deliveryId: string;
    /** Bearer credential authenticating the pull. */
    token: string;
    /** `fetch` implementation to use. */
    fetchImpl: FetchLike;
    /** Abort the request after this many ms. */
    pullTimeoutMs: number;
    /** Correlation-scoped logger. */
    log: PullLogger;
}

/**
 * Pull a delivery payload via `GET ${origin}/v1/delivery/:deliveryId`. Throws on
 * timeout, non-2xx status, or a malformed JSON body — every such failure is the
 * caller's signal to withhold the ACK so the relay can redeliver. Bounds the
 * request with an AbortController whose timer is always cleared, so a slow relay
 * cannot wedge the connection and no timer is left dangling.
 */
export async function pullDeliveryPayload(opts: PullDeliveryPayloadOptions): Promise<unknown> {
    const { routingUrl, deliveryId, token, fetchImpl, pullTimeoutMs, log } = opts;
    const url = `${toHttpOrigin(routingUrl)}/v1/delivery/${encodeURIComponent(deliveryId)}`;
    log.debug({ deliveryId, url }, 'Pulling routing delivery payload');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), pullTimeoutMs);
    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            signal: controller.signal,
        });
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error(`Delivery pull for ${deliveryId} timed out after ${pullTimeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(`Delivery pull for ${deliveryId} failed with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch (err) {
        // A malformed body is a retryable failure: surface it so the caller
        // withholds the ACK rather than dispatching a half-parsed payload.
        throw new Error(`Delivery pull for ${deliveryId} returned an unparseable JSON body: ${(err as Error).message}`);
    }
    return extractPulledPayload(body);
}

/**
 * Extract the GitHub webhook body from a pulled delivery response. The relay may
 * return the body directly, or wrap it as `{ payload: { rawPayload } }` /
 * `{ rawPayload }` (mirroring the inline `event` frame shape).
 */
export function extractPulledPayload(body: unknown): unknown {
    if (body && typeof body === 'object') {
        const obj = body as { rawPayload?: unknown; payload?: { rawPayload?: unknown } | null };
        if (obj.payload?.rawPayload !== undefined && obj.payload.rawPayload !== null) {
            return obj.payload.rawPayload;
        }
        if (obj.rawPayload !== undefined && obj.rawPayload !== null) {
            return obj.rawPayload;
        }
    }
    return body;
}
