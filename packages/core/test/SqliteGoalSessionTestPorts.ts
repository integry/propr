import Database from 'better-sqlite3';
import type {
    DurableCorrectiveMessage,
    GoalContainerInspection,
    GoalEventAppendResult,
    GoalExecutionIdentity,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionControlFence,
    GoalSessionControlTransition,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalModelChangeAcknowledgement,
    GoalModelChangeHistoryRecord,
    GoalProviderOperationFence,
    GoalStartedProviderEffect,
    GoalSessionRuntimePorts,
    GoalSessionState,
    GoalTerminalCommit,
    PersistedGoalSessionEvent,
} from '../src/agents/goalSession/contract.js';
import { sanitizeGoalSessionEvent } from '../src/agents/goalSession/securityBoundary.js';
import { assertProviderFirstEffectState } from '../src/agents/goalSession/providerFirstEffect.js';
import { assertStartedProviderEffect } from '../src/agents/goalSession/providerEffectProtocol.js';

function scope(identity: GoalSessionIdentity): string {
    return `${identity.goalId}\0${identity.sessionId}`;
}

function clone<T>(value: T): T { return structuredClone(value); }

/** Separate SQLite connections over one file, used only for true cross-port durability tests. */
export class SqliteGoalSessionTestPorts {
    private readonly database: Database.Database;
    private transitionFault: 'before_commit' | 'after_commit' | undefined;

    constructor(filename: string) {
        this.database = new Database(filename);
        this.database.pragma('journal_mode = WAL');
        this.database.pragma('busy_timeout = 5000');
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS goal_state (scope TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS goal_events (
                scope TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY (scope, sequence)
            );
            CREATE TABLE IF NOT EXISTS goal_commits (kind TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (kind, identity));
            CREATE TABLE IF NOT EXISTS goal_messages (
                scope TEXT NOT NULL, message_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY (scope, message_id)
            );
            CREATE TABLE IF NOT EXISTS goal_fixtures (kind TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY (kind, identity));
            CREATE TABLE IF NOT EXISTS goal_model_changes (
                scope TEXT NOT NULL, operation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                model TEXT NOT NULL, status TEXT NOT NULL, acknowledgement TEXT,
                PRIMARY KEY (scope, operation_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS goal_model_change_order
                ON goal_model_changes(scope, sequence);
            CREATE TABLE IF NOT EXISTS goal_model_sequences (
                scope TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)
            );
            CREATE TABLE IF NOT EXISTS goal_provider_effects (
                scope TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
                PRIMARY KEY (scope, operation_id)
            );
            INSERT OR IGNORE INTO goal_model_sequences(scope, next_sequence)
            SELECT scope, sequence + 1 FROM (
                SELECT scope, sequence,
                    ROW_NUMBER() OVER (PARTITION BY scope ORDER BY sequence DESC) AS ordering_rank
                FROM goal_model_changes
            ) WHERE ordering_rank = 1;
        `);
    }

    asRuntimePorts(): GoalSessionRuntimePorts {
        return {
            state: this, transitions: this, events: this, terminal: this, messages: this,
            recovery: this, modelChanges: this, providerFirstEffects: this,
        };
    }

    async claim(
        identity: GoalSessionIdentity,
        operationId: string,
        model: string,
    ): Promise<GoalModelChangeHistoryRecord> {
        return this.database.transaction(() => {
            const existing = this.readModelChange(identity, operationId);
            if (existing) return existing;
            const row = this.database.prepare(`
                INSERT INTO goal_model_sequences(scope, next_sequence) VALUES (?, 2)
                ON CONFLICT(scope) DO UPDATE SET next_sequence = next_sequence + 1
                RETURNING next_sequence - 1 AS sequence
            `).get(scope(identity)) as { sequence: number };
            this.database.prepare(
                'INSERT INTO goal_model_changes(scope, operation_id, sequence, model, status) VALUES (?, ?, ?, ?, ?)',
            ).run(scope(identity), operationId, row.sequence, model, 'pending');
            return { operationId, model, sequence: row.sequence, status: 'pending' as const };
        }).immediate();
    }

    async settle(
        identity: GoalSessionIdentity,
        operationId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void> {
        this.database.transaction(() => {
            this.database.prepare(
                'UPDATE goal_model_changes SET status = ?, acknowledgement = ? WHERE scope = ? AND operation_id = ?',
            ).run('settled', JSON.stringify(acknowledgement), scope(identity), operationId);
            this.database.prepare(`
                UPDATE goal_model_changes SET status = 'retired', acknowledgement = NULL
                WHERE scope = ? AND status = 'settled' AND operation_id NOT IN (
                    SELECT operation_id FROM goal_model_changes
                    WHERE scope = ? AND status = 'settled' ORDER BY sequence DESC LIMIT 64
                )
            `).run(scope(identity), scope(identity));
        }).immediate();
    }

    close(): void { this.database.close(); }

    /** Production-shape boundary: locked durable compare and primitive start are one transaction. */
    async start<T>(fence: GoalProviderOperationFence, effect: () => GoalStartedProviderEffect<T>): Promise<T> {
        let started: GoalStartedProviderEffect<T> | undefined;
        this.database.transaction(() => {
            const state = this.readState(fence);
            assertProviderFirstEffectState(state, fence);
            this.database.prepare(
                'INSERT OR IGNORE INTO goal_provider_effects(scope, operation_id, kind) VALUES (?, ?, ?)',
            ).run(scope(fence), fence.operationId, fence.kind);
            started = effect();
            assertStartedProviderEffect<T>(started);
        }).immediate();
        return started!.completion;
    }

    providerEffectCount(): number {
        return (this.database.prepare('SELECT COUNT(*) AS count FROM goal_provider_effects').get() as { count: number }).count;
    }

    setTransitionFault(fault: 'before_commit' | 'after_commit' | undefined): void {
        this.transitionFault = fault;
    }

    async load(identity: GoalSessionIdentity): Promise<GoalSessionState | null> {
        return this.readState(identity);
    }

    async create(state: Omit<GoalSessionState, 'version'>): Promise<GoalSessionState | null> {
        const saved = { ...clone(state), version: 1 };
        const result = this.database.prepare('INSERT OR IGNORE INTO goal_state(scope, payload) VALUES (?, ?)')
            .run(scope(state), JSON.stringify(saved));
        return result.changes === 1 ? saved : null;
    }

    async compareAndSet(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): Promise<GoalSessionState | null> {
        const saved = { ...clone(next), version: expected.version + 1 };
        const current = this.readState(expected);
        if (current?.version !== expected.version) return null;
        const result = this.database.prepare('UPDATE goal_state SET payload = ? WHERE scope = ? AND payload = ?')
            .run(JSON.stringify(saved), scope(expected), JSON.stringify(current));
        return result.changes === 1 ? saved : null;
    }

    async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ): Promise<GoalSessionState | null> {
        const isTransition = !('scope' in operation);
        if (isTransition && this.transitionFault === 'before_commit') {
            this.transitionFault = undefined;
            throw new Error('Injected crash before state/audit transaction commit');
        }
        const result = this.database.transaction(() => 'scope' in operation
            ? this.commitTerminal(expected, next, operation)
            : this.commitTransition(expected, next, operation))();
        if (isTransition && this.transitionFault === 'after_commit') {
            this.transitionFault = undefined;
            throw new Error('Injected crash after state/audit transaction commit');
        }
        return result;
    }

    async append(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        return this.database.transaction(() => {
            const state = this.readState(fence);
            if (!matchesTurn(state, fence, execution)) return { accepted: false as const, reason: 'turn_not_active' as const };
            return { accepted: true as const, persisted: this.record(fence, fence.turnId, execution, event) };
        })();
    }

    async appendControl(
        fence: GoalSessionControlFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        return this.database.transaction(() => {
            const state = this.readState(fence);
            if (!state || state.controllerEpoch !== fence.controllerEpoch
                || state.providerBarrierIntent?.phase === 'pending'
                || ['cancelling', 'terminated', 'failed'].includes(state.status)) {
                return { accepted: false as const, reason: 'stale_fence' as const };
            }
            return {
                accepted: true as const,
                persisted: this.record(fence, `#control-e${fence.controllerEpoch}`, execution, event),
            };
        })();
    }

    async replay(identity: GoalSessionIdentity, afterSequence = 0): Promise<PersistedGoalSessionEvent[]> {
        const rows = this.database.prepare(
            'SELECT payload FROM goal_events WHERE scope = ? AND sequence > ? ORDER BY sequence',
        ).all(scope(identity), afterSequence) as Array<{ payload: string }>;
        return rows.map(row => JSON.parse(row.payload) as PersistedGoalSessionEvent);
    }

    async listPending(identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]> {
        const rows = this.database.prepare(
            'SELECT payload FROM goal_messages WHERE scope = ? ORDER BY sequence',
        ).all(scope(identity)) as Array<{ payload: string }>;
        return rows.map(row => JSON.parse(row.payload) as DurableCorrectiveMessage)
            .filter(message => !message.acknowledgedAt);
    }

    async acknowledge(
        _fence: GoalSessionFence,
        _execution: GoalExecutionIdentity,
        _messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'> {
        return this.acknowledgeMessage(_fence, _execution, _messageId, false);
    }

    async acknowledgeWithEvent(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'> {
        return this.database.transaction(() => {
            const state = this.readState(fence);
            if (!matchesTurn(state, fence, execution)) return 'stale_fence' as const;
            const message = this.readMessage(fence, messageId);
            if (!message) return 'not_found' as const;
            if (message.acknowledgedAt) return 'already_acknowledged' as const;
            this.writeMessage({ ...message, acknowledgedAt: new Date().toISOString() });
            this.record(fence, fence.turnId, execution, { type: 'message_acknowledged', messageId });
            return 'acknowledged' as const;
        })();
    }

    enqueueMessage(message: DurableCorrectiveMessage): void {
        this.database.prepare('INSERT INTO goal_messages(scope, message_id, sequence, payload) VALUES (?, ?, ?, ?)')
            .run(scope(message), message.messageId, message.sequence, JSON.stringify(message));
    }

    async inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection> {
        return this.fixture('container', scope(identity)) ?? { status: 'missing', reason: 'not configured' };
    }

    async inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection> {
        return this.fixture('repository', repository.worktreePath) ?? {
            ...repository, exists: false, reason: 'not configured',
        };
    }

    setContainerInspection(identity: GoalSessionIdentity, inspection: GoalContainerInspection): void {
        this.setFixture('container', scope(identity), inspection);
    }

    setRepositoryInspection(repository: GoalRepositoryIdentity, inspection: GoalRepositoryInspection): void {
        this.setFixture('repository', repository.worktreePath, inspection);
    }

    private readState(identity: GoalSessionIdentity): GoalSessionState | null {
        const row = this.database.prepare('SELECT payload FROM goal_state WHERE scope = ?')
            .get(scope(identity)) as { payload: string } | undefined;
        return row ? JSON.parse(row.payload) as GoalSessionState : null;
    }

    private readModelChange(
        identity: GoalSessionIdentity,
        operationId: string,
    ): GoalModelChangeHistoryRecord | undefined {
        const row = this.database.prepare(
            'SELECT sequence, model, status, acknowledgement FROM goal_model_changes WHERE scope = ? AND operation_id = ?',
        ).get(scope(identity), operationId) as {
            sequence: number; model: string; status: GoalModelChangeHistoryRecord['status']; acknowledgement: string | null;
        } | undefined;
        return row ? {
            operationId, sequence: row.sequence, model: row.model, status: row.status,
            acknowledgement: row.acknowledgement
                ? JSON.parse(row.acknowledgement) as GoalModelChangeAcknowledgement : undefined,
        } : undefined;
    }

    private acknowledgeMessage(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
        withEvent: boolean,
    ): 'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found' {
        return this.database.transaction(() => {
            if (!matchesTurn(this.readState(fence), fence, execution)) return 'stale_fence' as const;
            const message = this.readMessage(fence, messageId);
            if (!message) return 'not_found' as const;
            if (message.acknowledgedAt) return 'already_acknowledged' as const;
            this.writeMessage({ ...message, acknowledgedAt: new Date().toISOString() });
            if (withEvent) this.record(fence, fence.turnId, execution, { type: 'message_acknowledged', messageId });
            return 'acknowledged' as const;
        })();
    }

    private readMessage(identity: GoalSessionIdentity, messageId: string): DurableCorrectiveMessage | undefined {
        const row = this.database.prepare('SELECT payload FROM goal_messages WHERE scope = ? AND message_id = ?')
            .get(scope(identity), messageId) as { payload: string } | undefined;
        return row ? JSON.parse(row.payload) as DurableCorrectiveMessage : undefined;
    }

    private writeMessage(message: DurableCorrectiveMessage): void {
        this.database.prepare('UPDATE goal_messages SET payload = ? WHERE scope = ? AND message_id = ?')
            .run(JSON.stringify(message), scope(message), message.messageId);
    }

    private commitTransition(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        transition: GoalSessionControlTransition,
    ): GoalSessionState | null {
        const current = this.readState(expected);
        if (!matchesTransition(current, transition)) return null;
        const identity = transitionKey(transition);
        if (this.hasCommit('transition', identity)) return current;
        if (current.version !== expected.version) return null;
        const saved = { ...clone(next), version: current.version + 1 };
        this.writeState(current, saved);
        for (const event of transition.auditEvents) {
            const turnId = transition.turnScoped === true && 'turnId' in transition.fence
                ? transition.fence.turnId : `#control-e${transition.fence.controllerEpoch}`;
            this.record(transition.fence, turnId, transition.execution, event);
        }
        this.addCommit('transition', identity);
        return saved;
    }

    private commitTerminal(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        completion: GoalTerminalCommit,
    ): GoalSessionState | null {
        const current = this.readState(expected);
        const identity = terminalKey(completion);
        if (this.hasCommit('terminal', identity)) return current;
        if (!current || current.version !== expected.version
            || current.controllerEpoch !== completion.fence.controllerEpoch) return null;
        if (completion.scope === 'turn' && !matchesTurn(current, completion.fence, completion.execution)) return null;
        const saved = { ...clone(next), version: current.version + 1 };
        this.writeState(current, saved);
        const turnId = completion.scope === 'turn'
            ? completion.fence.turnId : `#control-e${completion.fence.controllerEpoch}`;
        for (const event of completion.auditEvents) this.record(completion.fence, turnId, completion.execution, event);
        this.record(completion.fence, turnId, completion.execution, completion.event);
        this.addCommit('terminal', identity);
        return saved;
    }

    private writeState(current: GoalSessionState, saved: GoalSessionState): void {
        const result = this.database.prepare('UPDATE goal_state SET payload = ? WHERE scope = ? AND payload = ?')
            .run(JSON.stringify(saved), scope(current), JSON.stringify(current));
        if (result.changes !== 1) throw new Error('SQLite state changed inside an immediate transaction');
    }

    private record(
        fence: GoalSessionControlFence,
        turnId: string,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): PersistedGoalSessionEvent {
        const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM goal_events WHERE scope = ?')
            .get(scope(fence)) as { sequence: number };
        const persisted: PersistedGoalSessionEvent = {
            ...fence, turnId, ...execution, sequence: row.sequence + 1,
            recordedAt: new Date().toISOString(), event: clone(sanitizeGoalSessionEvent(event)),
        };
        this.database.prepare('INSERT INTO goal_events(scope, sequence, payload) VALUES (?, ?, ?)')
            .run(scope(fence), persisted.sequence, JSON.stringify(persisted));
        return persisted;
    }

    private fixture<T>(kind: string, identity: string): T | undefined {
        const row = this.database.prepare('SELECT payload FROM goal_fixtures WHERE kind = ? AND identity = ?')
            .get(kind, identity) as { payload: string } | undefined;
        return row ? JSON.parse(row.payload) as T : undefined;
    }

    private setFixture(kind: string, identity: string, value: unknown): void {
        this.database.prepare(
            'INSERT INTO goal_fixtures(kind, identity, payload) VALUES (?, ?, ?) '
            + 'ON CONFLICT(kind, identity) DO UPDATE SET payload = excluded.payload',
        ).run(kind, identity, JSON.stringify(value));
    }

    private hasCommit(kind: string, identity: string): boolean {
        return Boolean(this.database.prepare('SELECT 1 FROM goal_commits WHERE kind = ? AND identity = ?').get(kind, identity));
    }

    private addCommit(kind: string, identity: string): void {
        this.database.prepare('INSERT INTO goal_commits(kind, identity) VALUES (?, ?)').run(kind, identity);
    }
}

function matchesTurn(
    state: GoalSessionState | null,
    fence: GoalSessionFence,
    execution: GoalExecutionIdentity,
): state is GoalSessionState {
    return Boolean(state && state.controllerEpoch === fence.controllerEpoch
        && state.providerBarrierIntent?.phase !== 'pending'
        && !['cancelling', 'terminated', 'failed'].includes(state.status)
        && state.activeTurn?.turnId === fence.turnId
        && state.activeTurn.executionId === execution.executionId
        && state.activeTurn.attemptId === execution.attemptId
        && !['completed', 'cancelled', 'failed'].includes(state.activeTurn.status));
}

function matchesTransition(
    state: GoalSessionState | null,
    transition: GoalSessionControlTransition,
): state is GoalSessionState {
    if (!state || state.controllerEpoch !== transition.fence.controllerEpoch
        || state.providerBarrierIntent?.phase === 'pending'
        || ['cancelling', 'terminated', 'failed'].includes(state.status)) return false;
    return transition.turnScoped !== true
        || ('turnId' in transition.fence && matchesTurn(state, transition.fence, transition.execution));
}

function transitionKey(value: GoalSessionControlTransition): string {
    return JSON.stringify([scope(value.fence), value.fence.controllerEpoch,
        value.turnScoped === true && 'turnId' in value.fence ? value.fence.turnId : null,
        value.execution.executionId, value.execution.attemptId, value.transitionId]);
}

function terminalKey(value: GoalTerminalCommit): string {
    return JSON.stringify([value.scope, scope(value.fence), value.fence.controllerEpoch,
        value.scope === 'turn' ? value.fence.turnId : null,
        value.execution.executionId, value.execution.attemptId]);
}
