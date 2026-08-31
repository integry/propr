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
const SAFE_VALUE = /^[A-Za-z0-9._:/ -]{0,512}$/;
const SECRET_VALUE = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|https?:\/\/[^\s]*@|ssh:\/\/[^\s]*@[^\s]*@|-----BEGIN)/i;
const SENSITIVE_FIELD = /(?:secret|token|password|credential|authorization|private.?key|api.?key)/i;

/**
 * Decodes the provider-neutral v1 recovery DTO. It is intentionally flat and
 * allowlisted: commands, argv, mounts, endpoints, paths, envelopes, config/env
 * dumps, and nested provider objects cannot cross the foundation boundary.
 */
export function sanitizeRecoveryMetadata(value: GoalSessionJsonValue): GoalSessionJsonValue {
    if (!isPlainObject(value)) {
        throw new GoalSessionContractError('Recovery metadata must use the version 1 object codec', 'INVALID_RECOVERY_METADATA');
    }
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, candidate] of Object.entries(value)) {
        if (!ALLOWED_FIELDS.has(key)) {
            assertDiscardableExtra(key, candidate);
            continue;
        }
        if (!isRecoveryScalar(candidate)) {
            throw new GoalSessionContractError('Recovery metadata fields must be scalar', 'INVALID_RECOVERY_METADATA');
        }
        if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
            throw new GoalSessionContractError('Recovery metadata contains a non-finite number', 'INVALID_RECOVERY_METADATA');
        }
        if (key === 'version' && candidate !== GOAL_RECOVERY_METADATA_CODEC_VERSION) {
            throw new GoalSessionContractError('Recovery metadata codec version is unsupported', 'INVALID_RECOVERY_METADATA');
        }
        if (typeof candidate === 'string'
            && (!SAFE_VALUE.test(candidate) || SECRET_VALUE.test(candidate) || candidate.startsWith('/'))) {
            throw new GoalSessionContractError('Recovery metadata contains an unsafe value', 'RECOVERY_METADATA_CONTAINS_CREDENTIAL');
        }
        result[key] = candidate;
    }
    return result;
}

function isPlainObject(value: GoalSessionJsonValue): value is Record<string, GoalSessionJsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isRecoveryScalar(value: GoalSessionJsonValue): value is string | number | boolean | null {
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function assertDiscardableExtra(key: string, value: GoalSessionJsonValue): void {
    if (!SENSITIVE_FIELD.test(key) && (typeof value !== 'string' || !SECRET_VALUE.test(value))) return;
    throw new GoalSessionContractError(
        'Recovery metadata contains credential material', 'RECOVERY_METADATA_CONTAINS_CREDENTIAL',
    );
}

export function assertCredentialFreeRecoveryMetadata(value: GoalSessionJsonValue): void {
    sanitizeRecoveryMetadata(value);
}
