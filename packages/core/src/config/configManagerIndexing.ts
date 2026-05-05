import { db } from '../db/connection.js';
import { getIndexingProgress } from '../services/relevance/indexingCancellation.js';
import logger from '../utils/logger.js';

export interface RepositoryIndexingProgress {
    totalFiles: number;
    processedFiles: number;
    percentComplete: number;
    inputTokens: number;
    outputTokens: number;
    phase: 'files' | 'directories' | 'done';
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

/**
 * Gets the indexing status for all repositories.
 */
export async function getRepositoriesIndexingStatus(): Promise<RepositoryIndexingStatus[]> {
    try {
        const repos = await db('repositories')
            .select('full_name', 'branch', 'indexing_status', 'last_indexed_at', 'last_indexed_hash', 'last_indexed_commit_message', 'icon_path');

        const results: RepositoryIndexingStatus[] = [];
        for (const r of repos) {
            const status: RepositoryIndexingStatus = {
                full_name: r.full_name,
                branch: r.branch || 'HEAD',
                indexing_status: r.indexing_status || 'idle',
                last_indexed_at: r.last_indexed_at ? new Date(r.last_indexed_at).toISOString() : null,
                last_indexed_hash: r.last_indexed_hash || null,
                last_indexed_commit_message: r.last_indexed_commit_message || null,
                icon_path: r.icon_path || null
            };

            if (status.indexing_status === 'indexing') {
                const progress = await getIndexingProgress(r.full_name);
                if (progress) {
                    const percentComplete = progress.totalFiles > 0
                        ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
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

            results.push(status);
        }

        return results;
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
        return {
            full_name: repo.full_name,
            branch: repo.branch || 'HEAD',
            indexing_status: repo.indexing_status || 'idle',
            last_indexed_at: repo.last_indexed_at ? new Date(repo.last_indexed_at).toISOString() : null,
            last_indexed_hash: repo.last_indexed_hash || null,
            last_indexed_commit_message: repo.last_indexed_commit_message || null,
            icon_path: repo.icon_path || null
        };
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, fullName, branch }, 'Failed to load repository indexing status');
        return null;
    }
}
