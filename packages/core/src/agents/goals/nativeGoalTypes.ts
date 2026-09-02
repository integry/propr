/**
 * Provider-neutral contract for one durable, native coding-agent goal.
 *
 * A goal is intentionally not a plan or a collection of calls. The provider
 * session remains the execution authority; these types only describe the
 * identity, container, controls, and event fence around it.
 */

export type NativeGoalStatus =
    | 'starting'
    | 'running'
    | 'pause_requested'
    | 'paused'
    | 'resuming'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
    | 'failed';

export type NativeGoalEventKind =
    | 'terminal'
    | 'assistant'
    | 'tool'
    | 'plan'
    | 'todo'
    | 'usage'
    | 'checkpoint'
    | 'status'
    | 'provider';

export interface NativeGoalWorktree {
    /** Absolute path on the ProPR host. */
    hostPath: string;
    /** Absolute, stable path presented to the coding agent. */
    containerPath: string;
    repository: string;
    branch: string;
}

export interface NativeGoalWritableMount {
    /** Stable logical name such as `provider-state` or `logs`. */
    name: string;
    /** Absolute, goal-scoped host path. */
    hostPath: string;
    /** Absolute path inside the goal container. */
    containerPath: string;
}

export interface NativeGoalContainerSpec {
    goalId: string;
    provider: string;
    image: string;
    worktree: NativeGoalWorktree;
    writableMounts: NativeGoalWritableMount[];
    environment?: Record<string, string>;
}

export interface NativeGoalContainer {
    id: string;
    name: string;
    /** Changes whenever a lost container is replaced. */
    generation: string;
    replaced: boolean;
}

export interface NativeGoalContainerRuntime {
    /**
     * Return the matching live goal container, or recreate it with the exact
     * persisted worktree and allowlisted mounts. Implementations must reject a
     * container whose ownership labels do not match the goal.
     */
    ensure(spec: NativeGoalContainerSpec, previous?: NativeGoalContainer): Promise<NativeGoalContainer>;
}

export interface NativeGoalModelState {
    requestedModel?: string;
    effectiveModel?: string;
    requestedReasoning?: string;
    effectiveReasoning?: string;
    acknowledged: boolean;
}

export interface NativeGoalSessionRecord {
    schemaVersion: 1;
    revision: number;
    goalId: string;
    objective: string;
    provider: string;
    containerImage: string;
    providerSessionId?: string;
    status: NativeGoalStatus;
    worktree: NativeGoalWorktree;
    writableMounts: NativeGoalWritableMount[];
    container?: NativeGoalContainer;
    /** Fences callbacks from an app-server/process that has been replaced. */
    supervisorEpoch: string;
    lastInputSequence: number;
    model: NativeGoalModelState;
    createdAt: string;
    updatedAt: string;
    failure?: string;
}

export interface NativeGoalSessionStore {
    get(goalId: string): Promise<NativeGoalSessionRecord | null>;
    findByProviderSession(provider: string, providerSessionId: string): Promise<NativeGoalSessionRecord | null>;
    findByWritableMount(hostPath: string): Promise<NativeGoalSessionRecord | null>;
    findByWorktree(hostPath: string): Promise<NativeGoalSessionRecord | null>;
    create(record: NativeGoalSessionRecord): Promise<void>;
    save(record: NativeGoalSessionRecord, expectedRevision: number): Promise<NativeGoalSessionRecord>;
}

export interface NativeGoalProviderEvent {
    /** Provider-derived identity used by the durable sink for deduplication. */
    providerEventId: string;
    providerSessionId: string;
    kind: NativeGoalEventKind;
    payload: unknown;
    occurredAt?: string;
}

export interface NativeGoalEvent extends NativeGoalProviderEvent {
    goalId: string;
    provider: string;
    /** Monotonic order assigned durably by the sink, per goal. */
    sequence: number;
    supervisorEpoch: string;
    recordedAt: string;
}

export type NativeGoalEventAppendResult =
    | { accepted: true; event: NativeGoalEvent }
    | { accepted: false; reason: 'duplicate' };

export interface NativeGoalEventSink {
    append(event: Omit<NativeGoalEvent, 'sequence' | 'recordedAt'>): Promise<NativeGoalEventAppendResult>;
}

export interface NativeGoalProviderStartRequest {
    goalId: string;
    objective: string;
    worktreePath: string;
    model?: string;
    reasoning?: string;
    /** Persist the provider identity before native goal activation can begin. */
    onSessionBound?: (providerSessionId: string) => Promise<void>;
}

export interface NativeGoalProviderResumeRequest extends NativeGoalProviderStartRequest {
    providerSessionId: string;
}

export interface NativeGoalProviderState {
    providerSessionId: string;
    objective: string;
    status: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete';
    effectiveModel?: string;
    effectiveReasoning?: string;
}

export interface NativeGoalCorrectiveInput {
    sequence: number;
    text: string;
}

export interface NativeGoalProviderSession {
    readonly provider: string;
    start(request: NativeGoalProviderStartRequest): Promise<NativeGoalProviderState>;
    resume(request: NativeGoalProviderResumeRequest): Promise<NativeGoalProviderState>;
    steer(input: NativeGoalCorrectiveInput): Promise<void>;
    /** Resolve only after native continuation has reached a safe turn boundary. */
    pauseAtSafeBoundary(): Promise<void>;
    continue(): Promise<void>;
    cancel(): Promise<void>;
    requestModel(model?: string, reasoning?: string): Promise<NativeGoalModelState>;
    onEvent(listener: (event: NativeGoalProviderEvent) => void): () => void;
    close(): Promise<void>;
}

export interface NativeGoalProviderFactory {
    readonly provider: string;
    connect(container: NativeGoalContainer, record: NativeGoalSessionRecord): Promise<NativeGoalProviderSession>;
}

export interface StartNativeGoalOptions {
    goalId: string;
    objective: string;
    image: string;
    worktree: NativeGoalWorktree;
    writableMounts: NativeGoalWritableMount[];
    environment?: Record<string, string>;
    model?: string;
    reasoning?: string;
}

export interface ResumeNativeGoalOptions {
    goalId: string;
    /** Optional immutable-identity checks supplied by the caller. */
    objective?: string;
    worktree?: NativeGoalWorktree;
}

export type NativeGoalEventRejection = 'stale_epoch' | 'cross_goal_session' | 'unbound_session';

export type NativeGoalEventIngestionResult =
    | NativeGoalEventAppendResult
    | { accepted: false; reason: NativeGoalEventRejection };
