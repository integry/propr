import Database from 'better-sqlite3';
import type {
    DurableCorrectiveMessage, GoalEventAppendResult, GoalExecutionIdentity,
    GoalModelChangeAcknowledgement, GoalModelChangeHistoryRecord, GoalProviderEffectStage,
    GoalProviderOperationFence, GoalSessionControlFence, GoalSessionControlTransition,
    GoalSessionEvent, GoalSessionFence, GoalSessionIdentity, GoalSessionState,
    GoalStartedProviderEffect, GoalTerminalCommit, PersistedGoalSessionEvent,
} from './contract.js';
import type {
    GoalProviderEffectClaimResult, GoalSessionAuthoritativeTransactionDomain,
} from './AuthoritativeGoalSessionRuntimePorts.js';
import { AuthoritativeGoalSessionRuntimePorts } from './AuthoritativeGoalSessionRuntimePorts.js';
import type { GoalSessionRecoveryPort, GoalSessionRuntimePorts } from './runtimePorts.js';
import { GoalSessionContractError } from './errors.js';
import { GoalSessionScopeError } from './InMemoryGoalSessionPorts.js';
import { assertStartedProviderEffect } from './providerEffectProtocol.js';
import { assertProviderFirstEffectState } from './providerFirstEffect.js';
import { assertGoalProviderEffectStage } from './providerOperationBoundary.js';
import { sanitizeGoalSessionEvent } from './securityBoundary.js';
import { sqliteGoalScope, sqliteTerminalKey, sqliteTransitionKey } from './sqliteGoalSessionKeys.js';
import { assertSqliteGoalControlSchema, replayableProviderOutcomeJson } from './sqliteGoalSessionSchema.js';

type EffectRow = { kind: string; status: string; outcome_json: string | null };

/** Production SQLite adapter over an injected, already-migrated control database. */
export class SqliteGoalSessionControlDomain implements GoalSessionAuthoritativeTransactionDomain {
    readonly state = this; readonly transitions = this; readonly events = this; readonly terminal = this; readonly messages = this; readonly modelChanges = this; readonly providerEffects = this;

    constructor(private readonly database: Database.Database) {
        database.pragma('foreign_keys = ON'); database.pragma('busy_timeout = 30000');
        assertSqliteGoalControlSchema(database);
    }

    async load(identity: GoalSessionIdentity): Promise<GoalSessionState | null> {
        this.assertOwner(identity);
        return this.readState(identity);
    }

    async create(state: Omit<GoalSessionState, 'version'>): Promise<GoalSessionState | null> {
        const saved = { ...structuredClone(state), version: 1 };
        return this.immediate(() => {
            this.database.prepare('INSERT OR IGNORE INTO goal_session_runtime_owners(session_id, goal_id) VALUES (?, ?)')
                .run(state.sessionId, state.goalId);
            this.assertOwner(state);
            const result = this.database.prepare(
                'INSERT OR IGNORE INTO goal_session_runtime_state(scope, payload_json) VALUES (?, ?)',
            ).run(sqliteGoalScope(state), JSON.stringify(saved));
            return result.changes === 1 ? saved : null;
        });
    }

    async compareAndSet(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): Promise<GoalSessionState | null> {
        return this.immediate(() => this.writeComparedState(expected, next));
    }

    async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ): Promise<GoalSessionState | null> {
        return this.immediate(() => {
            this.assertOwner(expected);
            return 'scope' in operation
                ? this.commitTerminal(expected, next, operation)
                : this.commitTransition(expected, next, operation);
        });
    }

    async append(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        return this.immediate(() => {
            this.assertOwner(fence);
            return matchesTurn(this.readState(fence), fence, execution)
                ? { accepted: true, persisted: this.record(fence, fence.turnId, execution, event) }
                : { accepted: false, reason: 'turn_not_active' };
        });
    }

    async appendControl(
        fence: GoalSessionControlFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        return this.immediate(() => {
            this.assertOwner(fence);
            const state = this.readState(fence);
            if (!matchesControl(state, fence)) return { accepted: false as const, reason: 'stale_fence' as const };
            return { accepted: true as const, persisted: this.record(fence, `#control-e${fence.controllerEpoch}`, execution, event) };
        });
    }

    async replay(identity: GoalSessionIdentity, afterSequence = 0): Promise<PersistedGoalSessionEvent[]> {
        this.assertOwner(identity);
        const rows = this.database.prepare(
            'SELECT payload_json FROM goal_events WHERE goal_id = ? AND sequence > ? ORDER BY sequence',
        ).all(identity.goalId, afterSequence) as Array<{ payload_json: string | null }>;
        return rows.flatMap(row => {
            if (!row.payload_json) return [];
            const event = JSON.parse(row.payload_json) as PersistedGoalSessionEvent;
            return event.sessionId === identity.sessionId ? [event] : [];
        });
    }

    async listPending(identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]> {
        this.assertOwner(identity);
        const rows = this.database.prepare(
            "SELECT message_id, sequence, body, created_at, acknowledged_at FROM goal_messages WHERE goal_id = ? AND state != 'acknowledged' ORDER BY sequence",
        ).all(identity.goalId) as Array<{
            message_id: string; sequence: number; body: string; created_at: string; acknowledged_at: string | null;
        }>;
        return rows.map(row => ({
            ...identity, messageId: row.message_id, sequence: row.sequence, body: row.body,
            createdAt: row.created_at, acknowledgedAt: row.acknowledged_at ?? undefined,
        }));
    }

    async acknowledgeWithEvent(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'> {
        return this.immediate(() => {
            this.assertOwner(fence);
            if (!matchesTurn(this.readState(fence), fence, execution)) return 'stale_fence';
            const row = this.database.prepare(
                'SELECT state FROM goal_messages WHERE goal_id = ? AND message_id = ?',
            ).get(fence.goalId, messageId) as { state: string } | undefined;
            if (!row) return 'not_found';
            if (row.state === 'acknowledged') return 'already_acknowledged';
            const acknowledgedAt = new Date().toISOString();
            this.database.prepare(
                "UPDATE goal_messages SET state = 'acknowledged', acknowledged_at = ? WHERE goal_id = ? AND message_id = ?",
            ).run(acknowledgedAt, fence.goalId, messageId);
            this.record(fence, fence.turnId, execution, { type: 'message_acknowledged', messageId });
            return 'acknowledged';
        });
    }

    async claim(identity: GoalSessionIdentity, operationId: string, model: string): Promise<GoalModelChangeHistoryRecord> {
        return this.immediate(() => {
            this.assertOwner(identity);
            const existing = this.readModelChange(identity, operationId);
            if (existing) return existing;
            const row = this.database.prepare(`
                INSERT INTO goal_session_runtime_model_sequences(scope, next_sequence) VALUES (?, 2)
                ON CONFLICT(scope) DO UPDATE SET next_sequence = next_sequence + 1
                RETURNING next_sequence - 1 AS sequence
            `).get(sqliteGoalScope(identity)) as { sequence: number };
            this.database.prepare(`INSERT INTO goal_session_runtime_model_changes
                (scope, operation_id, sequence, model, status) VALUES (?, ?, ?, ?, 'pending')`)
                .run(sqliteGoalScope(identity), operationId, row.sequence, model);
            return { operationId, model, sequence: row.sequence, status: 'pending' };
        });
    }

    async settle(
        identity: GoalSessionIdentity,
        operationId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void> {
        this.immediate(() => {
            this.assertOwner(identity);
            this.database.prepare(`UPDATE goal_session_runtime_model_changes
                SET status = 'settled', acknowledgement_json = ? WHERE scope = ? AND operation_id = ?`)
                .run(JSON.stringify(acknowledgement), sqliteGoalScope(identity), operationId);
            this.database.prepare(`UPDATE goal_session_runtime_model_changes SET status = 'retired', acknowledgement_json = NULL
                WHERE scope = ? AND status = 'settled' AND operation_id NOT IN (
                    SELECT operation_id FROM goal_session_runtime_model_changes
                    WHERE scope = ? AND status = 'settled' ORDER BY sequence DESC LIMIT 64
                )`).run(sqliteGoalScope(identity), sqliteGoalScope(identity));
        });
    }

    async claimProviderEffect(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
    ): Promise<GoalProviderEffectClaimResult> {
        assertGoalProviderEffectStage(stage);
        return this.immediate(() => {
            this.assertOwner(fence);
            assertProviderFirstEffectState(this.readState(fence), fence);
            const current = this.readEffect(fence, stage);
            if (current?.kind !== undefined && current.kind !== fence.kind) {
                throw new GoalSessionContractError('Provider effect kind conflicts with its durable claim', 'PROVIDER_EFFECT_IN_DOUBT');
            }
            if (current?.status === 'settled') {
                return { status: 'settled', outcome: JSON.parse(current.outcome_json ?? 'null') };
            }
            if (current?.status === 'terminal_in_doubt' || current && fence.kind === 'open') {
                this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                    SET status = 'terminal_in_doubt', updated_at = ? WHERE scope = ? AND operation_id = ? AND stage = ?`)
                    .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
                return { status: 'terminal_in_doubt' };
            }
            if (current) {
                this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                    SET status = 'claimed', updated_at = ? WHERE scope = ? AND operation_id = ? AND stage = ?`)
                    .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
                return { status: 'recoverable' };
            }
            this.database.prepare(`INSERT INTO goal_session_runtime_provider_effects
                (scope, operation_id, kind, stage, status, updated_at) VALUES (?, ?, ?, ?, 'claimed', ?)`)
                .run(sqliteGoalScope(fence), fence.operationId, fence.kind, stage, new Date().toISOString());
            return { status: 'claimed' };
        });
    }

    async runClaimedProviderEffect<T>(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        effect: () => GoalStartedProviderEffect<T>,
    ): Promise<GoalStartedProviderEffect<T>> {
        assertGoalProviderEffectStage(stage);
        return this.immediate(() => {
            this.assertOwner(fence);
            assertProviderFirstEffectState(this.readState(fence), fence);
            const claim = this.readEffect(fence, stage);
            if (!claim || claim.kind !== fence.kind || claim.status !== 'claimed') throw new GoalSessionContractError(
                'Provider effect stage does not own an exact durable claim', 'PROVIDER_EFFECT_IN_DOUBT',
            );
            this.database.prepare(`UPDATE goal_session_runtime_provider_effects SET status = 'starting', updated_at = ?
                WHERE scope = ? AND operation_id = ? AND stage = ? AND status = 'claimed'`)
                .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
            const started = effect();
            assertStartedProviderEffect<T>(started);
            this.database.prepare(`UPDATE goal_session_runtime_provider_effects SET status = 'started', updated_at = ?
                WHERE scope = ? AND operation_id = ? AND stage = ? AND status = 'starting'`)
                .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
            return started;
        });
    }

    async settleProviderEffect(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        outcome: unknown,
    ): Promise<void> {
        assertGoalProviderEffectStage(stage);
        const outcomeJson = stage === 'container_spawn' ? null : replayableProviderOutcomeJson(outcome);
        this.immediate(() => {
            this.assertOwner(fence);
            this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                SET status = ?, outcome_json = ?, updated_at = ? WHERE scope = ? AND operation_id = ? AND stage = ?`)
                .run(stage === 'container_spawn' ? 'terminal_in_doubt' : 'settled', outcomeJson,
                    new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
        });
    }

    async markProviderEffectRecoverable(fence: GoalProviderOperationFence, stage: GoalProviderEffectStage): Promise<void> {
        assertGoalProviderEffectStage(stage); this.immediate(() => {
            this.assertOwner(fence);
            this.database.prepare(`UPDATE goal_session_runtime_provider_effects SET status = 'recoverable', updated_at = ?
                WHERE scope = ? AND operation_id = ? AND stage = ? AND status != 'settled'`)
                .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage);
        });
    }

    private commitTransition(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        transition: GoalSessionControlTransition,
    ): GoalSessionState | null {
        const current = this.readState(expected);
        if (!matchesTransition(current, transition)) return null;
        const identity = sqliteTransitionKey(transition);
        if (this.hasCommit('transition', identity)) return current;
        if (current.version !== expected.version) return null;
        const saved = this.writeComparedState(expected, next);
        if (!saved) return null;
        for (const event of transition.auditEvents) this.record(
            transition.fence,
            transition.turnScoped === true && 'turnId' in transition.fence
                ? transition.fence.turnId : `#control-e${transition.fence.controllerEpoch}`,
            transition.execution, event,
        );
        this.addCommit('transition', identity);
        return saved;
    }

    private commitTerminal(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        completion: GoalTerminalCommit,
    ): GoalSessionState | null {
        const current = this.readState(expected);
        const identity = sqliteTerminalKey(completion);
        if (!current || current.version !== expected.version || current.controllerEpoch !== completion.fence.controllerEpoch
            || completion.scope === 'turn' && !matchesTurn(current, completion.fence, completion.execution)) return null;
        if (this.hasCommit('terminal', identity)) return current;
        const saved = this.writeComparedState(expected, next);
        if (!saved) return null;
        const turnId = completion.scope === 'turn'
            ? completion.fence.turnId : `#control-e${completion.fence.controllerEpoch}`;
        for (const event of completion.auditEvents) this.record(completion.fence, turnId, completion.execution, event);
        this.record(completion.fence, turnId, completion.execution, completion.event);
        this.addCommit('terminal', identity);
        return saved;
    }

    private writeComparedState(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): GoalSessionState | null {
        this.assertOwner(expected);
        const current = this.readState(expected);
        if (current?.version !== expected.version) return null;
        const saved = { ...structuredClone(next), version: expected.version + 1 };
        const result = this.database.prepare(`UPDATE goal_session_runtime_state SET payload_json = ?
            WHERE scope = ? AND payload_json = ?`)
            .run(JSON.stringify(saved), sqliteGoalScope(expected), JSON.stringify(current));
        return result.changes === 1 ? saved : null;
    }

    private record(
        fence: GoalSessionControlFence,
        turnId: string,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): PersistedGoalSessionEvent {
        const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM goal_events WHERE goal_id = ?')
            .get(fence.goalId) as { sequence: number };
        const persisted: PersistedGoalSessionEvent = {
            ...fence, turnId, ...execution, sequence: row.sequence + 1,
            recordedAt: new Date().toISOString(), event: structuredClone(sanitizeGoalSessionEvent(event)),
        };
        this.database.prepare(`INSERT INTO goal_events
            (goal_id, sequence, kind, event_type, payload_json, idempotency_key, lease_epoch, created_at)
            VALUES (?, ?, 'goal_session', ?, ?, ?, ?, ?)`)
            .run(fence.goalId, persisted.sequence, persisted.event.type, JSON.stringify(persisted),
                `goal-session:${fence.sessionId}:${persisted.sequence}`, fence.controllerEpoch, persisted.recordedAt);
        return persisted;
    }

    private readState(identity: GoalSessionIdentity): GoalSessionState | null {
        const row = this.database.prepare('SELECT payload_json FROM goal_session_runtime_state WHERE scope = ?')
            .get(sqliteGoalScope(identity)) as { payload_json: string } | undefined;
        return row ? JSON.parse(row.payload_json) as GoalSessionState : null;
    }

    private readEffect(identity: GoalProviderOperationFence, stage: GoalProviderEffectStage): EffectRow | undefined {
        return this.database.prepare(`SELECT kind, status, outcome_json FROM goal_session_runtime_provider_effects
            WHERE scope = ? AND operation_id = ? AND stage = ?`)
            .get(sqliteGoalScope(identity), identity.operationId, stage) as EffectRow | undefined;
    }

    private readModelChange(identity: GoalSessionIdentity, operationId: string): GoalModelChangeHistoryRecord | undefined {
        const row = this.database.prepare(`SELECT sequence, model, status, acknowledgement_json
            FROM goal_session_runtime_model_changes WHERE scope = ? AND operation_id = ?`)
            .get(sqliteGoalScope(identity), operationId) as {
                sequence: number; model: string; status: GoalModelChangeHistoryRecord['status']; acknowledgement_json: string | null;
            } | undefined;
        return row ? {
            operationId, sequence: row.sequence, model: row.model, status: row.status,
            acknowledgement: row.acknowledgement_json
                ? JSON.parse(row.acknowledgement_json) as GoalModelChangeAcknowledgement : undefined,
        } : undefined;
    }

    private assertOwner(identity: GoalSessionIdentity): void {
        const row = this.database.prepare('SELECT goal_id FROM goal_session_runtime_owners WHERE session_id = ?')
            .get(identity.sessionId) as { goal_id: string } | undefined;
        if (row && row.goal_id !== identity.goalId) throw new GoalSessionScopeError();
    }

    private hasCommit(kind: string, identity: string): boolean {
        return Boolean(this.database.prepare('SELECT 1 FROM goal_session_runtime_commits WHERE kind = ? AND identity = ?').get(kind, identity));
    }

    private addCommit(kind: string, identity: string): void {
        this.database.prepare('INSERT INTO goal_session_runtime_commits(kind, identity) VALUES (?, ?)').run(kind, identity);
    }

    private immediate<T>(operation: () => T): T {
        return this.database.transaction(operation).immediate();
    }
}

/** Mandatory production composition; no ephemeral fallback is accepted. */
export function createSqliteGoalSessionRuntimePorts(
    database: Database.Database,
    recovery: GoalSessionRecoveryPort,
): GoalSessionRuntimePorts {
    const domain = new SqliteGoalSessionControlDomain(database);
    return new AuthoritativeGoalSessionRuntimePorts(domain, recovery).asRuntimePorts();
}

function matchesControl(state: GoalSessionState | null, fence: GoalSessionControlFence): state is GoalSessionState {
    return Boolean(state && state.controllerEpoch === fence.controllerEpoch
        && state.providerBarrierIntent?.phase !== 'pending'
        && !['cancelling', 'terminated', 'failed'].includes(state.status));
}

function matchesTurn(
    state: GoalSessionState | null,
    fence: GoalSessionFence,
    execution: GoalExecutionIdentity,
): state is GoalSessionState {
    return Boolean(matchesControl(state, fence)
        && state.activeTurn?.turnId === fence.turnId
        && state.activeTurn.executionId === execution.executionId
        && state.activeTurn.attemptId === execution.attemptId
        && !['completed', 'cancelled', 'failed'].includes(state.activeTurn.status));
}

function matchesTransition(
    state: GoalSessionState | null,
    transition: GoalSessionControlTransition,
): state is GoalSessionState {
    if (!matchesControl(state, transition.fence)) return false;
    return transition.turnScoped !== true
        || 'turnId' in transition.fence && matchesTurn(state, transition.fence, transition.execution);
}
