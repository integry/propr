import path from 'node:path';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { settleTimeoutStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import logger from '../../../utils/logger.js';
import type { SpritesRunPaths } from './spritesCommand.js';
import type { SpritesRuntimeConfig } from './spritesConfig.js';
import type { SpritesCredentialSync } from './spritesCredentials.js';
import { settleLauncher } from './spritesExecution.js';
import {
    createAgentSprite, prepareSprite, retainedCredentialRuns, spriteName, spriteRunInProgress, wakeSprite,
    SpriteBaselineUnknownError, SPRITES_RETAINED_CREDENTIALS_MARKER, type SpritePool, type SpriteProvisioning, type SpritesSetupBundle,
} from './spritesProvisioning.js';
import type { SpriteLike, SpritesClientLike } from './spritesSdk.js';

/**
 * Ownership helpers of one Sprites run: acquiring a Sprite that is safe to
 * use, the run deadline before the run starts, and the recovery obligation of
 * credentials that could not be written back.
 */

export interface SpriteRunLease { sprite: SpriteLike; name: string; release(): void }

export interface SpriteAcquisitionTimings { queueMs?: number; wakeMs?: number; created?: boolean }

/** Rejects as soon as `signal` aborts; `promise` itself keeps running (and is awaited before cleanup). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export class SpritesStartDeadlineError extends Error {
    constructor(run: string, timeoutMs: number) {
        super(`Agent run ${run} reached its ${timeoutMs}ms deadline before it started on a Sprite`);
        this.name = 'SpritesStartDeadlineError';
    }
}

/** The result of a run whose deadline passed before it started: a timeout, as when it passes during the run. */
export function startDeadlineResult(timeoutMs: number, preserveOutput: boolean): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => settleTimeoutStop(timeoutMs, { exitCode: null, stdout: '', stderr: '', messageTimestamps: new Map() }, preserveOutput, { resolve, reject }));
}

/**
 * A free Sprite of this worker that no other process's run is using and that
 * holds no credentials awaiting recovery (a Sprite that cannot be checked is skipped).
 */
export async function acquireSprite(
    { pool, client, config }: { pool: SpritePool; client: SpritesClientLike; config: SpritesRuntimeConfig },
    signal: AbortSignal,
    timings: SpriteAcquisitionTimings,
): Promise<SpriteRunLease> {
    const queued = Date.now();
    const skip = new Set<number>();
    for (;;) {
        const slot = await pool.acquireSlot(signal, skip);
        timings.queueMs = Date.now() - queued;
        const name = spriteName(config, slot.slot);
        let lease: SpriteRunLease;
        try {
            const started = Date.now();
            const { sprite, created } = await wakeSprite(client, name, config);
            timings.wakeMs = Date.now() - started;
            timings.created = created;
            lease = { sprite, name, release: slot.release };
        } catch (error) {
            slot.release();
            throw new Error(`Could not wake or create Sprite ${name}: ${(error as Error).message}`, { cause: error });
        }
        if (timings.created) return lease;
        const retained = await retainedCredentialRuns(lease.sprite).catch(error => {
            logger.warn({ sprite: name, error: (error as Error).message }, 'Could not check the Sprite for retained credentials; skipping it');
            return null;
        });
        if (retained && retained.length > 0) {
            logger.error({ sprite: name, runDirectories: retained }, 'Sprite holds credentials that were not written back; skipping it until they are recovered and the run directories deleted');
        } else if (retained && !await spriteRunInProgress(lease.sprite)) {
            return lease;
        } else if (retained) {
            logger.warn({ sprite: name }, 'Sprite is running another process\'s agent run; set PROPR_SPRITES_WORKER_ID per ProPR process on one host');
        }
        slot.release();
        skip.add(slot.slot);
    }
}

/** Whether any run directory on the Sprite holds credentials awaiting recovery (true when that cannot be checked). */
export async function spriteHoldsRetainedCredentials(sprite: SpriteLike, run: string): Promise<boolean> {
    return retainedCredentialRuns(sprite).then(runs => runs.length > 0, error => {
        logger.warn({ run, sprite: sprite.name, error: (error as Error).message }, 'Could not check the Sprite for retained credentials; not restoring it');
        return true;
    });
}

/** Why a run directory holds credentials awaiting recovery. */
export type SpritesRecoveryReason =
    /** Written with the run's credential copy, cleared once its refreshed tokens were written back: a worker that stops mid-run leaves it. */
    | 'pending-write-back'
    /** The canonical store did not take the returned tokens: the run directory's `returned/` holds them. */
    | 'write-back-failed'
    /** The launcher's export could not be confirmed: the live copies in the agent home are kept as they are. */
    | 'export-unconfirmed';

function recoveryMarker(paths: SpritesRunPaths): string {
    return path.posix.join(paths.root, SPRITES_RETAINED_CREDENTIALS_MARKER);
}

/**
 * Quarantines the Sprite, for every worker process, until the retained
 * credentials are recovered. Resolves false when the obligation could not be
 * persisted: then only this process knows, and must keep the Sprite out of use.
 */
export async function persistRecoveryObligation(
    sprite: SpriteLike, paths: SpritesRunPaths, run: string, { reason = 'write-back-failed', liveCopies = [] }: { reason?: SpritesRecoveryReason; liveCopies?: readonly string[] } = {},
): Promise<boolean> {
    const record = { run, reason, retainedAt: new Date().toISOString(), ...(liveCopies.length > 0 ? { liveCopies } : {}) };
    try {
        await sprite.filesystem().writeFile(recoveryMarker(paths), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        if (reason !== 'pending-write-back') {
            logger.error({ run, sprite: sprite.name, runDirectory: paths.root, reason, liveCopies }, 'Sprite quarantined: it is not restored or given another run until its retained credentials are recovered and the run directory is deleted');
        }
        return true;
    } catch (error) {
        logger.error({ run, sprite: sprite.name, runDirectory: paths.root, reason, error: (error as Error).message }, 'Could not mark the Sprite as holding retained credentials; this worker keeps it out of use until it restarts');
        return false;
    }
}

/**
 * Lifts the run's own recovery obligation once nothing of its credentials is
 * left to recover (written back, or never installed). Resolves false when the
 * marker could not be removed: the Sprite then stays quarantined.
 */
export async function clearRecoveryObligation(sprite: SpriteLike, paths: SpritesRunPaths, run: string): Promise<boolean> {
    try {
        await sprite.filesystem().rm(recoveryMarker(paths), { force: true });
        return true;
    } catch (error) {
        logger.warn({ run, sprite: sprite.name, runDirectory: paths.root, error: (error as Error).message }, 'Could not clear the run\'s credential recovery marker; the Sprite stays quarantined');
        return false;
    }
}

/**
 * Deletes the Sprite and creates it again under the same name: used when no
 * clean baseline can be established for it, so its filesystem (which may hold
 * an earlier run's data) never becomes a checkpoint. Only called while the
 * lease is held, after acquisition found no retained credentials and no live launcher.
 */
export async function replaceSprite(client: SpritesClientLike, config: SpritesRuntimeConfig, lease: SpriteRunLease, reason: string): Promise<SpriteRunLease> {
    logger.warn({ sprite: lease.name, reason }, 'Replacing the Sprite: no clean baseline can be established for it');
    await client.deleteSprite(lease.name);
    return { ...lease, sprite: await createAgentSprite(client, lease.name, config) };
}

/**
 * {@link prepareSprite}, replacing the Sprite when no clean baseline can be
 * established for it. Resolves with the lease to use (a new Sprite when replaced).
 */
export async function provisionLeasedSprite(
    { client, config, bundle }: { client: SpritesClientLike; config: SpritesRuntimeConfig; bundle: SpritesSetupBundle },
    lease: SpriteRunLease,
    signal: AbortSignal,
): Promise<{ lease: SpriteRunLease; provisioning: SpriteProvisioning; replaced: boolean }> {
    try {
        return { lease, provisioning: await prepareSprite(lease.sprite, bundle, config), replaced: false };
    } catch (error) {
        if (!(error instanceof SpriteBaselineUnknownError)) throw error;
        signal.throwIfAborted();
        const replacement = await replaceSprite(client, config, lease, error.message);
        return { lease: replacement, provisioning: await prepareSprite(replacement.sprite, bundle, config), replaced: true };
    }
}

export interface SpritesCredentialFinish {
    /** Credentials of the run stay on the Sprite for recovery (the Sprite is quarantined). */
    retained: boolean;
    /** The launcher's export was not confirmed: the live copies in the agent home are the ones to recover. */
    liveCopiesRetained: boolean;
    /** The obligation could not be persisted: only this process knows, and must keep the Sprite out of use. */
    holdSprite: boolean;
    writeBackMs?: number;
}

/**
 * Writes the run's refreshed tokens back, once the launcher confirmed their
 * export (a returned file it has not exported yet looks like no refresh), and
 * lifts the run's recovery obligation. When the export cannot be confirmed or
 * the write-back fails, the credentials stay on the Sprite and the obligation
 * records why.
 */
export async function finishRunCredentials(
    sprite: SpriteLike, paths: SpritesRunPaths, run: string, { credentials, settleMs }: { credentials: SpritesCredentialSync; settleMs?: number },
): Promise<SpritesCredentialFinish> {
    const started = Date.now();
    if (!await settleLauncher(sprite, paths, settleMs)) {
        const liveCopies = credentials.records.filter(record => record[0] === 'store').map(record => record[2]);
        logger.error({ run, sprite: sprite.name, runDirectory: paths.root, liveCopies }, 'Could not confirm that the Sprites run returned its refreshed credentials; kept the live copies on the Sprite. Copy each newer file back to its canonical store, then delete the run directory');
        const persisted = await persistRecoveryObligation(sprite, paths, run, { reason: 'export-unconfirmed', liveCopies });
        return { retained: true, liveCopiesRetained: true, holdSprite: !persisted };
    }
    const outcome = await credentials.writeBack(sprite.filesystem(), paths);
    const writeBackMs = Date.now() - started;
    if (outcome.retained) return { retained: true, liveCopiesRetained: false, holdSprite: !await persistRecoveryObligation(sprite, paths, run), writeBackMs };
    // A marker that cannot be removed keeps the Sprite quarantined: safe, if needlessly.
    await clearRecoveryObligation(sprite, paths, run);
    return { retained: false, liveCopiesRetained: false, holdSprite: false, writeBackMs };
}
