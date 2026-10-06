import path from 'path';
import fs from 'fs-extra';
import logger from '../utils/logger.js';
import { createHooklessGit } from './hooklessGit.js';
import { redactAuthenticatedGitUrl } from './redactGitUrl.js';
import { classifyPushError, formatPushRejectionClass, type PushRejectionDiagnosis } from './pushRejection.js';
import { getRescueRetentionDays, rescueBundlePath, rescueRefName } from './rescueRefs.js';

/**
 * The salvage ladder, tried in order once the final push from a worktree fails:
 * `retry` (refreshed credential), `rescue_ref` (same commits to refs/propr/rescue/<taskId>),
 * `bundle` (git bundle on durable local storage), `worktree` (keep the worktree).
 * `none` means every rung failed and the commits may be lost.
 */
export type PushSalvageRung = 'retry' | 'rescue_ref' | 'bundle' | 'worktree' | 'none';

export interface PushSalvageAttempt {
    rung: Exclude<PushSalvageRung, 'none'>;
    succeeded: boolean;
    error?: string;
}

export interface PushFailureRecord {
    diagnosis: PushRejectionDiagnosis;
    /** The rung that preserved the commits. */
    rung: Exclude<PushSalvageRung, 'retry'>;
    branchName: string;
    repository: string;
    rescueRef?: string;
    bundlePath?: string;
    worktreePath?: string;
    /** Exact command(s) a reviewer runs to recover the commits. */
    recoveryInstruction: string;
    attempts: PushSalvageAttempt[];
}

/** Recorded on the task timeline whichever rung succeeded. */
export interface PushSalvageEvent {
    rung: PushSalvageRung;
    classification: PushRejectionDiagnosis['classification'];
    summary: string;
    rescueRef?: string;
    bundlePath?: string;
    worktreePath?: string;
    recoveryInstruction?: string;
    unblockUrls?: string[];
}

export interface PushSalvageOperations<T> {
    /** Rung 1: refresh the git credential and push the original destination once more. */
    retryPush(): Promise<T>;
    /** Rung 2: push the same HEAD to `ref` on the same remote. */
    pushRescueRef(ref: string): Promise<void>;
    /** Rung 3: write a bundle of the branch to `bundlePath`. */
    createBundle(bundlePath: string): Promise<void>;
    /** Rung 4: keep the worktree past the job's cleanup. */
    retainWorktree(): Promise<void>;
}

export interface PushSalvageOptions<T> {
    taskId: string;
    repoOwner: string;
    repoName: string;
    branchName: string;
    worktreePath: string;
    /** The failed push. */
    error: unknown;
    operations: PushSalvageOperations<T>;
    bundleDirectory?: string;
    /** Records the outcome on the task timeline; failures here never mask the push error. */
    onEvent?: (event: PushSalvageEvent) => Promise<void> | void;
}

export class PushFailedError extends Error {
    readonly pushFailure: PushFailureRecord;

    constructor(pushFailure: PushFailureRecord, cause?: unknown) {
        super(formatPushFailureMessage(pushFailure), { cause });
        this.name = 'PushFailedError';
        this.pushFailure = pushFailure;
    }
}

/** The salvage retry could not obtain a fresh credential, so no second push reached the
 * remote and the original rejection remains the diagnosis. */
export class CredentialRefreshError extends Error {
    constructor(cause: unknown) {
        super(`Credential refresh failed: ${errorMessage(cause)}`, { cause });
        this.name = 'CredentialRefreshError';
    }
}

function errorMessage(error: unknown): string {
    return redactAuthenticatedGitUrl(error instanceof Error ? error.message : String(error));
}

/** Quotes one argument for a POSIX shell so branch names and paths stay literal when the
 * recovery command is copied into a terminal. Plain arguments are left bare for readability. */
export function quoteShellArgument(value: string): string {
    if (value !== '' && /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRecoveryInstruction(record: Pick<PushFailureRecord, 'rung' | 'rescueRef' | 'bundlePath' | 'worktreePath' | 'branchName' | 'repository'>): string {
    const q = quoteShellArgument;
    const branch = q(record.branchName);
    switch (record.rung) {
        case 'rescue_ref':
            return `The commits were pushed to \`${record.rescueRef}\` on ${record.repository}. Recover them with: \`git fetch origin ${q(record.rescueRef ?? '')} && git checkout -B ${branch} FETCH_HEAD\`, then push the branch.`;
        case 'bundle':
            return `The commits were saved to the git bundle \`${record.bundlePath}\` on the ProPR host. Recover them with: \`git fetch ${q(record.bundlePath ?? '')} HEAD && git checkout -B ${branch} FETCH_HEAD\`, then push the branch.`;
        case 'worktree':
            return `The worktree was kept at \`${record.worktreePath}\` on the ProPR host (marked with .retention-info.json). Recover the commits with: \`git -C ${q(record.worktreePath ?? '')} push origin ${q(`HEAD:refs/heads/${record.branchName}`)}\`, or copy them out before the retention period ends.`;
        default:
            return 'ProPR could not preserve the commits: the rescue ref push, bundle and worktree retention all failed. See the worker logs.';
    }
}

/** Failure summary used as the task's failure reason and inside GitHub comments. Keeps
 * the classification and unblock URL first so truncation never drops them. */
export function formatPushFailureMessage(record: PushFailureRecord): string {
    const { diagnosis } = record;
    const lines = [
        `Push of branch ${record.branchName} was rejected (${diagnosis.classification}): ${diagnosis.summary}`,
        ...diagnosis.unblockUrls.map(url => `Unblock URL: ${url}`),
        `Recovery: ${record.recoveryInstruction}`,
    ];
    if (diagnosis.excerpt) lines.push(`Remote output:\n${diagnosis.excerpt}`);
    return lines.join('\n');
}

/** Markdown section for GitHub failure comments. */
export function formatPushFailureMarkdown(record: PushFailureRecord): string {
    const { diagnosis } = record;
    const lines = [
        '### Push rejected',
        '',
        `**Reason:** ${formatPushRejectionClass(diagnosis.classification)} (\`${diagnosis.classification}\`)`,
        '',
        diagnosis.summary,
    ];
    if (diagnosis.unblockUrls.length > 0) {
        lines.push('', '**Unblock URL:**', ...diagnosis.unblockUrls.map(url => `- ${url}`));
    }
    lines.push('', `**Recovery:** ${record.recoveryInstruction}`);
    if (diagnosis.excerpt) {
        lines.push('', '<details><summary>Remote output</summary>', '', '```', diagnosis.excerpt.replace(/```/g, "'''"), '```', '', '</details>');
    }
    return lines.join('\n');
}

/** Finds a push failure anywhere in an error's cause chain. */
export function getPushFailure(error: unknown): PushFailureRecord | undefined {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth++) {
        const record = (current as { pushFailure?: PushFailureRecord }).pushFailure;
        if (record && typeof record === 'object' && 'diagnosis' in record) return record;
        current = (current as { cause?: unknown }).cause;
    }
    return undefined;
}

/** Structured copy stored on the FAILED history entry; the excerpt is kept short. */
export function pushFailureHistoryMetadata(error: unknown): { pushFailure?: PushFailureRecord } {
    const record = getPushFailure(error);
    return record ? { pushFailure: record } : {};
}

function toEvent(rung: PushSalvageRung, diagnosis: PushRejectionDiagnosis, record?: Partial<PushFailureRecord>): PushSalvageEvent {
    const summaries: Record<PushSalvageRung, string> = {
        retry: 'Push succeeded after refreshing the git credential',
        rescue_ref: `Push rejected (${diagnosis.classification}); commits saved to ${record?.rescueRef}`,
        bundle: `Push rejected (${diagnosis.classification}); commits saved to bundle ${record?.bundlePath}`,
        worktree: `Push rejected (${diagnosis.classification}); worktree retained at ${record?.worktreePath}`,
        none: `Push rejected (${diagnosis.classification}); commits could not be preserved`,
    };
    return {
        rung,
        classification: diagnosis.classification,
        summary: summaries[rung],
        ...(record?.rescueRef ? { rescueRef: record.rescueRef } : {}),
        ...(record?.bundlePath ? { bundlePath: record.bundlePath } : {}),
        ...(record?.worktreePath ? { worktreePath: record.worktreePath } : {}),
        ...(record?.recoveryInstruction ? { recoveryInstruction: record.recoveryInstruction } : {}),
        ...(diagnosis.unblockUrls.length ? { unblockUrls: diagnosis.unblockUrls } : {}),
    };
}

/**
 * Runs the salvage ladder after the final push failed. Returns the retry's result when
 * rung 1 succeeds; otherwise throws a PushFailedError naming the rung that preserved the
 * commits and the exact recovery instruction.
 */
export async function salvageFailedPush<T>(options: PushSalvageOptions<T>): Promise<T> {
    const { taskId, repoOwner, repoName, branchName, worktreePath, operations } = options;
    const repository = `${repoOwner}/${repoName}`;
    const attempts: PushSalvageAttempt[] = [];
    const log = logger.withCorrelation(taskId, { taskId, repository, branchName, worktreePath });
    let pushError = options.error;
    const emit = async (event: PushSalvageEvent) => {
        try {
            await options.onEvent?.(event);
        } catch (eventError) {
            log.warn({ error: (eventError as Error).message }, 'Failed to record push salvage event');
        }
    };

    log.warn({ error: errorMessage(pushError), classification: classifyPushError(pushError).classification }, 'Final push failed; starting salvage ladder');

    try {
        const result = await operations.retryPush();
        attempts.push({ rung: 'retry', succeeded: true });
        const diagnosis = classifyPushError(options.error);
        log.info({ classification: diagnosis.classification }, 'Push succeeded after credential refresh');
        await emit(toEvent('retry', diagnosis));
        return result;
    } catch (retryError) {
        // A failed credential refresh says nothing about why the remote rejected the
        // push; keep the original diagnosis and record the refresh failure as the attempt.
        if (!(retryError instanceof CredentialRefreshError)) pushError = retryError;
        attempts.push({ rung: 'retry', succeeded: false, error: errorMessage(retryError) });
    }

    // Classify the latest rejection: a refreshed credential can turn an auth error
    // into the rule violation that actually blocks the push. A retry error that does
    // not classify (it likely never reached the remote) keeps the original error.
    let diagnosis = classifyPushError(pushError);
    if (diagnosis.classification === 'unknown' && pushError !== options.error) {
        pushError = options.error;
        diagnosis = classifyPushError(pushError);
    }
    const finish = async (rung: PushFailureRecord['rung'], extra: Partial<PushFailureRecord> = {}): Promise<never> => {
        const base = { rung, branchName, repository, ...extra };
        const record: PushFailureRecord = { ...base, diagnosis, attempts, recoveryInstruction: buildRecoveryInstruction(base) };
        log.error({ rung, classification: diagnosis.classification, rescueRef: record.rescueRef, bundlePath: record.bundlePath }, 'Push salvage finished');
        await emit(toEvent(rung, diagnosis, record));
        throw new PushFailedError(record, pushError);
    };

    const rescueRef = rescueRefName(taskId);
    try {
        await operations.pushRescueRef(rescueRef);
        attempts.push({ rung: 'rescue_ref', succeeded: true });
        return await finish('rescue_ref', { rescueRef });
    } catch (error) {
        if (error instanceof PushFailedError) throw error;
        attempts.push({ rung: 'rescue_ref', succeeded: false, error: errorMessage(error) });
    }

    const bundlePath = rescueBundlePath(repoOwner, repoName, taskId, options.bundleDirectory);
    try {
        await fs.ensureDir(path.dirname(bundlePath));
        await operations.createBundle(bundlePath);
        attempts.push({ rung: 'bundle', succeeded: true });
        return await finish('bundle', { bundlePath });
    } catch (error) {
        if (error instanceof PushFailedError) throw error;
        attempts.push({ rung: 'bundle', succeeded: false, error: errorMessage(error) });
    }

    try {
        await operations.retainWorktree();
        attempts.push({ rung: 'worktree', succeeded: true });
        return await finish('worktree', { worktreePath });
    } catch (error) {
        if (error instanceof PushFailedError) throw error;
        attempts.push({ rung: 'worktree', succeeded: false, error: errorMessage(error) });
    }

    return finish('none');
}

export const SALVAGE_RETENTION_REASON = 'push_salvage';

export interface SalvageRetentionInfo {
    timestamp: string;
    issueProcessed: boolean;
    success: false;
    /** `null` when PUSH_RESCUE_RETENTION_DAYS=0: kept until an operator deletes it. */
    retentionHours: number | null;
    scheduledCleanup: string | null;
    reason: typeof SALVAGE_RETENTION_REASON;
    taskId: string;
    branchName: string;
}

/** Writes `.retention-info.json` so cleanupWorktree keeps this worktree regardless of
 * WORKTREE_RETENTION_STRATEGY, and cleanupExpiredWorktrees removes it after retention.
 * A retention of 0 days writes no cleanup deadline, so the worktree is never expired. */
export async function writeSalvageRetentionMarker(worktreePath: string, details: { taskId: string; branchName: string; retentionHours?: number | null }): Promise<void> {
    const retentionDays = getRescueRetentionDays();
    const retentionHours = details.retentionHours !== undefined ? details.retentionHours : (retentionDays === 0 ? null : retentionDays * 24);
    const info: SalvageRetentionInfo = {
        timestamp: new Date().toISOString(),
        issueProcessed: true,
        success: false,
        retentionHours,
        scheduledCleanup: retentionHours === null ? null : new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString(),
        reason: SALVAGE_RETENTION_REASON,
        taskId: details.taskId,
        branchName: details.branchName,
    };
    await fs.writeJson(path.join(worktreePath, '.retention-info.json'), info);
}

/** True while a salvage marker protects its worktree: indefinitely without a deadline,
 * otherwise until the scheduled cleanup. */
export function isActiveSalvageRetention(info: unknown): boolean {
    if (!info || typeof info !== 'object') return false;
    const { reason, scheduledCleanup } = info as Partial<SalvageRetentionInfo>;
    if (reason !== SALVAGE_RETENTION_REASON) return false;
    return scheduledCleanup === null || Date.parse(scheduledCleanup ?? '') > Date.now();
}

export async function isSalvageRetainedWorktree(worktreePath: string): Promise<boolean> {
    try {
        return isActiveSalvageRetention(await fs.readJson(path.join(worktreePath, '.retention-info.json')));
    } catch {
        return false;
    }
}

export interface WorktreePushSalvageOptions<T> {
    worktreePath: string;
    taskId: string;
    branchName: string;
    /** HTTPS URL of the remote the failed push targeted. */
    repoUrl: string;
    /** Forces a new installation token (installation tokens are short-lived). */
    refreshToken: () => Promise<string>;
    /** Pushes the original destination again; it must pick up the refreshed credential. */
    retryPush: (token: string) => Promise<T>;
}

/** Real git implementation of the ladder for a worktree whose HEAD holds the work. */
export function createWorktreePushSalvageOperations<T>(options: WorktreePushSalvageOptions<T>): PushSalvageOperations<T> {
    const git = createHooklessGit(options.worktreePath);
    let token: string | undefined;
    const freshToken = async () => (token ??= await options.refreshToken());
    const redact = (error: unknown) => new Error(errorMessage(error).replaceAll(token || '\0', '[REDACTED]'));
    return {
        async retryPush() {
            try {
                token = await options.refreshToken();
            } catch (error) {
                throw new CredentialRefreshError(error);
            }
            return options.retryPush(token);
        },
        async pushRescueRef(ref) {
            const url = options.repoUrl.replace('https://', `https://x-access-token:${await freshToken()}@`);
            try {
                await git.raw(['push', '--force', url, `HEAD:${ref}`]);
            } catch (error) {
                throw redact(error);
            }
        },
        async createBundle(bundlePath) {
            // Prefer only the commits the remote lacks; fall back to the full history when
            // the remote-tracking refs give no usable boundary.
            try {
                await git.raw(['bundle', 'create', bundlePath, 'HEAD', '--not', '--remotes']);
            } catch {
                await git.raw(['bundle', 'create', bundlePath, 'HEAD']);
            }
            await git.raw(['bundle', 'verify', bundlePath]);
        },
        async retainWorktree() {
            await writeSalvageRetentionMarker(options.worktreePath, { taskId: options.taskId, branchName: options.branchName });
            // Free the branch so the next job for the same PR can check it out; the
            // worktree's detached HEAD keeps the commits reachable.
            await git.raw(['checkout', '--detach']).catch(error => {
                logger.warn({ worktreePath: options.worktreePath, error: errorMessage(error) }, 'Could not detach retained worktree HEAD');
            });
        },
    };
}
