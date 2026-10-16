/**
 * Strict row codec for persisted resume-resync records. A record is the only
 * thing that can make this Core send (or resend) `resync_complete`, so decoding
 * fails closed: unknown fields, malformed identities or timestamps, out-of-bound
 * collections and counters, states inconsistent with their completion, and
 * completion evidence whose digest does not match the persisted progress are all
 * rejected rather than repaired or guessed.
 */

import { createHash } from 'node:crypto';
import { isAccountStatusTimestamp } from '@propr/shared';
import {
    RESYNC_GITHUB_DEPENDENT_FAMILIES,
    RESYNC_INSTALLATION_FAMILIES,
    RESYNC_REPOSITORY_FAMILIES,
} from './routingResumeResyncMatrix.js';
import type { ResyncCompletion, ResyncCompletionEvidence } from './routingResumeResyncProtocol.js';
import type { RepositoryResyncProgress, ResumeResyncRecord, ResumeResyncState } from './routingResumeResyncStore.js';

/** Repositories tracked for one generation; a larger set fails the attempt closed. */
export const MAX_RESYNC_REPOSITORIES = 1000;
/** Longest persisted `owner/name`. */
const MAX_REPOSITORY_NAME_LENGTH = 201;
/** Persisted counters (attempts, failures) beyond this are corrupt. */
const MAX_COUNTER = 1_000_000;
/** Persisted error text bound (repository-level errors are 300 characters). */
export const MAX_PERSISTED_ERROR_LENGTH = 1024;
const MAX_PROGRESS_JSON_BYTES = 1024 * 1024;
const MAX_COMPLETION_JSON_BYTES = 8 * 1024;
const MAX_COMPLETION_ID_LENGTH = 128;

const STATES: readonly ResumeResyncState[] = ['pending', 'reconciling', 'partial', 'failed', 'completed', 'acknowledged'];
const REPOSITORY_STATUSES = ['pending', 'reconciled', 'inaccessible', 'failed'];
const REPOSITORY_FAMILIES: readonly string[] = RESYNC_REPOSITORY_FAMILIES;
const GITHUB_DEPENDENT: readonly string[] = RESYNC_GITHUB_DEPENDENT_FAMILIES;
const INSTALLATION_FAMILIES: readonly string[] = RESYNC_INSTALLATION_FAMILIES;
const ALL_FAMILIES = [...REPOSITORY_FAMILIES, ...INSTALLATION_FAMILIES];
/** GitHub owners have no dots; a repository name may, but is never `.` or `..`. */
const REPOSITORY_NAME = /^[A-Za-z0-9_-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

/** Whether `owner/name` is a repository name the codec will persist. */
export function isResyncRepositoryName(repository: string): boolean {
    return repository.length <= MAX_REPOSITORY_NAME_LENGTH && REPOSITORY_NAME.test(repository);
}

export interface ResumeResyncRow {
    installation_id: number | string;
    routing_generation: number | string;
    resume_generation: number | string;
    state: string;
    gap_started_at: string;
    gap_ended_at: string | null;
    attempts: number;
    started_at: string | null;
    last_attempt_at: string | null;
    next_retry_at: string | null;
    last_error: string | null;
    progress_json: string;
    completion_json: string | null;
    acknowledged_at: string | null;
    updated_at: string;
}

class CorruptResumeResyncRecordError extends Error {
    constructor(detail: string) {
        super(`Unrecognized persisted resume-resync ${detail}`);
        this.name = 'CorruptResumeResyncRecordError';
    }
}

function corrupt(detail: string): never {
    throw new CorruptResumeResyncRecordError(detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value: unknown, keys: readonly string[], detail: string): Record<string, unknown> {
    if (!isPlainObject(value)) corrupt(detail);
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !actual.every(key => keys.includes(key))) corrupt(detail);
    return value;
}

function counter(value: unknown, detail: string, min = 0): number {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || (parsed as number) < min || (parsed as number) > MAX_COUNTER) corrupt(detail);
    return parsed as number;
}

function identity(value: unknown, detail: string): number {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) corrupt(detail);
    return parsed as number;
}

function timestamp(value: unknown, detail: string): string {
    if (!isAccountStatusTimestamp(value)) corrupt(detail);
    return value;
}

function optionalTimestamp(value: unknown, detail: string): string | null {
    return value === null || value === undefined ? null : timestamp(value, detail);
}

function optionalText(value: unknown, max: number, detail: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.length > max) corrupt(detail);
    return value;
}

function families(value: unknown, allowed: readonly string[], detail: string): string[] {
    if (!Array.isArray(value) || value.length > allowed.length) corrupt(detail);
    const seen = new Set<string>();
    for (const family of value) {
        if (typeof family !== 'string' || !allowed.includes(family) || seen.has(family)) corrupt(detail);
        seen.add(family);
    }
    return [...value] as string[];
}

function parseJson(raw: unknown, maxBytes: number, detail: string): unknown {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) corrupt(detail);
    try {
        return JSON.parse(raw);
    } catch {
        return corrupt(detail);
    }
}

const PROGRESS_KEYS = ['status', 'completedFamilies', 'inapplicableFamilies', 'access', 'configured', 'attempts', 'lastError', 'updatedAt'];

function decodeRepositoryProgress(repository: string, value: unknown): RepositoryResyncProgress {
    const detail = `progress for ${repository.slice(0, MAX_REPOSITORY_NAME_LENGTH)}`;
    const entry = exactObject(value, PROGRESS_KEYS, detail);
    if (!REPOSITORY_STATUSES.includes(entry.status as string)) corrupt(detail);
    if (entry.access !== null && entry.access !== 'accessible' && entry.access !== 'inaccessible') corrupt(detail);
    if (typeof entry.configured !== 'boolean') corrupt(detail);
    const progress: RepositoryResyncProgress = {
        status: entry.status as RepositoryResyncProgress['status'],
        completedFamilies: families(entry.completedFamilies, REPOSITORY_FAMILIES, detail),
        inapplicableFamilies: families(entry.inapplicableFamilies, GITHUB_DEPENDENT, detail),
        access: entry.access as RepositoryResyncProgress['access'],
        configured: entry.configured,
        attempts: counter(entry.attempts, detail),
        lastError: optionalText(entry.lastError, MAX_PERSISTED_ERROR_LENGTH, detail),
        updatedAt: optionalTimestamp(entry.updatedAt, detail),
    };
    // Inapplicability needs evidence, and a family cannot be both outcomes.
    if (progress.inapplicableFamilies.length > 0 && progress.access !== 'inaccessible' && progress.configured) corrupt(detail);
    if (progress.inapplicableFamilies.some(family => progress.completedFamilies.includes(family))) corrupt(detail);
    // Converged outcomes must agree with the access they were reconciled under.
    if (progress.status === 'inaccessible' && progress.access !== 'inaccessible') corrupt(detail);
    if (progress.status === 'reconciled' && progress.access === 'inaccessible') corrupt(detail);
    return progress;
}

function decodeProgress(raw: unknown): Pick<ResumeResyncRecord, 'repositories' | 'installationFamilies' | 'consecutiveFailures'> {
    const progress = exactObject(parseJson(raw, MAX_PROGRESS_JSON_BYTES, 'progress'), ['repositories', 'installationFamilies', 'consecutiveFailures'], 'progress');
    if (!isPlainObject(progress.repositories)) corrupt('progress');
    const entries = Object.entries(progress.repositories);
    if (entries.length > MAX_RESYNC_REPOSITORIES) corrupt('progress (repository bound exceeded)');
    const repositories: Record<string, RepositoryResyncProgress> = {};
    const seen = new Set<string>();
    for (const [repository, value] of entries) {
        if (!isResyncRepositoryName(repository) || seen.has(repository.toLowerCase())) {
            corrupt('progress (repository name)');
        }
        seen.add(repository.toLowerCase());
        repositories[repository] = decodeRepositoryProgress(repository, value);
    }
    return {
        repositories,
        installationFamilies: families(progress.installationFamilies, INSTALLATION_FAMILIES, 'progress'),
        consecutiveFailures: counter(progress.consecutiveFailures, 'progress'),
    };
}

function decodeEvidence(value: unknown): ResyncCompletionEvidence {
    const evidence = exactObject(value, ['repositories', 'families', 'attempts', 'digest'], 'completion evidence');
    const counts = exactObject(evidence.repositories, ['total', 'reconciled', 'inaccessible', 'unconfigured'], 'completion evidence');
    const repositories = {
        total: counter(counts.total, 'completion evidence'),
        reconciled: counter(counts.reconciled, 'completion evidence'),
        inaccessible: counter(counts.inaccessible, 'completion evidence'),
        unconfigured: counter(counts.unconfigured, 'completion evidence'),
    };
    if (repositories.total > MAX_RESYNC_REPOSITORIES
        || repositories.reconciled + repositories.inaccessible + repositories.unconfigured !== repositories.total) corrupt('completion evidence');
    if (typeof evidence.digest !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.digest)) corrupt('completion evidence');
    return {
        repositories,
        families: families(evidence.families, ALL_FAMILIES, 'completion evidence'),
        attempts: counter(evidence.attempts, 'completion evidence', 1),
        digest: evidence.digest,
    };
}

function decodeCompletion(raw: unknown): ResyncCompletion | null {
    if (raw === null || raw === undefined) return null;
    const completion = exactObject(parseJson(raw, MAX_COMPLETION_JSON_BYTES, 'completion'), ['completionId', 'completedAt', 'evidence'], 'completion');
    if (typeof completion.completionId !== 'string' || completion.completionId.length === 0
        || completion.completionId.length > MAX_COMPLETION_ID_LENGTH) corrupt('completion');
    return {
        completionId: completion.completionId,
        completedAt: timestamp(completion.completedAt, 'completion'),
        evidence: decodeEvidence(completion.evidence),
    };
}

/** Bounded, non-secret digest over every per-repository outcome; names stay local. */
export function computeResyncDigest(record: Pick<ResumeResyncRecord, 'repositories' | 'installationFamilies'>): string {
    const outcomes = Object.entries(record.repositories)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([repository, progress]) => [
            repository.toLowerCase(), progress.status, progress.access, progress.configured,
            [...progress.completedFamilies].sort(), [...progress.inapplicableFamilies].sort(),
        ]);
    return createHash('sha256')
        .update(JSON.stringify({ outcomes, installation: [...record.installationFamilies].sort() }))
        .digest('hex');
}

/** Evidence counts: accessible+configured, inaccessible, and accessible but no longer configured. */
export function countResyncOutcomes(repositories: Record<string, RepositoryResyncProgress>): ResyncCompletionEvidence['repositories'] {
    const entries = Object.values(repositories);
    const inaccessible = entries.filter(progress => progress.status === 'inaccessible').length;
    const unconfigured = entries.filter(progress => progress.status === 'reconciled' && !progress.configured).length;
    const reconciled = entries.filter(progress => progress.status === 'reconciled' && progress.configured).length;
    return { total: entries.length, reconciled, inaccessible, unconfigured };
}

/** Each state is consistent with its gap, completion and acknowledgement, or the record is corrupt. */
function checkStateInvariants(record: ResumeResyncRecord): void {
    const completed = record.state === 'completed' || record.state === 'acknowledged';
    if (record.state === 'pending' ? record.gapEndedAt !== null : record.gapEndedAt === null) corrupt('gap');
    if (record.gapEndedAt !== null && Date.parse(record.gapEndedAt) < Date.parse(record.gapStartedAt)) corrupt('gap');
    if (completed !== (record.completion !== null)) corrupt('completion state');
    if ((record.state === 'acknowledged') !== (record.acknowledgedAt !== null)) corrupt('acknowledgement');
    if (!record.completion) return;
    const evidence = record.completion.evidence;
    const settled = (progress: RepositoryResyncProgress, family: string) =>
        progress.completedFamilies.includes(family) || progress.inapplicableFamilies.includes(family);
    const repositoryFamilies = evidence.families.filter(family => REPOSITORY_FAMILIES.includes(family));
    if (evidence.repositories.total !== Object.keys(record.repositories).length
        || evidence.digest !== computeResyncDigest(record)
        || JSON.stringify(evidence.repositories) !== JSON.stringify(countResyncOutcomes(record.repositories))
        || evidence.attempts > record.attempts
        || Object.values(record.repositories).some(progress => (progress.status !== 'reconciled' && progress.status !== 'inaccessible')
            || !repositoryFamilies.every(family => settled(progress, family)))
        || !evidence.families.filter(family => INSTALLATION_FAMILIES.includes(family)).every(family => record.installationFamilies.includes(family))) {
        corrupt('completion evidence (does not match persisted progress)');
    }
}

export function encodeResumeResyncRecord(record: ResumeResyncRecord): ResumeResyncRow {
    return {
        installation_id: record.installationId,
        routing_generation: record.routingGeneration,
        resume_generation: record.resumeGeneration,
        state: record.state,
        gap_started_at: record.gapStartedAt,
        gap_ended_at: record.gapEndedAt,
        attempts: record.attempts,
        started_at: record.startedAt,
        last_attempt_at: record.lastAttemptAt,
        next_retry_at: record.nextRetryAt,
        last_error: record.lastError,
        progress_json: JSON.stringify({
            repositories: record.repositories,
            installationFamilies: record.installationFamilies,
            consecutiveFailures: record.consecutiveFailures,
        }),
        completion_json: record.completion ? JSON.stringify(record.completion) : null,
        acknowledged_at: record.acknowledgedAt,
        updated_at: record.updatedAt,
    };
}

/** Decode a persisted row; throws on anything that is not a well-formed record. */
export function decodeResumeResyncRow(row: ResumeResyncRow): ResumeResyncRecord {
    // A corrupt row must not be guessed into a state that could acknowledge.
    if (!STATES.includes(row.state as ResumeResyncState)) corrupt(`state "${String(row.state).slice(0, 32)}"`);
    const record: ResumeResyncRecord = {
        installationId: identity(row.installation_id, 'installation'),
        routingGeneration: identity(row.routing_generation, 'routing generation'),
        resumeGeneration: identity(row.resume_generation, 'resume generation'),
        state: row.state as ResumeResyncState,
        gapStartedAt: timestamp(row.gap_started_at, 'gap'),
        gapEndedAt: optionalTimestamp(row.gap_ended_at, 'gap'),
        attempts: counter(row.attempts, 'attempts'),
        startedAt: optionalTimestamp(row.started_at, 'timestamps'),
        lastAttemptAt: optionalTimestamp(row.last_attempt_at, 'timestamps'),
        nextRetryAt: optionalTimestamp(row.next_retry_at, 'timestamps'),
        lastError: optionalText(row.last_error, MAX_PERSISTED_ERROR_LENGTH, 'error'),
        ...decodeProgress(row.progress_json),
        completion: decodeCompletion(row.completion_json),
        acknowledgedAt: optionalTimestamp(row.acknowledged_at, 'acknowledgement'),
        updatedAt: timestamp(row.updated_at, 'timestamps'),
    };
    checkStateInvariants(record);
    return record;
}
