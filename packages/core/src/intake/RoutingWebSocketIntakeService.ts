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

import logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { processWebhookEvent, type WebhookEventType } from '../webhook/webhookHandler.js';
import {
    ALLOWED_ROUTING_PROTOCOLS,
    BoundedDeliverySet,
    DEFAULT_MAX_DEDUPE_ENTRIES,
    DEFAULT_PULL_TIMEOUT_MS,
    WS_OPEN,
    buildConnectUrl,
    extractPulledPayload,
    isSupportedEventType,
    rawDataToString,
    toHttpOrigin,
    type FetchLike,
    type MinimalWebSocket,
    type RawData,
    type RoutingDelivery,
    type RoutingFrame,
    type WebSocketCtor,
} from './routingWebSocketProtocol.js';

export type { FetchLike, MinimalWebSocket, RawData, WebSocketCtor } from './routingWebSocketProtocol.js';

export interface RoutingWebSocketIntakeServiceOptions {
    /**
     * Routing relay origin. Defaults to `process.env.PROPR_ROUTING_URL`. The
     * service appends `/v1/connect` and dials it as a `ws://`/`wss://` URL, and
     * derives the HTTP origin (for payload pulls) from the same value.
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
    /** Timeout for pulling a delivery payload over HTTP, in ms. */
    pullTimeoutMs?: number;
    /**
     * WebSocket constructor to use. Defaults to a lazy import of the `ws`
     * package; primarily a seam for tests to inject a fake transport.
     */
    webSocketFactory?: WebSocketCtor;
    /** `fetch` implementation for payload pulls; defaults to the global `fetch`. */
    fetchImpl?: FetchLike;
}

export class RoutingWebSocketIntakeService {
    private readonly routingUrl: string;
    private readonly relayToken: string;
    private readonly dispatch: (payload: unknown, eventType: WebhookEventType, correlationId: string) => Promise<void>;
    private readonly initialReconnectDelayMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly pingIntervalMs: number;
    private readonly pullTimeoutMs: number;
    private readonly webSocketFactory?: WebSocketCtor;
    private readonly fetchImpl?: FetchLike;

    private socket: MinimalWebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private currentReconnectDelayMs: number;
    private stopped = false;

    /** Delivery ids that have been accepted locally — duplicates are dropped. */
    private readonly seenDeliveries: BoundedDeliverySet;
    /** Installation access tokens pushed via `token` frames, keyed by installation. */
    private readonly installationTokens = new Map<string, string>();

    constructor(options: RoutingWebSocketIntakeServiceOptions = {}) {
        this.routingUrl = (options.routingUrl ?? process.env.PROPR_ROUTING_URL ?? '').trim();
        this.relayToken = (options.relayToken ?? process.env.PROPR_GH_RELAY_TOKEN ?? '').trim();
        this.dispatch = options.dispatch ?? processWebhookEvent;
        this.initialReconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
        this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
        this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
        this.webSocketFactory = options.webSocketFactory;
        this.fetchImpl = options.fetchImpl;
        this.currentReconnectDelayMs = this.initialReconnectDelayMs;
        this.seenDeliveries = new BoundedDeliverySet(options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES);
    }

    /**
     * Open the routing connection and begin receiving events. Resolves once the
     * initial connection attempt has been kicked off; the service then maintains
     * the connection (including reconnects) in the background until {@link stop}.
     */
    async start(): Promise<void> {
        if (!this.routingUrl) {
            throw new Error(
                'RoutingWebSocketIntakeService requires a routing URL. Set PROPR_ROUTING_URL or pass options.routingUrl.',
            );
        }

        // Fail fast on a malformed/wrong-scheme URL rather than letting `ws`
        // reject it at connect time and reconnecting against it forever.
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(this.routingUrl);
        } catch {
            throw new Error(
                `RoutingWebSocketIntakeService routing URL ("${this.routingUrl}") is not a valid URL. ` +
                    'Set PROPR_ROUTING_URL to a ws://, wss://, http://, or https:// origin.',
            );
        }
        if (!ALLOWED_ROUTING_PROTOCOLS.includes(parsedUrl.protocol)) {
            throw new Error(
                `RoutingWebSocketIntakeService routing URL must use ws://, wss://, http://, or https:// ` +
                    `(got "${parsedUrl.protocol}//"). Check PROPR_ROUTING_URL.`,
            );
        }

        // Lazy-load `ws` so the dependency is only needed when routing mode runs,
        // and reference the specifier indirectly so the bundler/type-checker does
        // not require `@types/ws` for this otherwise-untyped package. Tests inject
        // a fake transport via options.webSocketFactory.
        let WebSocketImpl = this.webSocketFactory;
        if (!WebSocketImpl) {
            const wsSpecifier = 'ws';
            const wsModule = (await import(wsSpecifier)) as { default?: WebSocketCtor } & Record<string, unknown>;
            WebSocketImpl = (wsModule.default ?? (wsModule as unknown)) as WebSocketCtor;
        }

        this.stopped = false;
        this.connect(WebSocketImpl);
    }

    private connect(WebSocketImpl: WebSocketCtor): void {
        if (this.stopped) return;

        const connectUrl = buildConnectUrl(this.routingUrl);
        logger.info({ routingUrl: connectUrl }, 'Connecting to GitHub event routing WebSocket...');

        let socket: MinimalWebSocket;
        try {
            // Authenticate the upgrade request so the relay accepts this backend.
            const headers = this.relayToken ? { Authorization: `Bearer ${this.relayToken}` } : {};
            const wsOptions = Object.keys(headers).length > 0 ? { headers } : undefined;
            socket = new WebSocketImpl(connectUrl, wsOptions);
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
            logger.info('Routing WebSocket connected. Receiving GitHub events over routing relay.');
            this.startPing();
        });

        socket.on('message', (data: RawData) => {
            void this.handleMessage(data);
        });

        socket.on('error', (err: Error) => {
            logger.error({ error: err.message }, 'Routing WebSocket error');
        });

        socket.on('close', (code: number) => {
            this.stopPing();
            this.socket = null;
            if (this.stopped) {
                logger.info('Routing WebSocket closed during shutdown');
                return;
            }
            logger.warn({ code }, 'Routing WebSocket closed, scheduling reconnect');
            this.scheduleReconnect(WebSocketImpl);
        });
    }

    private async handleMessage(data: RawData): Promise<void> {
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
                await this.handleEventFrame(frame);
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
                this.send({ type: 'pong' });
                return;
            default:
                logger.debug({ type: frame.type }, 'Ignoring routing frame with unknown type');
        }
    }

    /** Cache an installation access token pushed by the relay. */
    private handleTokenFrame(frame: RoutingFrame): void {
        const installationId = frame.installationId;
        const token = frame.token;
        if (installationId === undefined || !token) {
            logger.warn('Discarding token frame missing installationId or token');
            return;
        }
        this.installationTokens.set(String(installationId), token);
        logger.debug({ installationId }, 'Cached installation token from routing relay');
    }

    private async handleEventFrame(frame: RoutingFrame): Promise<void> {
        const correlationId = generateCorrelationId();
        const log = logger.withCorrelation(correlationId);

        const delivery = frame.delivery;
        const deliveryId = delivery?.deliveryId;
        const sequence = frame.sequence;
        if (!delivery || !deliveryId) {
            log.warn({ sequence }, 'Discarding event frame with no delivery id');
            return;
        }

        const rawEventType = (delivery.eventType ?? delivery.event ?? '').trim();
        if (!rawEventType) {
            log.warn({ deliveryId, sequence }, 'Discarding event frame with no event type');
            // ACK so the relay does not redeliver an event we can never handle.
            this.sendAck(sequence, deliveryId);
            return;
        }

        // Duplicate suppression: a delivery we have already accepted is ACKed again
        // (the relay may resend if a prior ACK was lost) but never reprocessed.
        if (this.seenDeliveries.has(deliveryId)) {
            log.debug({ deliveryId, sequence }, 'Ignoring duplicate routing delivery');
            this.sendAck(sequence, deliveryId);
            return;
        }

        if (!isSupportedEventType(rawEventType)) {
            log.debug({ eventType: rawEventType, deliveryId, sequence }, 'Ignoring unsupported routing event type');
            this.seenDeliveries.add(deliveryId);
            this.sendAck(sequence, deliveryId);
            return;
        }

        // Reserve the delivery id before processing so a concurrent redelivery is
        // not processed twice. Released on failure so a later redelivery retries.
        this.seenDeliveries.add(deliveryId);

        let payload: unknown;
        try {
            payload = await this.resolvePayload(delivery, log);
        } catch (error) {
            this.seenDeliveries.delete(deliveryId);
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
            this.seenDeliveries.delete(deliveryId);
            log.error(
                { error: (error as Error).message, eventType: rawEventType, deliveryId, sequence },
                'Failed to process routing event; will not ACK (relay may redeliver)',
            );
            return;
        }

        // ACK only after local acceptance, so the relay never advances past an
        // event the webhook handler has not processed.
        this.sendAck(sequence, deliveryId);
    }

    /**
     * Materialize the GitHub webhook payload for a delivery: prefer the inline
     * `delivery.payload.rawPayload`, otherwise pull it over HTTP from the relay.
     */
    private async resolvePayload(delivery: RoutingDelivery, log: ReturnType<typeof logger.withCorrelation>): Promise<unknown> {
        const inline = delivery.payload?.rawPayload;
        if (inline !== undefined && inline !== null) {
            return inline;
        }
        return this.pullPayload(delivery, log);
    }

    /** Pull a delivery payload via `GET ${origin}/v1/delivery/:deliveryId`. */
    private async pullPayload(delivery: RoutingDelivery, log: ReturnType<typeof logger.withCorrelation>): Promise<unknown> {
        const deliveryId = delivery.deliveryId as string;
        const token = this.resolveInstallationToken(delivery);
        if (!token) {
            throw new Error(`No installation token available to pull delivery ${deliveryId}`);
        }

        const fetchImpl = this.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
        if (!fetchImpl) {
            throw new Error('No fetch implementation available to pull delivery payload');
        }

        const url = `${toHttpOrigin(this.routingUrl)}/v1/delivery/${encodeURIComponent(deliveryId)}`;
        log.debug({ deliveryId, url }, 'Pulling routing delivery payload');

        // Bound the pull with an AbortController whose timer is always cleared, so
        // a slow relay cannot wedge the connection and no timer is left dangling.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.pullTimeoutMs);
        let response: Response;
        try {
            response = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                },
                signal: controller.signal,
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error(`Delivery pull for ${deliveryId} timed out after ${this.pullTimeoutMs}ms`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            throw new Error(`Delivery pull for ${deliveryId} failed with HTTP ${response.status}`);
        }

        const body = (await response.json()) as unknown;
        return extractPulledPayload(body);
    }

    /** Resolve the credential for a payload pull: frame token, else cached token. */
    private resolveInstallationToken(delivery: RoutingDelivery): string | undefined {
        if (delivery.installationToken) return delivery.installationToken;
        if (delivery.installationId !== undefined) {
            return this.installationTokens.get(String(delivery.installationId));
        }
        return undefined;
    }

    /** Send an ACK frame to the relay for an accepted delivery. */
    private sendAck(sequence: number | undefined, deliveryId: string): void {
        this.send({ type: 'ack', sequence, deliveryId });
    }

    /** Serialize and send a frame to the relay if the socket is open. */
    private send(frame: Record<string, unknown>): void {
        if (!this.socket || this.socket.readyState !== WS_OPEN) {
            logger.warn({ type: frame.type }, 'Cannot send routing frame; socket not open');
            return;
        }
        try {
            this.socket.send(JSON.stringify(frame));
        } catch (error) {
            logger.error({ error: (error as Error).message, type: frame.type }, 'Failed to send routing frame');
        }
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

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopPing();

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
