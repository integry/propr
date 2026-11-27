import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Pi keeps a goal's conversation in session files. The run's Pi home is
 * disposable (pi-entrypoint.sh recreates it every run), so a goal's sessions
 * live in a per-goal host directory instead, mounted here. It is outside the
 * disposable home, so the entrypoint never deletes or reseeds it.
 */
export const PI_CONTAINER_GOAL_SESSION_DIR = '/home/node/.propr-pi-goal-session';
/** pi-entrypoint.sh makes this mounted directory owner-only before and after the run. */
export const PI_GOAL_SESSION_DIR_ENV = 'PROPR_PI_GOAL_SESSION_DIR';
const DEFAULT_PI_GOAL_SESSIONS_ROOT = path.join('/tmp/git-processor', 'pi-goal-sessions');

/** Pi session IDs and goal IDs both use letters, digits, `.`, `_` and `-`, starting and ending alphanumeric. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

/** Where every goal's Pi sessions live on the host; one owner-only subdirectory per goal. */
export function piGoalSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(environment.PI_GOAL_SESSIONS_PATH || DEFAULT_PI_GOAL_SESSIONS_ROOT);
}

function assertSafeIdentifier(value: string, kind: string): void {
    if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Invalid ${kind} for a Pi goal session: ${JSON.stringify(value)}`);
}

export function piGoalSessionDir(goalId: string, root: string = piGoalSessionsRoot()): string {
    assertSafeIdentifier(goalId, 'goal ID');
    return path.join(root, goalId);
}

export interface PiGoalSession {
    /** Host directory mounted at {@link PI_CONTAINER_GOAL_SESSION_DIR}. */
    hostDir: string;
    sessionId: string;
    /** Saved session file name when resuming; absent for a new session. */
    resumeFile?: string;
}

/**
 * The saved session file for `sessionId`, if any. Pi names session files
 * `<timestamp>_<id>.jsonl`; the newest one wins if a run ever wrote two.
 */
export function findPiGoalSessionFile(hostDir: string, sessionId: string): string | undefined {
    let names: string[];
    try { names = fs.readdirSync(hostDir); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    const suffix = `_${sessionId}.jsonl`;
    return names.filter(name => name.endsWith(suffix) && fs.statSync(path.join(hostDir, name)).isFile()).sort().pop();
}

function ensureOwnerOnlyDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
}

/**
 * Prepares the goal's session store and decides how Pi opens its session: a
 * new session under a ProPR-assigned ID, or the exact saved session file.
 *
 * Pi silently starts an empty session when `--session` names a file that does
 * not exist, so a resume whose file is gone fails here instead of continuing
 * the goal without its conversation.
 */
export function preparePiGoalSession(goalId: string, resumeSessionId?: string, root: string = piGoalSessionsRoot()): PiGoalSession {
    const hostDir = piGoalSessionDir(goalId, root);
    ensureOwnerOnlyDir(root);
    ensureOwnerOnlyDir(hostDir);
    if (!resumeSessionId) return { hostDir, sessionId: randomUUID() };
    assertSafeIdentifier(resumeSessionId, 'session ID');
    const resumeFile = findPiGoalSessionFile(hostDir, resumeSessionId);
    if (!resumeFile) {
        throw new Error(`Pi goal session ${resumeSessionId} is missing from the goal's session store (${hostDir}); its conversation cannot be resumed`);
    }
    return { hostDir, sessionId: resumeSessionId, resumeFile };
}

/** `--session-id` creates the session under the assigned ID; `--session <file>` reopens the exact saved one. */
export function piGoalSessionCliArgs(session: PiGoalSession): string[] {
    return [
        '--session-dir', PI_CONTAINER_GOAL_SESSION_DIR,
        ...(session.resumeFile
            ? ['--session', path.posix.join(PI_CONTAINER_GOAL_SESSION_DIR, session.resumeFile)]
            : ['--session-id', session.sessionId]),
    ];
}

/** Removes a goal's saved Pi sessions; used when the goal is deleted. */
export async function removePiGoalSessions(goalId: string, root: string = piGoalSessionsRoot()): Promise<void> {
    await fs.promises.rm(piGoalSessionDir(goalId, root), { recursive: true, force: true });
}

/**
 * Watches `pi --mode json` records for the moment the session is saved: Pi
 * writes the session file when the first user message is appended, so the
 * session header followed by that message's `message_end` means the prompt is
 * on disk and the session can be resumed. Returns the session ID once, and
 * only for `expectedSessionId` when one is given.
 */
export function createPiSessionSavedDetector(expectedSessionId?: string): (line: string) => string | undefined {
    let headerId: string | undefined;
    let reported = false;
    return line => {
        if (reported || !line.trim()) return undefined;
        let record: { type?: string; id?: unknown; message?: { role?: string } };
        try { record = JSON.parse(line); } catch { return undefined; }
        // Another session is never the goal's: its identity must not be saved.
        if (record?.type === 'session' && typeof record.id === 'string') headerId = !expectedSessionId || record.id === expectedSessionId ? record.id : undefined;
        else if (headerId && record?.type === 'message_end' && record.message?.role === 'user') {
            reported = true;
            return headerId;
        }
        return undefined;
    };
}
