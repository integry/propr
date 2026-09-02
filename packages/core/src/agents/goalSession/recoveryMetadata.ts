import type { GoalSessionJsonValue } from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { isSafeIdentifier } from './safeIdentifier.js';

export const GOAL_RECOVERY_METADATA_CODEC_VERSION = 2;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_USAGE_COMPONENTS = 32;
const SECRET_VALUE = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|https?:\/\/[^\s]*@|ssh:\/\/[^\s]*@|-----BEGIN)/i;
const SENSITIVE_FIELD = /(?:secret|token|password|credential|authorization|private.?key|api.?key)/i;

type RecoveryProvider = 'codex' | 'claude' | 'antigravity';
/** Legacy durable shape retained for source compatibility during v1 migration. */
export interface GoalRecoveryMetadataV1 {
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
type Codec = { protocolVersion: string; required: readonly string[]; optional: readonly string[] };

/** Pinned provider protocol codecs accepted by the v2 envelope. */
const PROVIDER_CODECS: Readonly<Record<RecoveryProvider, Codec>> = {
    codex: {
        protocolVersion: 'app-server-0.146.0',
        required: ['threadId', 'initialized'],
        optional: [
            'sessionId', 'turnId', 'checkpoint', 'openKey', 'repository', 'model',
            'providerHomeIdentity', 'cliVersion',
        ],
    },
    claude: {
        protocolVersion: 'cli-2.1.220',
        required: ['sessionId'],
        optional: ['reasoningId', 'checkpoint', 'transcriptCursor'],
    },
    antigravity: {
        protocolVersion: 'cli-1.1.13',
        required: ['conversationId', 'manifestVersion', 'manifestChecksum'],
        optional: ['checkpoint', 'conversationChecksum'],
    },
};

const LEGACY_FIELDS = new Set([
    'checkpoint', 'conversation', 'cursor', 'offset', 'sequence', 'revision', 'phase', 'state', 'version',
]);
const CLOSED_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
    phase: new Set(['initialized', 'pending', 'running', 'paused', 'checkpoint', 'completed', 'failed', 'cancelled']),
    state: new Set(['pending', 'active', 'idle', 'paused', 'completed', 'failed', 'cancelled', 'terminated']),
};

/**
 * Decodes either the bounded provider-specific v2 envelope or an existing flat
 * v1 record during migration.  New provider state should always use v2; v1 is
 * retained only so an already-durable session can be reopened deterministically.
 */
export function sanitizeRecoveryMetadata(
    value: GoalSessionJsonValue,
    expectedProvider?: string,
): GoalSessionJsonValue {
    if (!isPlainObject(value)) invalid('Recovery metadata must be an object');
    assertBounded(value);
    if (value.version === GOAL_RECOVERY_METADATA_CODEC_VERSION) {
        return decodeV2(value, expectedProvider);
    }
    return decodeLegacyV1(value);
}

/**
 * New provider ingress is v2-only for the three pinned providers.  Unknown
 * embedding adapters retain their closed legacy codec for source compatibility;
 * an existing v1 durable record may be read, but can never be returned by a
 * successful Codex/Claude/Antigravity interaction.
 */
export function sanitizeNewRecoveryMetadata(
    value: GoalSessionJsonValue,
    expectedProvider: string,
): GoalSessionJsonValue {
    const decoded = sanitizeRecoveryMetadata(value, expectedProvider);
    if (expectedProvider === 'codex' || expectedProvider === 'claude' || expectedProvider === 'antigravity') {
        if (!isPlainObject(decoded) || decoded.version !== GOAL_RECOVERY_METADATA_CODEC_VERSION
            || !isPlainObject(decoded.payload)) invalid('New provider recovery metadata must use the pinned v2 codec');
        const payload = decoded.payload as Record<string, GoalSessionJsonValue>;
        const required = expectedProvider === 'codex'
            ? [
                'threadId', 'sessionId', 'initialized', 'openKey', 'repository', 'model',
                'providerHomeIdentity', 'cliVersion',
            ]
            : PROVIDER_CODECS[expectedProvider].required;
        if (required.some(field => payload[field] === undefined)) {
            invalid('New provider recovery metadata is missing an exact identity');
        }
    }
    return decoded;
}

function decodeV2(value: Record<string, GoalSessionJsonValue>, expectedProvider?: string): GoalSessionJsonValue {
    exactFields(value, ['version', 'provider', 'protocolVersion', 'payload', 'usage']);
    const provider = providerName(value.provider);
    if (expectedProvider !== undefined && expectedProvider !== provider) {
        invalid('Recovery metadata belongs to a different provider');
    }
    const codec = PROVIDER_CODECS[provider];
    if (value.protocolVersion !== codec.protocolVersion) invalid('Recovery protocol version is unsupported');
    if (!isPlainObject(value.payload)) invalid('Recovery payload must be an object');
    exactFields(value.payload, [...codec.required, ...codec.optional]);
    for (const field of codec.required) if (value.payload[field] === undefined) invalid(`Recovery payload is missing ${field}`);
    const payload: Record<string, GoalSessionJsonValue> = {};
    for (const field of [...codec.required, ...codec.optional]) {
        const candidate = value.payload[field];
        if (candidate === undefined) continue;
        payload[field] = field === 'initialized'
            ? safeBoolean(candidate, field)
            : field === 'manifestVersion' || field === 'transcriptCursor'
                ? safeNonNegativeInteger(candidate, field)
                : field === 'repository'
                    ? safeRepositoryIdentity(candidate)
                    : field === 'providerHomeIdentity'
                        ? safeProviderHomeIdentity(candidate)
                        : safeIdentifier(candidate, field);
    }
    return {
        version: GOAL_RECOVERY_METADATA_CODEC_VERSION,
        provider,
        protocolVersion: codec.protocolVersion,
        payload,
        usage: decodeUsage(value.usage),
    };
}

function decodeUsage(value: GoalSessionJsonValue | undefined): GoalSessionJsonValue {
    if (value === undefined) return { components: [] };
    if (!isPlainObject(value)) invalid('Recovery usage must be an object');
    exactFields(value, ['components']);
    if (!Array.isArray(value.components) || value.components.length > MAX_USAGE_COMPONENTS) {
        invalid('Recovery usage components are invalid');
    }
    const seen = new Set<string>();
    const components = value.components.map((candidate, index) => {
        if (!isPlainObject(candidate)) invalid(`Recovery usage component ${index} is invalid`);
        exactFields(candidate, ['component', 'watermark', 'occurrenceId']);
        const component = closed(candidate.component, ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cost_usd'], 'usage component');
        if (seen.has(component)) invalid('Recovery usage component is duplicated');
        seen.add(component);
        return {
            component,
            watermark: safeNonNegativeInteger(candidate.watermark, 'usage watermark'),
            occurrenceId: safeIdentifier(candidate.occurrenceId, 'usage occurrenceId'),
        };
    });
    return { components };
}

function decodeLegacyV1(value: Record<string, GoalSessionJsonValue>): GoalSessionJsonValue {
    const result: Record<string, string | number> = {};
    for (const [key, candidate] of Object.entries(value)) {
        if (!LEGACY_FIELDS.has(key)) rejectExtra(key, candidate);
        if (key === 'version') {
            if (candidate !== 1) invalid('Recovery metadata codec version is unsupported');
            result.version = 1;
            continue;
        }
        if (key === 'offset' || key === 'sequence') result[key] = safeNonNegativeInteger(candidate, key);
        else if ((key === 'cursor' || key === 'revision') && typeof candidate === 'number') result[key] = safeNonNegativeInteger(candidate, key);
        else {
            const decoded = safeIdentifier(candidate, key);
            if (CLOSED_VALUES[key] && !CLOSED_VALUES[key].has(decoded)) invalid(`Recovery metadata contains an invalid ${key}`);
            result[key] = decoded;
        }
    }
    return result;
}

function exactFields(value: Record<string, GoalSessionJsonValue>, allowedFields: readonly string[]): void {
    const allowed = new Set(allowedFields);
    for (const [key, candidate] of Object.entries(value)) if (!allowed.has(key)) rejectExtra(key, candidate);
}

function providerName(value: GoalSessionJsonValue): RecoveryProvider {
    if (value !== 'codex' && value !== 'claude' && value !== 'antigravity') invalid('Recovery provider is unsupported');
    return value;
}

function safeIdentifier(value: GoalSessionJsonValue | undefined, field: string): string {
    if (!isSafeIdentifier(value) || SECRET_VALUE.test(value)) invalid(`Recovery metadata contains an invalid ${field}`);
    return value;
}

function safeNonNegativeInteger(value: GoalSessionJsonValue | undefined, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`Recovery metadata contains an invalid ${field}`);
    return value;
}

function safeBoolean(value: GoalSessionJsonValue, field: string): boolean {
    if (typeof value !== 'boolean') invalid(`Recovery metadata contains an invalid ${field}`);
    return value;
}

function safeRepositoryIdentity(value: GoalSessionJsonValue | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
        || Buffer.byteLength(value) > 512 || SECRET_VALUE.test(value)) invalid('Recovery repository identity is invalid');
    return value;
}

function safeProviderHomeIdentity(value: GoalSessionJsonValue | undefined): string {
    if (value !== '/home/node/.codex' && value !== '/home/node/.claude' && value !== '/home/node/.gemini') {
        invalid('Recovery provider-home identity is invalid');
    }
    return value;
}

function closed<T extends string>(value: GoalSessionJsonValue | undefined, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`Recovery metadata contains an invalid ${field}`);
    return value as T;
}

function isPlainObject(value: unknown): value is Record<string, GoalSessionJsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertBounded(value: GoalSessionJsonValue): void {
    let serialized: string;
    try { serialized = JSON.stringify(value); }
    catch { invalid('Recovery metadata is not serializable'); }
    if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) invalid('Recovery metadata exceeds its size bound');
}

function rejectExtra(key: string, value: GoalSessionJsonValue): never {
    if (SENSITIVE_FIELD.test(key) || (typeof value === 'string' && SECRET_VALUE.test(value))) {
        throw new GoalSessionContractError('Recovery metadata contains credential material', 'RECOVERY_METADATA_CONTAINS_CREDENTIAL');
    }
    invalid('Recovery metadata contains an undeclared field');
}

function invalid(message: string): never {
    throw new GoalSessionContractError(message, 'INVALID_RECOVERY_METADATA');
}

export function assertCredentialFreeRecoveryMetadata(value: GoalSessionJsonValue, expectedProvider?: string): void {
    sanitizeRecoveryMetadata(value, expectedProvider);
}

/** Existing callers use this name during reopen; strict decoding never scrubs. */
export function scrubDurableRecoveryMetadata(value: GoalSessionJsonValue, expectedProvider?: string): GoalSessionJsonValue {
    return sanitizeRecoveryMetadata(value, expectedProvider);
}
