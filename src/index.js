import logger from './utils/logger.js'; 
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import { withErrorHandling } from './utils/errorHandler.js';
import config from '../config/index.js';

/**
 * Example usage of the authentication and logging system
 */
async function main() {
    logger.info('GitFix application starting', {
        environment: config.environment,
        logLevel: config.logging.level,
    });

    try {
        logger.debug('Testing GitHub authentication...');
        const octokit = await getAuthenticatedOctokit();
        
        // Test the authentication by getting the authenticated app
        const { data: app } = await octokit.request('GET /app');
        logger.info('Successfully authenticated with GitHub', {
            appName: app.name,
            appId: app.id,
        });

        // Example of using the authenticated client
        const { data: repos } = await octokit.request('GET /installation/repositories', {
            per_page: 5,
        });
        
        logger.info('Found repositories', {
            count: repos.total_count,
            repositories: repos.repositories.map(r => r.full_name),
        });

    } catch (error) {
        logger.error('Failed to initialize application', {
            error: error.message,
            stack: error.stack,
        });
        process.exit(1);
    }

    logger.info('GitFix application initialized successfully');
}

// Wrap main function with error handling
const safeMain = withErrorHandling(main, 'main');

// Only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    safeMain();
}

export { main };
 
