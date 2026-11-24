/**
 * Opt-in idle shutdown for the control plane (issue #3770).
 *
 * The control plane runs continuously unless an operator turns this on. When
 * it is on, the daemon stops the instance after it has had nothing to do for
 * `PROPR_IDLE_SHUTDOWN_AFTER`, publishes a wake hint (the next due time of
 * scheduled work) and exits with code 0 so a supervisor with an `on-failure`
 * restart policy (a Fly Machine, systemd) leaves the host stopped until
 * something starts it again.
 *
 * This module holds only the pure, shared parts: the setting names, value
 * parsing, effective-setting resolution (environment, then the instance
 * setting, then off), the Redis keys the processes coordinate through and the
 * wire shapes the API, CLI and UI read.
 */

/** `.env` switch: `off` (default) or `on`. */
export const IDLE_SHUTDOWN_ENV = 'PROPR_IDLE_SHUTDOWN';
/** `.env` idle window, e.g. `15m`. */
export const IDLE_SHUTDOWN_AFTER_ENV = 'PROPR_IDLE_SHUTDOWN_AFTER';
/** Optional override for where the wake hint file is written. */
export const IDLE_WAKE_HINT_FILE_ENV = 'PROPR_IDLE_WAKE_HINT_FILE';
/** `system_configs` key holding the Web UI setting (`{ enabled, afterMs }`). */
export const IDLE_SHUTDOWN_SETTING = 'idle_shutdown';
/** Name of the wake hint file inside the data directory. */
export const IDLE_WAKE_HINT_FILENAME = 'idle-wake-hint.json';

export const DEFAULT_IDLE_SHUTDOWN_AFTER_MS = 15 * 60_000;
export const MIN_IDLE_SHUTDOWN_AFTER_MS = 60_000;
export const MAX_IDLE_SHUTDOWN_AFTER_MS = 24 * 60 * 60_000;

/** Daemon-published idle detector status, read by `/api/status` and `propr check`. */
export const IDLE_STATUS_REDIS_KEY = 'system:idle:status';
/** Most recent idle shutdown record. */
export const IDLE_LAST_SHUTDOWN_REDIS_KEY = 'system:idle:last_shutdown';
/** Most recent wake record (source and cold-start duration). */
export const IDLE_LAST_WAKE_REDIS_KEY = 'system:idle:last_wake';
/** First request after a wake, recorded by the API so the daemon can name the wake source. */
export const IDLE_WAKE_SIGNAL_REDIS_KEY = 'system:idle:wake_signal';
/** Per-process activity heartbeats: `system:idle:activity:<role>:<id>`. */
export const IDLE_ACTIVITY_REDIS_PREFIX = 'system:idle:activity:';
/** Pub/sub channel on which the daemon tells the API and workers to drain and exit. */
export const IDLE_SHUTDOWN_CHANNEL = 'system:idle:shutdown';
/**
 * Every API and worker process that takes part in idle shutdown registers
 * here (hash field `<role>:<id>`), refreshes its entry while it runs and
 * removes it on a clean stop. The daemon expects a fresh heartbeat (and, for
 * the API, a fresh activity record) from every entry before it may stop.
 */
export const IDLE_PARTICIPANTS_REDIS_KEY = 'system:idle:participants';
/**
 * The daemon's drain request, kept for as long as the drain runs so a process
 * that missed the pub/sub message (or reconnected) still finds it.
 */
export const IDLE_SHUTDOWN_INTENT_REDIS_KEY = 'system:idle:shutdown_intent';
/** Acknowledgements of one drain request: hash `<prefix><intentId>`, field `<phase>:<role>:<id>`. */
export const IDLE_SHUTDOWN_ACKS_REDIS_PREFIX = 'system:idle:shutdown_acks:';

export type IdleShutdownSource = 'environment' | 'settings' | 'default';

export interface StoredIdleShutdownSetting {
    enabled: boolean;
    afterMs: number;
}

export interface IdleShutdownConfig {
    enabled: boolean;
    afterMs: number;
    /** Where `enabled`/`afterMs` came from; the environment always wins. */
    source: IdleShutdownSource;
    /** Invalid values that were ignored, for logs and `propr check`. */
    warnings: string[];
}

const DURATION_PART = /(\d+)\s*(ms|s|m|h)/gy;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse an idle window such as `15m`, `90s`, `1h30m` or `2h`. A bare integer
 * is minutes. Returns null for anything else, including values outside
 * [1 minute, 24 hours].
 */
export function parseIdleShutdownDuration(raw: unknown): number | null {
    if (typeof raw === 'number') return boundDuration(raw);
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    if (value === '') return null;
    if (/^\d+$/.test(value)) return boundDuration(Number(value) * 60_000);
    DURATION_PART.lastIndex = 0;
    let total = 0;
    let consumed = 0;
    for (let match = DURATION_PART.exec(value); match; match = DURATION_PART.exec(value)) {
        total += Number(match[1]) * UNIT_MS[match[2]];
        consumed = DURATION_PART.lastIndex;
        while (value[consumed] === ' ') consumed += 1;
        DURATION_PART.lastIndex = consumed;
    }
    return consumed === value.length ? boundDuration(total) : null;
}

function boundDuration(ms: number): number | null {
    if (!Number.isSafeInteger(ms)) return null;
    return ms >= MIN_IDLE_SHUTDOWN_AFTER_MS && ms <= MAX_IDLE_SHUTDOWN_AFTER_MS ? ms : null;
}

/** `on`/`off` and the usual boolean spellings; null when unset or unrecognized. */
export function parseIdleShutdownSwitch(raw: unknown): boolean | null {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    if (['on', 'true', '1', 'yes', 'enabled'].includes(value)) return true;
    if (['off', 'false', '0', 'no', 'disabled'].includes(value)) return false;
    return null;
}

/** Render a window back to the `.env` form (`15m`, `1h30m`, `90s`). */
export function formatIdleShutdownDuration(ms: number): string {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    const parts = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''].filter(Boolean);
    return parts.length > 0 ? parts.join('') : `${ms}ms`;
}

/** Validate a stored instance setting; null when it is missing or malformed. */
export function parseStoredIdleShutdownSetting(raw: unknown): StoredIdleShutdownSetting | null {
    if (!raw || typeof raw !== 'object') return null;
    const { enabled, afterMs } = raw as Record<string, unknown>;
    const after = parseIdleShutdownDuration(afterMs);
    if (typeof enabled !== 'boolean' || after === null) return null;
    return { enabled, afterMs: after };
}

/**
 * Read a stored instance setting: null when there is none, the setting when
 * it is well formed, and an error when a setting is present but malformed.
 * A malformed setting is not "no setting": falling back to the default would
 * let the environment switch stop the instance after a window nobody chose.
 */
export function readStoredIdleShutdownSetting(raw: unknown): StoredIdleShutdownSetting | null {
    if (raw === null || raw === undefined) return null;
    const setting = parseStoredIdleShutdownSetting(raw);
    if (!setting) throw new Error(`The stored ${IDLE_SHUTDOWN_SETTING} setting is malformed; expected { enabled: boolean, afterMs: 1m to 24h }`);
    return setting;
}

function hasValue(value: string | undefined): value is string {
    return value !== undefined && value.trim() !== '';
}

/**
 * The effective setting. Each field resolves on its own: a field set in the
 * environment wins (and is shown read-only in the Web UI), then the instance
 * setting saved from the Web UI, then the default (off, 15 minutes). An
 * invalid environment value is reported and ignored, so a typo never turns
 * idle shutdown on. A present but malformed instance setting throws (see
 * `readStoredIdleShutdownSetting`).
 */
export function resolveIdleShutdownConfig(
    env: Record<string, string | undefined>,
    stored: unknown = null,
): IdleShutdownConfig {
    const warnings: string[] = [];
    const setting = readStoredIdleShutdownSetting(stored);
    const rawSwitch = env[IDLE_SHUTDOWN_ENV];
    const rawAfter = env[IDLE_SHUTDOWN_AFTER_ENV];
    let enabled = setting?.enabled ?? false;
    let afterMs = setting?.afterMs ?? DEFAULT_IDLE_SHUTDOWN_AFTER_MS;
    let source: IdleShutdownSource = setting ? 'settings' : 'default';
    if (hasValue(rawSwitch)) {
        const parsed = parseIdleShutdownSwitch(rawSwitch);
        if (parsed === null) warnings.push(`${IDLE_SHUTDOWN_ENV}="${rawSwitch}" is not "on" or "off"; idle shutdown stays off`);
        enabled = parsed ?? false;
        source = 'environment';
    }
    if (hasValue(rawAfter)) {
        const parsed = parseIdleShutdownDuration(rawAfter);
        if (parsed === null) {
            warnings.push(`${IDLE_SHUTDOWN_AFTER_ENV}="${rawAfter}" is not a duration between 1m and 24h; using ${formatIdleShutdownDuration(afterMs)}`);
        } else {
            afterMs = parsed;
        }
    }
    return { enabled, afterMs, source, warnings };
}

/** Whether the environment pins the setting, so the Web UI cannot change it. */
export function isIdleShutdownEnvironmentManaged(env: Record<string, string | undefined>): boolean {
    return hasValue(env[IDLE_SHUTDOWN_ENV]) || hasValue(env[IDLE_SHUTDOWN_AFTER_ENV]);
}

/** The signals the idle detector looks at; each blocker names one. */
export const IDLE_SIGNALS = [
    'queue_jobs',
    'agent_runs',
    'ui_sessions',
    'mcp_requests',
    'http_requests',
    'followup_handoffs',
    'connect_deliveries',
    'goals',
    'ultrafix_loops',
    'scheduled_work',
    'unavailable',
] as const;
export type IdleSignal = typeof IDLE_SIGNALS[number];

export interface IdleBlocker {
    signal: IdleSignal;
    detail: string;
}

/** A scheduled item and when it is next due (epoch ms). */
export interface ScheduledItem {
    kind: 'automation' | 'deferred_automation_run' | 'delayed_job' | 'polling' | 'ultrafix_retry';
    dueAt: number;
    detail: string;
}

/** What wakes a stopped instance. */
export type IdleWakeSource = 'http' | 'connect_ping' | 'schedule' | 'unknown';

/** Written before an idle exit; read back on the next start. */
export interface IdleWakeHint {
    version: 1;
    shutdownAt: string;
    reason: string;
    idleForMs: number;
    /** Next due time of scheduled work (ISO), or null when nothing is scheduled. */
    nextDueAt: string | null;
    nextDue: ScheduledItem[];
    /** Set once a start has consumed this hint, so a later plain restart is not counted as a wake. */
    wokeAt?: string;
    /**
     * Stopped with Connect intake: `pending` until the relay has accepted the
     * replay of deliveries cached while stopped, then `accepted`. A start
     * keeps asking (and leaves the hint pending) until the relay accepts.
     */
    connectReplay?: 'pending' | 'accepted';
    /**
     * Earliest stop whose cached deliveries the relay has not yet accepted to
     * replay (ISO). Set when this stop was made while an earlier stop's replay
     * was still pending, so the replay cursor survives the hint replacement;
     * absent means `shutdownAt`.
     */
    replaySince?: string;
    /**
     * When this stop disconnected Connect intake (ISO), taken before the
     * disconnect: deliveries the relay cached from then on are this stop's
     * to replay. Absent on hints written before it existed (`shutdownAt`).
     */
    intakeStoppedAt?: string;
}

export interface IdleWakeRecord {
    wokeAt: string;
    source: IdleWakeSource;
    /** Process start to daemon ready, in ms. */
    coldStartMs: number;
    /** How long the instance was stopped, in ms. */
    sleptMs: number | null;
    shutdownAt: string | null;
}

export interface IdleShutdownRecord {
    shutdownAt: string;
    reason: string;
    idleForMs: number;
    nextDueAt: string | null;
}

/** Shape of `IDLE_STATUS_REDIS_KEY` and the `idleShutdown` field of `/api/status`. */
export interface IdleShutdownStatus {
    enabled: boolean;
    afterMs: number;
    source: IdleShutdownSource;
    idle: boolean;
    idleSince: string | null;
    /** When the instance will stop if nothing changes. */
    shutdownAt: string | null;
    blockers: IdleBlocker[];
    nextDueAt: string | null;
    checkedAt: string;
    lastShutdown: IdleShutdownRecord | null;
    lastWake: IdleWakeRecord | null;
}

/** Defensive parse of a published status (it crosses Redis and HTTP). */
export function parseIdleShutdownStatus(raw: unknown): IdleShutdownStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<IdleShutdownStatus>;
    if (typeof value.enabled !== 'boolean' || typeof value.idle !== 'boolean' || typeof value.afterMs !== 'number') return null;
    if (!Array.isArray(value.blockers) || typeof value.checkedAt !== 'string') return null;
    return value as IdleShutdownStatus;
}
