import { createHash } from 'node:crypto';
import type {
    NativeGoalContainer,
    NativeGoalCorrectiveInput,
    NativeGoalModelState,
    NativeGoalProviderEvent,
    NativeGoalProviderFactory,
    NativeGoalProviderResumeRequest,
    NativeGoalProviderSession,
    NativeGoalProviderStartRequest,
    NativeGoalProviderState,
    NativeGoalSessionRecord,
} from '../../agents/goals/nativeGoalTypes.js';
import { CodexAppServerClient, CodexAppServerStdioTransport } from './CodexAppServerClient.js';
import type { CodexAppServerNotification } from './codexAppServerProtocol.js';
import type { ThreadGoal, ThreadGoalStatus } from './generated/index.js';

type CodexClientConnector = (
    container: NativeGoalContainer,
    record: NativeGoalSessionRecord,
) => Promise<CodexAppServerClient> | CodexAppServerClient;

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function providerStatus(status: ThreadGoalStatus): NativeGoalProviderState['status'] {
    if (status === 'usageLimited') return 'usage_limited';
    if (status === 'budgetLimited') return 'budget_limited';
    if (status === 'complete') return 'complete';
    return status;
}

function extractThreadId(notification: CodexAppServerNotification): string | undefined {
    const direct = notification.params?.threadId;
    if (typeof direct === 'string') return direct;
    const thread = notification.params?.thread;
    if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string') {
        return (thread as { id: string }).id;
    }
    return undefined;
}

export function classifyCodexGoalNotification(notification: CodexAppServerNotification): NativeGoalProviderEvent['kind'] {
    const method = notification.method.toLowerCase();
    const item = notification.params?.item as { type?: string } | undefined;
    const itemType = item?.type?.toLowerCase() ?? '';
    const methodRules: Array<[NativeGoalProviderEvent['kind'], string[]]> = [
        ['usage', ['tokenusage', 'ratelimit', 'usage']],
        ['plan', ['plan']],
        ['todo', ['todo']],
        ['assistant', ['agentmessage', 'reasoning']],
        ['terminal', ['command', 'process', 'terminalinteraction']],
        ['tool', ['tool']],
        ['checkpoint', ['turn/completed', 'compacted', 'goal/']],
        ['status', ['error', 'status', 'turn/started']],
    ];
    const itemKinds: Record<string, NativeGoalProviderEvent['kind']> = {
        plan: 'plan', todo: 'todo', agentmessage: 'assistant', reasoning: 'assistant',
        commandexecution: 'terminal', filechange: 'tool', mcptoolcall: 'tool', dynamictoolcall: 'tool',
    };
    return methodRules.find(([, fragments]) => fragments.some(fragment => method.includes(fragment)))?.[0]
        ?? itemKinds[itemType]
        ?? (itemType.includes('toolcall') ? 'tool' : 'provider');
}

/** Codex App Server implementation of the provider-neutral native goal contract. */
export class CodexNativeGoalProvider implements NativeGoalProviderSession {
    readonly provider = 'codex';
    private threadId?: string;
    private objective?: string;
    private activeTurnId?: string;
    private effectiveModel?: string;
    private effectiveReasoning?: string;
    private readonly completedTurns = new Set<string>();
    private readonly turnWaiters = new Map<string, Deferred<void>[]>();
    private readonly settingsWaiters: Deferred<{ model?: string; effort?: string }>[] = [];
    private readonly listeners = new Set<(event: NativeGoalProviderEvent) => void>();
    private readonly occurrence = new Map<string, number>();
    private readonly unsubscribe: () => void;
    private readonly unsubscribeServerRequests: () => void;

    constructor(private readonly client: CodexAppServerClient, private readonly acknowledgementTimeoutMs = 5_000) {
        this.unsubscribe = client.onNotification(notification => this.handleNotification(notification));
        this.unsubscribeServerRequests = client.onServerRequest(request => this.handleNotification(request));
    }

    async start(request: NativeGoalProviderStartRequest): Promise<NativeGoalProviderState> {
        const response = await this.client.request('thread/start', {
            cwd: request.worktreePath,
            runtimeWorkspaceRoots: [request.worktreePath],
            model: request.model,
            config: request.reasoning ? { model_reasoning_effort: request.reasoning } : undefined,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            ephemeral: false,
            historyMode: 'paginated',
        });
        this.threadId = response.thread.id;
        await request.onSessionBound?.(this.threadId);
        this.objective = request.objective;
        this.effectiveModel = response.model;
        this.effectiveReasoning = response.reasoningEffort ?? undefined;
        const { goal } = await this.client.request('thread/goal/set', {
            threadId: this.threadId,
            objective: request.objective,
            status: 'active',
        });
        return this.stateFromGoal(goal);
    }

    async resume(request: NativeGoalProviderResumeRequest): Promise<NativeGoalProviderState> {
        // Assign before requesting so notifications emitted during resume are fenced to this thread.
        this.threadId = request.providerSessionId;
        this.objective = request.objective;
        const response = await this.client.request('thread/resume', {
            threadId: request.providerSessionId,
            cwd: request.worktreePath,
            runtimeWorkspaceRoots: [request.worktreePath],
            excludeTurns: true,
        });
        if (response.thread.id !== request.providerSessionId) throw new Error('Codex resumed a different thread');
        this.effectiveModel = response.model;
        this.effectiveReasoning = response.reasoningEffort ?? undefined;
        const { goal } = await this.client.request('thread/goal/get', { threadId: request.providerSessionId });
        if (!goal) throw new Error('Codex thread has no persisted native goal');
        if (goal.objective !== request.objective) throw new Error('Codex thread objective does not match the ProPR goal');
        return this.stateFromGoal(goal);
    }

    async steer(input: NativeGoalCorrectiveInput): Promise<void> {
        const threadId = this.requireThread();
        const userInput = [{ type: 'text' as const, text: input.text, text_elements: [] as [] }];
        const clientUserMessageId = `propr:${threadId}:steer:${input.sequence}`;
        if (this.activeTurnId) {
            await this.client.request('turn/steer', {
                threadId,
                expectedTurnId: this.activeTurnId,
                clientUserMessageId,
                input: userInput,
            });
        } else {
            const response = await this.client.request('turn/start', { threadId, clientUserMessageId, input: userInput });
            this.activeTurnId = response.turn.id;
        }
    }

    async pauseAtSafeBoundary(): Promise<void> {
        const threadId = this.requireThread();
        const activeAtRequest = this.activeTurnId;
        await this.client.request('thread/goal/set', { threadId, status: 'paused' });
        const boundaryTurn = this.activeTurnId ?? activeAtRequest;
        if (boundaryTurn) await this.waitForTurnCompletion(boundaryTurn);
    }

    async continue(): Promise<void> {
        await this.client.request('thread/goal/set', { threadId: this.requireThread(), status: 'active' });
    }

    async cancel(): Promise<void> {
        const threadId = this.requireThread();
        // Clear first so interrupting an active turn cannot schedule another native continuation.
        await this.client.request('thread/goal/clear', { threadId });
        const turnId = this.activeTurnId;
        if (turnId) await this.client.request('turn/interrupt', { threadId, turnId });
    }

    async requestModel(model?: string, reasoning?: string): Promise<NativeGoalModelState> {
        const waiter = deferred<{ model?: string; effort?: string }>();
        this.settingsWaiters.push(waiter);
        let settings: { model?: string; effort?: string } | null;
        try {
            await this.client.request('thread/settings/update', {
                threadId: this.requireThread(),
                ...(model !== undefined && { model }),
                ...(reasoning !== undefined && { effort: reasoning }),
            });
            settings = await Promise.race([
                waiter.promise,
                new Promise<null>(resolve => setTimeout(() => resolve(null), this.acknowledgementTimeoutMs)),
            ]);
        } finally {
            const index = this.settingsWaiters.indexOf(waiter);
            if (index >= 0) this.settingsWaiters.splice(index, 1);
        }
        if (settings) {
            this.effectiveModel = settings.model ?? this.effectiveModel;
            this.effectiveReasoning = settings.effort ?? this.effectiveReasoning;
        }
        return {
            requestedModel: model,
            requestedReasoning: reasoning,
            effectiveModel: this.effectiveModel,
            effectiveReasoning: this.effectiveReasoning,
            acknowledged: settings !== null,
        };
    }

    onEvent(listener: (event: NativeGoalProviderEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async close(): Promise<void> {
        this.unsubscribe();
        this.unsubscribeServerRequests();
        await this.client.close();
    }

    private stateFromGoal(goal: ThreadGoal): NativeGoalProviderState {
        if (this.threadId && goal.threadId !== this.threadId) throw new Error('Codex returned a goal for a different thread');
        return {
            providerSessionId: goal.threadId,
            objective: goal.objective,
            status: providerStatus(goal.status),
            effectiveModel: this.effectiveModel,
            effectiveReasoning: this.effectiveReasoning,
        };
    }

    private handleNotification(notification: CodexAppServerNotification): void {
        const notificationThreadId = extractThreadId(notification);
        if (this.threadId && notificationThreadId && notificationThreadId !== this.threadId) return;
        const params = notification.params ?? {};
        if (notification.method === 'turn/started') {
            const turn = params.turn as { id?: unknown } | undefined;
            if (typeof turn?.id === 'string') this.activeTurnId = turn.id;
        } else if (notification.method === 'turn/completed') {
            const turn = params.turn as { id?: unknown } | undefined;
            if (typeof turn?.id === 'string') this.completeTurn(turn.id);
        } else if (notification.method === 'thread/settings/updated') {
            const settings = params.threadSettings as { model?: string; effort?: string } | undefined;
            if (settings) {
                const waiters = this.settingsWaiters.splice(0);
                for (const waiter of waiters) waiter.resolve(settings);
            }
        }

        const providerSessionId = notificationThreadId ?? this.threadId;
        if (!providerSessionId) return;
        const providerEventId = this.eventId(notification);
        const event: NativeGoalProviderEvent = {
            providerEventId,
            providerSessionId,
            kind: classifyCodexGoalNotification(notification),
            payload: notification,
        };
        for (const listener of this.listeners) listener(event);
    }

    private completeTurn(turnId: string): void {
        if (this.activeTurnId === turnId) this.activeTurnId = undefined;
        this.completedTurns.add(turnId);
        if (this.completedTurns.size > 100) this.completedTurns.delete(this.completedTurns.values().next().value!);
        const waiters = this.turnWaiters.get(turnId) ?? [];
        this.turnWaiters.delete(turnId);
        for (const waiter of waiters) waiter.resolve();
    }

    private waitForTurnCompletion(turnId: string): Promise<void> {
        if (this.completedTurns.has(turnId)) return Promise.resolve();
        const waiter = deferred<void>();
        const waiters = this.turnWaiters.get(turnId) ?? [];
        waiters.push(waiter);
        this.turnWaiters.set(turnId, waiters);
        return waiter.promise;
    }

    private eventId(notification: CodexAppServerNotification): string {
        const params = notification.params ?? {};
        const item = params.item as { id?: unknown } | undefined;
        const stableAnchor = [notification.method, (notification as { id?: unknown }).id, extractThreadId(notification), params.turnId,
            typeof item?.id === 'string' ? item.id : params.itemId,
            notification.method.includes('goal/') ? (params.goal as { updatedAt?: unknown } | undefined)?.updatedAt : undefined,
        ].filter(value => value !== undefined).join(':');
        const isDelta = notification.method.toLowerCase().includes('delta');
        const occurrenceKey = `${stableAnchor}:${JSON.stringify(params)}`;
        const occurrence = isDelta ? (this.occurrence.get(occurrenceKey) ?? 0) + 1 : 0;
        if (isDelta) this.occurrence.set(occurrenceKey, occurrence);
        return createHash('sha256').update(`${stableAnchor}:${JSON.stringify(params)}:${occurrence}`).digest('hex');
    }

    private requireThread(): string {
        if (!this.threadId) throw new Error('Codex native goal thread is not started');
        return this.threadId;
    }
}

export class CodexNativeGoalProviderFactory implements NativeGoalProviderFactory {
    readonly provider = 'codex';

    constructor(private readonly connectClient: CodexClientConnector, private readonly acknowledgementTimeoutMs = 5_000) {}

    async connect(container: NativeGoalContainer, record: NativeGoalSessionRecord): Promise<NativeGoalProviderSession> {
        const client = await this.connectClient(container, record);
        await client.initialize();
        return new CodexNativeGoalProvider(client, this.acknowledgementTimeoutMs);
    }
}

/** Connect to the App Server running inside an already goal-scoped Docker container. */
export function createDockerCodexAppServerConnector(dockerCommand = 'docker'): CodexClientConnector {
    return (container, record) => new CodexAppServerClient(new CodexAppServerStdioTransport({
        command: dockerCommand,
        args: [
            'exec', '-i', '--user', '1000:1000',
            '-e', 'HOME=/home/node',
            '-w', record.worktree.containerPath,
            container.id,
            'codex', 'app-server', '--enable', 'goals',
        ],
    }));
}
