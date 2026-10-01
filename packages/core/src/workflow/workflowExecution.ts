import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getExecutionOwnershipContext } from '../claude/docker/dockerExecutionOwnership.js';
import type { AgentExecutionResult } from '../agents/types.js';
import type { ResolvedRepositoryWorkflow } from './repositoryWorkflow.js';

/** Scoped to one execution, including synthetic-provider retries; never process-global policy. */
export const repositoryWorkflowExecution = new AsyncLocalStorage<{ workflow: ResolvedRepositoryWorkflow; marker: string }>();

export async function executeWithRepositoryWorkflow(
    workflow: ResolvedRepositoryWorkflow | undefined,
    execute: () => Promise<AgentExecutionResult>,
): Promise<AgentExecutionResult> {
    getExecutionOwnershipContext()?.signal.throwIfAborted();
    if (!workflow) return execute();
    const marker = `PROPR_WORKFLOW_${randomUUID()}`;
    const result = await repositoryWorkflowExecution.run({ workflow, marker }, execute);
    const logs = `${result.logs}\n${result.rawOutput ?? ''}`;
    const failure = logs.match(new RegExp(`${marker}:hook:(after_create|before_run):([1-9][0-9]*)`));
    if (failure) {
        result.success = false;
        result.terminationReason = undefined;
        result.error = `Repository workflow ${failure[1]} failed with exit code ${failure[2]}`;
    }
    const validation = workflow.config.validation ?? [];
    if (validation.length) {
        const reports = validation.map((command, index) => {
            const matches = [...logs.matchAll(new RegExp(`${marker}:validation:${index}:([0-9]+)`, 'g'))];
            const code = matches.at(-1)?.[1];
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
    if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
        su-exec node env HOME=/home/node USER=node LOGNAME=node timeout --signal=TERM --kill-after=5s ${workflow.timeoutMs / 1000}s /bin/bash -c "$1" </dev/null >&2
    else
        timeout --signal=TERM --kill-after=5s ${workflow.timeoutMs / 1000}s /bin/bash -c "$1" </dev/null >&2
    fi
}
run_hook() {
    echo "Running ProPR workflow hook: $1" >&2
    run_command "$2"
    hook_exit=$?
    echo "${marker}:hook:$1:$hook_exit" >&2
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
"$entrypoint" "$@"
agent_exit=$?
${(workflow.config.validation ?? []).map((command, index) => `run_command ${quote(command)}\necho "${marker}:validation:${index}:$?" >&2`).join('\n')}
exit "$agent_exit"
`.trim();
    if (Buffer.byteLength(script, 'utf8') > WORKFLOW_WRAPPER_MAX_BYTES) {
        throw new Error('Invalid .propr/workflow.yml: expanded hooks and validation wrapper exceeds 120 KiB; move long commands into repository scripts and invoke those scripts from the workflow');
    }
    return script;
}
