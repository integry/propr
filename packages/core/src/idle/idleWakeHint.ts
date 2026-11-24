/**
 * Wake hint persistence for idle shutdown (issue #3770).
 *
 * Before an idle exit the daemon writes the next due time of scheduled work
 * to `<DATA_DIR>/idle-wake-hint.json` (or `PROPR_IDLE_WAKE_HINT_FILE`), so a
 * supervisor that is not Connect (a systemd timer, a cron job, a wake-on-LAN
 * script) can start the host in time. The same file tells the next start that
 * it is waking from an idle stop rather than a plain restart, and the start
 * marks it consumed so a later restart is not counted as a wake again.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    IDLE_WAKE_HINT_FILE_ENV,
    IDLE_WAKE_HINT_FILENAME,
    type IdleWakeHint,
    type IdleWakeRecord,
    type IdleWakeSource,
    type ScheduledItem,
} from '@propr/shared';

export function resolveIdleWakeHintPath(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env[IDLE_WAKE_HINT_FILE_ENV]?.trim();
    if (configured) return path.resolve(configured);
    const dataDir = env.DATA_DIR ?? path.join(process.cwd(), 'data');
    return path.join(dataDir, IDLE_WAKE_HINT_FILENAME);
}

export function buildIdleWakeHint(input: {
    shutdownAt: number;
    reason: string;
    idleForMs: number;
    nextDue: ScheduledItem[];
}): IdleWakeHint {
    const first = [...input.nextDue].sort((a, b) => a.dueAt - b.dueAt)[0];
    return {
        version: 1,
        shutdownAt: new Date(input.shutdownAt).toISOString(),
        reason: input.reason,
        idleForMs: input.idleForMs,
        nextDueAt: first ? new Date(first.dueAt).toISOString() : null,
        nextDue: input.nextDue,
    };
}

/** Write atomically (temp file + rename) so a supervisor never reads a torn file. */
export async function writeIdleWakeHint(hint: IdleWakeHint, file: string = resolveIdleWakeHintPath()): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(hint, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    await rename(temporary, file);
}

export async function readIdleWakeHint(file: string = resolveIdleWakeHintPath()): Promise<IdleWakeHint | null> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch {
        return null;
    }
    try {
        const value = JSON.parse(raw) as Partial<IdleWakeHint>;
        if (value.version !== 1 || typeof value.shutdownAt !== 'string' || Number.isNaN(Date.parse(value.shutdownAt))) return null;
        return {
            version: 1,
            shutdownAt: value.shutdownAt,
            reason: typeof value.reason === 'string' ? value.reason : 'idle',
            idleForMs: typeof value.idleForMs === 'number' ? value.idleForMs : 0,
            nextDueAt: typeof value.nextDueAt === 'string' ? value.nextDueAt : null,
            nextDue: Array.isArray(value.nextDue) ? value.nextDue : [],
            ...(typeof value.wokeAt === 'string' ? { wokeAt: value.wokeAt } : {}),
        };
    } catch {
        return null;
    }
}

/** How close to a hinted due time a start must be to count as a scheduled wake. */
export const SCHEDULE_WAKE_TOLERANCE_MS = 2 * 60_000;

/**
 * Name what woke the instance. A request the API saw first (the Connect wake
 * ping at `/wake`, or any other HTTP request through the Fly proxy) wins;
 * otherwise a start at or after the hinted due time is a scheduled wake.
 */
export function classifyIdleWake(input: {
    hint: IdleWakeHint;
    now: number;
    apiSignal: IdleWakeSource | null;
}): IdleWakeSource {
    if (input.apiSignal === 'connect_ping' || input.apiSignal === 'http') return input.apiSignal;
    const due = input.hint.nextDueAt ? Date.parse(input.hint.nextDueAt) : Number.NaN;
    if (Number.isFinite(due) && input.now >= due - SCHEDULE_WAKE_TOLERANCE_MS) return 'schedule';
    return 'unknown';
}

export function buildIdleWakeRecord(input: {
    hint: IdleWakeHint;
    source: IdleWakeSource;
    now: number;
    processStartedAt: number;
}): IdleWakeRecord {
    const shutdownAt = Date.parse(input.hint.shutdownAt);
    return {
        wokeAt: new Date(input.now).toISOString(),
        source: input.source,
        coldStartMs: Math.max(0, Math.round(input.now - input.processStartedAt)),
        sleptMs: Number.isFinite(shutdownAt) ? Math.max(0, input.processStartedAt - shutdownAt) : null,
        shutdownAt: input.hint.shutdownAt,
    };
}

/** Whether a start is waking from an idle stop recorded in `hint`. */
export function isPendingIdleWake(hint: IdleWakeHint | null): hint is IdleWakeHint {
    return hint !== null && hint.wokeAt === undefined;
}
