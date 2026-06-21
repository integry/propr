/**
 * Routing WebSocket intake service.
 *
 * In `routing_websocket` mode (the default GitHub event intake mode, see
 * resolveGithubEventIntakeMode) GitHub events are not polled and are not
 * delivered to a locally-exposed webhook endpoint. Instead the vendor-run
 * routing relay holds the public webhook endpoint and forwards each event to
 * connected ProPR backends over an authenticated WebSocket. This service owns
 * that long-lived connection: it dials the routing origin (PROPR_ROUTING_URL),
 * receives event envelopes, and dispatches them through the same shared webhook
 * handler (`processWebhookEvent`) that the direct webhook path uses — so event
 * handling is identical regardless of how the event arrived.
 *
 * The service is resilient by design: it reconnects with capped exponential
 * backoff, keeps the socket alive with periodic pings, and shuts down cleanly
 * so the daemon can stop it on SIGINT/SIGTERM without leaking sockets or timers.
 */

import logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { processWebhookEvent, SUPPORTED_WEBHOOK_EVENTS, type WebhookEventType } from './webhookHandler.js';

/** Raw frame payload types `ws` can surface on a 'message' event. */
export type RawData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * The minimal slice of the `ws` WebSocket API this service relies on. Declared
 * locally so the service compiles without `@types/ws`; the runtime instance is
 * supplied by the `ws` package via a lazy import in {@link start}.
 */
export interface MinimalWebSocket {
    on(event: 'open', listener: () => void): void;
    on(event: 'message', listener: (data: RawData) => void): void;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'pong', listener: () => void): void;
    ping(): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    readonly readyState: number;
}

export type WebSocketCtor = new (address: string, options?: Record<string, unknown>) => MinimalWebSocket;

/** WebSocket.OPEN — the numeric readyState for an open connection. */
const WS_OPEN = 1;

/**
 * Schemes the `ws` package accepts for a connection address. The routing URL is
 * validated as an https relay origin at boot (validateIntakeModePrerequisites),
 * but the service also self-validates so a misconfigured or directly-constructed
 * instance fails fast with a clear message instead of reconnecting forever
 * against a malformed address.
 */
const ALLOWED_ROUTING_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

/** Normalize any `RawData` frame the `ws` package can emit into a UTF-8 string. */
function rawDataToString(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    // Fragmented frames arrive as an array of Buffer chunks.
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    // ArrayBuffer (or a typed-array view) — wrap without copying the bytes.
    return Buffer.from(data).toString('utf8');
}

/**
 * A single GitHub event forwarded by the routing relay. The relay wraps each
 * GitHub webhook delivery in a small JSON envelope so the event type (normally
 * carried in the `X-GitHub-Event` header) survives the WebSocket hop.
 */
interface RoutingEventEnvelope {
    /** GitHub event type, e.g. `issues`, `pull_request`, `check_run`. */
    eventType?: string;
    /** Alternate field name some relays use for the event type. */
    event?: string;
    /** The GitHub webhook payload. */
    payload?: unknown;
    /** Optional delivery id for correlation/de-duplication. */
    deliveryId?: string;
}

export interface RoutingWebSocketIntakeServiceOptions {
    /**
     * Routing relay WebSocket origin. Defaults to `process.env.PROPR_ROUTING_URL`.
     * Boot-time prerequisite validation (validateIntakeModePrerequisites) already
     * guarantees this is present and valid in routing mode.
     */
    routingUrl?: string;
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
    /**
     * Headers sent on the WebSocket upgrade request so the routing relay can
     * authenticate this backend. Defaults to a Bearer `Authorization` header
     * built from `process.env.PROPR_GH_RELAY_TOKEN` (the durable relay
     * credential) when present. Pass `{}` to send no headers.
     */
    headers?: Record<string, string>;
    /**
     * WebSocket constructor to use. Defaults to a lazy import of the `ws`
     * package; primarily a seam for tests to inject a fake transport.
     */
    webSocketFactory?: WebSocketCtor;
}

/**
 * Build the default upgrade headers from the relay credential. The routing
 * relay shares the relay token (PROPR_GH_RELAY_TOKEN) for authentication, so we
 * present it as a Bearer token when available. Returns an empty object when no
 * token is configured (boot-time validation already requires it in routing mode).
 */
function buildDefaultHeaders(): Record<string, string> {
    const relayToken = process.env.PROPR_GH_RELAY_TOKEN?.trim();
    return relayToken ? { Authorization: `Bearer ${relayToken}` } : {};
}

function isSupportedEventType(value: string): value is WebhookEventType {
    return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export class RoutingWebSocketIntakeService {
    private readonly routingUrl: string;
    private readonly dispatch: (payload: unknown, eventType: WebhookEventType, correlationId: string) => Promise<void>;
    private readonly initialReconnectDelayMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly pingIntervalMs: number;
    private readonly headers: Record<string, string>;
    private readonly webSocketFactory?: WebSocketCtor;

    private socket: MinimalWebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private currentReconnectDelayMs: number;
    private stopped = false;

    constructor(options: RoutingWebSocketIntakeServiceOptions = {}) {
        const routingUrl = options.routingUrl ?? process.env.PROPR_ROUTING_URL ?? '';
        this.routingUrl = routingUrl.trim();
        this.dispatch = options.dispatch ?? processWebhookEvent;
        this.initialReconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
        this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
        this.headers = options.headers ?? buildDefaultHeaders();
        this.webSocketFactory = options.webSocketFactory;
        this.currentReconnectDelayMs = this.initialReconnectDelayMs;
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

        logger.info({ routingUrl: this.routingUrl }, 'Connecting to GitHub event routing WebSocket...');

        let socket: MinimalWebSocket;
        try {
            // Authenticate the upgrade request so the relay accepts this backend.
            const wsOptions = Object.keys(this.headers).length > 0 ? { headers: this.headers } : undefined;
            socket = new WebSocketImpl(this.routingUrl, wsOptions);
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
        const correlationId = generateCorrelationId();
        const correlatedLogger = logger.withCorrelation(correlationId);

        let envelope: RoutingEventEnvelope;
        try {
            envelope = JSON.parse(rawDataToString(data)) as RoutingEventEnvelope;
        } catch (error) {
            correlatedLogger.warn(
                { error: (error as Error).message },
                'Discarding malformed routing message (not valid JSON)',
            );
            return;
        }

        const deliveryId = envelope.deliveryId;
        const rawEventType = (envelope.eventType ?? envelope.event ?? '').trim();
        if (!rawEventType) {
            correlatedLogger.warn({ deliveryId }, 'Discarding routing message with no event type');
            return;
        }
        if (!isSupportedEventType(rawEventType)) {
            correlatedLogger.debug({ eventType: rawEventType, deliveryId }, 'Ignoring unsupported routing event type');
            return;
        }

        try {
            correlatedLogger.debug({ eventType: rawEventType, deliveryId }, 'Dispatching routing event');
            await this.dispatch(envelope.payload, rawEventType, correlationId);
        } catch (error) {
            correlatedLogger.error(
                { error: (error as Error).message, eventType: rawEventType, deliveryId },
                'Failed to process routing event',
            );
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
