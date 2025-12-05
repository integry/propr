import simpleGit from 'simple-git';

export async function ensureGitRepository(logger) {
    try {
        const git = simpleGit();

        const isRepo = await git.checkIsRepo();

        if (!isRepo) {
            logger.warn('Current directory is not a git repository. Initializing...');
            await git.init();
            logger.info('Git repository initialized successfully');
        } else {
            logger.debug('Current directory is a valid git repository');
        }

        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to ensure git repository');
        throw error;
    }
}
