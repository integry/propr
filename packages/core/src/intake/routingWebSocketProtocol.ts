/**
 * Wire-protocol primitives for {@link RoutingWebSocketIntakeService}: the minimal
 * transport interfaces, the relay frame/delivery shapes, and the pure helpers
 * (frame decoding, URL derivation, payload extraction, dedupe bookkeeping) that
 * the service composes. Kept separate from the service so the orchestration class
 * stays focused on connection lifecycle and dispatch.
 */

import { validateRoutingUrl as validateRoutingUrlPolicy } from '@propr/shared';

import { SUPPORTED_WEBHOOK_EVENTS, type WebhookEventType } from '../webhook/webhookHandler.js';
import { parseWebhookPayload } from './webhookPayload.js';

export { parseWebhookPayload } from './webhookPayload.js';

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

/** Default ceiling for the delivery-id dedupe set. */
export const DEFAULT_MAX_DEDUPE_ENTRIES = 10_000;

/** Default ceiling for the cached installation-token map. */
export const DEFAULT_MAX_TOKEN_ENTRIES = 5_000;

/** Default timeout for pulling a delivery payload over HTTP. */
export const DEFAULT_PULL_TIMEOUT_MS = 15_000;

/**
 * The authoritative disposition ProPR reports for a routed delivery in its ACK
 * frame. ProPR — not the relay — owns this decision; the relay forwards every
 * eligible-looking trigger and records whatever status comes back:
 *   - `accepted`: ProPR has processed / started work on the delivery. May consume
 *     a seat (see {@link DeliveryAckBilling}).
 *   - `blocked`: ProPR would have processed the delivery but policy or capacity
 *     prevented it (e.g. an org over its seat limit). Terminal; visible to admins.
 *   - `ignored`: ProPR deliberately took no action (unsupported event, a user not
 *     allowed to trigger, a passive event). Terminal; consumes no seat.
 * `blocked` and `ignored` are both terminal — the relay must not redeliver — and
 * differ only in intent: `blocked` is "wanted to, couldn't", `ignored` is
 * "nothing to do". A delivery is redelivered ONLY when no ACK is sent at all.
 */
export type DeliveryAckStatus = 'accepted' | 'blocked' | 'ignored';

/** The set of valid {@link DeliveryAckStatus} values, for runtime validation. */
const DELIVERY_ACK_STATUSES: readonly DeliveryAckStatus[] = ['accepted', 'blocked', 'ignored'];

/** Optional billing metadata carried on an ACK frame. */
export interface DeliveryAckBilling {
    /** Whether processing this delivery consumed a seat. Only meaningful for `accepted`. */
    seatConsumed: boolean;
}

/**
 * The disposition ProPR attaches to an ACK. Returned by the webhook dispatcher so
 * the intake service can ACK with an explicit, authoritative status/reason instead
 * of a bare acknowledgement. A dispatcher that returns nothing is treated as a
 * plain {@link ACCEPTED_DISPOSITION} (the common case: the event was processed and
 * no billing/policy signal was produced).
 */
export interface DeliveryDisposition {
    status: DeliveryAckStatus;
    /**
     * Machine-readable reason for the status, primarily for `blocked`/`ignored`
     * (e.g. `user_not_allowed`, `unsupported_event`, `limit_reached`). Surfaced in
     * the relay's delivery history so admins can see *why* a delivery was not acted
     * on instead of it merely showing as DELIVERED.
     */
    reason?: string;
    billing?: DeliveryAckBilling;
}

/** Shared "processed, no billing/policy signal" disposition — the default ACK. */
export const ACCEPTED_DISPOSITION: DeliveryDisposition = Object.freeze({ status: 'accepted' });

/** Shared disposition for an event ProPR cannot or will not handle. */
export const IGNORED_UNSUPPORTED_DISPOSITION: DeliveryDisposition = Object.freeze({
    status: 'ignored',
    reason: 'unsupported_event',
});

/**
 * Coerce an arbitrary dispatcher return value into a {@link DeliveryDisposition}.
 * A dispatcher may return `undefined`/`void` (the legacy and common shape) — that
 * maps to {@link ACCEPTED_DISPOSITION}. A returned object is honored only when it
 * carries a recognized {@link DeliveryAckStatus}; anything else degrades to
 * `accepted` so a malformed dispatcher return can never silently suppress an ACK.
 */
export function normalizeDisposition(outcome: DeliveryDisposition | void | undefined): DeliveryDisposition {
    if (outcome && typeof outcome === 'object') {
        const status = (outcome as DeliveryDisposition).status;
        if (typeof status === 'string' && (DELIVERY_ACK_STATUSES as readonly string[]).includes(status)) {
            return outcome as DeliveryDisposition;
        }
    }
    return ACCEPTED_DISPOSITION;
}

/**
 * Build the backend -> relay ACK frame for an accepted/blocked/ignored delivery.
 * `status` is always present; `reason` and `billing` are included only when the
 * disposition carries them, keeping the wire frame minimal. A relay that predates
 * the explicit-status contract still finds the original `{ type, sequence,
 * deliveryId }` fields and can ignore the rest, so the change is backward
 * compatible.
 */
export function buildAckFrame(
    sequence: number,
    deliveryId: string,
    disposition: DeliveryDisposition,
): Record<string, unknown> {
    const frame: Record<string, unknown> = { type: 'ack', sequence, deliveryId, status: disposition.status };
    if (disposition.reason !== undefined) frame.reason = disposition.reason;
    if (disposition.billing !== undefined) frame.billing = disposition.billing;
    return frame;
}

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
        // Delete-then-add refreshes recency: an id already present is moved to the
        // most-recently-inserted position so it is evicted last. This matches the
        // "recently seen" intent — a delivery that keeps being redelivered stays in
        // the set rather than aging out and risking reprocessing under heavy traffic.
        this.ids.delete(id);
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
 * Bounded, insertion-ordered map of id -> value with the same recency/eviction
 * semantics as {@link BoundedDeliverySet}: re-setting a key refreshes its
 * recency, and once the cap is reached the oldest entry is evicted. Used to
 * remember each accepted delivery's {@link DeliveryDisposition} so a redelivery
 * can be re-ACKed with the SAME status it was first ACKed with, rather than
 * defaulting every re-ACK to `accepted`.
 */
export class BoundedDeliveryMap<V> {
    private readonly entries = new Map<string, V>();
    private readonly maxEntries: number;

    /** `maxEntries` is clamped to a minimum of 1 (see {@link BoundedDeliverySet}). */
    constructor(maxEntries: number) {
        this.maxEntries = Math.max(1, Math.floor(maxEntries));
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    get(id: string): V | undefined {
        return this.entries.get(id);
    }

    set(id: string, value: V): void {
        // Delete-then-set refreshes recency: see BoundedDeliverySet.add.
        this.entries.delete(id);
        this.entries.set(id, value);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    /** Refresh an entry's recency without changing its value; no-op for unknown ids. */
    touch(id: string): void {
        const value = this.entries.get(id);
        if (value !== undefined) this.set(id, value);
    }

    get size(): number {
        return this.entries.size;
    }
}

/**
 * Tracks delivery ids across their lifecycle to make ACKing safe under
 * redelivery. A delivery is "in flight" while its payload is being resolved and
 * dispatched, and "accepted" once dispatch has resolved (with whatever
 * disposition the dispatcher reported — accepted/blocked/ignored). The two
 * states are deliberately separate: a redelivery that arrives while the first
 * attempt is still in flight must NOT be ACKed (the first attempt may yet fail),
 * whereas a redelivery of an already-accepted delivery is safely re-ACKed —
 * with its original disposition — without reprocessing. The accepted map is
 * bounded so memory cannot grow without limit.
 */
export class DeliveryTracker {
    private readonly inFlight = new Set<string>();
    private readonly accepted: BoundedDeliveryMap<DeliveryDisposition>;

    constructor(maxAcceptedEntries: number) {
        this.accepted = new BoundedDeliveryMap(maxAcceptedEntries);
    }

    isAccepted(id: string): boolean {
        return this.accepted.has(id);
    }

    isInFlight(id: string): boolean {
        return this.inFlight.has(id);
    }

    /** The disposition a delivery was first ACKed with, or undefined if not accepted. */
    getDisposition(id: string): DeliveryDisposition | undefined {
        return this.accepted.get(id);
    }

    /** Mark a delivery as being processed. */
    begin(id: string): void {
        this.inFlight.add(id);
    }

    /**
     * Mark a delivery as durably accepted (and no longer in flight), remembering
     * the disposition it was ACKed with so a later redelivery re-ACKs identically.
     */
    accept(id: string, disposition: DeliveryDisposition): void {
        this.inFlight.delete(id);
        this.accepted.set(id, disposition);
    }

    /**
     * Refresh an already-accepted delivery's recency without changing its stored
     * disposition. Used when a duplicate of an accepted delivery is re-ACKed:
     * re-setting moves it to the most-recently-seen position so a frequently-
     * redelivered id is not evicted under heavy traffic and then reprocessed as if
     * it were new. A no-op for unknown ids.
     */
    touch(id: string): void {
        this.accepted.touch(id);
    }

    /** Release a failed delivery so a later redelivery is retried. */
    fail(id: string): void {
        this.inFlight.delete(id);
    }
}

/** A cached installation token together with its optional absolute expiry (epoch ms). */
interface CachedToken {
    token: string;
    /** Epoch-ms expiry; `undefined` means the relay sent no expiry (treated as non-expiring). */
    expiresAt?: number;
}

/**
 * Bounded, insertion-ordered map of installation id -> access token. Re-setting a
 * key refreshes its recency; once the cap is reached the oldest entry is evicted,
 * so a long-running multi-tenant daemon cannot accumulate stale tokens forever.
 *
 * Tokens may carry an absolute expiry (GitHub installation tokens live ~1 hour):
 * an expired entry is treated as a cache miss (and dropped) so a stale credential
 * is never used for a payload pull. The relay is still expected to push a refreshed
 * `token` frame before expiry; the expiry check is the safety net for when it does
 * not. A clock is injectable for deterministic tests.
 */
export class BoundedTokenCache {
    private readonly tokens = new Map<string, CachedToken>();
    private readonly maxEntries: number;
    private readonly now: () => number;

    /**
     * `maxEntries` is clamped to a minimum of 1: a cap of 0 or a negative number
     * would evict every token the instant it is cached, silently disabling the
     * fallback credential path used for payload pulls.
     */
    constructor(maxEntries: number, now: () => number = () => Date.now()) {
        this.maxEntries = Math.max(1, Math.floor(maxEntries));
        this.now = now;
    }

    set(key: string, value: string, expiresAt?: number): void {
        this.tokens.delete(key);
        this.tokens.set(key, { token: value, expiresAt });
        while (this.tokens.size > this.maxEntries) {
            const oldest = this.tokens.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.tokens.delete(oldest);
        }
    }

    get(key: string): string | undefined {
        const entry = this.tokens.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
            // Stale: drop it so we fall through to "no token" rather than pulling
            // with a credential the relay has already rotated.
            this.tokens.delete(key);
            return undefined;
        }
        return entry.token;
    }
}

/**
 * Normalize a relay-supplied token expiry into epoch ms. Accepts an epoch-ms
 * number or an ISO-8601 string; returns `undefined` when no expiry was supplied
 * OR the supplied value is unparseable. Callers that received a value should treat
 * an `undefined` result as "corrupt expiry" (see {@link RoutingWebSocketIntakeService}'s
 * token handler, which drops such a frame rather than caching a token forever),
 * while an absent value legitimately means "non-expiring".
 */
export function parseTokenExpiry(expiresAt: number | string | undefined): number | undefined {
    if (typeof expiresAt === 'number') return Number.isFinite(expiresAt) ? expiresAt : undefined;
    if (typeof expiresAt === 'string') {
        const ms = Date.parse(expiresAt);
        return Number.isNaN(ms) ? undefined : ms;
    }
    return undefined;
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
    /** Installation access token on `token` frames (the relay's field name). */
    installationToken?: string;
    /** Legacy alias for `installationToken` on `token` frames. */
    token?: string;
    /** Optional token expiry on `token` frames (epoch ms or ISO-8601 string). */
    expiresAt?: number | string;
    /** Present on `error` frames. */
    message?: string;
    code?: string;
    deliveryId?: string;
    /** Present on `ping` frames; echoed back in the `pong` reply. */
    nonce?: string;
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

/**
 * Validate a routing origin before the service dials it. Throws an actionable
 * error when the value fails the shared routing-URL policy: unparseable, an
 * insecure non-localhost scheme, or a path/query/hash. The policy itself lives
 * in `@propr/shared` (validateRoutingUrlPolicy) so this dialer and the boot/CLI
 * prerequisite checks agree on exactly one rule — in particular both reject
 * insecure `ws://`/`http://` to anything but localhost, closing the gap where a
 * directly-constructed service could dial an unencrypted non-local origin.
 *
 * The routing URL is an ORIGIN only — the service owns the `/v1/...` paths it
 * appends (connect + payload pull) — so a configured path like `wss://relay/v1`
 * would corrupt the derived URLs (e.g. `/v1/v1/connect`).
 */
export function validateRoutingUrl(routingUrl: string): void {
    const error = validateRoutingUrlPolicy(routingUrl);
    if (error) {
        throw new Error(`RoutingWebSocketIntakeService: ${error} Check PROPR_ROUTING_URL.`);
    }
}

/**
 * Resolve the `ws` WebSocket constructor, preferring an injected factory (the
 * test seam) and otherwise lazy-importing the `ws` package so the dependency is
 * only loaded when routing mode runs. The specifier is referenced indirectly so
 * the bundler/type-checker does not require `@types/ws` for this otherwise-
 * untyped package.
 */
export async function loadWebSocketCtor(factory?: WebSocketCtor): Promise<WebSocketCtor> {
    if (factory) return factory;
    const wsSpecifier = 'ws';
    const wsModule = (await import(wsSpecifier)) as { default?: WebSocketCtor } & Record<string, unknown>;
    const ctor = (wsModule.default ?? (wsModule as unknown)) as WebSocketCtor;
    // The `ws` module is imported untyped (no @types/ws), so a changed export shape
    // would otherwise surface as a cryptic "not a constructor" at the first connect.
    // Verify the resolved value is callable as a constructor here and fail with an
    // actionable message instead.
    if (typeof ctor !== 'function') {
        throw new Error(
            'The "ws" package did not export a WebSocket constructor. Ensure a compatible version of "ws" is installed.',
        );
    }
    return ctor;
}

/**
 * Await all in-flight promises, but no longer than `timeoutMs`. Used at shutdown
 * so a wedged handler (which, unlike a payload pull, has no timeout of its own)
 * cannot block the daemon's signal handler forever. `onTimeout` runs (for
 * logging) when the deadline wins the race; the timer is always cleared.
 */
export async function drainWithTimeout(
    work: Iterable<Promise<unknown>>,
    timeoutMs: number,
    onTimeout: () => void,
): Promise<void> {
    let drainTimer: NodeJS.Timeout | undefined;
    const drained = Promise.allSettled([...work]);
    const timeout = new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
            onTimeout();
            resolve();
        }, timeoutMs);
    });
    await Promise.race([drained, timeout]);
    if (drainTimer) clearTimeout(drainTimer);
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

/** Resolve the credential for a payload pull: frame token, else cached token. */
export function resolveInstallationToken(delivery: RoutingDelivery, tokens: BoundedTokenCache): string | undefined {
    if (delivery.installationToken) return delivery.installationToken;
    if (delivery.installationId !== undefined) {
        return tokens.get(String(delivery.installationId));
    }
    return undefined;
}

/** Inputs for {@link resolveDeliveryPayload}. Grouped to stay within max-params. */
export interface ResolveDeliveryPayloadOptions {
    delivery: RoutingDelivery;
    routingUrl: string;
    tokens: BoundedTokenCache;
    fetchImpl: FetchLike | undefined;
    pullTimeoutMs: number;
    log: PullLogger;
}

/**
 * Materialize the GitHub webhook payload for a delivery: prefer the inline
 * `delivery.payload.rawPayload`, otherwise pull it over HTTP from the relay,
 * resolving the installation credential (frame token, else cached token) and a
 * `fetch` implementation first. Throws if no payload can be produced — the
 * caller's signal to withhold the ACK so the relay can redeliver.
 */
export async function resolveDeliveryPayload(opts: ResolveDeliveryPayloadOptions): Promise<unknown> {
    const { delivery, routingUrl, tokens, fetchImpl, pullTimeoutMs, log } = opts;
    const inline = delivery.payload?.rawPayload;
    if (inline !== undefined && inline !== null) {
        return parseWebhookPayload(inline);
    }

    const deliveryId = delivery.deliveryId as string;
    const token = resolveInstallationToken(delivery, tokens);
    if (!token) {
        throw new Error(`No installation token available to pull delivery ${deliveryId}`);
    }

    const fetcher = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetcher) {
        throw new Error('No fetch implementation available to pull delivery payload');
    }

    const pulled = await pullDeliveryPayload({ routingUrl, deliveryId, token, fetchImpl: fetcher, pullTimeoutMs, log });
    return parseWebhookPayload(pulled);
}
