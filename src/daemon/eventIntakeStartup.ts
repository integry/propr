import type { GithubEventIntakeMode } from '@propr/shared';
import type { RoutingWebSocketIntakeService } from '@propr/core';
import type { RoutingStatusPublisher } from './routingStatusPublisher.js';

/**
 * The daemon's GitHub event-intake startup, extracted as a small, dependency-injected
 * function so the central mode switch can be exercised without standing up real Redis,
 * GitHub, or WebSocket connections.
 *
 * The mode is the single behavior switch for this feature:
 *   polling           — pull issues from the GitHub API on an interval (no webhook handler)
 *   direct_webhook    — register the shared webhook handler; events arrive at the local endpoint
 *   routing_websocket — register the shared webhook handler and open the routing WebSocket
 *
 * Each branch starts only its intended components; this is what the unit tests assert.
 */

/** Minimal structured-logger shape; defaults to a no-op so the function is silent under test. */
export interface EventIntakeLogger {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
}

const noopLogger: EventIntakeLogger = { info: () => {}, warn: () => {} };

export interface EventIntakeStartupDeps {
    /** Run a single polling cycle (already wrapped with error handling). */
    safePoll: () => void;
    /** Polling cadence in ms; the recurring poll is scheduled at this rate in polling mode. */
    pollingIntervalMs: number;
    /** Schedules the recurring poll. Injectable so tests can assert scheduling without real timers. */
    scheduleInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
    /** Initializes the shared webhook handler (used by both direct_webhook and routing_websocket). */
    initWebhookHandler: () => Promise<void>;
    /** Constructs the routing WebSocket intake service (routing_websocket only). */
    createRoutingService: () => RoutingWebSocketIntakeService;
    /** Starts publishing routing status to Redis (routing_websocket only). */
    startRoutingStatusPublisher: (service: RoutingWebSocketIntakeService) => Promise<RoutingStatusPublisher>;
    /** Optional structured logger; defaults to a no-op. */
    logger?: EventIntakeLogger;
    /** Base fields merged into the startup log line. */
    startupLogContext?: Record<string, unknown>;
    /** Whether the webhook signing secret is configured (used for a direct_webhook warning/log only). */
    webhookSecretConfigured?: boolean;
    /** Routing relay URL, surfaced in the routing_websocket startup log only. */
    routingUrl?: string;
}

export interface EventIntakeStartupResult {
    /** Polling interval handle (polling mode only), else null. */
    intervalId: NodeJS.Timeout | null;
    /** Routing service instance (routing_websocket mode only), else null. */
    routingService: RoutingWebSocketIntakeService | null;
    /** Routing status publisher (routing_websocket mode only), else null. */
    routingStatusPublisher: RoutingStatusPublisher | null;
}

/**
 * Start the components for the resolved event-intake mode and return the handles the
 * daemon needs for shutdown. Only the components for the given mode are started.
 */
export async function startEventIntake(
    mode: GithubEventIntakeMode,
    deps: EventIntakeStartupDeps,
): Promise<EventIntakeStartupResult> {
    const log = deps.logger ?? noopLogger;
    const scheduleInterval = deps.scheduleInterval ?? setInterval;
    const baseLog = deps.startupLogContext ?? {};

    const result: EventIntakeStartupResult = {
        intervalId: null,
        routingService: null,
        routingStatusPublisher: null,
    };

    switch (mode) {
        case 'polling': {
            log.info({
                ...baseLog,
                pollingInterval: deps.pollingIntervalMs,
            }, 'GitHub Issue Detection Daemon starting in polling mode...');

            deps.safePoll();
            result.intervalId = scheduleInterval(deps.safePoll, deps.pollingIntervalMs);
            break;
        }

        case 'direct_webhook': {
            log.info({
                ...baseLog,
                webhookEnabled: true,
                webhookSecretConfigured: !!deps.webhookSecretConfigured,
            }, 'GitHub Issue Detection Daemon starting in direct webhook mode...');

            if (!deps.webhookSecretConfigured) {
                log.warn('GH_WEBHOOK_SECRET is not set! Webhook signature verification will be skipped.');
            }

            await deps.initWebhookHandler();
            log.info('Webhook handler initialized. Webhooks will be received by dashboard API service.');
            break;
        }

        case 'routing_websocket': {
            log.info({
                ...baseLog,
                routingUrl: deps.routingUrl || 'not configured',
            }, 'GitHub Issue Detection Daemon starting in routing WebSocket mode...');

            // The routing relay forwards events into the same shared handler, so
            // initialize it before opening the connection to avoid dropping events.
            await deps.initWebhookHandler();
            log.info('Webhook handler initialized. GitHub events will be received over the routing WebSocket.');

            const routingService = deps.createRoutingService();
            await routingService.start();
            result.routingService = routingService;
            result.routingStatusPublisher = await deps.startRoutingStatusPublisher(routingService);
            break;
        }
    }

    return result;
}
