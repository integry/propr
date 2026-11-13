/**
 * Nested agent executions: an execution started on behalf of a running parent
 * execution, while the parent still holds its admission slot.
 *
 * The parent link is carried explicitly, never inferred from timing or a
 * shared `propr.task.id` label:
 *
 * - A parent launch runs inside `runAsAgentAdmissionParent(scope)`. Its
 *   admission registers `scope -> its holder token` in Redis, in the same
 *   atomic acquire that admits it. Only a live (not draining, not recovering)
 *   holder can be found through its scope.
 * - A nested launch runs inside `runWithAgentAdmissionParent(scope)`. Its
 *   acquire resolves the scope to the parent's holder record in Redis, so a
 *   scope that names no live holder makes it an ordinary top-level launch.
 *
 * Scopes: an orchestrating goal session uses `goal:<nonce>` (the signed child association reaches
 * the issues and PR comments it creates as a resource-bound body marker);
 * an automation run phase uses `agent-run-grant:<grantId>` (its MCP grant
 * identifies the calling run on the API side). See
 * docs/docs/architecture/agent-run-admission.md#nested-executions.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Nested executions may not themselves carry nested executions. */
export const AGENT_ADMISSION_MAX_NESTING_DEPTH = 1;
/** Running nested executions one parent may carry at once. */
export const AGENT_RUN_NESTED_LIMIT_ENV = 'PROPR_AGENT_RUN_NESTED_LIMIT';
export const DEFAULT_AGENT_RUN_NESTED_LIMIT = 4;
const MAX_AGENT_RUN_NESTED_LIMIT = 32;

/** Environment variable that carries an orchestrating goal's parent nonce into its container. */
export const AGENT_ADMISSION_PARENT_ENV = 'PROPR_PARENT_EXECUTION';

export interface AgentAdmissionNesting {
    /** Scope of the parent this execution is charged under. */
    parent?: string;
    /** Scope this execution registers, so its own nested executions find it. */
    register?: string;
}

const nestingContext = new AsyncLocalStorage<AgentAdmissionNesting>();

/**
 * Runs `operation` as work on behalf of the parent registered under `scope`.
 * Nothing registers inside it: a nested execution is not itself a parent
 * unless its own launch says so. An absent scope runs `operation` with no
 * nesting at all (ordinary top-level admission).
 */
export function runWithAgentAdmissionParent<T>(scope: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    if (!scope) return nestingContext.exit(operation);
    return nestingContext.run({ parent: scope }, operation);
}

/** Runs `operation` so that the physical launch inside it registers as the parent `scope`. */
export function runAsAgentAdmissionParent<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const outer = nestingContext.getStore();
    return nestingContext.run({ ...(outer?.parent ? { parent: outer.parent } : {}), register: scope }, operation);
}

export function currentAgentAdmissionNesting(): AgentAdmissionNesting | undefined {
    return nestingContext.getStore();
}

/** Parses the operator's nested-execution bound; throws a clear error on a malformed value. */
export function parseAgentRunNestedLimit(raw: string | undefined): number | undefined {
    if (raw === undefined || !raw.trim()) return undefined;
    const value = Number(raw.trim());
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > MAX_AGENT_RUN_NESTED_LIMIT) {
        throw new Error(`Invalid ${AGENT_RUN_NESTED_LIMIT_ENV}: expected an integer from 1 to ${MAX_AGENT_RUN_NESTED_LIMIT}`);
    }
    return value;
}

export type AgentAdmissionNestingRefusal = 'depth' | 'count' | 'alias';

/** A nested launch that cannot safely proceed. Refused at once, never waited for. */
export class AgentAdmissionNestingError extends Error {
    readonly reason: AgentAdmissionNestingRefusal;
    constructor(reason: AgentAdmissionNestingRefusal, limit: number = 0) {
        super(reason === 'alias'
            ? `Nested agent execution refused: another agent alias is at its ceiling; change the parent plan instead of waiting`
            : reason === 'depth'
            ? `Nested agent execution refused: its parent is itself nested, and nesting is limited to depth ${limit}`
            : `Nested agent execution refused: its parent already carries ${limit} running nested executions (${AGENT_RUN_NESTED_LIMIT_ENV}=${limit})`);
        this.name = 'AgentAdmissionNestingError';
        this.reason = reason;
    }
}

// ---------------------------------------------------------------------------
// Orchestrating goals: a nonce in the container environment, a marker in each issue

const GOAL_SCOPE_PREFIX = 'goal:';
const NONCE = /^[A-Za-z0-9-]{32,64}$/;
const MARKER = /<!--\s*propr-parent-execution:\s*([A-Za-z0-9-]{32,64}):([a-f0-9]{64})\s*-->/;

/** Public identifier of one goal, stable across attempts. It grants no admission authority. */
export function createGoalParentNonce(goalId: string): string {
    return createHash('sha256').update(`propr-goal-parent:${goalId}`).digest('hex').slice(0, 40);
}

export function goalParentScope(nonce: string): string {
    if (!NONCE.test(nonce)) throw new Error('Invalid goal parent nonce');
    return `${GOAL_SCOPE_PREFIX}${nonce}`;
}

/** A launch-specific signing capability; only the goal receives it, never the instance secret. */
export const AGENT_ADMISSION_PARENT_KEY_ENV = 'PROPR_PARENT_EXECUTION_KEY';
export function goalParentSigningKey(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
    goalParentScope(nonce);
    const root = env.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim() || env.SYSTEM_TASK_SECRET?.trim() || env.SESSION_SECRET?.trim();
    if (!root) throw new Error('Orchestrating goal admission requires PROPR_CREDENTIAL_ENCRYPTION_KEY, SYSTEM_TASK_SECRET or SESSION_SECRET');
    return createHmac('sha256', root).update(`propr.goal-child.v1\0${nonce}`).digest('hex');
}

export interface AgentAdmissionChildTarget {
    repoOwner: string;
    repoName: string;
    number: number;
    /** Absent for an issue; present for a specific PR command, never a whole PR. */
    commentId?: number;
    commentType?: 'issue' | 'review';
}

/** Canonical resource binding signed by the goal before it triggers the child. */
export function agentAdmissionChildIdentity(target: AgentAdmissionChildTarget): string {
    if (!target.repoOwner || !target.repoName || !Number.isSafeInteger(target.number) || target.number < 1
        || (target.commentId !== undefined && (!Number.isSafeInteger(target.commentId) || target.commentId < 1))) {
        throw new Error('Invalid admission child target');
    }
    return `${target.repoOwner.toLowerCase()}/${target.repoName.toLowerCase()}/${target.commentId === undefined ? 'issues' : 'pull'}/${target.number}`
        + (target.commentId === undefined ? '' : `/${target.commentType === 'review' ? 'review-comments' : 'comments'}/${target.commentId}`);
}

/** The signed association is durable in the resource body and serialized queue data. */
export function parentExecutionMarker(nonce: string, target?: AgentAdmissionChildTarget, env: NodeJS.ProcessEnv = process.env): string {
    if (!target) return `<!-- propr-parent-execution: ${nonce} -->`; // Historical, untrusted marker.
    const signature = createHmac('sha256', goalParentSigningKey(nonce, env)).update(agentAdmissionChildIdentity(target)).digest('hex');
    return `<!-- propr-parent-execution: ${nonce}:${signature} -->`;
}

/**
 * Validate the durable association with this exact resource. A public marker
 * copied to another issue, repository or command is ordinary work. Legacy
 * unsigned markers and a bare scope saved by older workers grant no authority.
 */
export function parentScopeFromIssueBody(body: unknown, target?: AgentAdmissionChildTarget, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (typeof body !== 'string' || !target) return undefined;
    const match = MARKER.exec(body);
    if (!match) return undefined;
    try {
        const signature = createHmac('sha256', goalParentSigningKey(match[1], env)).update(agentAdmissionChildIdentity(target)).digest();
        return timingSafeEqual(signature, Buffer.from(match[2], 'hex')) ? goalParentScope(match[1]) : undefined;
    } catch { return undefined; } // Missing trust root or malformed identity: ordinary accounting.
}

/** An automation run phase, identified by its run-scoped MCP grant. */
export function agentRunGrantParentScope(grantId: string): string {
    return `agent-run-grant:${grantId}`;
}

/**
 * Bounds parallel launches made on behalf of a parent to the nested count, so
 * a caller that fans out (semantic scoring chunks) queues its own work instead
 * of being refused. Outside a parent it imposes no limit.
 */
export function nestedLaunchGate(env: NodeJS.ProcessEnv = process.env): <T>(task: () => Promise<T>) => Promise<T> {
    if (!nestingContext.getStore()?.parent) return task => task();
    let limit: number;
    try { limit = parseAgentRunNestedLimit(env[AGENT_RUN_NESTED_LIMIT_ENV]) ?? DEFAULT_AGENT_RUN_NESTED_LIMIT; } catch { limit = 1; }
    let active = 0;
    const queue: Array<() => void> = [];
    return async task => {
        // A finishing task hands its slot straight to the next waiter.
        if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
        else active++;
        try { return await task(); }
        finally {
            const next = queue.shift();
            if (next) next(); else active--;
        }
    };
}

/** Select the explicit link of the command being executed, never the PR's issue or an older comment. */
export function parentScopeFromCommentJob(data: {
    repoOwner?: string; repoName?: string; pullRequestNumber?: number;
    commandCommentId?: number; commandCommentType?: 'issue' | 'review'; commentId?: number; commentBody?: string; agentAdmissionParent?: string;
    ultrafixMeta?: { instructions?: string; sourceCommentId?: number; sourceCommentType?: 'issue' | 'review' };
}, comments: Array<{ id: number; body: string; createdAt?: string; commandMode?: string; agentAdmissionParent?: string; agentAdmissionParentProof?: string; type?: 'issue' | 'review' }> = []): string | undefined {
    if (!data.repoOwner || !data.repoName || !data.pullRequestNumber) return undefined;
    const verify = (body: unknown, commentId: number | undefined, commentType?: 'issue' | 'review') => commentId === undefined ? undefined
        : parentScopeFromIssueBody(body, { repoOwner: data.repoOwner!, repoName: data.repoName!, number: data.pullRequestNumber!, commentId, commentType });
    const ordered = [...comments].sort((a, b) => (a.createdAt && b.createdAt ? a.createdAt.localeCompare(b.createdAt) : 0) || a.id - b.id);
    const selected = data.commandCommentId !== undefined
        ? ordered.find(comment => comment.id === data.commandCommentId)
        : ordered.filter(comment => comment.commandMode && comment.commandMode !== 'default').at(-1) ?? ordered.at(-1);
    if (selected) {
        // Only internal synthetic loop steps may use the durable origin command.
        // A real comment always has to prove its own association, after pickup.
        return selected.id === 0
            ? verify(data.ultrafixMeta?.instructions, data.ultrafixMeta?.sourceCommentId, data.ultrafixMeta?.sourceCommentType)
            : verify(selected.agentAdmissionParentProof ?? selected.body, selected.id, selected.type);
    }
    if (comments.length) return undefined; // The queued command was removed or replaced.
    return verify(data.commentBody, data.commandCommentId ?? data.commentId, data.commandCommentType);
}
