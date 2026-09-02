import { createHash, randomUUID } from 'node:crypto';
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
import { GoalSessionContractError, GoalSessionScopeError } from './errors.js';
import { assertStartedProviderEffect } from './providerEffectProtocol.js';
import { assertProviderFirstEffectState } from './providerFirstEffect.js';
import { assertGoalProviderEffectStage, assertGoalProviderOperationFence } from './providerOperationBoundary.js';
import { sanitizeGoalSessionEvent } from './securityBoundary.js';
import { sqliteGoalScope, sqliteTerminalKey, sqliteTransitionKey } from './sqliteGoalSessionKeys.js';
import { assertSqliteGoalControlSchema, replayableProviderOutcomeJson } from './sqliteGoalSessionSchema.js';
import { isSafeIdentifier } from './safeIdentifier.js';

type EffectRow = { kind: string; status: string; claim_token: string; outcome_json: string | null };

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
            this.bindOwnerForCreate(state);
            this.assertOwner(state);
            const result = this.database.prepare(
                `INSERT OR IGNORE INTO goal_session_runtime_state
                    (session_id, goal_id, scope, payload_json) VALUES (?, ?, ?, ?)`,
            ).run(state.sessionId, state.goalId, sqliteGoalScope(state), JSON.stringify(saved));
            if (result.changes !== 1) return null;
            this.syncProviderSession(saved);
            return saved;
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
            `SELECT payload_json FROM goal_events
                WHERE goal_id = ? AND sequence > ? AND kind = 'domain'
                    AND event_type LIKE 'goal_session.%' ORDER BY sequence`,
        ).all(identity.goalId, afterSequence) as Array<{ payload_json: string | null }>;
        return rows.flatMap(row => {
            if (!row.payload_json) return [];
            let event: unknown;
            try { event = JSON.parse(row.payload_json); }
            catch { return []; }
            return isPersistedRuntimeEvent(event, identity) ? [event] : [];
        });
    }

    async listPending(identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]> {
        this.assertOwner(identity);
        const rows = this.database.prepare(
            `SELECT message_id, sequence, body, created_at, acknowledged_at FROM goal_messages
                WHERE goal_id = ? AND state IN ('queued', 'delivering', 'delivered') ORDER BY queue_ordinal`,
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
            const row = this.database.prepare(`SELECT state, delivered_at FROM goal_messages
                WHERE goal_id = ? AND message_id = ?`).get(fence.goalId, messageId) as {
                state: string; delivered_at: string | null;
            } | undefined;
            if (!row) return 'not_found';
            if (row.state === 'acknowledged') return 'already_acknowledged';
            if (!['queued', 'delivering', 'delivered'].includes(row.state)) return 'not_found';
            const acknowledgedAt = new Date().toISOString();
            if (row.state === 'queued') this.database.prepare(`UPDATE goal_messages SET state = 'delivering',
                claimed_by = ?, claimed_turn_id = ?, claimed_lease_generation = ?,
                delivery_key = ?, delivery_attempts = delivery_attempts + 1
                WHERE goal_id = ? AND message_id = ? AND state = 'queued'`)
                .run(fence.sessionId, fence.turnId, fence.controllerEpoch,
                    boundedEventKey(['message-delivery', fence.sessionId, fence.turnId, messageId]), fence.goalId, messageId);
            if (row.state !== 'delivered') this.database.prepare(`UPDATE goal_messages SET state = 'delivered', delivered_at = ?
                WHERE goal_id = ? AND message_id = ? AND state = 'delivering'`)
                .run(acknowledgedAt, fence.goalId, messageId);
            const result = this.database.prepare(`UPDATE goal_messages SET state = 'acknowledged', acknowledged_at = ?
                WHERE goal_id = ? AND message_id = ? AND state = 'delivered' AND delivered_at IS NOT NULL`)
                .run(acknowledgedAt, fence.goalId, messageId);
            if (result.changes !== 1) return 'stale_fence';
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
                INSERT INTO goal_session_runtime_model_sequences
                    (session_id, goal_id, scope, next_sequence) VALUES (?, ?, ?, 2)
                ON CONFLICT(scope) DO UPDATE SET next_sequence = next_sequence + 1
                RETURNING next_sequence - 1 AS sequence
            `).get(identity.sessionId, identity.goalId, sqliteGoalScope(identity)) as { sequence: number };
            this.database.prepare(`INSERT INTO goal_session_runtime_model_changes
                (session_id, goal_id, scope, operation_id, sequence, model, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
                .run(identity.sessionId, identity.goalId, sqliteGoalScope(identity), operationId, row.sequence, model);
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
        assertGoalProviderOperationFence(fence); assertGoalProviderEffectStage(stage);
        return this.immediate(() => {
            this.assertOwner(fence);
            assertProviderFirstEffectState(this.readState(fence), fence);
            const current = this.readEffect(fence, stage);
            if (current && current.kind !== fence.kind) {
                throw new GoalSessionContractError('Provider effect kind conflicts with its durable claim', 'PROVIDER_EFFECT_IN_DOUBT');
            }
            if (current?.status === 'settled') {
                return { status: 'settled', outcome: JSON.parse(current.outcome_json ?? 'null') };
            }
            if (current && (current.status === 'started' || current.status === 'poisoned')) {
                return { status: 'terminal_in_doubt' };
            }
            const token = randomUUID();
            if (current) {
                const result = this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                    SET status = 'recoverable', claim_token = ?, updated_at = ?
                    WHERE scope = ? AND operation_id = ? AND stage = ?
                        AND claim_token = ? AND status IN ('unstarted', 'recoverable')`)
                    .run(token, new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage, current.claim_token);
                if (result.changes !== 1) throw effectCasFailure();
                return { status: 'recoverable', token };
            }
            this.database.prepare(`INSERT INTO goal_session_runtime_provider_effects
                (session_id, goal_id, scope, operation_id, kind, stage, status, claim_token, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'unstarted', ?, ?)`)
                .run(fence.sessionId, fence.goalId, sqliteGoalScope(fence), fence.operationId,
                    fence.kind, stage, token, new Date().toISOString());
            return { status: 'claimed', token };
        });
    }

    async runClaimedProviderEffect<T>(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        token: string,
        effect: () => GoalStartedProviderEffect<T>,
    ): Promise<GoalStartedProviderEffect<T>> {
        assertGoalProviderOperationFence(fence); assertGoalProviderEffectStage(stage);
        if (!isSafeIdentifier(token)) throw effectCasFailure();
        // Persist provider entry before callback execution. A crash after this
        // CAS is conservatively live/unknown and can never re-enter callback.
        this.immediate(() => {
            this.assertOwner(fence);
            assertProviderFirstEffectState(this.readState(fence), fence);
            const result = this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                SET status = 'started', updated_at = ? WHERE scope = ? AND operation_id = ?
                    AND stage = ? AND claim_token = ? AND status IN ('unstarted', 'recoverable')`)
                .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage, token);
            if (result.changes !== 1) throw effectCasFailure();
        });
        // Re-lock and revalidate the authoritative state immediately around the
        // synchronous primitive start. Invalidations on another connection are
        // serialized before or after this callback, never through it.
        return this.immediate(() => {
            this.assertOwner(fence);
            assertProviderFirstEffectState(this.readState(fence), fence);
            const claim = this.readEffect(fence, stage);
            if (!claim || claim.kind !== fence.kind || claim.status !== 'started'
                || claim.claim_token !== token) throw effectCasFailure();
            const started = effect();
            assertStartedProviderEffect<T>(started);
            return started;
        });
    }

    async settleProviderEffect(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        token: string,
        outcome: unknown,
    ): Promise<void> {
        assertGoalProviderOperationFence(fence); assertGoalProviderEffectStage(stage);
        if (!isSafeIdentifier(token)) throw effectCasFailure();
        const outcomeJson = stage === 'container_spawn' ? null : replayableProviderOutcomeJson(outcome);
        this.immediate(() => {
            this.assertOwner(fence);
            const result = this.database.prepare(`UPDATE goal_session_runtime_provider_effects
                SET status = ?, outcome_json = ?, updated_at = ? WHERE scope = ? AND operation_id = ?
                    AND stage = ? AND status = 'started' AND claim_token = ?`)
                .run(stage === 'container_spawn' ? 'poisoned' : 'settled', outcomeJson,
                    new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage, token);
            if (result.changes !== 1) throw effectCasFailure();
        });
    }

    async poisonProviderEffect(fence: GoalProviderOperationFence, stage: GoalProviderEffectStage, token: string): Promise<void> {
        assertGoalProviderOperationFence(fence); assertGoalProviderEffectStage(stage);
        if (!isSafeIdentifier(token)) throw effectCasFailure();
        this.immediate(() => {
            this.assertOwner(fence);
            this.database.prepare(`UPDATE goal_session_runtime_provider_effects SET status = 'poisoned', updated_at = ?
                WHERE scope = ? AND operation_id = ? AND stage = ? AND claim_token = ? AND status != 'settled'`)
                .run(new Date().toISOString(), sqliteGoalScope(fence), fence.operationId, stage, token);
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
        this.addCommit(transition.fence, 'transition', identity);
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
        this.addCommit(completion.fence, 'terminal', identity);
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
        if (result.changes !== 1) return null;
        this.syncProviderSession(saved);
        return saved;
    }

    private syncProviderSession(state: GoalSessionState): void {
        const metadata = state.recoveryMetadata === undefined ? null : replayableProviderOutcomeJson(state.recoveryMetadata);
        const result = this.database.prepare(`UPDATE goal_provider_sessions SET
            provider_thread_id = ?, recovery_metadata_json = ?,
            effective_model = COALESCE(?, effective_model), lease_generation = ?,
            current_turn_id = ?, current_execution_id = ?, current_attempt_id = ?, updated_at = ?
            WHERE session_id = ? AND goal_id = ?`)
            .run(state.providerSessionId ?? null, metadata, state.currentModel ?? null, state.controllerEpoch,
                state.activeTurn?.turnId ?? null, state.activeTurn?.executionId ?? null,
                state.activeTurn?.attemptId ?? null, new Date().toISOString(), state.sessionId, state.goalId);
        if (result.changes !== 1) throw new GoalSessionScopeError();
    }

    private record(
        fence: GoalSessionControlFence,
        turnId: string,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): PersistedGoalSessionEvent {
        const sequence = this.allocateEventSequence(fence.goalId);
        const persisted: PersistedGoalSessionEvent = {
            ...fence, turnId, ...execution, sequence,
            recordedAt: new Date().toISOString(), event: structuredClone(sanitizeGoalSessionEvent(event)),
        };
        const payloadJson = replayableProviderOutcomeJson(persisted);
        if (Buffer.byteLength(payloadJson, 'utf8') > 256 * 1024) throw new GoalSessionContractError(
            'Goal runtime event exceeds the authoritative payload bound', 'UNSAFE_PROVIDER_VALUE',
        );
        this.database.prepare(`INSERT INTO goal_events
            (goal_id, sequence, kind, event_type, payload_json, idempotency_key, lease_epoch, created_at,
                schema_version, source_session_id, source_turn_id, source_execution_id, source_attempt_id,
                lease_generation, payload_bytes)
            VALUES (?, ?, 'domain', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
            .run(fence.goalId, persisted.sequence, `goal_session.${persisted.event.type}`, payloadJson,
                boundedEventKey(['goal-session', fence.sessionId, String(sequence)]),
                fence.controllerEpoch, persisted.recordedAt, fence.sessionId, turnId,
                execution.executionId, execution.attemptId, fence.controllerEpoch,
                Buffer.byteLength(payloadJson, 'utf8'));
        this.database.prepare(`UPDATE goal_event_state SET projection_sequence = ?, updated_at = ?
            WHERE goal_id = ? AND projection_sequence < ?`)
            .run(sequence, persisted.recordedAt, fence.goalId, sequence);
        return persisted;
    }

    private allocateEventSequence(goalId: string): number {
        this.database.prepare(`INSERT OR IGNORE INTO goal_event_state
            (goal_id, high_watermark, min_retained_sequence, projection_sequence, checkpoint_sequence, updated_at)
            SELECT goal_id, COALESCE((SELECT MAX(sequence) FROM goal_events WHERE goal_id = ?), 0), 1,
                COALESCE((SELECT MAX(sequence) FROM goal_events WHERE goal_id = ?), 0), 0, ?
            FROM goals WHERE goal_id = ?`)
            .run(goalId, goalId, new Date().toISOString(), goalId);
        const row = this.database.prepare(`UPDATE goal_event_state
            SET high_watermark = high_watermark + 1, updated_at = ? WHERE goal_id = ?
            RETURNING high_watermark AS sequence`).get(new Date().toISOString(), goalId) as { sequence: number } | undefined;
        if (!row) throw new GoalSessionContractError(
            'Authoritative goal event allocator is missing', 'AUTHORITATIVE_DOMAIN_MISSING',
        );
        return row.sequence;
    }

    private readState(identity: GoalSessionIdentity): GoalSessionState | null {
        const row = this.database.prepare('SELECT payload_json FROM goal_session_runtime_state WHERE scope = ?')
            .get(sqliteGoalScope(identity)) as { payload_json: string } | undefined;
        return row ? JSON.parse(row.payload_json) as GoalSessionState : null;
    }

    private readEffect(identity: GoalProviderOperationFence, stage: GoalProviderEffectStage): EffectRow | undefined {
        return this.database.prepare(`SELECT kind, status, claim_token, outcome_json FROM goal_session_runtime_provider_effects
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
        const row = this.database.prepare('SELECT goal_id FROM goal_provider_sessions WHERE session_id = ?')
            .get(identity.sessionId) as { goal_id: string } | undefined;
        if (!row || row.goal_id !== identity.goalId) throw new GoalSessionScopeError();
    }

    private bindOwnerForCreate(state: Omit<GoalSessionState, 'version'>): void {
        if (!isSafeIdentifier(state.goalId) || !isSafeIdentifier(state.sessionId)
            || !isSafeIdentifier(state.provider)) throw new GoalSessionScopeError();
        try {
            this.database.prepare(`INSERT OR IGNORE INTO goal_provider_sessions
                (session_id, goal_id, agent, effective_model, lease_generation, created_at, updated_at)
                SELECT ?, goal_id, agent, effective_model, lease_epoch, ?, ? FROM goals
                WHERE goal_id = ? AND agent = ?`)
                .run(state.sessionId, new Date().toISOString(), new Date().toISOString(), state.goalId, state.provider);
        } catch { throw new GoalSessionScopeError(); }
        this.assertOwner(state);
    }

    private hasCommit(kind: string, identity: string): boolean {
        return Boolean(this.database.prepare('SELECT 1 FROM goal_session_runtime_commits WHERE kind = ? AND identity = ?').get(kind, identity));
    }

    private addCommit(owner: GoalSessionIdentity, kind: string, identity: string): void {
        this.database.prepare(`INSERT INTO goal_session_runtime_commits
            (session_id, goal_id, kind, identity) VALUES (?, ?, ?, ?)`)
            .run(owner.sessionId, owner.goalId, kind, identity);
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

function boundedEventKey(parts: readonly string[]): string {
    return `goal-session:${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

function isPersistedRuntimeEvent(
    value: unknown,
    identity: GoalSessionIdentity,
): value is PersistedGoalSessionEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const event = value as Partial<PersistedGoalSessionEvent>;
    if (event.goalId !== identity.goalId || event.sessionId !== identity.sessionId
        || !isSafeIdentifier(event.turnId) || !isSafeIdentifier(event.executionId)
        || !isSafeIdentifier(event.attemptId) || !Number.isSafeInteger(event.controllerEpoch)
        || !Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1
        || typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))
        || !event.event || typeof event.event !== 'object' || Array.isArray(event.event)) return false;
    try { sanitizeGoalSessionEvent(event.event as GoalSessionEvent); }
    catch { return false; }
    return true;
}

function effectCasFailure(): GoalSessionContractError {
    return new GoalSessionContractError(
        'Provider effect token no longer owns the exact durable state', 'PROVIDER_EFFECT_IN_DOUBT',
    );
}
