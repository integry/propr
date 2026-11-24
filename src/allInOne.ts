/**
 * `propr all-in-one` — the slim control plane.
 *
 * Runs the daemon (event intake), the main worker, the API (which also serves
 * the built Web UI on the same origin) and, optionally, the repository
 * indexing worker in ONE Node process. Module-level singletons are therefore
 * shared instead of duplicated per process: the SQLite handle, the task queue
 * connection, the worker state manager, config caches and the loaded
 * dependency graph itself. That shared baseline is where most of the memory
 * saving over the multi-container stack comes from.
 *
 *   PROPR_INDEXING=inline    (default) indexing worker in this process
 *   PROPR_INDEXING=separate  run `npm run indexing-worker` alongside instead
 *   PROPR_INDEXING=off       no repository indexing
 *
 * The multi-container stack remains the default deployment; this entry is
 * selected with `npm run all-in-one`, `node dist/src/allInOne.js` in the app
 * image, or the launcher/CLI `minimal` profile.
 */
import 'dotenv/config';
import { logger } from '@propr/core';
import { prepareAllInOneEnvironment, resolveIndexingMode, runShutdownSequence, type ShutdownStep } from './allInOneConfig.js';

export interface StartedAllInOne {
    close(): Promise<string[]>;
}

/**
 * Start every component in one process. Components register their close
 * handle as soon as they are up, so a signal (or a failure) mid-startup still
 * closes whatever already started.
 */
export async function startAllInOne(): Promise<StartedAllInOne> {
    const indexingMode = resolveIndexingMode(process.env.PROPR_INDEXING);
    const defaulted = prepareAllInOneEnvironment(process.env);
    logger.info({ indexingMode, defaulted }, 'Starting ProPR all-in-one control plane');

    // Started components, in START order. Shutdown uses a fixed order instead
    // (see below), so record them by role.
    const handles: Partial<Record<'daemon' | 'worker' | 'indexing' | 'api', ShutdownStep>> = {};
    let closing: Promise<string[]> | undefined;

    const close = (): Promise<string[]> => {
        closing ??= (async () => {
            // 1. Stop intake first: no new GitHub events become jobs.
            // 2. Drain the indexing worker; it does not own the egress proxies.
            // 3. Drain the main worker; its sweeper then closes every egress
            //    proxy in the process, which is why it goes after indexing.
            // 4. Close the API (HTTP, Socket.IO, sessions) last so the UI keeps
            //    reporting state while jobs drain.
            // 5. Close the process-wide task queue connection shared by all.
            const steps = (['daemon', 'indexing', 'worker', 'api'] as const)
                .map(role => handles[role])
                .filter((step): step is ShutdownStep => step !== undefined);
            const core = await import('@propr/core');
            steps.push({ name: 'shared task queue', close: () => core.shutdownQueue() });
            return runShutdownSequence(steps, {
                info: message => logger.info(message),
                error: (message, error) => logger.error({ error: (error as Error)?.message }, message),
            });
        })();
        return closing;
    };

    let signalled = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            if (signalled) {
                logger.warn(`all-in-one received a second ${signal}; exiting immediately`);
                process.exit(1);
            }
            signalled = true;
            logger.info(`all-in-one received ${signal}, shutting down gracefully...`);
            void close().then(failed => process.exit(failed.length > 0 ? 1 : 0));
        });
    }

    // Migrate once for every component, then tell the later startups so they
    // skip their own (idempotent but redundant) migration pass.
    const core = await import('@propr/core');
    await core.runMigrations();
    process.env.PROPR_MIGRATIONS_PREAPPLIED = '1';

    // The API (and with it the UI) comes up first: the worker may wait for an
    // agent image build before it claims jobs, and the operator should be able
    // to watch that from the dashboard.
    const api = await import('../packages/api/server.js');
    const startedApi = await api.startApiServer({ installSignalHandlers: false });
    handles.api = { name: 'api', close: () => startedApi.close() };

    const { startDaemon } = await import('./daemon.js');
    const startedDaemon = await startDaemon({ installSignalHandlers: false, closeSharedQueue: false });
    handles.daemon = { name: 'daemon', close: () => startedDaemon.close() };

    const { startWorker } = await import('./worker.js');
    const startedWorker = await startWorker({ installSignalHandlers: false });
    handles.worker = { name: 'worker', close: () => startedWorker.close() };
    const statusSignal = await import('./jobs/pullRequestStatusSignal.js');
    await statusSignal.enablePullRequestStatusMaintenance({ backfill: true });

    if (indexingMode === 'inline') {
        const { startIndexingWorkerService } = await import('./indexing_worker.js');
        // The main worker already owns the egress proxy sweeper and network policy.
        const indexing = await startIndexingWorkerService({ installSignalHandlers: false, ownEgressProxies: false });
        handles.indexing = { name: 'indexing worker', close: () => indexing.close() };
    } else if (indexingMode === 'separate') {
        logger.info('PROPR_INDEXING=separate: run the indexing worker as its own process (npm run indexing-worker)');
    } else {
        logger.info('PROPR_INDEXING=off: repository indexing is disabled');
    }

    logger.info({ indexingMode }, 'ProPR all-in-one control plane started');
    return { close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`
ProPR all-in-one control plane

Runs the daemon, worker and API (serving the Web UI) in one Node process.

Usage: node dist/src/allInOne.js

Environment:
  PROPR_INDEXING      inline (default) | separate | off
  PROPR_SERVE_UI      1 (default) serves propr-ui/dist from the API; 0 disables
  PROPR_UI_DIST_DIR   explicit UI bundle directory
  FRONTEND_URL        defaults to API_PUBLIC_URL (same origin)
`);
        process.exit(0);
    }
    startAllInOne().catch(error => {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'All-in-one startup failed');
        process.exit(1);
    });
}
