/**
 * Worktree admission refusals for disk pressure, and what was measured.
 *
 * A refusal must be diagnosable after the fact: did the disk really run low,
 * or did `readers/` claims leak (a live worker that never released one is never
 * reclaimed as "owner gone")? So the error carries the numbers admission
 * compared, and its message spells them out in human-readable units. Only the
 * message survives a BullMQ round-trip, so the details are in it too, and
 * `worktreeDiskPressureDetails` recovers them from either form.
 */

/** What admission measured when it refused a job. */
export interface WorktreeDiskPressureMeasurement {
  /** The filesystem path that was measured (the nearest existing ancestor of the worktree base). */
  filesystem: string;
  /** `bavail * bsize` of that filesystem. */
  freeBytes: number;
  /** Instance reserve kept free beyond all claims. */
  reserveBytes: number;
  /** Summed `reservedBytes` of the other jobs' claims. */
  reservedBytes: number;
  /** Number of other claims that reserve bytes. */
  claimCount: number;
  /** The requesting job's own reservation. */
  taskBytes: number;
}

/** One counted claim, for the per-refusal claim listing. */
export interface CountedStorageClaim {
  file: string;
  reservedBytes: number;
  owner?: { host: string; pid: number };
  /** Milliseconds since the claim file was last written. */
  ageMs: number;
}

const PREFIX = 'Worktree disk pressure: admission reserve unavailable';
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Bytes in binary units with one decimal (6.2 GiB); whole bytes below 1 KiB. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** A duration as `3h 12m`, `4m 05s` or `12s`. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `filesystem /x: free 6.2 GiB < required 7.0 GiB = reserve 2.0 GiB + 4 other claims × 1.0 GiB + this job 1.0 GiB` */
export function formatWorktreeDiskPressure(m: WorktreeDiskPressureMeasurement): string {
  const required = m.reserveBytes + m.reservedBytes + m.taskBytes;
  const claims = m.claimCount === 0
    ? '0 other claims'
    : m.reservedBytes % m.claimCount === 0
      ? `${m.claimCount} other claim${m.claimCount === 1 ? '' : 's'} × ${formatBytes(m.reservedBytes / m.claimCount)}`
      : `${m.claimCount} other claims totalling ${formatBytes(m.reservedBytes)}`;
  return `filesystem ${m.filesystem}: free ${formatBytes(m.freeBytes)} < required ${formatBytes(required)} `
    + `= reserve ${formatBytes(m.reserveBytes)} + ${claims} + this job ${formatBytes(m.taskBytes)}`;
}

/** The message of a refusal: the fixed prefix, then what was measured. */
export function worktreeDiskPressureMessage(summary: string, measurement?: WorktreeDiskPressureMeasurement): string {
  return `${PREFIX}${summary}; data retained${measurement ? ` (${formatWorktreeDiskPressure(measurement)})` : ''}`;
}

/**
 * Admission refused a task because the worktree filesystem is below its
 * reserve. Thrown before the task's processor runs, so the processor's own
 * failure reporting never sees it; callers that owe someone an answer (a PR
 * comment job, for instance) recognise it by name.
 */
export class WorktreeDiskPressureError extends Error {
  readonly measurement?: WorktreeDiskPressureMeasurement;
  constructor(measurement?: WorktreeDiskPressureMeasurement) {
    super(worktreeDiskPressureMessage('', measurement));
    this.name = 'WorktreeDiskPressureError';
    if (measurement) this.measurement = { ...measurement };
  }
}

/** True for the admission refusal above, whether or not the instance survived a queue round-trip. */
export function isWorktreeDiskPressureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'WorktreeDiskPressureError' || error.message.startsWith('Worktree disk pressure:');
}

function isMeasurement(value: unknown): value is WorktreeDiskPressureMeasurement {
  const m = value as Partial<WorktreeDiskPressureMeasurement> | null;
  return !!m && typeof m.filesystem === 'string'
    && [m.freeBytes, m.reserveBytes, m.reservedBytes, m.claimCount, m.taskBytes].every(n => typeof n === 'number' && Number.isFinite(n));
}

/** The measurement a refusal carries, when it is still the original instance (or a copy of its fields). */
export function worktreeDiskPressureMeasurementOf(error: unknown): WorktreeDiskPressureMeasurement | null {
  const measurement = (error as { measurement?: unknown } | null)?.measurement;
  return isMeasurement(measurement) ? { ...measurement } : null;
}

/** The human-readable measurement of a refusal, from the instance or from its message after a queue round-trip. */
export function worktreeDiskPressureDetails(error: unknown): string | null {
  const measurement = worktreeDiskPressureMeasurementOf(error);
  if (measurement) return formatWorktreeDiskPressure(measurement);
  if (!(error instanceof Error) || !isWorktreeDiskPressureError(error)) return null;
  return measurementFromMessage(error.message);
}

/**
 * The trailing `(filesystem … this job <size>)` of a refusal message. Parsed
 * with plain string searches rather than a regular expression: the message can
 * come back from the queue with arbitrary content, and a backtracking pattern
 * over it is polynomial in its length.
 */
function measurementFromMessage(message: string): string | null {
  if (!message.endsWith(')')) return null;
  const start = message.indexOf('(filesystem ');
  if (start < 0) return null;
  const inner = message.slice(start + 1, -1);
  const jobAt = inner.lastIndexOf(' this job ');
  if (jobAt <= 'filesystem'.length) return null;
  const size = inner.slice(jobAt + ' this job '.length);
  return size.length > 0 && !size.includes(')') ? inner : null;
}

/** Log fields of a refusal: the raw numbers and the readable sentence. */
export function worktreeDiskPressureLogFields(error: unknown): Record<string, unknown> {
  const measurement = worktreeDiskPressureMeasurementOf(error);
  const details = worktreeDiskPressureDetails(error);
  return { ...(measurement ? { diskPressure: measurement } : {}), ...(details ? { diskPressureDetails: details } : {}) };
}

/** The per-refusal warning that lists every counted claim, so leaked ones are visible. */
export function formatCountedClaims(measurement: WorktreeDiskPressureMeasurement, claims: CountedStorageClaim[], ownClaim?: string): string {
  const lines = claims.map(claim => {
    const owner = claim.owner ? `${claim.owner.host} pid ${claim.owner.pid}` : 'unknown owner';
    return `  ${claim.file}${claim.file === ownClaim ? ' (this job)' : ''}: ${formatBytes(claim.reservedBytes)}, owner ${owner}, age ${formatAge(claim.ageMs)}`;
  });
  return `[storage] Worktree admission refused (${formatWorktreeDiskPressure(measurement)}); `
    + `${claims.length} claim${claims.length === 1 ? '' : 's'} counted:${lines.length ? `\n${lines.join('\n')}` : ' none'}`;
}
