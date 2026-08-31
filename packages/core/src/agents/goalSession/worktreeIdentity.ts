import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GoalRepositoryIdentity } from './contract.js';

function repositoryName(value: string): string {
    const trimmed = value.trim().replace(/^git\+/, '');
    const ssh = /^(?:[^@/]+@)?([^/:]+(?:\.[^/:]+)+):(.+)$/.exec(trimmed);
    if (ssh) return normalizedHostPath(ssh[1], ssh[2]);
    if (trimmed.includes('://')) {
        const url = new URL(trimmed);
        return normalizedHostPath(url.hostname, url.pathname);
    }
    return cleanPath(trimmed).toLowerCase();
}

function normalizedHostPath(host: string, repositoryPath: string): string {
    const cleaned = cleanPath(repositoryPath);
    return (host.toLowerCase() === 'github.com' ? cleaned : `${host}/${cleaned}`).toLowerCase();
}

function cleanPath(value: string): string {
    return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
}

/** Stable logical checkout identity. Mutable HEAD/checkpoint state is deliberately excluded. */
export function fingerprintGoalWorktree(repository: GoalRepositoryIdentity): string {
    return createHash('sha256').update([
        repositoryName(repository.repository),
        path.resolve(repository.worktreePath),
        repository.branch,
    ].join('\0')).digest('hex');
}
