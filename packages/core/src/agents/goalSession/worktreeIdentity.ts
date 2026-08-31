import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GoalRepositoryIdentity } from './contract.js';

/** Stable identity expected for the exact logical worktree used by a turn. */
export function fingerprintGoalWorktree(repository: GoalRepositoryIdentity): string {
    return createHash('sha256').update([
        repository.repository,
        path.resolve(repository.worktreePath),
        repository.branch,
        repository.headSha ?? '',
    ].join('\0')).digest('hex');
}
