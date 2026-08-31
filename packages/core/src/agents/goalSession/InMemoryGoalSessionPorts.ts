import type {
    DurableCorrectiveMessage,
    GoalContainerInspection,
    GoalEventAppendResult,
    GoalExecutionIdentity,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionEvent,
    GoalSessionEventSink,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalSessionMessagePort,
    GoalSessionRecoveryPort,
    GoalSessionRuntimePorts,
    GoalSessionState,
    GoalSessionStatePort,
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
 * Deterministic durable-port fake used by contract tests and embedders. All
 * state/event/message mutations are synchronous inside each async method, which
 * gives the same atomic fence semantics expected from a database transaction.
 */
export class InMemoryGoalSessionPorts implements
    GoalSessionStatePort,
    GoalSessionEventSink,
    GoalSessionMessagePort,
    GoalSessionRecoveryPort {
    private readonly states = new Map<string, GoalSessionState>();
    private readonly sessionOwners = new Map<string, string>();
    private readonly events = new Map<string, PersistedGoalSessionEvent[]>();
    private readonly messages = new Map<string, DurableCorrectiveMessage[]>();
    private readonly containerInspections = new Map<string, GoalContainerInspection>();
    private readonly repositoryInspections = new Map<string, GoalRepositoryInspection>();

    asRuntimePorts(): GoalSessionRuntimePorts {
        return { state: this, events: this, messages: this, recovery: this };
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

    async append(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<GoalEventAppendResult> {
        try { this.assertGoalScope(fence); }
        catch (error) {
            if (error instanceof GoalSessionScopeError) return { accepted: false, reason: 'wrong_goal' };
            throw error;
        }
        const key = keyOf(fence);
        const state = this.states.get(key);
        if (!state || state.controllerEpoch !== fence.controllerEpoch) {
            return { accepted: false, reason: 'stale_fence' };
        }
        const isReconciliation = event.type === 'reconciliation'
            && fence.turnId === `reconciliation-${state.controllerEpoch}`;
        if (!isReconciliation && state.activeTurn?.turnId !== fence.turnId) {
            return { accepted: false, reason: 'turn_not_active' };
        }
        const turnIsTerminal = state.activeTurn
            && ['completed', 'cancelled', 'failed'].includes(state.activeTurn.status);
        if (!isReconciliation && turnIsTerminal && event.type !== 'completion') {
            return { accepted: false, reason: 'turn_not_active' };
        }
        const log = this.events.get(key) ?? [];
        const persisted: PersistedGoalSessionEvent = {
            ...fence,
            ...execution,
            sequence: (log.at(-1)?.sequence ?? 0) + 1,
            recordedAt: new Date().toISOString(),
            event: clone(event),
        };
        log.push(persisted);
        this.events.set(key, log);
        return { accepted: true, persisted: clone(persisted) };
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
        messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'> {
        this.assertGoalScope(fence);
        const state = this.states.get(keyOf(fence));
        if (!state || state.controllerEpoch !== fence.controllerEpoch || state.activeTurn?.turnId !== fence.turnId) {
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
}
