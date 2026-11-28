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
/**
 * The mounted directory stays owned by the worker (whatever its UID); nothing
 * chowns it. When the worker is not the container's node user, pi-entrypoint.sh
 * opens it to node for the run (mode 0707) and returns it to 0700 afterwards.
 * A run killed before that leaves it 0707, which {@link preparePiGoalSession}
 * restores to 0700 as its owner before listing it. The session files in it are
 * owned by node and owner-only, so the worker lists and deletes them but never
 * reads them.
 */
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
        throw sessionStoreAccessError(error, hostDir, 'list');
    }
    const suffix = `_${sessionId}.jsonl`;
    return names.filter(name => name.endsWith(suffix) && fs.statSync(path.join(hostDir, name)).isFile()).sort().pop();
}

function isPermissionError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EACCES' || code === 'EPERM';
}

/** EACCES/EPERM as an actionable error: the store is owned by another user than this worker. */
function sessionStoreAccessError(error: unknown, dir: string, action: string): unknown {
    if (!isPermissionError(error)) return error;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return new Error(
        `Cannot ${action} the Pi goal session store ${dir}: permission denied for ProPR's user${uid === undefined ? '' : ` (UID ${uid})`}. ` +
        'It must be owned by the user ProPR runs as; fix its ownership (for example chown it to that user) and retry.',
        { cause: error },
    );
}

/**
 * Creates the directory owner-only; an existing one is only chmodded when it is
 * not owner-only already, e.g. a goal store a killed run left open to node.
 */
function ensureOwnerOnlyDir(dir: string): void {
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    } catch (error) {
        throw sessionStoreAccessError(error, dir, 'prepare');
    }
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
    const dir = piGoalSessionDir(goalId, root);
    try { await fs.promises.rm(dir, { recursive: true, force: true }); }
    catch (error) { throw sessionStoreAccessError(error, dir, 'delete'); }
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
