import logger from '../utils/logger.js';
import { parseTokenExpiry, type BoundedTokenCache, type RoutingFrame } from './routingWebSocketProtocol.js';

/** Cache an installation access token pushed by the relay in a `token` frame. */
export function cacheTokenFrame(frame: RoutingFrame, installationTokens: BoundedTokenCache): void {
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
    installationTokens.set(String(installationId), token, expiresAt);
    logger.debug({ installationId, expiresAt }, 'Cached installation token from routing relay');
}
