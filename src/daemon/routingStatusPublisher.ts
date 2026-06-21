import type { Redis } from 'ioredis';
import { logger, type RoutingWebSocketIntakeService } from '@propr/core';
import { ROUTING_STATUS_REDIS_KEY } from '@propr/shared';

/** Redis key carrying the daemon-published routing WebSocket runtime state. */
const ROUTING_STATUS_KEY = ROUTING_STATUS_REDIS_KEY;
/** TTL so the key disappears shortly after the daemon dies without a clean shutdown. */
const ROUTING_STATUS_TTL_SECONDS = 90;
/** Periodic refresh cadence; comfortably shorter than the TTL above. Keeps the key
 *  alive and recovers from a missed change-triggered publish even when the routing
 *  connection is idle. */
const PUBLISH_INTERVAL_MS = 30000;
/** Debounce window for change-triggered publishes, so a burst of ACKs coalesces
 *  into a single Redis write instead of one per delivery. Small enough that
 *  operators see near-immediate freshness. */
const CHANGE_DEBOUNCE_MS = 250;

export interface RoutingStatusPublisher {
    /** Stop publishing and clear the published state so consumers see the path is down. */
    stop(): Promise<void>;
}

/**
 * Publish the routing connection's runtime state to Redis so the API status route
 * (a separate process) and `propr check` can report connectivity, last delivery id,
 * and last ACK for the default routing_websocket intake path.
 */
export async function startRoutingStatusPublisher(
    routingService: RoutingWebSocketIntakeService,
    redis: Redis,
): Promise<RoutingStatusPublisher> {
    const publish = async (): Promise<void> => {
        try {
            await redis.set(
                ROUTING_STATUS_KEY,
                JSON.stringify(routingService.getStatus()),
                'EX',
                ROUTING_STATUS_TTL_SECONDS,
            );
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to publish routing status');
        }
    };

    await publish();
    const interval = setInterval(() => { void publish(); }, PUBLISH_INTERVAL_MS);

    // Publish promptly on connection state changes and ACKs so the operator-facing
    // diagnostics (connected, lastDeliveryId, lastAckAt) are fresh instead of lagging
    // up to one full PUBLISH_INTERVAL_MS behind the actual routing state. Bursts are
    // coalesced through a short debounce to avoid a Redis write per delivery.
    let changeTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    // onStatusChange returns an unsubscribe so stop() can detach this listener from
    // the service. Without it the service would retain this publisher's closure even
    // after stop(), leaking it if the routing service is ever restarted in-process.
    const unsubscribe = routingService.onStatusChange(() => {
        // Ignore late status changes after stop() (e.g. the service emitting a
        // disconnect while it drains) so we never re-publish after clearing the key.
        if (stopped || changeTimer) return;
        changeTimer = setTimeout(() => {
            changeTimer = null;
            void publish();
        }, CHANGE_DEBOUNCE_MS);
    });

    return {
        async stop(): Promise<void> {
            stopped = true;
            clearInterval(interval);
            // Detach from the service so it does not keep this publisher alive.
            if (typeof unsubscribe === 'function') unsubscribe();
            if (changeTimer) {
                clearTimeout(changeTimer);
                changeTimer = null;
            }
            // Clear the published state promptly so status consumers see the routing
            // path is down instead of waiting for the TTL to lapse.
            try {
                await redis.del(ROUTING_STATUS_KEY);
            } catch (error) {
                logger.error({ error: (error as Error).message }, 'Failed to clear routing status on shutdown');
            }
        },
    };
}
