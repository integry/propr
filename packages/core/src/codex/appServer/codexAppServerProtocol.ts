import type {
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
} from './generated/index.js';

export type CodexRequestId = string | number;
export type CodexJson = null | boolean | number | string | CodexJson[] | { [key: string]: CodexJson };

export interface CodexThreadStartParams {
    model?: string | null;
    cwd?: string | null;
    runtimeWorkspaceRoots?: string[] | null;
    approvalPolicy?: 'untrusted' | 'on-request' | 'never' | null;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
    config?: Record<string, CodexJson> | null;
    ephemeral?: boolean | null;
    historyMode?: 'legacy' | 'paginated' | null;
}

export interface CodexThreadResumeParams {
    threadId: string;
    cwd?: string | null;
    runtimeWorkspaceRoots?: string[] | null;
    excludeTurns?: boolean;
}

export interface CodexThreadResponse {
    thread: { id: string; [key: string]: unknown };
    model: string;
    reasoningEffort: string | null;
    [key: string]: unknown;
}

export interface CodexUserTextInput { type: 'text'; text: string; text_elements: [] }
export interface CodexTurnStartParams {
    threadId: string;
    clientUserMessageId?: string | null;
    input: CodexUserTextInput[];
}
export interface CodexTurnSteerParams extends CodexTurnStartParams { expectedTurnId: string }
export interface CodexTurnInterruptParams { threadId: string; turnId: string }
export interface CodexThreadSettingsUpdateParams {
    threadId: string;
    model?: string | null;
    effort?: string | null;
}

export interface CodexAppServerRequestMap {
    'thread/start': { params: CodexThreadStartParams; result: CodexThreadResponse };
    'thread/resume': { params: CodexThreadResumeParams; result: CodexThreadResponse };
    'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse };
    'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse };
    'thread/goal/clear': { params: ThreadGoalClearParams; result: ThreadGoalClearResponse };
    'thread/settings/update': { params: CodexThreadSettingsUpdateParams; result: Record<string, never> };
    'turn/start': { params: CodexTurnStartParams; result: { turn: { id: string; [key: string]: unknown } } };
    'turn/steer': { params: CodexTurnSteerParams; result: { turnId: string } };
    'turn/interrupt': { params: CodexTurnInterruptParams; result: Record<string, never> };
}

export type CodexAppServerMethod = keyof CodexAppServerRequestMap;
export interface CodexAppServerNotification {
    method: string;
    params?: Record<string, unknown>;
}
export interface CodexAppServerServerRequest extends CodexAppServerNotification { id: CodexRequestId }

export interface CodexInitializeParams {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: {
        experimentalApi: boolean;
        requestAttestation: boolean;
        optOutNotificationMethods?: string[] | null;
    } | null;
}
