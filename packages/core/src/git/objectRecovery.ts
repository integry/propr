import fs from 'node:fs/promises';
import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { createHooklessGit } from './hooklessGit.js';
import { configureGitRemoteAuthentication, redactAuthenticatedGitUrl } from './repoBranching.js';
import { OBJECT_REPAIR_MARKER, RepositoryRepairRequiredError, verifiedInPreparation, withRepositoryPreparation } from './repositoryPreparation.js';
import logger from '../utils/logger.js';

export { RepositoryRepairRequiredError } from './repositoryPreparation.js';

export const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;
const DONOR_PREFIX = 'propr-object-recovery-';
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Outside refs/heads: Git refuses a tag object as a branch tip.
const DONOR_REF = 'refs/propr/recovery';
const VERIFIED_EXCLUSIONS = 16;
const SLOW_VERIFICATION_MS = 5_000;

/**
 * Walk trees and blobs too: resolving a commit alone does not prove it can be
 * checked out. `complete` names revisions whose closure is already proven, so
 * the walk stops where it meets them.
 */
async function verifyObjects(git: SimpleGit, revision: string, complete: string[] = []): Promise<void> {
    await git.raw(['rev-list', '--objects', '--quiet', '--missing=error', revision, ...(complete.length ? ['--not', ...complete] : []), '--']);
}

function missingObject(error: unknown): boolean {
    return /unable to read tree|bad tree object|missing (?:blob|tree|commit)|could not read [0-9a-f]{7,}|bad object [0-9a-f]{7,}|unable to read [0-9a-f]{7,}/i.test(String((error as Error)?.message ?? error));
}

/** The gate is held: a closure verified earlier in this hold is not walked again. */
async function hasMissingObjects(git: SimpleGit, common: string, revision: string): Promise<boolean> {
    const verified = verifiedInPreparation(common);
    if (verified?.has(revision)) return false;
    const started = Date.now();
    try {
        await verifyObjects(git, revision, [...(verified ?? [])].slice(-VERIFIED_EXCLUSIONS));
        verified?.add(revision);
        return false;
    } catch (error) {
        if (!missingObject(error)) throw error;
        return true;
    } finally {
        const durationMs = Date.now() - started;
        logger[durationMs >= SLOW_VERIFICATION_MS ? 'info' : 'debug']({ common, revision, durationMs }, 'Walked Git object closure under the preparation gate');
    }
}

async function removeStaleDonors(common: string): Promise<void> {
    const entries = await fs.readdir(common, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory() && /^propr-object-recovery-[a-zA-Z0-9]{6}$/.test(entry.name)) {
            await fs.rm(path.join(common, entry.name), { recursive: true, force: true });
        }
    }
}

async function readMarker(marker: string): Promise<string | undefined> {
    return fs.readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    });
}

async function unlinkVerifiedMarker(marker: string, contents: string): Promise<void> {
    // An operator can intervene outside the worker gate. Recheck immediately
    // before removal so an observed replacement is never cleared with old evidence.
    if (await readMarker(marker) === contents) {
        await fs.unlink(marker).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}

/**
 * An incident opened for an interrupted ordinary fetch. Restoring its revision
 * proves nothing about other refs, so only a successful fetch closes it.
 */
function awaitsFetch(contents: string): boolean {
    try { return JSON.parse(contents)?.fetchVerificationPending === true; }
    catch { return false; } // Retain unreadable incident data for an operator.
}

/** The gate is held. Only the incident recorded in the marker can clear it. */
async function clearResolvedMarker(
    git: SimpleGit, common: string, marker: string, { revision, missing }: { revision: string; missing: boolean },
): Promise<void> {
    const contents = await readMarker(marker);
    if (contents === undefined || awaitsFetch(contents)) return;
    let recorded: unknown;
    try { recorded = JSON.parse(contents)?.revision; }
    catch { return; } // Retain unreadable incident data for an operator.
    if (typeof recorded !== 'string' || !OBJECT_ID.test(recorded)) return;
    if (recorded === revision ? missing : await hasMissingObjects(git, common, recorded)) return;
    await removeStaleDonors(common);
    await unlinkVerifiedMarker(marker, contents);
}

async function donorDepth(git: SimpleGit, revision: string): Promise<string[]> {
    if (!GIT_SHALLOW_CLONE_DEPTH || (await git.raw(['rev-parse', '--is-shallow-repository'])).trim() !== 'true') return [];
    try {
        // A cached tip may have advanced since cloning. The reachable commit
        // count bounds the longest path to its shallow boundaries, even at merges.
        const count = Number((await git.raw(['rev-list', '--count', revision, '--'])).trim());
        if (count > 0) return [`--depth=${Math.max(count, GIT_SHALLOW_CLONE_DEPTH)}`];
    } catch (error) {
        if (!missingObject(error)) throw error;
        // A missing commit can hide the distance to a boundary.
    }
    return [];
}

/** Persist the unresolved revision. Returns nothing when an earlier incident is already recorded. */
async function recordIncident(common: string, revision: string, context: string, forFetch: boolean): Promise<string | undefined> {
    const contents = JSON.stringify({ revision, startedAt: new Date().toISOString(), ...(forFetch ? { fetchVerificationPending: true } : {}) });
    try {
        await fs.writeFile(path.join(common, OBJECT_REPAIR_MARKER), contents, { flag: 'wx', mode: 0o600 });
        return contents;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw new RepositoryRepairRequiredError(common,
            `${context}the repair marker could not be recorded; inspect cache permissions or storage (${(error as Error).message})`,
            'Restore write access to the repository cache, then retry the task.');
    }
}

/**
 * Recover only after a closure check has proved damage while holding the gate.
 * `forFetch` leaves the incident recorded after the repair: the interrupted
 * fetch has not succeeded yet, and its caller clears the incident when it does.
 */
async function repairIfMissing(
    git: SimpleGit, common: string, { revision, ref }: { revision: string; ref?: string }, { token, forFetch = false }: { token?: string; forFetch?: boolean } = {},
): Promise<boolean> {
    const context = ref ? `ref '${ref}': ` : '';
    const missing = await hasMissingObjects(git, common, revision);
    const marker = path.join(common, OBJECT_REPAIR_MARKER);
    try {
        await clearResolvedMarker(git, common, marker, { revision, missing });
    } catch (error) {
        throw new RepositoryRepairRequiredError(common, `${context}could not verify or clear the recorded repair; inspect cache permissions or storage (${(error as Error).message})`);
    }
    if (!missing) return false;
    const contents = await recordIncident(common, revision, context, forFetch);
    if (contents === undefined) {
        throw new RepositoryRepairRequiredError(common, `${context}a previous automatic repair failed or was interrupted`);
    }
    let temporary: string | undefined;
    try {
        logger.warn({ common, revision }, 'Missing Git objects; attempting one additive repair');
        await removeStaleDonors(common);
        // Same filesystem as the destination permits atomic hard-link publication.
        temporary = await fs.mkdtemp(path.join(common, DONOR_PREFIX));
        const donor = createHooklessGit(temporary);
        await donor.init(true);
        const remote = (await git.getConfig('remote.origin.url')).value;
        if (!remote) throw new Error('origin has no URL');
        const fetchUrl = remote.replace(/^(https:\/\/)[^/]*@/i, '$1');
        await configureGitRemoteAuthentication(donor, token, fetchUrl);
        // A fresh object database prevents negotiation using the damaged clone.
        const depth = await donorDepth(git, revision);
        await donor.raw(['fetch', '--no-tags', '--no-recurse-submodules', ...depth, '--', fetchUrl, `${revision}:${DONOR_REF}`]);
        // The fetch checks the pack, and this walks its closure without enforcing
        // modern fsck formatting rules on historical objects.
        await verifyObjects(donor, revision);
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
        verifiedInPreparation(common)?.add(revision);
        await fs.rm(temporary, { recursive: true, force: true });
        temporary = undefined;
        if (!forFetch) await unlinkVerifiedMarker(marker, contents);
        logger.info({ common, revision }, 'Restored Git objects; worktree preparation can continue');
        return true;
    } catch (error) {
        throw new RepositoryRepairRequiredError(common, context + redactAuthenticatedGitUrl((error as Error).message));
    } finally {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {
            logger.warn({ temporary }, 'Could not remove the temporary object recovery repository');
        });
    }
}

/** Pin and verify before creating a branch. Recovery only adds immutable objects. */
export async function ensureWorktreeObjects(git: SimpleGit, startPoint: string, ref?: string): Promise<string> {
    return withRepositoryPreparation(git, async common => {
        const revision = OBJECT_ID.test(startPoint)
            ? startPoint
            : (await git.raw(['rev-parse', '--verify', '--end-of-options', startPoint])).trim();
        if (!OBJECT_ID.test(revision)) throw new Error('Invalid worktree starting revision');
        await repairIfMissing(git, common, { revision, ref });
        return revision;
    });
}

/**
 * Ancestry needs commits only. A tree or blob missing from a later commit on
 * the branch does not stop a checkout of an earlier one, so the closure is
 * walked, and repaired, only when the commit history itself cannot be read.
 * Returns whether a repair restored it.
 */
export async function ensureCommitHistory(git: SimpleGit, revision: string, ref?: string): Promise<boolean> {
    return withRepositoryPreparation(git, async common => {
        try {
            await git.raw(['rev-list', '--quiet', '--end-of-options', revision, '--']);
            return false;
        } catch (error) {
            if (!missingObject(error)) throw error;
            return repairIfMissing(git, common, { revision, ref });
        }
    });
}

const MISSING_FETCH_BASE = /failed to resolve \d+ delta|unresolved deltas left after unpacking|did not send all necessary objects|bad object refs\/|invalid object [0-9a-f]{7,}/i;

function fetchBlockedByMissingObjects(error: unknown): boolean {
    return missingObject(error) || MISSING_FETCH_BASE.test(String((error as Error)?.message ?? error));
}

/**
 * Cached tips that can block an ordinary fetch, most likely first: the ref Git
 * named, the fetched branch, then every local ref. Even a single-branch fetch
 * checks connectivity against all of them, including ProPR's own backups under
 * refs/propr. Object IDs are read without peeling so a ref whose tip object is
 * missing, or an annotated tag that lost only its tag object, stays visible.
 */
async function* fetchRecoveryCandidates(
    git: SimpleGit, error: unknown, branch?: string,
): AsyncGenerator<{ revision: string; ref: string }> {
    const seen = new Set<string>();
    const named = /bad object (refs\/\S+)/.exec(String((error as Error)?.message ?? error))?.[1];
    for (const ref of [named, branch ? `refs/remotes/origin/${branch}` : undefined]) {
        if (!ref) continue;
        const revision = (await git.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])).trim();
        if (!OBJECT_ID.test(revision) || seen.has(revision)) continue;
        seen.add(revision);
        yield { revision, ref };
    }
    const refs = await git.raw(['for-each-ref', '--format=%(objectname) %(refname)']);
    for (const line of refs.split('\n')) {
        const [revision, ref] = line.split(' ');
        if (!OBJECT_ID.test(revision) || seen.has(revision)) continue;
        seen.add(revision);
        yield { revision, ref };
    }
}

/** The ordinary fetch succeeded under the gate: an incident that was waiting for it is over. */
async function clearVerifiedFetch(common: string): Promise<void> {
    const marker = path.join(common, OBJECT_REPAIR_MARKER);
    const contents = await readMarker(marker);
    if (contents === undefined || !awaitsFetch(contents)) return;
    await removeStaleDonors(common);
    await unlinkVerifiedMarker(marker, contents);
}

/** Point the retained incident at the damage that still blocks the fetch. It keeps waiting for the fetch. */
async function retainIncidentFor(common: string, revision: string, context: string): Promise<void> {
    const marker = path.join(common, OBJECT_REPAIR_MARKER);
    const current = await readMarker(marker);
    // An operator removed the marker outside the gate; this attempt is still spent.
    if (current === undefined) return void await recordIncident(common, revision, context, true);
    let recorded: unknown;
    try { recorded = JSON.parse(current)?.revision; }
    catch { return; } // Retain unreadable incident data for an operator.
    if (recorded === revision) return;
    const replacement = `${marker}.next`;
    await fs.writeFile(replacement, JSON.stringify({ revision, startedAt: new Date().toISOString(), fetchVerificationPending: true }), { mode: 0o600 });
    await fs.rename(replacement, marker);
}

/**
 * The single authorized repair has been spent, in this call or in one that was
 * interrupted before its fetch succeeded. Verifying the repaired revision
 * proved nothing about other refs, so a fetch that is still blocked by missing
 * objects records the remaining damage and stops instead of starting another donor.
 */
async function remainingDamage(
    git: SimpleGit, common: string, { error, branch, repaired }: { error: unknown; branch?: string; repaired: boolean },
): Promise<unknown> {
    for await (const { revision, ref } of fetchRecoveryCandidates(git, error, branch)) {
        if (!await hasMissingObjects(git, common, revision)) continue;
        const context = `ref '${ref}': `;
        await retainIncidentFor(common, revision, context);
        const reason = repaired
            ? 'objects are still missing after the one automatic repair restored another ref'
            : 'a previous automatic repair failed or was interrupted before its fetch succeeded';
        return new RepositoryRepairRequiredError(common, `${context}${reason} (${redactAuthenticatedGitUrl((error as Error).message)})`);
    }
    return error;
}

async function fetchIncidentOpen(common: string): Promise<boolean> {
    const contents = await readMarker(path.join(common, OBJECT_REPAIR_MARKER));
    return contents !== undefined && awaitsFetch(contents);
}

/**
 * Retry an interrupted ordinary fetch once, after proving and repairing cached
 * damage. The incident stays recorded from before the donor starts until a
 * fetch succeeds, so a worker that stops anywhere in between leaves the next
 * one a fetch to verify, not another repair to attempt.
 */
export async function fetchWithObjectRecovery<T>(
    git: SimpleGit, fetch: () => Promise<T>, branch?: string, token?: string,
): Promise<T> {
    return withRepositoryPreparation(git, async common => {
        let repaired = false;
        for (;;) {
            let result: T;
            try {
                result = await fetch();
            } catch (error) {
                if (!fetchBlockedByMissingObjects(error)) throw error;
                if (repaired || await fetchIncidentOpen(common)) throw await remainingDamage(git, common, { error, branch, repaired });
                for await (const candidate of fetchRecoveryCandidates(git, error, branch)) {
                    repaired = await repairIfMissing(git, common, candidate, { token, forFetch: true });
                    if (repaired) break;
                }
                if (!repaired) throw error;
                continue;
            }
            await clearVerifiedFetch(common);
            return result;
        }
    });
}
