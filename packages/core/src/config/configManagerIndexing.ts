import { db } from '../db/connection.js';
import { getIndexingProgress } from '../services/relevance/indexingCancellation.js';
import logger from '../utils/logger.js';
import type { RepoToMonitor } from './configManager.js';

export interface RepositoryIndexingProgress {
    totalFiles: number;
    processedFiles: number;
    percentComplete: number;
    inputTokens: number;
    outputTokens: number;
    phase: 'files' | 'directories' | 'completed';
    totalDirectories: number;
    processedDirectories: number;
}

export interface RepositoryIndexingStatus {
    full_name: string;
    branch: string;
    indexing_status: 'idle' | 'indexing' | 'completed' | 'failed';
    last_indexed_at: string | null;
    last_indexed_hash: string | null;
    last_indexed_commit_message: string | null;
    icon_path: string | null;
    progress?: RepositoryIndexingProgress;
}

export interface RepositoryIndexCleanupResult {
    repositories: number;
    file_summaries: number;
    directory_summaries: number;
}

interface RepositoryIndexKey {
    repository: string;
    branch: string;
}

const DEFAULT_INDEX_BRANCH = 'HEAD';

function normalizeIndexBranch(branch?: string): string {
    return branch || DEFAULT_INDEX_BRANCH;
}

function toRepositoryIndexKey(repo: Pick<RepoToMonitor, 'name' | 'baseBranch'>): RepositoryIndexKey {
    return { repository: repo.name, branch: normalizeIndexBranch(repo.baseBranch) };
}

function serializeRepositoryIndexKey({ repository, branch }: RepositoryIndexKey): string {
    return `${repository}\0${branch}`;
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function whereRepositoryPathPrefix(query: ReturnType<typeof db>, repository: string) {
    return query.whereRaw('?? LIKE ? ESCAPE ?', ['path', `${escapeLikePattern(repository)}/%`, '\\']);
}

function deleteFileSummaries(repository: string, branch?: string) {
    const query = whereRepositoryPathPrefix(db('file_summaries'), repository);
    if (branch) query.andWhere({ branch });
    return query.delete();
}

function deleteDirectorySummaries(repository: string, branch?: string) {
    const query = db('directory_summaries')
        .where(function() {
            whereRepositoryPathPrefix(this, repository).orWhere('path', repository);
        });
    if (branch) query.andWhere({ branch });
    return query.delete();
}

function deleteRepositoryRows(repository: string, branch?: string) {
    const query = db('repositories').where({ full_name: repository });
    if (branch) query.andWhere({ branch });
    return query.delete();
}

/**
 * Clears persisted index data for repository entries that were removed from the
 * monitored repository config.
 */
export async function clearRemovedRepositoryIndexData(
    previousRepos: Pick<RepoToMonitor, 'name' | 'baseBranch'>[],
    nextRepos: Pick<RepoToMonitor, 'name' | 'baseBranch'>[]
): Promise<RepositoryIndexCleanupResult> {
    const nextKeys = new Set(nextRepos.map(repo => serializeRepositoryIndexKey(toRepositoryIndexKey(repo))));
    const nextRepositories = new Set(nextRepos.map(repo => repo.name));
    const removedByRepository = new Map<string, Set<string>>();

    for (const previousRepo of previousRepos) {
        const key = toRepositoryIndexKey(previousRepo);
        if (nextKeys.has(serializeRepositoryIndexKey(key))) continue;
        const branches = removedByRepository.get(key.repository) ?? new Set<string>();
        branches.add(key.branch);
        removedByRepository.set(key.repository, branches);
    }

    const result: RepositoryIndexCleanupResult = {
        repositories: 0,
        file_summaries: 0,
        directory_summaries: 0
    };

    for (const [repository, branches] of removedByRepository.entries()) {
        if (!nextRepositories.has(repository)) {
            result.file_summaries += await deleteFileSummaries(repository);
            result.directory_summaries += await deleteDirectorySummaries(repository);
            result.repositories += await deleteRepositoryRows(repository);
            continue;
        }

        for (const branch of branches) {
            result.file_summaries += await deleteFileSummaries(repository, branch);
            result.directory_summaries += await deleteDirectorySummaries(repository, branch);
            result.repositories += await deleteRepositoryRows(repository, branch);
        }
    }

    if (result.repositories || result.file_summaries || result.directory_summaries) {
        logger.info({
            cleanup: result,
            removed: Array.from(removedByRepository.entries()).map(([repository, branches]) => ({
                repository,
                branches: nextRepositories.has(repository) ? Array.from(branches) : 'all'
            }))
        }, 'Cleared index data for removed monitored repository entries');
    }

    return result;
}

/**
 * Gets the indexing status for all repositories.
 */
export async function getRepositoriesIndexingStatus(): Promise<RepositoryIndexingStatus[]> {
    try {
        const repos = await db('repositories')
            .select('full_name', 'branch', 'indexing_status', 'last_indexed_at', 'last_indexed_hash', 'last_indexed_commit_message', 'icon_path');

        return Promise.all(repos.map(async (r) => {
            const branch = r.branch || 'HEAD';
            const status: RepositoryIndexingStatus = {
                full_name: r.full_name,
                branch,
                indexing_status: r.indexing_status || 'idle',
                last_indexed_at: r.last_indexed_at ? new Date(r.last_indexed_at).toISOString() : null,
                last_indexed_hash: r.last_indexed_hash || null,
                last_indexed_commit_message: r.last_indexed_commit_message || null,
                icon_path: r.icon_path || null
            };

            if (status.indexing_status === 'indexing') {
                const progress = await getIndexingProgress(r.full_name, branch);
                if (progress) {
                    const totalItems = progress.phase === 'directories' ? progress.totalDirectories : progress.totalFiles;
                    const processedItems = progress.phase === 'directories' ? progress.processedDirectories : progress.processedFiles;
                    const percentComplete = totalItems > 0
                        ? Math.round((processedItems / totalItems) * 100)
                        : 0;
                    status.progress = {
                        totalFiles: progress.totalFiles,
                        processedFiles: progress.processedFiles,
                        percentComplete,
                        inputTokens: progress.inputTokens,
                        outputTokens: progress.outputTokens,
                        phase: progress.phase,
                        totalDirectories: progress.totalDirectories,
                        processedDirectories: progress.processedDirectories
                    };
                }
            }

            return status;
        }));
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to load repositories indexing status');
        return [];
    }
}

/**
 * Gets the indexing status for a specific repository and branch.
 */
export async function getRepositoryIndexingStatus(fullName: string, branch: string = 'HEAD'): Promise<RepositoryIndexingStatus | null> {
    try {
        const repo = await db('repositories')
            .where({ full_name: fullName, branch })
            .first();
        if (!repo) return null;
        const status: RepositoryIndexingStatus = {
            full_name: repo.full_name,
            branch: repo.branch || 'HEAD',
            indexing_status: repo.indexing_status || 'idle',
            last_indexed_at: repo.last_indexed_at ? new Date(repo.last_indexed_at).toISOString() : null,
            last_indexed_hash: repo.last_indexed_hash || null,
            last_indexed_commit_message: repo.last_indexed_commit_message || null,
            icon_path: repo.icon_path || null
        };

        if (status.indexing_status === 'indexing') {
            const progress = await getIndexingProgress(fullName, status.branch);
            if (progress) {
                const totalItems = progress.phase === 'directories' ? progress.totalDirectories : progress.totalFiles;
                const processedItems = progress.phase === 'directories' ? progress.processedDirectories : progress.processedFiles;
                const percentComplete = totalItems > 0
                    ? Math.round((processedItems / totalItems) * 100)
                    : 0;
                status.progress = {
                    totalFiles: progress.totalFiles,
                    processedFiles: progress.processedFiles,
                    percentComplete,
                    inputTokens: progress.inputTokens,
                    outputTokens: progress.outputTokens,
                    phase: progress.phase,
                    totalDirectories: progress.totalDirectories,
                    processedDirectories: progress.processedDirectories
                };
            }
        }

        return status;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, fullName, branch }, 'Failed to load repository indexing status');
        return null;
    }
}
