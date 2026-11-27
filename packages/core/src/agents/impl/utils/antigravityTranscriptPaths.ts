import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import logger from '../../../utils/logger.js';

/**
 * Where a disposable task run's Antigravity transcript travels from the agent
 * container back to the worker.
 *
 * The worker creates one private directory per run and bind-mounts it
 * read-write at a fixed container path outside every other mount, in
 * particular outside the read-only `/tmp/git-processor` tree. The entrypoint
 * copies agy's `brain/**\/transcript.jsonl` there before `--rm` removes the
 * container, and the worker reads it after the run.
 */
export const DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT = '/tmp/git-processor/propr-cache/transcripts/antigravity';
export const ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR = '/tmp/propr-antigravity-transcript';
const TRANSCRIPT_FILE_NAME = 'transcript.jsonl';

export function antigravityTranscriptRoot(): string {
    return path.resolve(process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT || DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT);
}

/**
 * The host path the Docker daemon must bind for a worker-side transcript
 * directory. The default root lives under `/tmp/git-processor`, which the
 * launcher mounts at the same path on the host and in the worker. A custom root
 * that the host sees elsewhere names its host location in
 * `PROPR_ANTIGRAVITY_TRANSCRIPT_HOST_ROOT`.
 */
export function resolveAntigravityTranscriptHostPath(workerPath: string): string {
    const hostRoot = process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_HOST_ROOT;
    if (!hostRoot) return workerPath;
    const root = antigravityTranscriptRoot();
    const resolved = path.resolve(workerPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return workerPath;
    return path.join(hostRoot, path.relative(root, resolved));
}

/**
 * Creates the run's private transcript directory and returns the transcript
 * file path inside it, or undefined when the worker cannot create one: the run
 * then proceeds without a transcript rather than failing.
 */
export function createAntigravityTranscriptPath(taskId?: string): string | undefined {
    const root = antigravityTranscriptRoot();
    const safeTaskId = taskId?.slice(-80).replace(/[^a-zA-Z0-9_.-]/g, '-') || 'run';
    try {
        fs.mkdirSync(root, { recursive: true });
        const directory = fs.mkdtempSync(path.join(root, `${safeTaskId}-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}-`));
        return path.join(directory, TRANSCRIPT_FILE_NAME);
    } catch (error) {
        logger.warn({ taskId, transcriptRoot: root, error: (error as Error).message }, 'Could not create the Antigravity transcript directory; the run trace will lack transcript steps');
        return undefined;
    }
}

/** The container-side path the entrypoint exports the transcript to. */
export function containerAntigravityTranscriptPath(transcriptPath: string): string {
    return path.posix.join(ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR, path.basename(transcriptPath));
}

/** Docker arguments that carry the transcript out of the container. */
export function buildAntigravityTranscriptArgs(transcriptPath: string | undefined): string[] {
    if (!transcriptPath) return [];
    return [
        '-v', `${resolveAntigravityTranscriptHostPath(path.dirname(transcriptPath))}:${ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR}:rw`,
        '-e', `PROPR_ANTIGRAVITY_TRANSCRIPT_PATH=${containerAntigravityTranscriptPath(transcriptPath)}`,
    ];
}

/** Removes the run's transcript, and its private directory when it is one of ours. */
export function cleanupAntigravityTranscript(transcriptPath: string | undefined): void {
    if (!transcriptPath) return;
    const root = antigravityTranscriptRoot();
    const resolved = path.resolve(transcriptPath);
    if (!resolved.startsWith(`${root}${path.sep}`)) return;
    const directory = path.dirname(resolved);
    try {
        if (directory !== root) fs.rmSync(directory, { recursive: true, force: true });
        else fs.rmSync(resolved, { force: true });
    } catch { /* best-effort cleanup */ }
}
