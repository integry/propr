import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getExecutionOwnershipContext } from '../claude/docker/dockerExecutionOwnership.js';
import type { AgentExecutionResult } from '../agents/types.js';
import type { ResolvedRepositoryWorkflow } from './repositoryWorkflow.js';
import { redactSecrets } from '../utils/secretRedaction.js';

/** Hook exit codes, and validation exit codes or `skipped` when the execution time budget ran out first. */
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
        this.pattern = new RegExp(`^${marker}:(?:hook:(after_create|before_run|after_run|before_remove|setup):([0-9]+)|validation:([0-9]+):([0-9]+|skipped))$`);
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
        if (match?.[1]) this.observation.hooks.set(match[1], match[2]);
        else if (match && Number(match[3]) < this.validationCount) this.observation.validation.set(Number(match[3]), match[4]);
        this.line = '';
        this.overflow = false;
        this.afterLineFeed = true;
    }
}

/** Scoped to one execution, including synthetic-provider retries; never process-global policy. */
export interface RepositoryWorkflowExecutionContext { workflow: ResolvedRepositoryWorkflow; marker: string; observed?: WorkflowObservation }
export const repositoryWorkflowExecution = new AsyncLocalStorage<RepositoryWorkflowExecutionContext>();

/** Read-only analysis containers `exec` the agent without hooks or validation. */
function isReadOnlyTransport(args: string[]): boolean {
    return args.some((arg, index) => (arg === 'PROPR_REPO_SETUP=0' && ['-e', '--env'].includes(args[index - 1])) || arg === '--env=PROPR_REPO_SETUP=0');
}

/** The wrapper argument of this execution, when the transport runs it. */
function runsWorkflowWrapper(context: RepositoryWorkflowExecutionContext | undefined, args: string[]): context is RepositoryWorkflowExecutionContext {
    return !!context && args.some(arg => arg.includes(context.marker)) && !isReadOnlyTransport(args);
}

/**
 * Collect reports only for the transport running this execution's wrapper. A
 * read-only container in the same execution never reports, so it must not
 * replace the observation of the run that actually executed hooks and validation.
 */
export function captureWorkflowMarkers(args: string[]): { append(chunk: string): void; finish(chunk: string): void } | undefined {
    const context = repositoryWorkflowExecution.getStore();
    if (!runsWorkflowWrapper(context, args)) return undefined;
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
        result.repositoryValidation = buildRepositoryValidationReport(validation.map((command, index) => {
            const code = observed.validation.get(index);
            return { command, status: code === undefined ? 'Not run (execution ended before validation)' : code === 'skipped' ? 'Not run (execution time limit reached)'
                : code === '0' ? 'Passed' : code === '124' || code === '137' ? 'Timed out' : `Failed (exit ${code})` };
        }));
    }
    return result;
}

// Completion comments share GitHub's 65,536-character body limit with summaries and logs.
export const REPOSITORY_VALIDATION_REPORT_MAX_LENGTH = 12_000;
const VALIDATION_LABEL_MAX_LENGTH = 200;
const ELLIPSIS = '…';

/**
 * Valid commands may be far longer than a comment can hold. Labels are redacted
 * before shortening so a cut can never leave an unrecognisable secret prefix,
 * and every command keeps its index and status within the aggregate budget.
 */
export function buildRepositoryValidationReport(entries: Array<{ command: string; status: string }>): string {
    const header = '### Repository validation\n\n';
    const prefixes = entries.map((entry, index) => ({ prefix: `- [${index + 1}] `, suffix: `: ${entry.status}` }));
    const fixed = header.length + prefixes.reduce((total, { prefix, suffix }) => total + prefix.length + suffix.length + 1, 0);
    const labelBudget = Math.min(VALIDATION_LABEL_MAX_LENGTH, Math.floor((REPOSITORY_VALIDATION_REPORT_MAX_LENGTH - fixed) / Math.max(entries.length, 1)));
    const lines = entries.map((entry, index) => {
        const label = redactSecrets(entry.command).replace(/\s+/g, ' ').trim();
        const shown = label.length <= labelBudget ? label : `${label.slice(0, Math.max(labelBudget - ELLIPSIS.length, 0)).trimEnd()}${ELLIPSIS}`;
        return `${prefixes[index].prefix}${shown}${prefixes[index].suffix}`;
    });
    return `${header}${lines.join('\n')}`;
}

// Below Linux's 128 KiB per-argument ceiling (including its terminating NUL).
export const WORKFLOW_WRAPPER_MAX_BYTES = 120 * 1024;
export const WORKFLOW_MARKER_TEMPLATE = `PROPR_WORKFLOW_${'0'.repeat(36)}`;

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Agent stderr is labelled separately from repository command output in execution logs. */
export const WORKFLOW_AGENT_STDERR_PREFIX = 'ProPR agent stderr: ';
export const WORKFLOW_COMMAND_OUTPUT_PREFIX = 'ProPR command output: ';
/** Removes the wrapper's agent stderr label from a diagnostic line. */
export function stripWorkflowAgentStderrPrefix(line: string): string {
    return line.startsWith(WORKFLOW_AGENT_STDERR_PREFIX) ? line.slice(WORKFLOW_AGENT_STDERR_PREFIX.length) : line;
}

// Container startup and teardown happen inside the execution timeout too.
const VALIDATION_DEADLINE_MARGIN_S = 30;
// timeout(1) sends KILL five seconds after TERM.
const KILL_GRACE_S = 5;

/**
 * Tells this execution's wrapper the transport's time limit, so post-agent
 * validation can stop before the limit instead of turning a completed agent run
 * into an execution timeout. Only `docker run` transports carrying the wrapper change.
 */
export function withWorkflowExecutionDeadline(command: string, args: string[], timeoutMs: number): string[] {
    const context = repositoryWorkflowExecution.getStore();
    if (!runsWorkflowWrapper(context, args) || !(context.workflow.config.validation?.length) || args[0] !== 'run' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return args;
    if (!/(?:^|\/)docker$/.test(command)) return args;
    return [args[0], '-e', `PROPR_EXECUTION_TIMEOUT_MS=${timeoutMs}`, ...args.slice(1)];
}

/** This script is passed as a Docker argv element. It must never execute on the worker. */
export function buildWorkflowWrapper(workflow: ResolvedRepositoryWorkflow, marker: string): string {
    const hooks = workflow.config.hooks ?? {};
    const hook = (name: 'after_create' | 'before_run' | 'after_run' | 'before_remove') => {
        const command = hooks[name];
        return command ? `run_hook ${name} ${quote(command)}` : ':';
    };
    const hookTimeoutS = workflow.timeoutMs / 1000;
    // Validation must leave room for the hooks that still follow it.
    const reserveS = VALIDATION_DEADLINE_MARGIN_S
        + (['after_run', 'before_remove'] as const).filter(name => hooks[name]).length * (Math.ceil(hookTimeoutS) + KILL_GRACE_S);
    const implicitSetup = `if [ "\${PROPR_REPO_SETUP:-1}" != "0" ] && [ -f "$PROPR_WORKSPACE/.propr/setup.sh" ]; then
    run_hook setup '/bin/bash .propr/setup.sh'
    setup_exit=$?
    if [ "$setup_exit" -ne 0 ] && [ "\${PROPR_REPO_SETUP_STRICT:-0}" = "1" ]; then exit "$setup_exit"; fi
fi`;
    const script = `
entrypoint="$0"
# Post-agent validation shares the execution time limit; stop starting commands before it.
validation_deadline=
case "\${PROPR_EXECUTION_TIMEOUT_MS:-}" in
    ''|*[!0-9]*) ;;
    *) validation_deadline=$(( SECONDS + PROPR_EXECUTION_TIMEOUT_MS / 1000 - ${reserveS} )) ;;
esac
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
        su-exec node env HOME=/home/node USER=node LOGNAME=node timeout --signal=TERM --kill-after=${KILL_GRACE_S}s "\${2:-${hookTimeoutS}}s" /bin/bash -c "$1" </dev/null >&2
    else
        timeout --signal=TERM --kill-after=${KILL_GRACE_S}s "\${2:-${hookTimeoutS}}s" /bin/bash -c "$1" </dev/null >&2
    fi
# Child output is untrusted, even when it knows the marker from /proc.
# Prefix every line so fragments from concurrent children cannot form a report.
# This also covers output from surviving background children.
} > >(/bin/sed -u 's/^/${WORKFLOW_COMMAND_OUTPUT_PREFIX}/' >&2) 2>&1
run_hook() {
    echo "Running ProPR workflow hook: $1" >&2
    run_command "$2"
    hook_exit=$?
    printf '\\n%s\\n' "${marker}:hook:$1:$hook_exit" >&2
    if [ "$hook_exit" -ne 0 ]; then echo "ProPR workflow hook $1 failed with exit code $hook_exit" >&2; fi
    return "$hook_exit"
}
run_validation() {
    limit=
    if [ -n "$validation_deadline" ]; then
        remaining=$(( validation_deadline - SECONDS ))
        if [ "$remaining" -le 0 ]; then
            echo "ProPR skipped validation command $(( $1 + 1 )): execution time limit reached" >&2
            printf '\\n%s\\n' "${marker}:validation:$1:skipped" >&2
            return 0
        fi
        if [ "$remaining" -lt ${Math.ceil(hookTimeoutS)} ]; then limit=$remaining; fi
    fi
    run_command "$2" $limit
    printf '\\n%s\\n' "${marker}:validation:$1:$?" >&2
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
"$entrypoint" "$@" 2> >(/bin/sed -u 's/^/${WORKFLOW_AGENT_STDERR_PREFIX}/' >&2)
agent_exit=$?
${(workflow.config.validation ?? []).map((command, index) => `run_validation ${index} ${quote(command)}`).join('\n')}
exit "$agent_exit"
`.trim();
    if (Buffer.byteLength(script, 'utf8') > WORKFLOW_WRAPPER_MAX_BYTES) {
        throw new Error('Invalid .propr/workflow.yml: expanded hooks and validation wrapper exceeds 120 KiB; move long commands into repository scripts and invoke those scripts from the workflow');
    }
    return script;
}
