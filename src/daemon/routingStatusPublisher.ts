import type { Redis } from 'ioredis';
import { logger, type RoutingWebSocketIntakeService } from '@propr/core';

/** Redis key carrying the daemon-published routing WebSocket runtime state. */
const ROUTING_STATUS_KEY = 'system:status:routing';
/** TTL so the key disappears shortly after the daemon dies without a clean shutdown. */
const ROUTING_STATUS_TTL_SECONDS = 90;
/** Re-publish cadence; comfortably shorter than the TTL above. */
const PUBLISH_INTERVAL_MS = 30000;

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

    return {
        async stop(): Promise<void> {
            clearInterval(interval);
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
