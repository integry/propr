import Database from 'better-sqlite3';
import { GoalSessionContractError } from './errors.js';

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
    goal_events: ['goal_id', 'sequence', 'kind', 'event_type', 'payload_json', 'idempotency_key', 'lease_epoch', 'created_at'],
    goal_messages: ['message_id', 'goal_id', 'sequence', 'body', 'state', 'acknowledged_at', 'created_at'],
    goal_session_runtime_owners: ['session_id', 'goal_id'],
    goal_session_runtime_state: ['scope', 'payload_json'],
    goal_session_runtime_commits: ['kind', 'identity'],
    goal_session_runtime_model_changes: ['scope', 'operation_id', 'sequence', 'model', 'status', 'acknowledgement_json'],
    goal_session_runtime_model_sequences: ['scope', 'next_sequence'],
    goal_session_runtime_provider_effects: ['scope', 'operation_id', 'kind', 'stage', 'status', 'outcome_json', 'updated_at'],
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
    const serialized = JSON.stringify(value ?? null);
    if (serialized === undefined) throw new GoalSessionContractError(
        'Provider outcome is not replayable JSON', 'PROVIDER_EFFECT_IN_DOUBT',
    );
    JSON.parse(serialized);
    return serialized;
}
