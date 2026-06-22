/**
 * Routing WebSocket intake service (daemon side).
 *
 * In `routing_websocket` mode GitHub events are not polled and are not delivered
 * to a locally-exposed webhook endpoint. Instead the vendor-run routing relay
 * (propr-routing) holds the public GitHub webhook endpoint and forwards each
 * delivery to connected ProPR backends over an authenticated WebSocket. This
 * service owns that long-lived connection: it dials `${PROPR_ROUTING_URL}/v1/connect`,
 * receives frames from the relay, materializes the GitHub webhook payload (either
 * inline or by pulling it over HTTP), and dispatches it through the same shared
 * webhook handler (`processWebhookEvent`) that the direct webhook path uses — so
 * event handling is identical regardless of how the event arrived.
 *
 * Protocol summary (relay -> backend frames, each a JSON object with a `type`):
 *   - `event`: a forwarded GitHub delivery. Carries a `sequence`, a `delivery`
 *     descriptor (`deliveryId`, `eventType`, optional `installationId` /
 *     `installationToken`), and either an inline payload at
 *     `delivery.payload.rawPayload` or nothing (the backend then pulls it via
 *     `GET ${PROPR_ROUTING_URL}/v1/delivery/:deliveryId`). The backend ACKs only
 *     after the local webhook handler has accepted (processed) the event.
 *   - `token`: an installation access token pushed out of band. Cached by
 *     installation id and used as a fallback credential when pulling a payload.
 *     May carry an `expiresAt` (epoch ms or ISO-8601); an expired cached token is
 *     treated as a miss, so the relay must refresh it before expiry. GitHub
 *     installation tokens live ~1 hour.
 *   - `error`: a relay-side error notification. Logged; never fatal.
 *   - `ping`: an application-level keepalive. Answered with a `pong` frame.
 *
 * Backend -> relay frames:
 *   - `ack`: `{ type: 'ack', sequence, deliveryId }` — sent only after the local
 *     webhook handler returns, so the relay never advances past an event we have
 *     not durably accepted.
 *   - `pong`: `{ type: 'pong' }` — keepalive response.
 *
 * The service is resilient by design: it reconnects with capped exponential
 * backoff, keeps the socket alive with periodic WebSocket pings, deduplicates
 * deliveries by id with bounded memory, and shuts down cleanly so the daemon can
 * stop it on SIGINT/SIGTERM without leaking sockets or timers.
 */

import { DEFAULT_PROPR_ROUTING_URL } from '@propr/shared';
import logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { processWebhookEvent, type WebhookEventType } from '../webhook/webhookHandler.js';
import {
    BoundedTokenCache,
    DEFAULT_MAX_DEDUPE_ENTRIES,
    DEFAULT_MAX_TOKEN_ENTRIES,
    DEFAULT_PULL_TIMEOUT_MS,
    DeliveryTracker,
    WS_OPEN,
    buildConnectUrl,
    drainWithTimeout,
    isSupportedEventType,
    loadWebSocketCtor,
    parseTokenExpiry,
    rawDataToString,
    resolveDeliveryPayload,
    validateRoutingUrl,
    type FetchLike,
    type MinimalWebSocket,
    type RawData,
    type RoutingFrame,
    type WebSocketCtor,
} from './routingWebSocketProtocol.js';

export type { FetchLike, MinimalWebSocket, RawData, WebSocketCtor } from './routingWebSocketProtocol.js';

export interface RoutingWebSocketIntakeServiceOptions {
    /**
     * Routing relay origin (scheme + host, no path). Defaults to
     * `process.env.PROPR_ROUTING_URL`, then to the hosted relay
     * ({@link DEFAULT_PROPR_ROUTING_URL}). The service owns the paths it appends:
     * it dials `${origin}/v1/connect` as a `ws://`/`wss://` URL and derives the
     * HTTP origin (for payload pulls at `/v1/delivery/:id`) from the same value.
     * A configured path/query/hash is rejected at {@link start}.
     */
    routingUrl?: string;
    /**
     * Relay credential presented on the WebSocket upgrade. Defaults to
     * `process.env.PROPR_GH_RELAY_TOKEN`.
     */
    relayToken?: string;
    /**
     * Event dispatcher. Defaults to the shared {@link processWebhookEvent}, which
     * requires {@link initializeWebhookHandler} to have run first.
     */
    dispatch?: (payload: unknown, eventType: WebhookEventType, correlationId: string) => Promise<void>;
    /** Initial reconnect delay in ms (doubles up to {@link maxReconnectDelayMs}). */
    reconnectDelayMs?: number;
    /** Maximum reconnect backoff delay in ms. */
    maxReconnectDelayMs?: number;
    /** Keepalive ping interval in ms. */
    pingIntervalMs?: number;
    /** Maximum number of delivery ids retained for deduplication. */
    maxDedupeEntries?: number;
    /** Maximum number of installation tokens cached from `token` frames. */
    maxTokenEntries?: number;
    /** Timeout for pulling a delivery payload over HTTP, in ms. */
    pullTimeoutMs?: number;
    /**
     * Maximum time {@link stop} waits to drain in-flight event handling before
     * closing the socket anyway. Bounds shutdown so a wedged `dispatch` (which,
     * unlike a payload pull, has no timeout of its own) cannot block the daemon's
     * SIGINT/SIGTERM handler forever.
     */
    shutdownDrainTimeoutMs?: number;
    /**
     * WebSocket constructor to use. Defaults to a lazy import of the `ws`
     * package; primarily a seam for tests to inject a fake transport.
     */
    webSocketFactory?: WebSocketCtor;
    /** `fetch` implementation for payload pulls; defaults to the global `fetch`. */
    fetchImpl?: FetchLike;
    /**
     * Clock used to stamp the last-ACK time exposed via {@link RoutingWebSocketIntakeService.getStatus}.
     * Defaults to `Date.now`; primarily a seam for deterministic tests.
     */
    now?: () => number;
}

/**
 * Runtime snapshot of the routing intake connection, surfaced so operators can
 * diagnose default (routing_websocket) deployments. Published by the daemon to
 * Redis and rendered by the API status route / CLI.
 */
export interface RoutingWebSocketStatus {
    /** Whether the routing WebSocket is currently connected to the relay. */
    connected: boolean;
    /** The routing relay origin this service dials (PROPR_ROUTING_URL). */
    routingUrl: string;
    /** Delivery id of the most recently ACKed GitHub event, or null if none yet. */
    lastDeliveryId: string | null;
    /** ISO-8601 timestamp of the most recent ACK sent to the relay, or null if none yet. */
    lastAckAt: string | null;
}

export class RoutingWebSocketIntakeService {
    private readonly routingUrl: string;
    private readonly relayToken: string;
    private readonly dispatch: (payload: unknown, eventType: WebhookEventType, correlationId: string) => Promise<void>;
    private readonly initialReconnectDelayMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly pingIntervalMs: number;
    private readonly pullTimeoutMs: number;
    private readonly shutdownDrainTimeoutMs: number;
    private readonly webSocketFactory?: WebSocketCtor;
    private readonly fetchImpl?: FetchLike;
    private readonly now: () => number;

    private socket: MinimalWebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private currentReconnectDelayMs: number;
    private stopped = false;
    /** Guards {@link start} so a second call cannot open a parallel socket. */
    private started = false;

    /**
     * Runtime state exposed via {@link getStatus} so `propr check` and the API
     * status route can report routing connectivity and delivery progress. These
     * are diagnostic only and never affect protocol behavior.
     */
    private connected = false;
    private lastDeliveryId: string | null = null;
    private lastAckAt: number | null = null;

    /**
     * Optional listener notified whenever the diagnostic status changes (connect,
     * disconnect, ACK). Lets the daemon's status publisher refresh the published
     * snapshot immediately instead of only on its periodic timer, so operators are
     * not looking at up-to-30s-stale connectivity/last-ACK state. Best-effort and
     * diagnostic only: a throwing listener never affects protocol behavior.
     */
    private statusChangeListener: (() => void) | null = null;

    /**
     * Event-frame handling in progress. Tracked so {@link stop} can drain accepted
     * work (and let its ACK reach the relay) before the socket is closed, rather
     * than cutting it off mid-flight and relying on relay redelivery.
     */
    private readonly inFlightWork = new Set<Promise<void>>();

    /** Tracks in-flight vs. accepted deliveries to keep ACKing safe under redelivery. */
    private readonly deliveries: DeliveryTracker;
    /** Installation access tokens pushed via `token` frames, keyed by installation. */
    private readonly installationTokens: BoundedTokenCache;

    constructor(options: RoutingWebSocketIntakeServiceOptions = {}) {
        // Falls back to the hosted routing relay (webhook.propr.dev) so the
        // daemon connects out of the box; an explicit routingUrl or
        // PROPR_ROUTING_URL overrides it for self-hosted relays.
        this.routingUrl =
            (options.routingUrl ?? process.env.PROPR_ROUTING_URL ?? DEFAULT_PROPR_ROUTING_URL).trim();
        this.relayToken = (options.relayToken ?? process.env.PROPR_GH_RELAY_TOKEN ?? '').trim();
        this.dispatch = options.dispatch ?? processWebhookEvent;
        this.initialReconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
        this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
        this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
        this.shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? 10_000;
        this.webSocketFactory = options.webSocketFactory;
        this.fetchImpl = options.fetchImpl;
        this.now = options.now ?? Date.now;
        this.currentReconnectDelayMs = this.initialReconnectDelayMs;
        this.deliveries = new DeliveryTracker(options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES);
        this.installationTokens = new BoundedTokenCache(options.maxTokenEntries ?? DEFAULT_MAX_TOKEN_ENTRIES);
    }

    /**
     * Open the routing connection and begin receiving events. Resolves once the
     * initial connection attempt has been kicked off; the service then maintains
     * the connection (including reconnects) in the background until {@link stop}.
     */
    async start(): Promise<void> {
        // Idempotent: a second start() (without an intervening stop()) must not open
        // a parallel socket, which would double-process events and leak the first
        // connection. Guard before any async work so concurrent callers also collapse
        // to a single connection.
        if (this.started) {
            logger.warn('RoutingWebSocketIntakeService.start() called while already started; ignoring');
            return;
        }
        this.started = true;

        try {
            if (!this.routingUrl) {
                throw new Error(
                    'RoutingWebSocketIntakeService requires a routing URL. Set PROPR_ROUTING_URL or pass options.routingUrl.',
                );
            }

            // Fail fast on a malformed/wrong-scheme/path-bearing URL rather than letting
            // `ws` reject it at connect time and reconnecting against it forever.
            validateRoutingUrl(this.routingUrl);

            // The relay rejects an unauthenticated upgrade; surface a clear failure here
            // (boot prerequisites also require PROPR_GH_RELAY_TOKEN, but this guards
            // direct construction and future call sites) instead of looping on 401s.
            if (!this.relayToken) {
                throw new Error(
                    'RoutingWebSocketIntakeService requires a relay token. Set PROPR_GH_RELAY_TOKEN or pass options.relayToken.',
                );
            }

            const WebSocketImpl = await loadWebSocketCtor(this.webSocketFactory);

            this.stopped = false;
            this.connect(WebSocketImpl);
        } catch (error) {
            // Startup failed before a connection was established (bad config, ws import
            // failure). Clear the guard so a corrected retry is possible instead of the
            // service being permanently wedged in a half-started state.
            this.started = false;
            throw error;
        }
    }

    private connect(WebSocketImpl: WebSocketCtor): void {
        if (this.stopped) return;

        const connectUrl = buildConnectUrl(this.routingUrl);
        logger.info({ routingUrl: connectUrl }, 'Connecting to GitHub event routing WebSocket...');

        let socket: MinimalWebSocket;
        try {
            // Authenticate the upgrade request so the relay accepts this backend.
            // start() guarantees a relay token, so the header is always present.
            socket = new WebSocketImpl(connectUrl, {
                headers: { Authorization: `Bearer ${this.relayToken}` },
            });
        } catch (error) {
            logger.error(
                { error: (error as Error).message },
                'Failed to open routing WebSocket connection, will retry',
            );
            this.scheduleReconnect(WebSocketImpl);
            return;
        }

        this.socket = socket;

        socket.on('open', () => {
            this.currentReconnectDelayMs = this.initialReconnectDelayMs;
            this.connected = true;
            logger.info('Routing WebSocket connected. Receiving GitHub events over routing relay.');
            this.startPing();
            this.notifyStatusChange();
        });

        socket.on('message', (data: RawData) => {
            void this.handleMessage(data, socket);
        });

        socket.on('error', (err: Error) => {
            logger.error({ error: err.message }, 'Routing WebSocket error');
        });

        socket.on('close', (code: number) => {
            this.stopPing();
            this.socket = null;
            this.connected = false;
            this.notifyStatusChange();
            if (this.stopped) {
                logger.info('Routing WebSocket closed during shutdown');
                return;
            }
            logger.warn({ code }, 'Routing WebSocket closed, scheduling reconnect');
            this.scheduleReconnect(WebSocketImpl);
        });
    }

    private async handleMessage(data: RawData, socket: MinimalWebSocket): Promise<void> {
        let frame: RoutingFrame;
        try {
            frame = JSON.parse(rawDataToString(data)) as RoutingFrame;
        } catch (error) {
            logger.warn(
                { error: (error as Error).message },
                'Discarding malformed routing frame (not valid JSON)',
            );
            return;
        }

        switch (frame.type) {
            case 'event':
                // Event frames are processed concurrently (a slow payload pull for
                // one delivery must not block others). Ordering is safe because the
                // relay matches each ACK by its `deliveryId`, not by strict sequence
                // advancement — so out-of-order ACKs are acceptable. In-flight
                // duplicate suppression (see handleEventFrame) prevents a redelivery
                // from being processed twice while the first attempt is running.
                // The receiving socket is bound to the work so its ACK is only sent
                // back over the same connection it arrived on.
                await this.trackWork(this.handleEventFrame(frame, socket));
                return;
            case 'token':
                this.handleTokenFrame(frame);
                return;
            case 'error':
                logger.error(
                    { code: frame.code, deliveryId: frame.deliveryId, message: frame.message },
                    'Routing relay reported an error',
                );
                return;
            case 'ping':
                // Echo the relay's nonce; the relay requires a non-empty nonce on
                // pong frames and rejects a nonce-less reply as a malformed frame.
                this.send({ type: 'pong', nonce: frame.nonce }, socket);
                return;
            default:
                logger.debug({ type: frame.type }, 'Ignoring routing frame with unknown type');
        }
    }

    /** Register an event-handling promise so {@link stop} can drain it. */
    private async trackWork(work: Promise<void>): Promise<void> {
        this.inFlightWork.add(work);
        try {
            await work;
        } finally {
            this.inFlightWork.delete(work);
        }
    }

    /** Cache an installation access token pushed by the relay. */
    private handleTokenFrame(frame: RoutingFrame): void {
        const installationId = frame.installationId;
        // The relay names this field `installationToken`; `token` is accepted as a
        // legacy alias so either shape populates the cache.
        const token = frame.installationToken ?? frame.token;
        if (installationId === undefined || !token) {
            logger.warn('Discarding token frame missing installationId or token');
            return;
        }
        // A token frame that carries an expiry we cannot parse is treated as
        // corrupt and dropped: caching it as non-expiring would let a stale
        // credential live forever and cause repeated pull failures, so we wait for
        // a well-formed refresh instead of trusting an unbounded token.
        const expiresAt = parseTokenExpiry(frame.expiresAt);
        if (frame.expiresAt !== undefined && expiresAt === undefined) {
            logger.warn(
                { installationId, expiresAt: frame.expiresAt },
                'Discarding token frame with unparseable expiry',
            );
            return;
        }
        this.installationTokens.set(String(installationId), token, expiresAt);
        logger.debug({ installationId, expiresAt }, 'Cached installation token from routing relay');
    }

    private async handleEventFrame(frame: RoutingFrame, socket: MinimalWebSocket): Promise<void> {
        const correlationId = generateCorrelationId();
        const log = logger.withCorrelation(correlationId);

        const delivery = frame.delivery;
        const deliveryId = delivery?.deliveryId;
        const sequence = frame.sequence;
        if (!delivery || !deliveryId) {
            log.warn({ sequence }, 'Discarding event frame with no delivery id');
            return;
        }

        // The ACK must echo the relay's sequence; without a numeric one we cannot
        // produce a valid ACK, so discard rather than emit a malformed sequence-less
        // ACK. The relay can redeliver with a proper sequence.
        if (typeof sequence !== 'number') {
            log.warn({ deliveryId, sequence }, 'Discarding event frame with no numeric sequence');
            return;
        }

        const rawEventType = (delivery.eventType ?? delivery.event ?? '').trim();
        if (!rawEventType) {
            log.warn({ deliveryId, sequence }, 'Discarding event frame with no event type');
            // ACK so the relay does not redeliver an event we can never handle.
            this.deliveries.accept(deliveryId);
            this.sendAck(sequence, deliveryId, socket);
            return;
        }

        // Already durably accepted: re-ACK (a prior ACK may have been lost) but
        // never reprocess. Refresh the id's dedupe recency so a delivery the relay
        // keeps redelivering does not age out of the bounded accepted set and get
        // reprocessed as if it were new under heavy traffic.
        if (this.deliveries.isAccepted(deliveryId)) {
            log.debug({ deliveryId, sequence }, 'Re-ACKing already-accepted routing delivery');
            this.deliveries.touch(deliveryId);
            this.sendAck(sequence, deliveryId, socket);
            return;
        }

        // A redelivery that arrives while the first attempt is still in flight is
        // dropped WITHOUT an ACK: the first attempt may still fail, and ACKing now
        // would let the relay advance past an event we have not yet accepted. The
        // in-flight attempt sends the ACK if and when it succeeds.
        if (this.deliveries.isInFlight(deliveryId)) {
            log.debug({ deliveryId, sequence }, 'Dropping in-flight duplicate routing delivery (no ACK)');
            return;
        }

        if (!isSupportedEventType(rawEventType)) {
            log.debug({ eventType: rawEventType, deliveryId, sequence }, 'Ignoring unsupported routing event type');
            this.deliveries.accept(deliveryId);
            this.sendAck(sequence, deliveryId, socket);
            return;
        }

        // Reserve the delivery id before processing so a concurrent redelivery is
        // not processed twice. Released on failure so a later redelivery retries.
        this.deliveries.begin(deliveryId);

        let payload: unknown;
        try {
            payload = await resolveDeliveryPayload({
                delivery,
                routingUrl: this.routingUrl,
                tokens: this.installationTokens,
                fetchImpl: this.fetchImpl,
                pullTimeoutMs: this.pullTimeoutMs,
                log,
            });
        } catch (error) {
            this.deliveries.fail(deliveryId);
            log.error(
                { error: (error as Error).message, deliveryId, sequence, eventType: rawEventType },
                'Failed to fetch routing delivery payload; will not ACK (relay may redeliver)',
            );
            return;
        }

        try {
            log.debug({ eventType: rawEventType, deliveryId, sequence }, 'Dispatching routing event');
            await this.dispatch(payload, rawEventType, correlationId);
        } catch (error) {
            this.deliveries.fail(deliveryId);
            log.error(
                { error: (error as Error).message, eventType: rawEventType, deliveryId, sequence },
                'Failed to process routing event; will not ACK (relay may redeliver)',
            );
            return;
        }

        // Mark accepted and ACK only after local acceptance, so the relay never
        // advances past an event the webhook handler has not processed. This is
        // deliberately at-least-once: if sendAck() cannot reach the relay (socket
        // closed, send throws), the delivery stays accepted in memory and is
        // re-ACKed on the next redelivery to THIS instance — but if the process
        // exits first, acceptance is lost and the relay redelivers, so the webhook
        // handler must tolerate a duplicate. Draining in stop() narrows, but does
        // not eliminate, that window (accepted ids are not persisted across restart).
        this.deliveries.accept(deliveryId);
        this.sendAck(sequence, deliveryId, socket);
    }

    /**
     * Send an ACK frame to the relay for an accepted delivery. Records the
     * delivery id and ACK time for {@link getStatus} only when the frame is
     * actually put on the wire, so the reported "last ACK" reflects real progress.
     */
    private sendAck(sequence: number, deliveryId: string, socket: MinimalWebSocket): void {
        if (this.send({ type: 'ack', sequence, deliveryId }, socket)) {
            this.lastDeliveryId = deliveryId;
            this.lastAckAt = this.now();
            this.notifyStatusChange();
        }
    }

    /**
     * Register a listener invoked whenever {@link getStatus} would return a changed
     * snapshot (connect, disconnect, ACK). The daemon's status publisher uses this
     * to refresh the published Redis snapshot promptly rather than waiting for its
     * periodic timer. Only one listener is supported (the publisher); a later call
     * replaces the previous one.
     *
     * Returns an unsubscribe function that detaches *this* listener (and only this
     * one — a no-op if a newer listener has since replaced it), so a consumer like
     * the status publisher can release its closure on stop() instead of the service
     * retaining it indefinitely if it is ever restarted in-process.
     */
    onStatusChange(listener: () => void): () => void {
        this.statusChangeListener = listener;
        return () => {
            if (this.statusChangeListener === listener) {
                this.statusChangeListener = null;
            }
        };
    }

    /** Fire the status-change listener, isolating it from protocol flow. */
    private notifyStatusChange(): void {
        if (!this.statusChangeListener) return;
        try {
            this.statusChangeListener();
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Routing status-change listener threw; ignoring');
        }
    }

    /**
     * Serialize and send a frame to the relay. Sends only when `socket` is still
     * the current connection and open: work that started on a connection which has
     * since dropped/reconnected must not push a (now stale, connection-scoped)
     * `sequence` over the new socket, where the relay could treat it as invalid.
     * Returns true when the frame was handed to the socket.
     */
    private send(frame: Record<string, unknown>, socket: MinimalWebSocket): boolean {
        if (socket !== this.socket || socket.readyState !== WS_OPEN) {
            logger.warn({ type: frame.type }, 'Cannot send routing frame; socket not open or no longer current');
            return false;
        }
        try {
            socket.send(JSON.stringify(frame));
            return true;
        } catch (error) {
            logger.error({ error: (error as Error).message, type: frame.type }, 'Failed to send routing frame');
            return false;
        }
    }

    /**
     * Snapshot of the routing connection for diagnostics. Read by the daemon,
     * which publishes it so the API status route and `propr check` can report
     * whether the default routing intake path is actually receiving and ACKing
     * GitHub events.
     */
    getStatus(): RoutingWebSocketStatus {
        return {
            connected: this.connected,
            routingUrl: this.routingUrl,
            lastDeliveryId: this.lastDeliveryId,
            lastAckAt: this.lastAckAt === null ? null : new Date(this.lastAckAt).toISOString(),
        };
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.socket && this.socket.readyState === WS_OPEN) {
                try {
                    this.socket.ping();
                } catch {
                    // A failed ping surfaces via the socket 'error'/'close' handlers.
                }
            }
        }, this.pingIntervalMs);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(WebSocketImpl: WebSocketCtor): void {
        if (this.stopped || this.reconnectTimer) return;

        const delay = this.currentReconnectDelayMs;
        logger.info({ delayMs: delay }, 'Reconnecting to routing WebSocket after delay');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(WebSocketImpl);
        }, delay);

        // Exponential backoff, capped.
        this.currentReconnectDelayMs = Math.min(this.currentReconnectDelayMs * 2, this.maxReconnectDelayMs);
    }

    /**
     * Stop the service and release all resources (socket, reconnect timer,
     * keepalive timer). Safe to call multiple times. Used by the daemon's
     * SIGINT/SIGTERM handlers for graceful shutdown.
     */
    async stop(): Promise<void> {
        this.stopped = true;
        this.connected = false;
        // Clear the start guard so a deliberate stop()/start() cycle can reconnect.
        this.started = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopPing();

        // Drain in-flight event handling BEFORE closing the socket so a delivery
        // that finishes during shutdown can still send its ACK over the open
        // connection, instead of completing against a null socket and forcing the
        // relay to redeliver (and risk duplicate processing) after restart.
        if (this.inFlightWork.size > 0) {
            logger.info({ inFlight: this.inFlightWork.size }, 'Draining in-flight routing deliveries before shutdown');
            // Bound the drain: a payload pull has its own timeout, but `dispatch`
            // does not, so an indefinitely-hung handler must not block shutdown
            // forever. After the deadline we stop waiting and close the socket; any
            // still-running work loses its ACK window and the relay redelivers.
            await drainWithTimeout([...this.inFlightWork], this.shutdownDrainTimeoutMs, () =>
                logger.warn(
                    { inFlight: this.inFlightWork.size, timeoutMs: this.shutdownDrainTimeoutMs },
                    'Timed out draining in-flight routing deliveries; closing socket anyway',
                ),
            );
        }

        if (this.socket) {
            try {
                this.socket.close(1000, 'shutting down');
            } catch {
                try {
                    this.socket.terminate();
                } catch {
                    // Already closed.
                }
            }
            this.socket = null;
        }

        logger.info('Routing WebSocket intake service stopped');
    }
}
