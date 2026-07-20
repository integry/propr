import logger from '../utils/logger.js';
import { type MinimalWebSocket, WS_OPEN } from './routingWebSocketProtocol.js';

const DEFAULT_PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PONG_TIMEOUT_MS = 30 * 1000;

function parsePositiveIntegerEnv(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const trimmed = value.trim();
    // Require a whole-string positive integer so values like `50abc` or `1.5`
    // are rejected rather than silently coerced to `50`/`1`.
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveRoutingPingIntervalMs(optionValue: number | undefined): number {
    return optionValue ?? parsePositiveIntegerEnv('PROPR_ROUTING_WS_PING_INTERVAL_MS') ?? DEFAULT_PING_INTERVAL_MS;
}

export function resolveRoutingPongTimeoutMs(optionValue: number | undefined): number {
    return optionValue ?? parsePositiveIntegerEnv('PROPR_ROUTING_WS_PONG_TIMEOUT_MS') ?? DEFAULT_PONG_TIMEOUT_MS;
}

interface RoutingWebSocketKeepaliveOptions {
    pingIntervalMs: number;
    pongTimeoutMs: number;
    isCurrentSocket: (socket: MinimalWebSocket) => boolean;
    onStaleConnection: () => void;
}

export class RoutingWebSocketKeepalive {
    private readonly pingIntervalMs: number;
    private readonly pongTimeoutMs: number;
    private readonly isCurrentSocket: (socket: MinimalWebSocket) => boolean;
    private readonly onStaleConnection: () => void;

    private pingTimer: NodeJS.Timeout | null = null;
    private pongDeadlineTimer: NodeJS.Timeout | null = null;

    constructor(options: RoutingWebSocketKeepaliveOptions) {
        this.pingIntervalMs = options.pingIntervalMs;
        this.pongTimeoutMs = options.pongTimeoutMs;
        this.isCurrentSocket = options.isCurrentSocket;
        this.onStaleConnection = options.onStaleConnection;
    }

    start(socket: MinimalWebSocket): void {
        this.stop();
        this.pingTimer = setInterval(() => {
            if (!this.isCurrentSocket(socket) || socket.readyState !== WS_OPEN) return;

            // Do not let a short custom ping interval continually postpone the
            // deadline for an unanswered ping. One outstanding ping is enough to
            // establish whether this TCP/WebSocket connection is still alive.
            if (this.pongDeadlineTimer) return;

            this.pongDeadlineTimer = setTimeout(() => {
                this.pongDeadlineTimer = null;
                if (!this.isCurrentSocket(socket) || socket.readyState !== WS_OPEN) return;
                logger.warn(
                    { pongTimeoutMs: this.pongTimeoutMs },
                    'Routing WebSocket pong deadline expired; terminating stale connection',
                );
                this.onStaleConnection();
                try {
                    // `ws.terminate()` emits `close`, whose existing handler owns
                    // reconnect scheduling and cleanup.
                    socket.terminate();
                } catch (error) {
                    logger.error(
                        { error: (error as Error).message },
                        'Failed to terminate stale routing WebSocket',
                    );
                }
            }, this.pongTimeoutMs);

            try {
                socket.ping();
            } catch (error) {
                this.clearPongDeadline();
                logger.warn(
                    { error: (error as Error).message },
                    'Routing WebSocket ping failed; terminating connection',
                );
                this.onStaleConnection();
                try {
                    socket.terminate();
                } catch {
                    // The socket is already unusable; its close handler normally
                    // owns reconnect scheduling.
                }
            }
        }, this.pingIntervalMs);
    }

    clearPongDeadline(): void {
        if (this.pongDeadlineTimer) {
            clearTimeout(this.pongDeadlineTimer);
            this.pongDeadlineTimer = null;
        }
    }

    stop(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        this.clearPongDeadline();
    }
}
