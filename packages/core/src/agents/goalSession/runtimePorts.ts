import type {
    GoalContainerInspection, GoalModelChangeHistoryPort, GoalProviderFirstEffectPort, GoalRepositoryIdentity,
    GoalRepositoryInspection, GoalSessionEventSink, GoalSessionIdentity,
    GoalSessionMessagePort, GoalSessionStatePort, GoalSessionTerminalPort,
    GoalSessionTransitionPort,
} from './contract.js';

export interface GoalSessionRecoveryPort {
    inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection>;
    inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection>;
}

export interface GoalSessionRuntimePorts {
    state: GoalSessionStatePort;
    transitions: GoalSessionTransitionPort;
    events: GoalSessionEventSink;
    terminal: GoalSessionTerminalPort;
    messages: GoalSessionMessagePort;
    recovery: GoalSessionRecoveryPort;
    modelChanges: GoalModelChangeHistoryPort;
    /** Same authoritative transaction domain as state; never a process-local mutex. */
    providerFirstEffects: GoalProviderFirstEffectPort;
}
