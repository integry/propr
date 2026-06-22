/**
 * Redis keys carrying cross-process runtime status.
 *
 * Centralized here so the daemon (publisher), the API status route, the CLI, and
 * their tests all reference one string instead of duplicating literals that could
 * silently drift out of sync.
 */

/**
 * Routing WebSocket intake runtime state, published by the daemon and read by the
 * API status route / `propr check` to report routing connectivity, last delivery
 * id, and last ACK for the default routing_websocket intake path.
 */
export const ROUTING_STATUS_REDIS_KEY = 'system:status:routing';
