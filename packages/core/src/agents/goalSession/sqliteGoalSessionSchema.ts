import Database from 'better-sqlite3';
import { GoalSessionContractError } from './errors.js';

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
    goals: ['goal_id', 'agent', 'effective_model', 'lease_epoch'],
    goal_provider_sessions: ['session_id', 'goal_id', 'provider_thread_id', 'lease_generation', 'current_turn_id', 'current_execution_id', 'current_attempt_id'],
    goal_event_state: ['goal_id', 'high_watermark', 'projection_sequence'],
    goal_events: ['goal_id', 'sequence', 'kind', 'event_type', 'payload_json', 'idempotency_key', 'lease_epoch', 'schema_version', 'payload_bytes'],
    goal_messages: ['message_id', 'goal_id', 'sequence', 'queue_ordinal', 'body', 'state', 'claimed_by', 'delivered_at', 'acknowledged_at', 'created_at'],
    goal_session_runtime_state: ['session_id', 'goal_id', 'scope', 'payload_json'],
    goal_session_runtime_commits: ['session_id', 'goal_id', 'kind', 'identity'],
    goal_session_runtime_model_changes: ['session_id', 'goal_id', 'scope', 'operation_id', 'sequence', 'model', 'status', 'acknowledgement_json'],
    goal_session_runtime_model_sequences: ['session_id', 'goal_id', 'scope', 'next_sequence'],
    goal_session_runtime_provider_effects: ['session_id', 'goal_id', 'scope', 'operation_id', 'kind', 'stage', 'status', 'claim_token', 'outcome_json', 'updated_at'],
};

export function assertSqliteGoalControlSchema(database: Database.Database): void {
    for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
        const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const columns = new Set(rows.map(row => row.name));
        if (required.some(column => !columns.has(column))) throw new GoalSessionContractError(
            `Required authoritative control persistence is absent: ${table}`, 'AUTHORITATIVE_DOMAIN_MISSING',
        );
    }
}

export function replayableProviderOutcomeJson(value: unknown): string {
    const serialized = JSON.stringify(closedJson(value ?? null, new Set(), 0));
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw invalidOutcome();
    return serialized;
}

function closedJson(value: unknown, seen: Set<object>, depth: number): unknown {
    if (depth > 32) throw invalidOutcome();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidOutcome();
        return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) throw invalidOutcome();
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const keys = Object.keys(value);
            if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalidOutcome();
            return value.map(item => closedJson(item, seen, depth + 1));
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalidOutcome();
        if (Object.getOwnPropertySymbols(value).length > 0) throw invalidOutcome();
        const result: Record<string, unknown> = {};
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (!descriptor.enumerable || !('value' in descriptor) || !key) throw invalidOutcome();
            result[key] = closedJson(descriptor.value, seen, depth + 1);
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

function invalidOutcome(): GoalSessionContractError {
    return new GoalSessionContractError(
        'Provider outcome is not bounded lossless JSON', 'PROVIDER_EFFECT_IN_DOUBT',
    );
}
