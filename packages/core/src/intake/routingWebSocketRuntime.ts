/**
 * Process-level helpers for the routing WebSocket intake service: resolving the
 * `ws` constructor and bounding shutdown drains. Re-exported from
 * routingWebSocketProtocol.ts for existing importers.
 */

import type { WebSocketCtor } from './routingWebSocketProtocol.js';

/**
 * Resolve the `ws` WebSocket constructor, preferring an injected factory (the
 * test seam) and otherwise lazy-importing the `ws` package so the dependency is
 * only loaded when routing mode runs. The specifier is referenced indirectly so
 * the bundler/type-checker does not require `@types/ws` for this otherwise-
 * untyped package.
 */
export async function loadWebSocketCtor(factory?: WebSocketCtor): Promise<WebSocketCtor> {
    if (factory) return factory;
    const wsSpecifier = 'ws';
    const wsModule = (await import(wsSpecifier)) as { default?: WebSocketCtor } & Record<string, unknown>;
    const ctor = (wsModule.default ?? (wsModule as unknown)) as WebSocketCtor;
    // The `ws` module is imported untyped (no @types/ws), so a changed export shape
    // would otherwise surface as a cryptic "not a constructor" at the first connect.
    // Verify the resolved value is callable as a constructor here and fail with an
    // actionable message instead.
    if (typeof ctor !== 'function') {
        throw new Error(
            'The "ws" package did not export a WebSocket constructor. Ensure a compatible version of "ws" is installed.',
        );
    }
    return ctor;
}

/**
 * Await all in-flight promises, but no longer than `timeoutMs`. Used at shutdown
 * so a wedged handler (which, unlike a payload pull, has no timeout of its own)
 * cannot block the daemon's signal handler forever. `onTimeout` runs (for
 * logging) when the deadline wins the race; the timer is always cleared.
 */
export async function drainWithTimeout(
    work: Iterable<Promise<unknown>>,
    timeoutMs: number,
    onTimeout: () => void,
): Promise<void> {
    let drainTimer: NodeJS.Timeout | undefined;
    const drained = Promise.allSettled([...work]);
    const timeout = new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
            onTimeout();
            resolve();
        }, timeoutMs);
    });
    await Promise.race([drained, timeout]);
    if (drainTimer) clearTimeout(drainTimer);
}
