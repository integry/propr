import type {
    CodexSessionSource0146, CodexThread0146, CodexThreadResponse0146,
} from './codexAppServer0146Bindings.generated.js';

export function assertExactThreadResponseFields(response: CodexThreadResponse0146): void {
    if (typeof response.model !== 'string' || typeof response.modelProvider !== 'string'
        || typeof response.cwd !== 'string' || !strings(response.runtimeWorkspaceRoots)
        || !strings(response.instructionSources)
        || !nullableString(response.serviceTier)
        || !['user', 'auto_review', 'guardian_subagent'].includes(String(response.approvalsReviewer))
        || !validApprovalPolicy(response.approvalPolicy) || !plainObject(response.sandbox)
        || !(response.activePermissionProfile === null || plainObject(response.activePermissionProfile))
        || !nullableString(response.reasoningEffort)
        || !validMultiAgentMode(response.multiAgentMode)) malformed();
}

export function assertExactThreadFields(thread: CodexThread0146): void {
    if (!validThreadStrings(thread) || !validThreadScalars(thread) || !validThreadNullableFields(thread)
        || !(thread.extra === null || plainObject(thread.extra) && Object.keys(thread.extra).length === 0)
        || !(thread.gitInfo === null || plainObject(thread.gitInfo))
        || !Array.isArray(thread.turns) || !validSessionSource(thread.source)) malformed();
}

function validThreadStrings(thread: CodexThread0146): boolean {
    return string(thread.id) && string(thread.sessionId) && string(thread.preview)
        && string(thread.modelProvider) && string(thread.cwd) && string(thread.cliVersion);
}

function validThreadScalars(thread: CodexThread0146): boolean {
    return typeof thread.ephemeral === 'boolean' && typeof thread.isPinned === 'boolean'
        && ['legacy', 'paginated'].includes(thread.historyMode)
        && finite(thread.createdAt) && finite(thread.updatedAt)
        && (thread.recencyAt === null || finite(thread.recencyAt)) && validThreadStatus(thread.status)
        && (thread.canAcceptDirectInput === null || typeof thread.canAcceptDirectInput === 'boolean');
}

function validThreadNullableFields(thread: CodexThread0146): boolean {
    return nullableString(thread.path) && nullableString(thread.forkedFromId)
        && nullableString(thread.parentThreadId) && nullableString(thread.threadSource)
        && nullableString(thread.agentNickname) && nullableString(thread.agentRole) && nullableString(thread.name);
}

function validSessionSource(value: unknown): value is CodexSessionSource0146 {
    if (typeof value === 'string') return ['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(value);
    if (!plainObject(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== 1) return false;
    if (keys[0] === 'custom') return string(value.custom);
    return keys[0] === 'subAgent' && validSubAgentSource(value.subAgent);
}

function validSubAgentSource(value: unknown): boolean {
    if (typeof value === 'string') return ['review', 'compact', 'memory_consolidation'].includes(value);
    if (!plainObject(value) || Object.keys(value).length !== 1) return false;
    if ('other' in value) return string(value.other);
    if (!('thread_spawn' in value) || !plainObject(value.thread_spawn)) return false;
    const spawn = value.thread_spawn;
    return exactKeys(spawn, ['parent_thread_id', 'depth', 'agent_path', 'agent_nickname', 'agent_role'])
        && string(spawn.parent_thread_id) && Number.isSafeInteger(spawn.depth) && Number(spawn.depth) >= 0
        && nullableString(spawn.agent_path) && nullableString(spawn.agent_nickname)
        && nullableString(spawn.agent_role);
}

function validThreadStatus(value: unknown): boolean {
    if (!plainObject(value) || typeof value.type !== 'string') return false;
    if (value.type === 'active') return exactKeys(value, ['type', 'activeFlags']) && Array.isArray(value.activeFlags);
    return ['notLoaded', 'idle', 'systemError'].includes(value.type) && exactKeys(value, ['type']);
}

function validApprovalPolicy(value: unknown): boolean {
    if (typeof value === 'string') return ['untrusted', 'on-request', 'never'].includes(value);
    if (!plainObject(value) || !plainObject(value.granular) || !exactKeys(value, ['granular'])) return false;
    const granular = value.granular;
    const fields = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
    return exactKeys(granular, fields) && fields.every(field => typeof granular[field] === 'boolean');
}

function validMultiAgentMode(value: unknown): boolean {
    if (value === 'explicitRequestOnly' || value === 'proactive') return true;
    return plainObject(value) && exactKeys(value, ['custom']) && string(value.custom);
}

function plainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every(key => key in value);
}

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(string);
}

function string(value: unknown): value is string { return typeof value === 'string'; }
function nullableString(value: unknown): boolean { return value === null || string(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function malformed(): never { throw new Error('App Server response violates generated Codex 0.146 bindings'); }
