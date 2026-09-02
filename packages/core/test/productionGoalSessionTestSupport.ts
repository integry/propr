import Database from 'better-sqlite3';
import type { GoalSessionRecoveryPort } from '../src/agents/goalSession/runtimePorts.js';

export const recovery: GoalSessionRecoveryPort = {
    inspectContainer: async () => ({ status: 'missing', reason: 'test' }),
    inspectRepository: async repository => ({ ...repository, exists: true }),
};

export function createControlTables(database: Database.Database): void {
    database.exec(`
        CREATE TABLE goal_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            kind TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, idempotency_key TEXT NOT NULL,
            lease_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX goal_events_goal_sequence_idx ON goal_events(goal_id, sequence);
        CREATE UNIQUE INDEX goal_events_goal_idempotency_idx ON goal_events(goal_id, idempotency_key);
        CREATE TABLE goal_messages (
            message_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
            predefined_kind TEXT, state TEXT NOT NULL DEFAULT 'queued', delivered_at TEXT, acknowledged_at TEXT,
            delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX goal_messages_goal_sequence_idx ON goal_messages(goal_id, sequence);
        CREATE UNIQUE INDEX goal_messages_goal_idempotency_idx ON goal_messages(goal_id, idempotency_key);
    `);
}

export function createRuntimeExtensionTables(database: Database.Database): void {
    database.exec(`
        CREATE TABLE goal_session_runtime_owners (session_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL);
        CREATE TABLE goal_session_runtime_state (scope TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
        CREATE TABLE goal_session_runtime_commits (
            kind TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (kind, identity)
        );
        CREATE TABLE goal_session_runtime_model_changes (
            scope TEXT NOT NULL, operation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            model TEXT NOT NULL, status TEXT NOT NULL, acknowledgement_json TEXT,
            PRIMARY KEY (scope, operation_id), UNIQUE (scope, sequence)
        );
        CREATE TABLE goal_session_runtime_model_sequences (
            scope TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL
        );
        CREATE TABLE goal_session_runtime_provider_effects (
            scope TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
            stage TEXT NOT NULL, status TEXT NOT NULL, outcome_json TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, operation_id, stage)
        );
        CREATE TRIGGER goal_runtime_provider_effect_stage_insert
            BEFORE INSERT ON goal_session_runtime_provider_effects
            WHEN NEW.stage NOT IN ('provider_primitive', 'stream_first_next', 'container_spawn')
            BEGIN SELECT RAISE(ABORT, 'invalid provider effect stage'); END;
        CREATE TRIGGER goal_runtime_provider_effect_stage_update
            BEFORE UPDATE OF stage ON goal_session_runtime_provider_effects
            WHEN NEW.stage NOT IN ('provider_primitive', 'stream_first_next', 'container_spawn')
            BEGIN SELECT RAISE(ABORT, 'invalid provider effect stage'); END;
    `);
}

export function createProductionSchema(filename: string): void {
    const database = new Database(filename);
    createControlTables(database);
    createRuntimeExtensionTables(database);
    database.close();
}
