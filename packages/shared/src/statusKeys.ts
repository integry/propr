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

/** One durable inventory per installation, shared by the workers and status readers. */
export function spritePoolKey(instanceId?: string) {
    const instance = instanceId?.trim();
    return instance ? `propr:sprites:${encodeURIComponent(instance)}:inventory` : 'propr:sprites:inventory';
}

export interface SpritePoolStatus {
    cap: number;
    inUse: number;
    idle: number;
    provisioning: number;
    orphansDeleted: number;
    awaitingCleanup: number;
}

export function spritePoolStatus(inventory: Record<string, string>): SpritePoolStatus | undefined {
    if (!inventory.cap) return undefined;
    const status = { cap: Number(inventory.cap), inUse: 0, idle: 0, provisioning: 0,
        orphansDeleted: Number(inventory.orphansDeleted || 0), awaitingCleanup: 0 };
    for (const [field, phase] of Object.entries(inventory)) {
        if (!field.startsWith('propr-')) continue;
        if (phase === 'inUse' || phase === 'idle' || phase === 'provisioning') status[phase]++;
        else status.awaitingCleanup++;
    }
    return status;
}
