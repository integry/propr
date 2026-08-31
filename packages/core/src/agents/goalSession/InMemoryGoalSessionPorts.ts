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
    GoalSessionEventSink,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalSessionMessagePort,
    GoalSessionRecoveryPort,
    GoalSessionRuntimePorts,
    GoalSessionState,
    GoalSessionStatePort,
    GoalSessionTerminalPort,
    GoalSessionTransitionPort,
    GoalTerminalCommit,
    PersistedGoalSessionEvent,
} from './contract.js';

export class GoalSessionScopeError extends Error {
    constructor(message = 'A provider session is owned by a different goal') {
        super(message);
        this.name = 'GoalSessionScopeError';
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function keyOf(identity: GoalSessionIdentity): string {
    return `${identity.goalId}\0${identity.sessionId}`;
}

/**
 * Deterministic in-memory durable-port fake used by contract tests and by
 * embedders that want the runtime without a database. All state/event/message
 * mutations are synchronous inside each async method, which gives the same
 * atomic fence semantics expected from a database transaction.
 *
 * This is explicitly NOT a production durability fallback: everything lives in
 * process memory and is lost on restart, so it must never back a real goal that
 * needs to survive a worker/daemon crash. Production deployments provide a
 * transactional {@link GoalSessionRuntimePorts} implementation instead.
 */
export class InMemoryGoalSessionPorts implements
    GoalSessionStatePort,
    GoalSessionEventSink,
    GoalSessionMessagePort,
    GoalSessionRecoveryPort,
    GoalSessionTerminalPort,
    GoalSessionTransitionPort {
    /** Marks this implementation as an ephemeral test/embedding double, never durable storage. */
    readonly isEphemeralTestDouble = true;

    private readonly states = new Map<string, GoalSessionState>();
    private readonly sessionOwners = new Map<string, string>();
    private readonly events = new Map<string, PersistedGoalSessionEvent[]>();
    private readonly messages = new Map<string, DurableCorrectiveMessage[]>();
    private readonly containerInspections = new Map<string, GoalContainerInspection>();
    private readonly repositoryInspections = new Map<string, GoalRepositoryInspection>();
    private readonly terminalCommits = new Set<string>();
    private readonly transitionCommits = new Set<string>();
    private terminalFault: 'before_commit' | 'before_commit_always' | 'after_commit' | undefined;
    private transitionFault: 'before_commit' | 'after_commit' | undefined;

    asRuntimePorts(): GoalSessionRuntimePorts {
        return { state: this, transitions: this, events: this, terminal: this, messages: this, recovery: this };
    }

    async load(identity: GoalSessionIdentity): Promise<GoalSessionState | null> {
        this.assertGoalScope(identity);
        const state = this.states.get(keyOf(identity));
        return state ? clone(state) : null;
    }

    async create(state: Omit<GoalSessionState, 'version'>): Promise<GoalSessionState | null> {
        this.assertGoalScope(state);
        const key = keyOf(state);
        if (this.states.has(key)) return null;
        const saved = { ...clone(state), version: 1 };
        this.sessionOwners.set(state.sessionId, state.goalId);
        this.states.set(key, saved);
        return clone(saved);
    }

    async compareAndSet(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): Promise<GoalSessionState | null> {
        this.assertGoalScope(expected);
        this.assertGoalScope(next);
        if (expected.goalId !== next.goalId || expected.sessionId !== next.sessionId) {
            throw new GoalSessionScopeError('A state update cannot move a session to another goal or identity');
        }
        const key = keyOf(expected);
        const current = this.states.get(key);
        if (!current || current.version !== expected.version) return null;
        const saved = { ...clone(next), version: current.version + 1 };
        this.states.set(key, saved);
        return clone(saved);
    }

    async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ): Promise<GoalSessionState | null> {
        if (!('scope' in operation)) return this.commitTransition(expected, next, operation);
        return this.commitTerminal(expected, next, operation);
    }

    private commitTerminal(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        completion: GoalTerminalCommit,
    ): GoalSessionState | null {
        this.assertGoalScope(expected);
        this.assertGoalScope(next);
        if (expected.goalId !== next.goalId || expected.sessionId !== next.sessionId) {
            throw new GoalSessionScopeError('A terminal transaction cannot move a session to another goal or identity');
        }
        const key = keyOf(expected);
        const current = this.states.get(key);
        const commitKey = terminalCommitKey(completion);
        const turnId = completion.scope === 'turn'
            ? completion.fence.turnId
            : `#control-e${completion.fence.controllerEpoch}`;
        if (this.terminalCommits.has(commitKey)) return current ? clone(current) : null;
        if (!current || current.version !== expected.version
            || current.controllerEpoch !== completion.fence.controllerEpoch) return null;
        if (completion.scope === 'turn'
            && (current.activeTurn?.turnId !== completion.fence.turnId
                || current.activeTurn.executionId !== completion.execution.executionId
                || current.activeTurn.attemptId !== completion.execution.attemptId)) return null;
        if (this.terminalFault === 'before_commit' || this.terminalFault === 'before_commit_always') {
            if (this.terminalFault === 'before_commit') this.terminalFault = undefined;
            throw new Error('Injected crash before terminal transaction commit');
        }
        const saved = { ...clone(next), version: current.version + 1 };
        this.states.set(key, saved);
        for (const event of completion.auditEvents ?? []) {
            this.record(key, { turnId, fence: completion.fence, execution: completion.execution, event });
        }
        this.record(key, { turnId, fence: completion.fence, execution: completion.execution, event: completion.event });
        this.terminalCommits.add(commitKey);
        if (this.terminalFault === 'after_commit') {
            this.terminalFault = undefined;
            throw new Error('Injected crash after terminal transaction commit');
        }
        return clone(saved);
    }

    /** Test-only crash injection around the atomic terminal transaction. */
    setTerminalFault(fault: 'before_commit' | 'before_commit_always' | 'after_commit' | undefined): void {
        this.terminalFault = fault;
    }

    /** Test-only crash injection around an atomic nonterminal state/audit transaction. */
    setTransitionFault(fault: 'before_commit' | 'after_commit' | undefined): void {
        this.transitionFault = fault;
    }

    async append(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        const scopeError = this.scopeRejection(fence);
        if (scopeError) return scopeError;
        const key = keyOf(fence);
        const state = this.states.get(key);
        if (!state || state.controllerEpoch !== fence.controllerEpoch) {
            return { accepted: false, reason: 'stale_fence' };
        }
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            return { accepted: false, reason: 'turn_not_active' };
        }
        if (state.activeTurn?.turnId !== fence.turnId
            || state.activeTurn.executionId !== execution.executionId
            || state.activeTurn.attemptId !== execution.attemptId
            || state.activeTurn.status === 'completed'
            || state.activeTurn.status === 'cancelled'
            || state.activeTurn.status === 'failed') {
            return { accepted: false, reason: 'turn_not_active' };
        }
        return { accepted: true, persisted: this.record(key, { turnId: fence.turnId, fence, execution, event }) };
    }

    async appendControl(
        fence: GoalSessionControlFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        const scopeError = this.scopeRejection(fence);
        if (scopeError) return scopeError;
        const key = keyOf(fence);
        const state = this.states.get(key);
        if (!state || state.controllerEpoch !== fence.controllerEpoch) {
            return { accepted: false, reason: 'stale_fence' };
        }
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            return { accepted: false, reason: 'stale_fence' };
        }
        // Control events are session/epoch fenced only, so they remain auditable
        // in idle state and are never attributed to a specific (possibly
        // completed) turn.
        return { accepted: true, persisted: this.record(key, { turnId: `#control-e${fence.controllerEpoch}`, fence, execution, event }) };
    }

    private scopeRejection(identity: GoalSessionIdentity): { accepted: false; reason: 'wrong_goal' } | null {
        try { this.assertGoalScope(identity); return null; }
        catch (error) {
            if (error instanceof GoalSessionScopeError) return { accepted: false, reason: 'wrong_goal' };
            throw error;
        }
    }

    private record(
        key: string,
        entry: { turnId: string; fence: GoalSessionControlFence; execution: GoalExecutionIdentity; event: GoalSessionEvent },
    ): PersistedGoalSessionEvent {
        const log = this.events.get(key) ?? [];
        const persisted: PersistedGoalSessionEvent = {
            goalId: entry.fence.goalId,
            sessionId: entry.fence.sessionId,
            controllerEpoch: entry.fence.controllerEpoch,
            turnId: entry.turnId,
            executionId: entry.execution.executionId,
            attemptId: entry.execution.attemptId,
            sequence: (log.at(-1)?.sequence ?? 0) + 1,
            recordedAt: new Date().toISOString(),
            event: clone(entry.event),
        };
        log.push(persisted);
        this.events.set(key, log);
        return clone(persisted);
    }

    async replay(identity: GoalSessionIdentity, afterSequence = 0): Promise<PersistedGoalSessionEvent[]> {
        this.assertGoalScope(identity);
        return clone((this.events.get(keyOf(identity)) ?? []).filter(event => event.sequence > afterSequence));
    }

    async listPending(identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]> {
        this.assertGoalScope(identity);
        return clone((this.messages.get(keyOf(identity)) ?? []).filter(message => !message.acknowledgedAt));
    }

    async acknowledge(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'> {
        this.assertGoalScope(fence);
        const state = this.states.get(keyOf(fence));
        if (!state || state.controllerEpoch !== fence.controllerEpoch
            || state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed'
            || state.activeTurn?.turnId !== fence.turnId
            || state.activeTurn.executionId !== execution.executionId
            || state.activeTurn.attemptId !== execution.attemptId
            || state.activeTurn.status === 'completed'
            || state.activeTurn.status === 'cancelled'
            || state.activeTurn.status === 'failed') {
            return 'stale_fence';
        }
        const records = this.messages.get(keyOf(fence)) ?? [];
        const record = records.find(message => message.messageId === messageId);
        if (!record) return 'not_found';
        if (record.acknowledgedAt) return 'already_acknowledged';
        record.acknowledgedAt = new Date().toISOString();
        return 'acknowledged';
    }

    /** Test/application helper representing the persistence side of the message port. */
    enqueueMessage(message: Omit<DurableCorrectiveMessage, 'sequence' | 'createdAt'> & Partial<Pick<DurableCorrectiveMessage, 'sequence' | 'createdAt'>>): DurableCorrectiveMessage {
        this.assertGoalScope(message);
        const key = keyOf(message);
        const records = this.messages.get(key) ?? [];
        if (records.some(record => record.messageId === message.messageId)) {
            throw new Error(`Corrective message "${message.messageId}" already exists`);
        }
        const record: DurableCorrectiveMessage = {
            ...message,
            sequence: message.sequence ?? (records.at(-1)?.sequence ?? 0) + 1,
            createdAt: message.createdAt ?? new Date().toISOString(),
        };
        records.push(record);
        records.sort((a, b) => a.sequence - b.sequence);
        this.messages.set(key, records);
        return clone(record);
    }

    setContainerInspection(identity: GoalSessionIdentity, inspection: GoalContainerInspection): void {
        this.assertGoalScope(identity);
        this.containerInspections.set(keyOf(identity), clone(inspection));
    }

    setRepositoryInspection(repository: GoalRepositoryIdentity, inspection: GoalRepositoryInspection): void {
        this.repositoryInspections.set(repository.worktreePath, clone(inspection));
    }

    async inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection> {
        this.assertGoalScope(identity);
        return clone(this.containerInspections.get(keyOf(identity)) ?? {
            status: 'missing',
            reason: 'No goal-scoped container was found',
        });
    }

    async inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection> {
        return clone(this.repositoryInspections.get(repository.worktreePath) ?? {
            ...repository,
            exists: false,
            reason: 'The goal worktree was not found',
        });
    }

    private assertGoalScope(identity: GoalSessionIdentity): void {
        const owner = this.sessionOwners.get(identity.sessionId);
        if (owner !== undefined && owner !== identity.goalId) throw new GoalSessionScopeError();
    }

    private commitTransition(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        transition: GoalSessionControlTransition,
    ): GoalSessionState | null {
        this.assertGoalScope(expected);
        this.assertGoalScope(next);
        if (expected.goalId !== next.goalId || expected.sessionId !== next.sessionId) {
            throw new GoalSessionScopeError('A state/audit transaction cannot move a session to another goal or identity');
        }
        const key = keyOf(expected);
        const current = this.states.get(key);
        const commitKey = transitionCommitKey(transition);
        if (!matchesTransitionLiveFence(current, transition)) return null;
        if (this.transitionCommits.has(commitKey)) return clone(current);
        if (current.version !== expected.version) return null;
        if (this.transitionFault === 'before_commit') {
            this.transitionFault = undefined;
            throw new Error('Injected crash before state/audit transaction commit');
        }
        const saved = { ...clone(next), version: current.version + 1 };
        this.states.set(key, saved);
        for (const event of transition.auditEvents) {
            this.record(key, {
                turnId: transition.turnScoped === true && 'turnId' in transition.fence
                    ? transition.fence.turnId
                    : `#control-e${transition.fence.controllerEpoch}`,
                fence: transition.fence,
                execution: transition.execution,
                event,
            });
        }
        this.transitionCommits.add(commitKey);
        if (this.transitionFault === 'after_commit') {
            this.transitionFault = undefined;
            throw new Error('Injected crash after state/audit transaction commit');
        }
        return clone(saved);
    }
}

function matchesTransitionLiveFence(
    current: GoalSessionState | undefined,
    transition: GoalSessionControlTransition,
): current is GoalSessionState {
    if (!current || current.controllerEpoch !== transition.fence.controllerEpoch
        || current.status === 'cancelling' || current.status === 'terminated' || current.status === 'failed') return false;
    if (transition.turnScoped !== true) return true;
    if (!('turnId' in transition.fence)) return false;
    return current.activeTurn?.turnId === transition.fence.turnId
        && current.activeTurn.executionId === transition.execution.executionId
        && current.activeTurn.attemptId === transition.execution.attemptId
        && current.activeTurn.status !== 'completed'
        && current.activeTurn.status !== 'cancelled'
        && current.activeTurn.status !== 'failed';
}

function terminalCommitKey(completion: GoalTerminalCommit): string {
    return JSON.stringify([
        completion.scope,
        completion.fence.goalId,
        completion.fence.sessionId,
        completion.fence.controllerEpoch,
        completion.scope === 'turn' ? completion.fence.turnId : null,
        completion.execution.executionId,
        completion.execution.attemptId,
    ]);
}

function transitionCommitKey(transition: GoalSessionControlTransition): string {
    return JSON.stringify([
        transition.fence.goalId,
        transition.fence.sessionId,
        transition.fence.controllerEpoch,
        transition.turnScoped === true && 'turnId' in transition.fence ? transition.fence.turnId : null,
        transition.execution.executionId,
        transition.execution.attemptId,
        transition.transitionId,
    ]);
}
