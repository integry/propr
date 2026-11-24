import type {
    AgentRunHandle, AgentRunResult, AgentRunSpec, AgentRuntime, WorkspaceTransportMode,
} from '../agents/runtime/types.js';
import logger from '../utils/logger.js';

export { WORKSPACE_TRANSPORT_ENV, resolveWorkspaceTransportMode, runtimeWorkspaceTransports } from './workspaceTransportMode.js';

/** What a finished run's workspace result did to the worker worktree. */
export interface WorkspaceRunOutcome {
    applied: boolean;
    /** How the result reached the worker: the temporary ref, or the bundle fallback. */
    via?: 'ref' | 'bundle';
    /** The run's result snapshot commit. */
    commit?: string;
    /** Why nothing was applied. */
    reason?: string;
}

/** A spec prepared for one run, plus the steps that bring its result back. */
export interface PreparedWorkspace {
    readonly spec: AgentRunSpec;
    /**
     * Values the runtime's launch environment must carry for variables the
     * spec references by name only (secrets never written into the spec).
     */
    readonly launchEnvironment: Readonly<Record<string, string>>;
    /** Bring the finished run's result into the worker worktree. */
    complete(handle: AgentRunHandle, result: AgentRunResult): Promise<WorkspaceRunOutcome>;
    /** Always called last, whatever happened: temporary refs, credentials and the kept run are discarded. */
    cleanup(handle?: AgentRunHandle): Promise<void>;
}

/**
 * How a task workspace reaches an agent run and how its result returns.
 * The worker keeps ownership of the worktree, commits and PRs in every mode.
 */
export interface WorkspaceTransport {
    readonly mode: WorkspaceTransportMode;
    prepare(spec: AgentRunSpec): Promise<PreparedWorkspace>;
}

export class WorkspaceTransportError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'WorkspaceTransportError';
    }
}

/** Today's transport: the worktree is bind-mounted, so the run edits it in place. */
export class BindWorkspaceTransport implements WorkspaceTransport {
    readonly mode = 'bind' as const;

    async prepare(spec: AgentRunSpec): Promise<PreparedWorkspace> {
        return {
            spec,
            launchEnvironment: {},
            complete: async () => ({ applied: true }),
            cleanup: async () => undefined,
        };
    }
}

export async function createWorkspaceTransport(mode: WorkspaceTransportMode): Promise<WorkspaceTransport> {
    if (mode === 'bind') return new BindWorkspaceTransport();
    // The clone transport brings git and GitHub auth; bind-mode launches never load them.
    const { CloneWorkspaceTransport } = await import('./workspaceCloneTransport.js');
    return new CloneWorkspaceTransport();
}

type LaunchOptions = { extraEnvVars?: Record<string, string> };

/**
 * Run `spec` on `runtime` through `transport`: prepare the workspace, start
 * the run, bring its result into the worker worktree, then clean up. A run
 * that rejects (aborted, stopped, ownership lost) applies nothing. A run that
 * exited non-zero still returns what it left (the worker preserves partial
 * work); if that return fails, the run's own failure is what the caller sees.
 */
export async function runWithWorkspaceTransport<Options extends LaunchOptions, Result extends AgentRunResult>(
    runtime: AgentRuntime<Options, Result>,
    spec: AgentRunSpec,
    options: Options,
    { transport, assertSupported = () => undefined }: { transport: WorkspaceTransport; assertSupported?: (spec: AgentRunSpec) => void },
): Promise<Result> {
    const prepared = await transport.prepare(spec);
    let handle: AgentRunHandle<Result> | undefined;
    try {
        assertSupported(prepared.spec);
        const launchEnvironment = Object.keys(prepared.launchEnvironment).length > 0
            ? { extraEnvVars: { ...options.extraEnvVars, ...prepared.launchEnvironment } }
            : {};
        handle = runtime.start(prepared.spec, { ...options, ...launchEnvironment });
        const result = await handle.wait();
        try {
            const outcome = await prepared.complete(handle, result);
            logger.info({ run: spec.name, transport: transport.mode, ...outcome }, 'Workspace transport returned the run result');
        } catch (error) {
            if (result.exitCode === 0 && !result.timedOut) throw error;
            logger.warn({ run: spec.name, transport: transport.mode, exitCode: result.exitCode, error: (error as Error).message },
                'Could not return the workspace of a failed run');
        }
        return result;
    } finally {
        await prepared.cleanup(handle).catch(error => {
            logger.warn({ run: spec.name, transport: transport.mode, error: (error as Error).message }, 'Workspace transport cleanup failed');
        });
    }
}
