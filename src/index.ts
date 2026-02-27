import { logger } from '@propr/core';
import { getAuthenticatedOctokit, withErrorHandling } from '@propr/core';
import config from '../config/index.js';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
});

async function main(): Promise<void> {
    logger.info('ProPR application starting', {
        environment: config.environment,
        logLevel: config.logging.level,
    });

    try {
        logger.debug('Testing GitHub authentication...');
        const octokit = await getAuthenticatedOctokit();

        const { data: app } = await octokit.request('GET /app');
        logger.info('Successfully authenticated with GitHub', {
            appName: app?.name,
            appId: app?.id,
        });

        const { data: repos } = await octokit.request('GET /installation/repositories', {
            per_page: 5,
        });

        logger.info('Found repositories', {
            count: repos.total_count,
            repositories: repos.repositories.map((r: { full_name: string }) => r.full_name),
        });

    } catch (error) {
        const err = error as Error;
        logger.error('Failed to initialize application', {
            error: err.message,
            stack: err.stack,
        });
        process.exit(1);
    }

    logger.info('ProPR application initialized successfully');
}

const safeMain = withErrorHandling(main, 'main');

if (import.meta.url === `file://${process.argv[1]}`) {
    safeMain();
}

export { main };
