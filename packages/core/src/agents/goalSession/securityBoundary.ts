import type { GoalSessionEvent } from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import type { GoalSessionJsonValue } from './contract.js';

const SECRET = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|-----BEGIN|https?:\/\/[^\s]*@)/i;
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,256}$/;

export function safeDiagnostic(value: string, fallback: string): string {
    const normalized = value.trim();
    return normalized && normalized.length <= 2048 && !SECRET.test(normalized)
        && !/[\0\r]/.test(normalized) ? normalized : fallback;
}

export function safeFailureDiagnostic(value: string, fallback: string): string {
    const normalized = safeDiagnostic(value, fallback);
    return /(?:^|\s)(?:\/|\.\.\/)|[A-Za-z]:\\|(?:https?|ssh|git):\/\/|\S+@\S+:|\b(?:argv|command|mount|remote|endpoint|environment|config)\b/i.test(normalized)
        ? fallback : normalized.slice(0, 512);
}

/** Copies only documented event fields; provider excess properties never cross persistence. */
export function sanitizeGoalSessionEvent(event: GoalSessionEvent): GoalSessionEvent {
    switch (event.type) {
        case 'output': return { type: 'output', channel: closed(event.channel, ['stdout', 'stderr'], 'output channel'), data: safeOutput(event.data) };
        case 'assistant': return clean({ type: 'assistant', messageId: safeOptionalId(event.messageId), content: safeDiagnostic(event.content, '[redacted]'), data: safeJson(event.data) });
        case 'tool': return clean({ type: 'tool', toolCallId: safeId(event.toolCallId), name: safeId(event.name), phase: closed(event.phase, ['started', 'progress', 'completed', 'failed'], 'tool phase'), data: safeJson(event.data) });
        case 'todo': return clean({ type: 'todo', todoId: safeId(event.todoId), title: safeDiagnostic(event.title, '[redacted]'), status: closed(event.status, ['pending', 'in_progress', 'completed', 'cancelled'], 'todo status'), data: safeJson(event.data) });
        case 'usage': return clean({ type: 'usage', model: safeOptionalId(event.model), inputTokens: finite(event.inputTokens), outputTokens: finite(event.outputTokens), cachedInputTokens: finite(event.cachedInputTokens), costUsd: finite(event.costUsd), data: safeJson(event.data) });
        case 'checkpoint': return clean({ type: 'checkpoint', checkpointId: safeId(event.checkpointId), recoveryMetadata: sanitizeRecoveryMetadata(event.recoveryMetadata), providerSessionId: safeOptionalId(event.providerSessionId) });
        case 'message_acknowledged': return { type: 'message_acknowledged', messageId: safeId(event.messageId) };
        case 'pause_requested': return { type: 'pause_requested', appliesAt: closed(event.appliesAt, ['immediate', 'next_safe_boundary', 'after_turn'], 'pause boundary') };
        case 'pause_boundary': return clean({ type: 'pause_boundary', boundary: safeId(event.boundary), checkpointId: safeOptionalId(event.checkpointId), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: finite(event.providerEventOrdinal) });
        case 'session_resumed': return { type: 'session_resumed' };
        case 'model_change_acknowledged': return { type: 'model_change_acknowledged', requestedModel: safeId(event.requestedModel), appliesAt: closed(event.appliesAt, ['immediate', 'next_safe_boundary', 'next_turn'], 'model boundary') };
        case 'model_changed': return clean({ type: 'model_changed', previousModel: safeOptionalId(event.previousModel), model: safeId(event.model), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: finite(event.providerEventOrdinal) });
        case 'turn_resumed': return { type: 'turn_resumed', turnId: safeId(event.turnId) };
        case 'reconciliation': return { type: 'reconciliation', outcome: closed(event.outcome, ['alive', 'resumed', 'failed', 'blocked'], 'reconciliation outcome'), reason: safeFailureDiagnostic(event.reason, 'Provider reconciliation completed safely') };
        case 'completion': return clean({ type: 'completion', outcome: closed(event.outcome, ['succeeded', 'failed', 'cancelled'], 'completion outcome'), summary: event.summary ? safeFailureDiagnostic(event.summary, '[redacted]') : undefined, error: event.error ? safeFailureDiagnostic(event.error, 'Provider operation failed') : undefined });
    }
    throw new GoalSessionContractError('Provider emitted an unknown event type', 'INVALID_PROVIDER_EVENT');
}

function clean<T extends GoalSessionEvent>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function safeId(value: string): string {
    if (!SAFE_ID.test(value) || SECRET.test(value)) throw new GoalSessionContractError('Provider emitted an unsafe identifier', 'UNSAFE_PROVIDER_VALUE');
    return value;
}

export function assertSafeProviderIdentifier(value: string): void {
    safeId(value);
}

function safeOptionalId(value: string | undefined): string | undefined {
    return value === undefined ? undefined : safeId(value);
}

function safeOutput(value: string): string {
    if (SECRET.test(value) || value.includes('\0')) return '[redacted output]';
    return Buffer.byteLength(value) <= 1024 * 1024 ? value : Buffer.from(value).subarray(0, 1024 * 1024).toString();
}

function finite(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
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
        if (typeof nested === 'string' && (SECRET.test(nested) || nested.startsWith('/'))) {
            throw new GoalSessionContractError('Provider event data contains an unsafe value', 'UNSAFE_PROVIDER_VALUE');
        }
        result[key] = nested as string | number | boolean | null;
    }
    return result;
}

function closed<T extends string>(value: T, allowed: readonly T[], name: string): T {
    if (!allowed.includes(value)) throw new GoalSessionContractError(`Provider emitted an invalid ${name}`, 'INVALID_PROVIDER_EVENT');
    return value;
}
