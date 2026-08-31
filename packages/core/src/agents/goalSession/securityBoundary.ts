import type { GoalSessionEvent } from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import type { GoalSessionJsonValue } from './contract.js';

const SECRET = /(?:\bBearer\s+\S+|\b(?:gh[oprsu]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}|\b(?:secret|token|password)[._:-][A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\s/@]+@)/i;
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,256}$/;

export function safeDiagnostic(value: string, fallback: string): string {
    const normalized = value.trim();
    return normalized && normalized.length <= 2048 && !SECRET.test(normalized)
        && !/[\0\r]/.test(normalized) ? normalized : fallback;
}

/** Copies only documented event fields; provider excess properties never cross persistence. */
export function sanitizeGoalSessionEvent(event: GoalSessionEvent): GoalSessionEvent {
    switch (event.type) {
        case 'output': return { type: 'output', channel: event.channel, data: safeDiagnostic(event.data, '[redacted output]') };
        case 'assistant': return clean({ type: 'assistant', messageId: safeOptionalId(event.messageId), content: safeDiagnostic(event.content, '[redacted]'), data: safeJson(event.data) });
        case 'tool': return clean({ type: 'tool', toolCallId: safeId(event.toolCallId), name: safeId(event.name), phase: event.phase, data: safeJson(event.data) });
        case 'todo': return clean({ type: 'todo', todoId: safeId(event.todoId), title: safeDiagnostic(event.title, '[redacted]'), status: event.status, data: safeJson(event.data) });
        case 'usage': return clean({ type: 'usage', model: safeOptionalId(event.model), inputTokens: finite(event.inputTokens), outputTokens: finite(event.outputTokens), cachedInputTokens: finite(event.cachedInputTokens), costUsd: finite(event.costUsd), data: safeJson(event.data) });
        case 'checkpoint': return clean({ type: 'checkpoint', checkpointId: safeId(event.checkpointId), recoveryMetadata: event.recoveryMetadata, providerSessionId: safeOptionalId(event.providerSessionId) });
        case 'message_acknowledged': return { type: 'message_acknowledged', messageId: safeId(event.messageId) };
        case 'pause_requested': return { type: 'pause_requested', appliesAt: event.appliesAt };
        case 'pause_boundary': return clean({ type: 'pause_boundary', boundary: safeId(event.boundary), checkpointId: safeOptionalId(event.checkpointId), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: finite(event.providerEventOrdinal) });
        case 'session_resumed': return { type: 'session_resumed' };
        case 'model_change_acknowledged': return { type: 'model_change_acknowledged', requestedModel: safeId(event.requestedModel), appliesAt: event.appliesAt };
        case 'model_changed': return clean({ type: 'model_changed', previousModel: safeOptionalId(event.previousModel), model: safeId(event.model), providerEventId: safeOptionalId(event.providerEventId), providerEventOrdinal: finite(event.providerEventOrdinal) });
        case 'turn_resumed': return { type: 'turn_resumed', turnId: safeId(event.turnId) };
        case 'reconciliation': return { type: 'reconciliation', outcome: event.outcome, reason: safeDiagnostic(event.reason, 'Provider reconciliation failed safely') };
        case 'completion': return clean({ type: 'completion', outcome: event.outcome, summary: event.summary ? safeDiagnostic(event.summary, '[redacted]') : undefined, error: event.error ? safeDiagnostic(event.error, 'Provider operation failed') : undefined });
    }
}

function clean<T extends GoalSessionEvent>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function safeId(value: string): string {
    if (!SAFE_ID.test(value) || SECRET.test(value)) throw new GoalSessionContractError('Provider emitted an unsafe identifier', 'UNSAFE_PROVIDER_VALUE');
    return value;
}

function safeOptionalId(value: string | undefined): string | undefined {
    return value === undefined ? undefined : safeId(value);
}

function finite(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeJson(value: GoalSessionJsonValue | undefined): GoalSessionJsonValue | undefined {
    if (value === undefined) return undefined;
    assertCredentialFreeRecoveryMetadata(value);
    return structuredClone(value);
}
