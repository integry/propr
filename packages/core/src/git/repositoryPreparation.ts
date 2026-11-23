import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { UnrecoverableError } from 'bullmq';
import type { SimpleGit } from 'simple-git';
import { StorageBusyError, StorageLifecycle } from '../storage/lifecycle.js';

export const OBJECT_REPAIR_MARKER = 'propr-object-repair-required.json';

export class RepositoryRepairRequiredError extends UnrecoverableError {
    constructor(common: string, detail: string,
        guidance = `Repair the missing objects, or remove ${OBJECT_REPAIR_MARKER} after fixing the underlying cause to allow one new repair attempt, then retry the task.`,
    ) {
        super(`Repository object repair required at ${common}: ${detail}. Local branches and worktrees were retained. ${guidance}`);
        this.name = 'RepositoryRepairRequiredError';
    }
}

export class RepositoryPreparationBusyError extends Error {
    constructor(common: string, cause: StorageBusyError) {
        super(`Repository preparation is busy at ${common}; wait for the current preparation or inspect the gate owner`, { cause });
        this.name = 'RepositoryPreparationBusyError';
    }
}

const DEFAULT_WAIT_MS = 120_000;

/** Large repositories can hold the gate for minutes; operators can lengthen the wait. */
function preparationWaitMs(): number {
    const configured = Number(process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_WAIT_MS;
}

/** Gates held by this async context, each with the revisions whose closure it has verified. */
const held = new AsyncLocalStorage<ReadonlyMap<string, Set<string>>>();

/**
 * Revisions already verified complete during the current hold of this gate.
 * Objects are immutable and preparation only adds them, so a closure verified
 * under the gate need not be walked again before the gate is released.
 */
export function verifiedInPreparation(common: string): Set<string> | undefined {
    return held.getStore()?.get(common);
}

/** Cross-process preparation gate, shared by the clone and its linked worktrees. */
export async function withRepositoryPreparation<T>(git: SimpleGit, run: (common: string) => Promise<T>): Promise<T> {
    const common = await realpath((await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (held.getStore()?.has(common)) return run(common);
    const gate = new StorageLifecycle(path.join(common, 'propr-preparation'));
    let acquired = false;
    try {
        return await gate.exclusive(() => {
            acquired = true;
            return held.run(new Map([...(held.getStore() ?? []), [common, new Set<string>()]]), () => run(common));
        }, preparationWaitMs());
    } catch (error) {
        if (acquired || !(error instanceof StorageBusyError)) throw error;
        // A timeout proves contention only. The repair marker also exists while a
        // healthy repair runs, so it is classified under the acquired gate, where
        // no other holder can still be repairing.
        throw new RepositoryPreparationBusyError(common, error);
    }
}
