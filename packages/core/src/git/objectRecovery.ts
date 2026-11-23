import fs from 'node:fs/promises';
import path from 'node:path';
import { UnrecoverableError } from 'bullmq';
import type { SimpleGit } from 'simple-git';
import { createHooklessGit } from './hooklessGit.js';
import { configureGitRemoteAuthentication, redactAuthenticatedGitUrl } from './repoBranching.js';
import { withRepositoryPreparation } from './repositoryPreparation.js';
import logger from '../utils/logger.js';

export class RepositoryRepairRequiredError extends UnrecoverableError {
    constructor(common: string, detail: string) {
        super(`Repository object repair required at ${common}: ${detail}. Local branches and worktrees were retained. `
            + 'Repair the missing objects, or remove propr-object-repair-required.json after fixing remote access to allow one new repair attempt, then retry the task.');
        this.name = 'RepositoryRepairRequiredError';
    }
}

/** Walk trees and blobs too: resolving a commit alone does not prove it can be checked out. */
async function verifyObjects(git: SimpleGit, revision: string): Promise<void> {
    await git.raw(['rev-list', '--objects', '--no-object-names', '--missing=error', revision, '--']);
}

function missingObject(error: unknown): boolean {
    return /unable to read tree|bad tree object|missing (?:blob|tree|commit)|could not read [0-9a-f]|bad object [0-9a-f]|unable to read [0-9a-f]/i.test(String((error as Error)?.message ?? error));
}

/**
 * Pin and verify before creating a branch. Recovery only adds immutable objects:
 * no reset, prune, ref import, alternates, or replacement of the live clone.
 * A durable marker bounds recovery across retries and process restarts.
 */
export async function ensureWorktreeObjects(git: SimpleGit, startPoint: string): Promise<string> {
    return withRepositoryPreparation(git, async () => {
        const common = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        const marker = path.join(common, 'propr-object-repair-required.json');
        const revision = (await git.raw(['rev-parse', '--verify', '--end-of-options', startPoint])).trim();
        if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Invalid worktree starting revision');
        try {
            await verifyObjects(git, revision);
            return revision;
        } catch (error) {
            if (!missingObject(error)) throw error;
        }
        try {
            await fs.writeFile(marker, JSON.stringify({ revision, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            throw new RepositoryRepairRequiredError(common, 'a previous automatic repair failed or was interrupted');
        }
        let temporary: string | undefined;
        try {
            logger.warn({ common, revision }, 'Missing Git objects; attempting one additive repair');
            // Same filesystem as the destination permits atomic hard-link publication.
            temporary = await fs.mkdtemp(path.join(common, 'propr-object-recovery-'));
            const donor = createHooklessGit(temporary);
            await donor.init(true);
            const remote = (await git.getConfig('remote.origin.url')).value;
            if (!remote) throw new Error('origin has no URL');
            await configureGitRemoteAuthentication(donor, undefined, remote);
            // A fresh object database prevents fetch negotiation from assuming the
            // damaged clone already has every object reachable from its commits.
            await donor.raw(['fetch', '--no-tags', '--no-recurse-submodules', remote, `${revision}:refs/heads/recovery`]);
            await verifyObjects(donor, revision);
            await donor.raw(['fsck', '--strict', '--no-dangling']);
            await donor.raw(['repack', '-ad']);
            const source = path.join(temporary, 'objects', 'pack');
            const destination = path.join(common, 'objects', 'pack');
            await fs.mkdir(destination, { recursive: true });
            // Pack first, index last: readers never discover a partial pack.
            const files = (await fs.readdir(source)).filter(file => /^pack-[0-9a-f]+\.(pack|idx)$/.test(file))
                .sort((a, b) => Number(a.endsWith('.idx')) - Number(b.endsWith('.idx')));
            for (const file of files) {
                try { await fs.link(path.join(source, file), path.join(destination, file)); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    // Never overwrite an existing pack; final verification must pass.
                }
            }
            await verifyObjects(git, revision);
            await fs.unlink(marker);
            logger.info({ common, revision }, 'Restored Git objects; worktree preparation can continue');
            return revision;
        } catch (error) {
            throw new RepositoryRepairRequiredError(common, redactAuthenticatedGitUrl((error as Error).message));
        } finally {
            if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {
                logger.warn({ temporary }, 'Could not remove the temporary object recovery repository');
            });
        }
    });
}
