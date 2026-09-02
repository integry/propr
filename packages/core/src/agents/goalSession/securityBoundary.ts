import type { GoalSessionEvent } from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import type { GoalSessionJsonValue } from './contract.js';
import { isSafeIdentifier } from './safeIdentifier.js';

const SECRET = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|-----BEGIN|https?:\/\/[^\s]*@)/i;
const WINDOWS_OR_UNC = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;
const URI_OR_ENDPOINT = /^(?:file|https?|ssh|git|docker|podman|unix|tcp):/i;
const COMMAND_LIKE = /(?:^|\s)(?:sh|bash|zsh|cmd(?:\.exe)?|powershell|docker|podman|sudo)(?:\s|$)|[;&|`$<>]/i;

export function safeDiagnostic(value: string, fallback: string): string {
    const normalized = value.trim();
    return normalized && normalized.length <= 2048 && !SECRET.test(normalized)
        && !/[\0\r]/.test(normalized) ? normalized : fallback;
}

export function safeFailureDiagnostic(value: string, fallback: string): string {
    const normalized = safeDiagnostic(value, fallback);
    return /(?:^|\s)(?:\/|\.\.?[\\/])|[A-Za-z]:[\\/]|(?:file|https?|ssh|git|docker|podman|tcp|unix):\/\/|\S+@\S+:|\b(?:argv|command|mount|remote|endpoint|environment|config|docker|podman|npm|npx|yarn|pnpm)\b/i.test(normalized)
        ? fallback : normalized.slice(0, 512);
}

/** Rebuilds an untrusted provider exception without its stack, cause, or excess fields. */
export function safeProviderException(error: unknown, fallback = 'Provider operation failed safely'): GoalSessionContractError {
    // Never inspect an untrusted Error. message/cause/stack/name may be hostile
    // getters and even a provider-created GoalSessionContractError is not a
    // trusted internal contract error once it crosses this boundary.
    void error;
    return new GoalSessionContractError(fallback, 'PROVIDER_OPERATION_FAILED');
}

/** Copies only documented event fields; provider excess properties never cross persistence. */
export function sanitizeGoalSessionEvent(event: GoalSessionEvent): GoalSessionEvent {
    switch (event.type) {
        case 'output': return { type: 'output', channel: closed(event.channel, ['stdout', 'stderr'], 'output channel'), data: safeOutput(event.data) };
        case 'assistant': return clean({ type: 'assistant', messageId: safeOptionalId(event.messageId), content: safeDiagnostic(event.content, '[redacted]'), data: safeJson(event.data) });
        case 'tool': return clean({ type: 'tool', toolCallId: safeId(event.toolCallId), name: safeId(event.name), phase: closed(event.phase, ['started', 'progress', 'completed', 'failed'], 'tool phase'), data: safeJson(event.data) });
        case 'todo': return clean({ type: 'todo', todoId: safeId(event.todoId), title: safeDiagnostic(event.title, '[redacted]'), status: closed(event.status, ['pending', 'in_progress', 'completed', 'cancelled'], 'todo status'), data: safeJson(event.data) });
        case 'usage': return clean({ type: 'usage', occurrenceId: safeId(event.occurrenceId), semantics: closed(event.semantics, ['delta', 'cumulative'], 'usage semantics'), watermark: requiredNonNegativeInteger(event.watermark, 'watermark'), model: safeOptionalId(event.model), inputTokens: nonNegativeInteger(event.inputTokens, 'inputTokens'), outputTokens: nonNegativeInteger(event.outputTokens, 'outputTokens'), cachedInputTokens: nonNegativeInteger(event.cachedInputTokens, 'cachedInputTokens'), costUsd: nonNegativeFinite(event.costUsd, 'costUsd'), data: safeJson(event.data) });
        case 'checkpoint': return clean({ type: 'checkpoint', checkpointId: safeId(event.checkpointId), recoveryMetadata: sanitizeRecoveryMetadata(event.recoveryMetadata), providerSessionId: safeOptionalId(event.providerSessionId) });
        case 'message_acknowledged': return { type: 'message_acknowledged', messageId: safeId(event.messageId) };
        case 'pause_requested': return { type: 'pause_requested', appliesAt: closed(event.appliesAt, ['immediate', 'next_safe_boundary', 'after_turn'], 'pause boundary') };
        case 'pause_boundary': return clean({ type: 'pause_boundary', boundary: safeId(event.boundary), checkpointId: safeOptionalId(event.checkpointId), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: nonNegativeInteger(event.providerEventOrdinal, 'providerEventOrdinal') });
        case 'session_resumed': return { type: 'session_resumed' };
        case 'model_change_acknowledged': return { type: 'model_change_acknowledged', requestedModel: safeId(event.requestedModel), appliesAt: closed(event.appliesAt, ['immediate', 'next_safe_boundary', 'next_turn'], 'model boundary') };
        case 'model_changed': return clean({ type: 'model_changed', previousModel: safeOptionalId(event.previousModel), model: safeId(event.model), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: nonNegativeInteger(event.providerEventOrdinal, 'providerEventOrdinal') });
        case 'turn_resumed': return { type: 'turn_resumed', turnId: safeId(event.turnId) };
        case 'reconciliation': return { type: 'reconciliation', outcome: closed(event.outcome, ['alive', 'resumed', 'failed', 'blocked'], 'reconciliation outcome'), reason: 'Provider reconciliation completed safely' };
        case 'completion': return clean({ type: 'completion', outcome: closed(event.outcome, ['succeeded', 'failed', 'cancelled'], 'completion outcome'), summary: event.summary ? '[redacted]' : undefined, error: event.error ? 'Provider operation failed safely' : undefined });
    }
    throw new GoalSessionContractError('Provider emitted an unknown event type', 'INVALID_PROVIDER_EVENT');
}

function clean<T extends GoalSessionEvent>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function safeId(value: string): string {
    if (!isSafeIdentifier(value) || SECRET.test(value)) throw new GoalSessionContractError('Provider emitted an unsafe identifier', 'UNSAFE_PROVIDER_VALUE');
    return value;
}

export function assertSafeProviderIdentifier(value: string): void {
    safeId(value);
}

function safeOptionalId(value: string | undefined): string | undefined {
    return value === undefined ? undefined : safeId(value);
}

function safeOutput(value: string): string {
    if (typeof value !== 'string') throw new GoalSessionContractError('Provider emitted non-string output', 'INVALID_PROVIDER_EVENT');
    if (SECRET.test(value) || value.includes('\0')) return '[redacted output]';
    return Buffer.byteLength(value) <= 1024 * 1024 ? value : Buffer.from(value).subarray(0, 1024 * 1024).toString();
}

function nonNegativeInteger(value: number | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 0) invalidNumeric(field);
    return value;
}

function nonNegativeFinite(value: number | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalidNumeric(field);
    return value;
}

function invalidNumeric(field: string): never {
    throw new GoalSessionContractError(`Provider emitted an invalid ${field}`, 'INVALID_PROVIDER_EVENT');
}

function safeJson(value: GoalSessionJsonValue | undefined): GoalSessionJsonValue | undefined {
    if (value === undefined) return undefined;
    if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
    const allowed = new Set(['file', 'line', 'progress', 'count', 'status', 'result', 'code', 'language']);
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, nested] of Object.entries(value)) {
        if (!allowed.has(key) || (nested !== null && !['string', 'number', 'boolean'].includes(typeof nested))) {
            throw new GoalSessionContractError('Provider event data contains an undeclared field', 'INVALID_PROVIDER_EVENT');
        }
        if (key === 'file') result[key] = safeRepositoryRelativePath(nested, key);
        else if (key === 'line' || key === 'count') result[key] = requiredNonNegativeInteger(nested, key);
        else if (key === 'progress') result[key] = boundedProgress(nested);
        else if (key === 'status') result[key] = safeClosedScalar(nested, key, ['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
        else if (key === 'language') result[key] = safeClosedScalar(nested, key, ['typescript', 'javascript', 'json', 'markdown', 'text', 'shell', 'yaml']);
        else if (key === 'code') result[key] = safeClosedScalar(nested, key, ['ok', 'failed', 'skipped', 'cancelled']);
        else result[key] = safeResultScalar(nested, key);
    }
    return result;
}

export function safeRepositoryRelativePath(value: unknown, field = 'file'): string {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024
        || hasControl(value) || value.startsWith('/') || WINDOWS_OR_UNC.test(value)
        || URI_OR_ENDPOINT.test(value) || COMMAND_LIKE.test(value) || value.includes('\\')) {
        throw new GoalSessionContractError(`Provider ${field} is not a safe repository-relative path`, 'UNSAFE_PROVIDER_VALUE');
    }
    const segments = value.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..') || segments.join('/') !== value) {
        throw new GoalSessionContractError(`Provider ${field} is not normalized`, 'UNSAFE_PROVIDER_VALUE');
    }
    return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidNumeric(field);
    return value;
}

function boundedProgress(value: unknown): number {
    const result = requiredNonNegativeInteger(value, 'progress');
    if (result > 100) invalidNumeric('progress');
    return result;
}

function safeClosedScalar(value: unknown, field: string, values: readonly string[]): string {
    if (typeof value !== 'string' || !values.includes(value)) {
        throw new GoalSessionContractError(`Provider event data contains an invalid ${field}`, 'INVALID_PROVIDER_EVENT');
    }
    return value;
}

function safeResultScalar(value: unknown, field: string): string | number | boolean | null {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return requiredNonNegativeInteger(value, field);
    if (typeof value !== 'string' || !value || value.length > 256 || SECRET.test(value)
        || hasControl(value) || URI_OR_ENDPOINT.test(value) || COMMAND_LIKE.test(value)
        || value.startsWith('/') || WINDOWS_OR_UNC.test(value) || value.includes('../')) {
        throw new GoalSessionContractError('Provider event data contains an unsafe value', 'UNSAFE_PROVIDER_VALUE');
    }
    return value;
}

function hasControl(value: string): boolean {
    return [...value].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

function closed<T extends string>(value: T, allowed: readonly T[], name: string): T {
    if (!allowed.includes(value)) throw new GoalSessionContractError(`Provider emitted an invalid ${name}`, 'INVALID_PROVIDER_EVENT');
    return value;
}
