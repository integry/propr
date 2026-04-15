import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

const log = logger;

/**
 * Tables that contain repository references and need migration when a repo is renamed.
 */
const TABLES_WITH_REPOSITORY = [
    { table: 'task_drafts', column: 'repository' },
    { table: 'plan_issues', column: 'repository' },
    { table: 'tasks', column: 'repository' },
    { table: 'llm_logs', column: 'repository' },
    { table: 'repo_chat_messages', column: 'repository' },
    { table: 'repo_todo_categories', column: 'repository' },
    { table: 'repo_todos', column: 'repository' },
] as const;

/**
 * Tables where the repository name is embedded in a path column (e.g., "owner/repo/path/to/file").
 * These require prefix replacement instead of exact match.
 */
const TABLES_WITH_PATH_PREFIX = [
    { table: 'file_summaries', column: 'path' },
    { table: 'directory_summaries', column: 'path' },
] as const;

/**
 * The repositories table uses full_name as a composite primary key,
 * which requires special handling during migration.
 */
const REPOSITORIES_TABLE = {
    table: 'repositories',
    column: 'full_name',
} as const;

export interface RepositoryRenameResult {
    detected: boolean;
    oldName?: string;
    newName?: string;
    migrated?: boolean;
    error?: string;
}

export interface MigrationResult {
    success: boolean;
    tablesUpdated: string[];
    rowsAffected: number;
    error?: string;
}

/**
 * Checks if a repository has been renamed by comparing the requested name
 * with the actual name returned by the GitHub API.
 *
 * GitHub automatically redirects requests for renamed repositories to the new name,
 * and the response contains the current (new) repository name.
 */
export async function detectRepositoryRename(
    requestedRepository: string
): Promise<{ renamed: boolean; currentName: string }> {
    const [owner, repo] = requestedRepository.split('/');

    if (!owner || !repo) {
        throw new Error(`Invalid repository format: ${requestedRepository}`);
    }

    try {
        const octokit = await getAuthenticatedOctokit();
        const response = await octokit.request('GET /repos/{owner}/{repo}', {
            owner,
            repo,
        });

        const currentName = response.data.full_name;
        const renamed = currentName.toLowerCase() !== requestedRepository.toLowerCase();

        if (renamed) {
            log.info({
                requestedRepository,
                currentName,
            }, 'Repository rename detected');
        }

        return { renamed, currentName };
    } catch (error) {
        const err = error as Error & { status?: number };

        // 404 means the repo doesn't exist (not just renamed)
        if (err.status === 404) {
            log.warn({ requestedRepository }, 'Repository not found');
            throw new Error(`Repository not found: ${requestedRepository}`);
        }

        throw error;
    }
}

/**
 * Migrates all database references from an old repository name to a new one.
 * This should be called when a repository rename is detected.
 */
export async function migrateRepositoryReferences(
    oldRepository: string,
    newRepository: string
): Promise<MigrationResult> {
    const tablesUpdated: string[] = [];
    let totalRowsAffected = 0;

    log.info({
        oldRepository,
        newRepository,
    }, 'Starting repository migration');

    try {
        await db.transaction(async (trx) => {
            // Migrate standard tables with repository column
            for (const { table, column } of TABLES_WITH_REPOSITORY) {
                try {
                    const result = await trx(table)
                        .where(column, oldRepository)
                        .update({ [column]: newRepository });

                    if (result > 0) {
                        tablesUpdated.push(table);
                        totalRowsAffected += result;
                        log.info({
                            table,
                            column,
                            rowsUpdated: result,
                        }, 'Migrated table');
                    }
                } catch (tableError) {
                    // Table might not exist in some environments, log and continue
                    log.warn({
                        table,
                        error: (tableError as Error).message,
                    }, 'Failed to migrate table (may not exist)');
                }
            }

            // Handle the repositories table specially (primary key)
            try {
                // Check if old repository exists
                const existingRepo = await trx(REPOSITORIES_TABLE.table)
                    .where(REPOSITORIES_TABLE.column, oldRepository)
                    .first();

                if (existingRepo) {
                    // Check if new name already exists
                    const newRepoExists = await trx(REPOSITORIES_TABLE.table)
                        .where(REPOSITORIES_TABLE.column, newRepository)
                        .first();

                    if (newRepoExists) {
                        // Merge: delete old, keep new (new might have more recent data)
                        await trx(REPOSITORIES_TABLE.table)
                            .where(REPOSITORIES_TABLE.column, oldRepository)
                            .delete();
                        log.info({
                            oldRepository,
                            newRepository,
                        }, 'Merged repository records (deleted old, kept new)');
                    } else {
                        // Update the primary key (requires delete + insert in SQLite)
                        const repoData = { ...existingRepo };
                        delete repoData[REPOSITORIES_TABLE.column];

                        await trx(REPOSITORIES_TABLE.table)
                            .where(REPOSITORIES_TABLE.column, oldRepository)
                            .delete();

                        await trx(REPOSITORIES_TABLE.table).insert({
                            ...repoData,
                            [REPOSITORIES_TABLE.column]: newRepository,
                        });

                        tablesUpdated.push(REPOSITORIES_TABLE.table);
                        totalRowsAffected += 1;
                        log.info({ oldRepository, newRepository }, 'Migrated repositories table');
                    }
                }
            } catch (repoTableError) {
                log.warn({
                    error: (repoTableError as Error).message,
                }, 'Failed to migrate repositories table');
            }

            // Migrate tables where repo name is embedded in path prefix (e.g., "owner/repo/path/to/file")
            for (const { table, column } of TABLES_WITH_PATH_PREFIX) {
                try {
                    // Use SQLite's replace function to update path prefixes
                    // This replaces "oldOwner/oldRepo/" with "newOwner/newRepo/" at the start of paths
                    const oldPrefix = `${oldRepository}/`;
                    const newPrefix = `${newRepository}/`;

                    const result = await trx(table)
                        .where(column, 'like', `${oldRepository}/%`)
                        .update({
                            [column]: trx.raw(`replace(${column}, ?, ?)`, [oldPrefix, newPrefix])
                        });

                    if (result > 0) {
                        tablesUpdated.push(table);
                        totalRowsAffected += result;
                        log.info({
                            table,
                            column,
                            rowsUpdated: result,
                        }, 'Migrated path-prefix table');
                    }
                } catch (pathTableError) {
                    log.warn({
                        table,
                        error: (pathTableError as Error).message,
                    }, 'Failed to migrate path-prefix table (may not exist)');
                }
            }
        });

        log.info({
            oldRepository,
            newRepository,
            tablesUpdated,
            totalRowsAffected,
        }, 'Repository migration completed successfully');

        return {
            success: true,
            tablesUpdated,
            rowsAffected: totalRowsAffected,
        };
    } catch (error) {
        log.error({
            oldRepository,
            newRepository,
            error: (error as Error).message,
        }, 'Repository migration failed');

        return {
            success: false,
            tablesUpdated,
            rowsAffected: totalRowsAffected,
            error: (error as Error).message,
        };
    }
}

/**
 * Checks if a repository has been renamed and automatically migrates
 * all database references if needed.
 *
 * Returns the current (possibly new) repository name.
 */
export async function checkAndMigrateRepository(
    repository: string
): Promise<RepositoryRenameResult> {
    try {
        const { renamed, currentName } = await detectRepositoryRename(repository);

        if (!renamed) {
            return { detected: false };
        }

        // Repository was renamed, migrate all references
        const migrationResult = await migrateRepositoryReferences(repository, currentName);

        return {
            detected: true,
            oldName: repository,
            newName: currentName,
            migrated: migrationResult.success,
            error: migrationResult.error,
        };
    } catch (error) {
        return {
            detected: false,
            error: (error as Error).message,
        };
    }
}

/**
 * Extracts repository name from GitHub API response and compares with requested name.
 * Can be used to detect renames from any API response that includes repository info.
 */
export function detectRenameFromResponse(
    requestedRepository: string,
    responseData: { full_name?: string; repository?: { full_name?: string } }
): { renamed: boolean; currentName: string | null } {
    const currentName = responseData.full_name || responseData.repository?.full_name || null;

    if (!currentName) {
        return { renamed: false, currentName: null };
    }

    const renamed = currentName.toLowerCase() !== requestedRepository.toLowerCase();
    return { renamed, currentName };
}

/**
 * Schedules a background check for repository rename.
 * This is useful when you don't want to block the current operation.
 */
export function scheduleRepositoryRenameCheck(repository: string): void {
    // Use setImmediate to not block the current operation
    setImmediate(async () => {
        try {
            const result = await checkAndMigrateRepository(repository);
            if (result.detected && result.migrated) {
                log.info({
                    oldName: result.oldName,
                    newName: result.newName,
                }, 'Background repository migration completed');
            }
        } catch (error) {
            log.warn({
                repository,
                error: (error as Error).message,
            }, 'Background repository rename check failed');
        }
    });
}
