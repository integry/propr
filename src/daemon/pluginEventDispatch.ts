import { db, logger, PluginCommandRunner, PluginDispatcher, prunePluginDeliveries } from '@propr/core';

/**
 * Deliver repository journal events to the plugin handlers subscribed to
 * them, and `handler` slash commands to their plugin's handler. Only the
 * daemon process holding an installation's lease delivers its events, and
 * each command attempt is claimed by one runner, so several daemons can run.
 * Nothing that appends an event waits for a delivery. Returns the stop
 * function for shutdown.
 */
export function startPluginEventDispatch(): () => Promise<void> {
    const dispatcher = new PluginDispatcher({ database: db });
    const commands = new PluginCommandRunner({ database: db });
    dispatcher.start();
    commands.start();
    logger.info({ owner: dispatcher.owner, commands: commands.owner }, 'Started plugin event dispatcher and command runner');
    return async () => { await Promise.all([dispatcher.stop(), commands.stop()]); };
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
