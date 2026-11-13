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
 * Scopes: an orchestrating goal session uses `goal:<nonce>` (the nonce reaches
 * the issues it creates as a body marker and from there the issue job data);
 * an automation run phase uses `agent-run-grant:<grantId>` (its MCP grant
 * identifies the calling run on the API side). See
 * docs/docs/architecture/agent-run-admission.md#nested-executions.
 */
import { createHash } from 'node:crypto';
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

export type AgentAdmissionNestingRefusal = 'depth' | 'count';

/** A nested launch beyond the depth or count bound. Refused at once, never waited for. */
export class AgentAdmissionNestingError extends Error {
    readonly reason: AgentAdmissionNestingRefusal;
    constructor(reason: AgentAdmissionNestingRefusal, limit: number) {
        super(reason === 'depth'
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
const MARKER = /<!--\s*propr-parent-execution:\s*([A-Za-z0-9-]{32,64})\s*-->/;

/**
 * The parent nonce of one orchestrating goal. Stable across the goal's
 * attempts, so an issue created before a resume still names the goal; it
 * reveals nothing about the goal ID. It is a link, not a credential: the
 * marker is visible to anyone who can read the issue (see
 * parentScopeFromIssueBody for why a copied marker is harmless).
 */
export function createGoalParentNonce(goalId: string): string {
    return createHash('sha256').update(`propr-goal-parent:${goalId}`).digest('hex').slice(0, 40);
}

export function goalParentScope(nonce: string): string {
    if (!NONCE.test(nonce)) throw new Error('Invalid goal parent nonce');
    return `${GOAL_SCOPE_PREFIX}${nonce}`;
}

/** The hidden line an orchestrating goal adds to each issue it creates for ProPR to implement. */
export function parentExecutionMarker(nonce: string): string {
    return `<!-- propr-parent-execution: ${nonce} -->`;
}

/**
 * The parent scope named by an issue body's marker, if any. Only a goal scope
 * can be named this way. A copied or stale marker is harmless beyond the
 * bounds: it charges work only under a goal session that is still live, and
 * never past `PROPR_AGENT_RUN_NESTED_LIMIT`.
 */
export function parentScopeFromIssueBody(body: unknown): string | undefined {
    if (typeof body !== 'string') return undefined;
    const match = MARKER.exec(body);
    return match ? goalParentScope(match[1]) : undefined;
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
