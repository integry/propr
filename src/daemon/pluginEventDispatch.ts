import { db, logger, PluginDispatcher, prunePluginDeliveries } from '@propr/core';

/**
 * Deliver repository journal events to the plugin handlers subscribed to
 * them. Only the daemon process holding an installation's lease delivers to
 * it, so several daemons can run. Nothing that appends an event waits for a
 * delivery. Returns the stop function for shutdown.
 */
export function startPluginEventDispatch(): () => Promise<void> {
    const dispatcher = new PluginDispatcher({ database: db });
    dispatcher.start();
    logger.info({ owner: dispatcher.owner }, 'Started plugin event dispatcher');
    return () => dispatcher.stop();
}

/** Delete plugin delivery records past their retention. Runs with the hourly journal retention sweep; never throws. */
export async function sweepPluginDeliveries(options: { now?: () => number } = {}): Promise<number> {
    try {
        const deleted = await prunePluginDeliveries(db, { now: options.now });
        if (deleted > 0) logger.info({ deleted }, 'Pruned expired plugin delivery records');
        return deleted;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to prune plugin delivery records');
        return 0;
    }
}
