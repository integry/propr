import type { GoalSessionJsonValue } from './contract.js';
import { GoalSessionContractError } from './errors.js';

/** Foundation codec version. Provider-specific codecs may add fields in adapters later. */
export const GOAL_RECOVERY_METADATA_CODEC_VERSION = 1;

export interface GoalRecoveryMetadataV1 {
    /** Omitted only for legacy records; the codec treats omission as v1 during migration. */
    version?: 1;
    checkpoint?: string;
    conversation?: string;
    cursor?: string | number;
    offset?: number;
    sequence?: number;
    revision?: string | number;
    phase?: string;
    state?: string;
}

const ALLOWED_FIELDS = new Set([
    'checkpoint', 'conversation', 'cursor', 'offset', 'sequence', 'revision', 'phase', 'state', 'version',
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SECRET_VALUE = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|https?:\/\/[^\s]*@|ssh:\/\/[^\s]*@[^\s]*@|-----BEGIN)/i;
const SENSITIVE_FIELD = /(?:secret|token|password|credential|authorization|private.?key|api.?key)/i;
const CLOSED_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
    phase: new Set(['initialized', 'pending', 'running', 'paused', 'checkpoint', 'completed', 'failed', 'cancelled']),
    state: new Set(['pending', 'active', 'idle', 'paused', 'completed', 'failed', 'cancelled', 'terminated']),
};

/**
 * Decodes the provider-neutral v1 recovery DTO. It is intentionally flat and
 * allowlisted: commands, argv, mounts, endpoints, paths, envelopes, config/env
 * dumps, and nested provider objects cannot cross the foundation boundary.
 */
export function sanitizeRecoveryMetadata(value: GoalSessionJsonValue): GoalSessionJsonValue {
    if (!isPlainObject(value)) {
        throw new GoalSessionContractError('Recovery metadata must use the version 1 object codec', 'INVALID_RECOVERY_METADATA');
    }
    const result: Record<string, string | number> = {};
    for (const [key, candidate] of Object.entries(value)) {
        if (!ALLOWED_FIELDS.has(key)) rejectExtra(key, candidate);
        if (key === 'version' && candidate !== GOAL_RECOVERY_METADATA_CODEC_VERSION) {
            throw new GoalSessionContractError('Recovery metadata codec version is unsupported', 'INVALID_RECOVERY_METADATA');
        }
        result[key] = sanitizeField(key, candidate);
    }
    return result;
}

function isPlainObject(value: GoalSessionJsonValue): value is Record<string, GoalSessionJsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function rejectExtra(key: string, value: GoalSessionJsonValue): never {
    if (SENSITIVE_FIELD.test(key) || (typeof value === 'string' && SECRET_VALUE.test(value))) {
        throw new GoalSessionContractError(
            'Recovery metadata contains credential material', 'RECOVERY_METADATA_CONTAINS_CREDENTIAL',
        );
    }
    throw new GoalSessionContractError(
        'Recovery metadata contains an undeclared field', 'INVALID_RECOVERY_METADATA',
    );
}

function sanitizeField(key: string, value: GoalSessionJsonValue): string | number {
    if (key === 'version') {
        if (value !== GOAL_RECOVERY_METADATA_CODEC_VERSION) invalidField(key);
        return value;
    }
    if (key === 'offset' || key === 'sequence') return safeNonNegativeInteger(value, key);
    if ((key === 'cursor' || key === 'revision') && typeof value === 'number') {
        return safeNonNegativeInteger(value, key);
    }
    if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value) || SECRET_VALUE.test(value)) invalidField(key);
    if (CLOSED_VALUES[key] && !CLOSED_VALUES[key].has(value)) invalidField(key);
    return value;
}

function safeNonNegativeInteger(value: GoalSessionJsonValue, key: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidField(key);
    return value;
}

function invalidField(key: string): never {
    throw new GoalSessionContractError(`Recovery metadata contains an invalid ${key}`, 'INVALID_RECOVERY_METADATA');
}

export function assertCredentialFreeRecoveryMetadata(value: GoalSessionJsonValue): void {
    sanitizeRecoveryMetadata(value);
}

/**
 * Migration-only decoder for already-durable legacy records. Invalid and excess
 * fields are removed one field at a time and are never forwarded to a provider.
 * New provider/API DTOs continue to use sanitizeRecoveryMetadata and fail closed.
 */
export function scrubDurableRecoveryMetadata(value: GoalSessionJsonValue): GoalSessionJsonValue {
    if (!isPlainObject(value)) return {};
    const scrubbed: Record<string, GoalSessionJsonValue> = {};
    for (const key of ALLOWED_FIELDS) {
        const candidate = value[key];
        if (candidate === undefined) continue;
        try {
            const decoded = sanitizeRecoveryMetadata({ [key]: candidate });
            if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) scrubbed[key] = decoded[key];
        } catch {
            // Legacy poison is deleted, never repaired into a provider DTO.
        }
    }
    return scrubbed;
}
