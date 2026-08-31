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
    GoalSessionRuntimePorts,
    GoalSessionState,
    GoalTerminalCommit,
    PersistedGoalSessionEvent,
} from '../src/agents/goalSession/contract.js';

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
            CREATE TABLE IF NOT EXISTS goal_fixtures (kind TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY (kind, identity));
        `);
    }

    asRuntimePorts(): GoalSessionRuntimePorts {
        return { state: this, transitions: this, events: this, terminal: this, messages: this, recovery: this };
    }

    close(): void { this.database.close(); }

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

    async listPending(_identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]> { return []; }

    async acknowledge(
        _fence: GoalSessionFence,
        _execution: GoalExecutionIdentity,
        _messageId: string,
    ): Promise<'not_found'> { return 'not_found'; }

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
            recordedAt: new Date().toISOString(), event: clone(event),
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
