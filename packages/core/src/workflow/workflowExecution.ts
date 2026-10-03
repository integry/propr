import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getExecutionOwnershipContext } from '../claude/docker/dockerExecutionOwnership.js';
import type { AgentExecutionResult } from '../agents/types.js';
import type { ResolvedRepositoryWorkflow } from './repositoryWorkflow.js';

export interface WorkflowObservation { hooks: Map<string, string>; validation: Map<number, string> }

/**
 * Collects genuine wrapper reports from raw transport stderr as it streams, so
 * repository output cannot evict them from a bounded diagnostic tail. A report
 * counts only as a whole line preceded by a literal LF and ended by LF or EOF;
 * JS multiline anchors would also accept CR, and chunks can split any line.
 */
export class WorkflowMarkerCollector {
    private line = '';
    private afterLineFeed = false;
    private overflow = false;
    private readonly observation: WorkflowObservation = { hooks: new Map(), validation: new Map() };
    private readonly pattern: RegExp;
    private readonly maxLineLength: number;

    constructor(marker: string, private readonly validationCount: number) {
        this.pattern = new RegExp(`^${marker}:(?:hook:(after_create|before_run|after_run|before_remove|setup)|validation:([0-9]+)):([0-9]+)$`);
        this.maxLineLength = marker.length + 64;
    }

    append(chunk: string): void {
        let start = 0;
        for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
            this.take(chunk.slice(start, end));
            this.finishLine();
            start = end + 1;
        }
        this.take(chunk.slice(start));
    }

    end(): WorkflowObservation {
        this.finishLine();
        return this.observation;
    }

    private take(fragment: string): void {
        if (this.overflow || !fragment) return;
        this.line += fragment;
        // No genuine report is this long; stop buffering untrusted output until LF.
        if (this.line.length > this.maxLineLength) { this.overflow = true; this.line = ''; }
    }

    private finishLine(): void {
        const match = this.afterLineFeed && !this.overflow ? this.pattern.exec(this.line) : null;
        if (match?.[1]) this.observation.hooks.set(match[1], match[3]);
        else if (match && Number(match[2]) < this.validationCount) this.observation.validation.set(Number(match[2]), match[3]);
        this.line = '';
        this.overflow = false;
        this.afterLineFeed = true;
    }
}

/** Scoped to one execution, including synthetic-provider retries; never process-global policy. */
export interface RepositoryWorkflowExecutionContext { workflow: ResolvedRepositoryWorkflow; marker: string; observed?: WorkflowObservation }
export const repositoryWorkflowExecution = new AsyncLocalStorage<RepositoryWorkflowExecutionContext>();

/** Collect reports only for the transport running this execution's wrapper. */
export function captureWorkflowMarkers(args: string[]): { append(chunk: string): void; finish(chunk: string): void } | undefined {
    const context = repositoryWorkflowExecution.getStore();
    if (!context || !args.some(arg => arg.includes(context.marker))) return undefined;
    const collector = new WorkflowMarkerCollector(context.marker, context.workflow.config.validation?.length ?? 0);
    return {
        append: chunk => collector.append(chunk),
        finish: chunk => { collector.append(chunk); context.observed = collector.end(); },
    };
}

export async function executeWithRepositoryWorkflow(
    workflow: ResolvedRepositoryWorkflow | undefined,
    execute: () => Promise<AgentExecutionResult>,
): Promise<AgentExecutionResult> {
    getExecutionOwnershipContext()?.signal.throwIfAborted();
    if (!workflow) return execute();
    const marker = `PROPR_WORKFLOW_${randomUUID()}`;
    const context: RepositoryWorkflowExecutionContext = { workflow, marker };
    const result = await repositoryWorkflowExecution.run(context, execute);
    // Only reports collected from the transport's raw stderr are authoritative.
    // Agent result logs may include decoded JSON strings that bypass filtering.
    const observed = context.observed ?? { hooks: new Map<string, string>(), validation: new Map<number, string>() };
    const fatalHook = (['after_create', 'before_run'] as const).find(name => /^[1-9][0-9]*$/.test(observed.hooks.get(name) ?? ''));
    if (fatalHook) {
        result.success = false;
        result.terminationReason = undefined;
        result.error = `Repository workflow ${fatalHook} failed with exit code ${observed.hooks.get(fatalHook)}`;
    }
    const validation = workflow.config.validation ?? [];
    if (validation.length) {
        const reports = validation.map((command, index) => {
            const code = observed.validation.get(index);
            const status = code === undefined ? 'Not run (execution ended before validation)' : code === '0' ? 'Passed' : code === '124' || code === '137' ? 'Timed out' : `Failed (exit ${code})`;
            return `- ${command.replace(/\n/g, ' ')}: ${status}`;
        });
        result.repositoryValidation = `### Repository validation\n\n${reports.join('\n')}`;
    }
    return result;
}

// Below Linux's 128 KiB per-argument ceiling (including its terminating NUL).
export const WORKFLOW_WRAPPER_MAX_BYTES = 120 * 1024;
export const WORKFLOW_MARKER_TEMPLATE = `PROPR_WORKFLOW_${'0'.repeat(36)}`;

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** This script is passed as a Docker argv element. It must never execute on the worker. */
export function buildWorkflowWrapper(workflow: ResolvedRepositoryWorkflow, marker: string): string {
    const hooks = workflow.config.hooks ?? {};
    const hook = (name: 'after_create' | 'before_run' | 'after_run' | 'before_remove') => {
        const command = hooks[name];
        return command ? `run_hook ${name} ${quote(command)}` : ':';
    };
    const implicitSetup = `if [ "\${PROPR_REPO_SETUP:-1}" != "0" ] && [ -f "$PROPR_WORKSPACE/.propr/setup.sh" ]; then
    run_hook setup '/bin/bash .propr/setup.sh'
    setup_exit=$?
    if [ "$setup_exit" -ne 0 ] && [ "\${PROPR_REPO_SETUP_STRICT:-0}" = "1" ]; then exit "$setup_exit"; fi
fi`;
    const script = `
entrypoint="$0"
export PROPR_WORKSPACE="\${PROPR_WORKSPACE:-/home/node/workspace}"
export PROPR_CACHE_DIR="\${PROPR_CACHE_DIR:-/tmp/git-processor/propr-cache/\${PROPR_AGENT_TYPE:-agent}}"
# Read-only analysis calls must not run workflow hooks.
if [ "\${PROPR_REPO_SETUP:-1}" = "0" ]; then exec "$entrypoint" "$@"; fi
mkdir -p "$PROPR_CACHE_DIR" 2>/dev/null || true
chown node:node "$PROPR_CACHE_DIR" 2>/dev/null || true
cd "$PROPR_WORKSPACE" || exit 1
run_command() {
    current_uid=$(id -u) || return 126
    if [ "$current_uid" = "0" ]; then
        if ! command -v su-exec >/dev/null 2>&1 || ! id node >/dev/null 2>&1 || [ "$(id -u node)" = "0" ]; then
            echo "Cannot run repository workflow command: unprivileged node user and su-exec are required" >&2
            return 126
        fi
        su-exec node env HOME=/home/node USER=node LOGNAME=node timeout --signal=TERM --kill-after=5s ${workflow.timeoutMs / 1000}s /bin/bash -c "$1" </dev/null >&2
    else
        timeout --signal=TERM --kill-after=5s ${workflow.timeoutMs / 1000}s /bin/bash -c "$1" </dev/null >&2
    fi
# Child output is untrusted, even when it knows the marker from /proc.
# Prefix every line so fragments from concurrent children cannot form a report.
# This also covers output from surviving background children.
} > >(/bin/sed -u 's/^/ProPR command output: /' >&2) 2>&1
run_hook() {
    echo "Running ProPR workflow hook: $1" >&2
    run_command "$2"
    hook_exit=$?
    printf '\\n%s\\n' "${marker}:hook:$1:$hook_exit" >&2
    if [ "$hook_exit" -ne 0 ]; then echo "ProPR workflow hook $1 failed with exit code $hook_exit" >&2; fi
    return "$hook_exit"
}
finish() {
    final_exit=$?
    trap - EXIT
    if [ "\${agent_started:-0}" = "1" ]; then ${hook('after_run')}; fi
    ${hook('before_remove')}
    exit "$final_exit"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
${hooks.after_create ? `${hook('after_create')} || exit $?` : implicitSetup}
${hook('before_run')} || exit $?
# Preserve the agent's stdin; repository commands never consume its prompt.
agent_started=1
"$entrypoint" "$@" 2> >(/bin/sed -u 's/^/ProPR command output: /' >&2)
agent_exit=$?
${(workflow.config.validation ?? []).map((command, index) => `run_command ${quote(command)}\nprintf '\\n%s\\n' "${marker}:validation:${index}:$?" >&2`).join('\n')}
exit "$agent_exit"
`.trim();
    if (Buffer.byteLength(script, 'utf8') > WORKFLOW_WRAPPER_MAX_BYTES) {
        throw new Error('Invalid .propr/workflow.yml: expanded hooks and validation wrapper exceeds 120 KiB; move long commands into repository scripts and invoke those scripts from the workflow');
    }
    return script;
}
