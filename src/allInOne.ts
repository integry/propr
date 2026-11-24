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
import { logger, setIdleShutdownComposedProcess } from '@propr/core';
import { createBoundedExit, createComponentSupervisor, prepareAllInOneEnvironment, resolveIndexingMode, type StartupStage } from './allInOneConfig.js';
import { flushLogs } from './shared/flushLogs.js';

export interface StartedAllInOne {
    close(): Promise<string[]>;
}

/**
 * Start every component in one process. Components register their close
 * handle as soon as they are up. A signal mid-startup stops any further
 * component from starting, waits (bounded) for the one still starting, and
 * closes it together with whatever already started. The whole stop is
 * bounded too and ends in process.exit (see `createBoundedExit`).
 */
export async function startAllInOne(): Promise<StartedAllInOne> {
    const indexingMode = resolveIndexingMode(process.env.PROPR_INDEXING);
    const defaulted = prepareAllInOneEnvironment(process.env);
    logger.info({ indexingMode, defaulted }, 'Starting ProPR all-in-one control plane');

    // Components close in SHUTDOWN_ORDER (intake, indexing, worker, API), then
    // the process-wide task queue connection shared by all.
    const supervisor = createComponentSupervisor({
        log: {
            info: message => logger.info(message),
            error: (message, error) => logger.error({ error: (error as Error)?.message }, message),
        },
        finalSteps: async () => {
            const core = await import('@propr/core');
            return [{ name: 'shared task queue', close: () => core.shutdownQueue() }];
        },
    });
    const close = (): Promise<string[]> => supervisor.close();
    // Signal and idle shutdown both end here, in a bounded exit.
    const closeAndExit = createBoundedExit({
        close,
        exit: code => process.exit(code),
        pendingStep: () => supervisor.pendingStep,
        log: {
            info: message => logger.info(message),
            error: (message, error) => logger.error({ error: (error as Error | undefined)?.message }, message),
        },
        flush: () => flushLogs(),
    });

    let signalled = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            if (signalled) {
                logger.warn(`all-in-one received a second ${signal}; exiting immediately`);
                process.exit(1);
            }
            signalled = true;
            logger.info(`all-in-one received ${signal}, shutting down gracefully...`);
            closeAndExit();
        });
    }
    // Idle shutdown: the API, worker and indexing worker in this process only
    // acknowledge the daemon's stop request; the daemon then runs this one close.
    setIdleShutdownComposedProcess(true);
    const idleShutdownStop = (): void => {
        logger.info('all-in-one: idle shutdown, closing every component');
        closeAndExit();
    };

    const stages: StartupStage[] = [
        {
            // Migrate once for every component, then tell the later startups so
            // they skip their own (idempotent but redundant) migration pass.
            name: 'database migrations',
            run: async () => {
                const core = await import('@propr/core');
                await core.runMigrations();
                process.env.PROPR_MIGRATIONS_PREAPPLIED = '1';
            },
        },
        {
            // The API (and with it the UI) comes up first: the worker may wait for
            // an agent image build before it claims jobs, and the operator should
            // be able to watch that from the dashboard.
            name: 'api',
            role: 'api',
            run: async () => (await import('../packages/api/server.js')).startApiServer({ installSignalHandlers: false }),
        },
        {
            name: 'daemon',
            role: 'daemon',
            run: async () => (await import('./daemon.js')).startDaemon({ installSignalHandlers: false, closeSharedQueue: false, idleShutdownStop }),
        },
        {
            name: 'worker',
            role: 'worker',
            run: async () => (await import('./worker.js')).startWorker({ installSignalHandlers: false }),
        },
        {
            name: 'pull request status maintenance',
            run: async () => (await import('./jobs/pullRequestStatusSignal.js')).enablePullRequestStatusMaintenance({ backfill: true }),
        },
    ];
    if (indexingMode === 'inline') {
        stages.push({
            name: 'indexing worker',
            role: 'indexing',
            // The main worker already owns the egress proxy sweeper and network policy.
            run: async () => (await import('./indexing_worker.js')).startIndexingWorkerService({ installSignalHandlers: false, ownEgressProxies: false }),
        });
    } else if (indexingMode === 'separate') {
        logger.info('PROPR_INDEXING=separate: run the indexing worker as its own process (npm run indexing-worker)');
    } else {
        logger.info('PROPR_INDEXING=off: repository indexing is disabled');
    }

    if (await supervisor.run(stages)) {
        logger.info({ indexingMode }, 'ProPR all-in-one control plane started');
    }
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
