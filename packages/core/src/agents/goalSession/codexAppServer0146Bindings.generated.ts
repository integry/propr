// GENERATED FROM `codex-cli 0.146.0 app-server generate-ts --experimental`.
// Keep this consumed protocol surface synchronized with the live-binary schema attestation test.

export const CODEX_CLI_VERSION_0146 = '0.146.0';
export const CODEX_APP_SERVER_PROTOCOL_0146 = 'app-server-0.146.0';

export const CODEX_APP_SERVER_METHODS_0146 = Object.freeze({
    initialize: 'initialize',
    initialized: 'initialized',
    modelList: 'model/list',
    threadStart: 'thread/start',
    threadResume: 'thread/resume',
});

export type CodexSandboxMode0146 = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexSubAgentSource0146 =
    | 'review'
    | 'compact'
    | 'memory_consolidation'
    | { other: string }
    | { thread_spawn: {
        parent_thread_id: string; depth: number; agent_path: string | null;
        agent_nickname: string | null; agent_role: string | null;
    } };
export type CodexSessionSource0146 =
    | 'cli'
    | 'vscode'
    | 'exec'
    | 'appServer'
    | { custom: string }
    | { subAgent: CodexSubAgentSource0146 }
    | 'unknown';

export interface CodexInitializeResponse0146 {
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
}

export interface CodexModelListResponse0146 {
    data: unknown[];
    nextCursor: string | null;
}

export interface CodexThread0146 {
    id: string;
    extra: Record<string, never> | null;
    sessionId: string;
    forkedFromId: string | null;
    parentThreadId: string | null;
    preview: string;
    ephemeral: boolean;
    isPinned: boolean;
    historyMode: 'legacy' | 'paginated';
    modelProvider: string;
    createdAt: number;
    updatedAt: number;
    recencyAt: number | null;
    status: unknown;
    path: string | null;
    cwd: string;
    cliVersion: string;
    source: CodexSessionSource0146;
    canAcceptDirectInput: boolean | null;
    threadSource: string | null;
    agentNickname: string | null;
    agentRole: string | null;
    gitInfo: unknown | null;
    name: string | null;
    turns: unknown[];
}

export interface CodexThreadStartParams0146 {
    model?: string | null;
    modelProvider?: string | null;
    allowProviderModelFallback?: boolean;
    serviceTier?: string | null;
    cwd?: string | null;
    runtimeWorkspaceRoots?: string[] | null;
    approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown> | null;
    approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent' | null;
    sandbox?: CodexSandboxMode0146 | null;
    permissions?: string | null;
    config?: Record<string, unknown> | null;
    serviceName?: string | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: unknown | null;
    multiAgentMode?: unknown | null;
    ephemeral?: boolean | null;
    historyMode?: 'legacy' | 'paginated' | null;
    sessionStartSource?: unknown | null;
    threadSource?: string | null;
    environments?: unknown[] | null;
    dynamicTools?: unknown[] | null;
    selectedCapabilityRoots?: unknown[] | null;
    mockExperimentalField?: string | null;
    experimentalRawEvents?: boolean;
}

export interface CodexThreadResumeParams0146 {
    threadId: string;
    history?: unknown[] | null;
    path?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    serviceTier?: string | null;
    cwd?: string | null;
    runtimeWorkspaceRoots?: string[] | null;
    approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown> | null;
    approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent' | null;
    sandbox?: CodexSandboxMode0146 | null;
    permissions?: string | null;
    config?: Record<string, unknown> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: unknown | null;
    excludeTurns?: boolean;
    initialTurnsPage?: unknown | null;
}

export interface CodexThreadResponse0146 {
    thread: CodexThread0146;
    model: string;
    modelProvider: string;
    serviceTier: string | null;
    cwd: string;
    runtimeWorkspaceRoots: string[];
    instructionSources: string[];
    approvalPolicy: unknown;
    approvalsReviewer: unknown;
    sandbox: unknown;
    activePermissionProfile: unknown | null;
    reasoningEffort: unknown | null;
    multiAgentMode: unknown;
}
