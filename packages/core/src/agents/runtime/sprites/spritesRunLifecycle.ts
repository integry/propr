import path from 'node:path';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { settleTimeoutStop } from '../../../claude/docker/dockerExecutionSettlement.js';
import logger from '../../../utils/logger.js';
import type { SpritesRunPaths } from './spritesCommand.js';
import type { SpritesRuntimeConfig } from './spritesConfig.js';
import { retainedCredentialRuns, spriteName, spriteRunInProgress, wakeSprite, SPRITES_RETAINED_CREDENTIALS_MARKER, type SpritePool } from './spritesProvisioning.js';
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

/**
 * Quarantines the Sprite, for every worker process, until the retained
 * credentials are recovered. Resolves false when the obligation could not be
 * persisted: then only this process knows, and must keep the Sprite out of use.
 */
export async function persistRecoveryObligation(sprite: SpriteLike, paths: SpritesRunPaths, run: string): Promise<boolean> {
    const marker = path.posix.join(paths.root, SPRITES_RETAINED_CREDENTIALS_MARKER);
    try {
        await sprite.filesystem().writeFile(marker, `${JSON.stringify({ run, retainedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
        logger.error({ run, sprite: sprite.name, runDirectory: paths.root }, 'Sprite quarantined: it is not restored or given another run until its retained credentials are recovered and the run directory is deleted');
        return true;
    } catch (error) {
        logger.error({ run, sprite: sprite.name, runDirectory: paths.root, error: (error as Error).message }, 'Could not mark the Sprite as holding retained credentials; this worker keeps it out of use until it restarts');
        return false;
    }
}
