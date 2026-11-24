import { repositoryWorkflowExecution, buildWorkflowWrapper, markWorkflowWrapperBuilt } from '../../workflow/workflowExecution.js';
import type { AgentType } from '../../agents/types.js';
import { buildAgentContainerResourceArgs, resolveAgentContainerResources } from '../../agents/agentContainerResources.js';
import type { AgentRunRepoSetup, AgentRunSpec } from '../../agents/runtime/types.js';
import { renderDockerEnvArgs, renderDockerRunArgs } from '../../agents/runtime/dockerRunArgs.js';
import { claudeConfigSeedScript } from './claudeConfigSeed.js';

export { buildAgentContainerResourceArgs };

const ENTRYPOINT_PATHS: Record<AgentType, string> = {
    claude: '/home/node/claude-entrypoint.sh',
    codex: '/home/node/codex-entrypoint.sh',
    antigravity: '/home/node/antigravity-entrypoint.sh',
    opencode: '/home/node/opencode-entrypoint.sh',
    vibe: '/home/node/vibe-entrypoint.sh'
};

const GIT_IDENTITIES: Record<AgentType, { name: string; email: string }> = {
    claude: { name: 'ProPR Claude Bot', email: 'claude-bot@propr.dev' },
    codex: { name: 'ProPR Codex Bot', email: 'codex-bot@propr.dev' },
    antigravity: { name: 'ProPR Antigravity Bot', email: 'antigravity-bot@propr.dev' },
    opencode: { name: 'ProPR OpenCode Bot', email: 'opencode-bot@propr.dev' },
    vibe: { name: 'ProPR Vibe Bot', email: 'vibe-bot@propr.dev' }
};

const WORKSPACE_PATH = '/home/node/workspace';
// The shared git-processor tree is mounted read-only in agent containers.
// Keep setup caches on the container's writable filesystem instead.
const DEFAULT_CACHE_ROOT = '/tmp/propr-setup-cache';

const REPO_SETUP_WRAPPER_SCRIPT = `
set -e

entrypoint="$0"
${claudeConfigSeedScript()}
setup_script="\${PROPR_WORKSPACE:-/home/node/workspace}/.propr/setup.sh"

export PROPR_WORKSPACE="\${PROPR_WORKSPACE:-/home/node/workspace}"
export PROPR_CACHE_DIR="\${PROPR_CACHE_DIR:-/tmp/propr-setup-cache/\${PROPR_AGENT_TYPE:-agent}}"

if [ "\${PROPR_REPO_SETUP:-1}" != "0" ] && [ -f "$setup_script" ]; then
    mkdir -p "$PROPR_CACHE_DIR" 2>/dev/null || true
    chown node:node "$PROPR_CACHE_DIR" 2>/dev/null || true

    echo "Running ProPR repo setup hook: $setup_script" >&2
    set +e
    if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
        cd "$PROPR_WORKSPACE"
        su-exec node env HOME=/home/node USER=node LOGNAME=node /bin/bash "$setup_script" </dev/null >&2
        setup_exit=$?
    else
        cd "$PROPR_WORKSPACE"
        /bin/bash "$setup_script" </dev/null >&2
        setup_exit=$?
    fi
    set -e
    if [ "$setup_exit" -ne 0 ]; then
        echo "ProPR repo setup hook failed with exit code $setup_exit" >&2
        if [ "\${PROPR_REPO_SETUP_STRICT:-0}" = "1" ]; then
            exit "$setup_exit"
        fi
        echo "Continuing so the agent can inspect and repair repository setup/build issues" >&2
    else
        echo "ProPR repo setup hook completed" >&2
    fi
fi

exec "$entrypoint" "$@"
`.trim();

function repoSetupEnvironment(agentType: AgentType): AgentRunRepoSetup['env'] {
    const gitIdentity = GIT_IDENTITIES[agentType];
    return [
        { name: 'PROPR_AGENT_TYPE', value: agentType },
        { name: 'PROPR_WORKSPACE', value: WORKSPACE_PATH },
        { name: 'PROPR_CACHE_DIR', value: `${DEFAULT_CACHE_ROOT}/${agentType}` },
        { name: 'GIT_AUTHOR_NAME', value: gitIdentity.name },
        { name: 'GIT_AUTHOR_EMAIL', value: gitIdentity.email },
        { name: 'GIT_COMMITTER_NAME', value: gitIdentity.name },
        { name: 'GIT_COMMITTER_EMAIL', value: gitIdentity.email },
    ];
}

/**
 * The repository setup hook (or the active repository workflow wrapper) that
 * runs before the provider entrypoint. Resolved when the run is described, so
 * the workflow wrapper of the current execution is captured.
 */
export function buildAgentRunRepoSetup(agentType: AgentType): AgentRunRepoSetup {
    const execution = repositoryWorkflowExecution.getStore();
    return {
        agentType,
        shell: '/bin/bash',
        script: execution ? buildWorkflowWrapper(execution.workflow, execution.marker) : REPO_SETUP_WRAPPER_SCRIPT,
        providerEntrypoint: ENTRYPOINT_PATHS[agentType],
        env: repoSetupEnvironment(agentType),
    };
}

/**
 * Finish a provider spec as every agent launch is finished: the common
 * resource boundary plus the repository setup wrapper around the entrypoint.
 */
export function applyAgentRunLaunchWrapper(spec: AgentRunSpec, agentType: AgentType): AgentRunSpec {
    spec.resources = resolveAgentContainerResources();
    spec.repoSetup = buildAgentRunRepoSetup(agentType);
    if (repositoryWorkflowExecution.getStore()) markWorkflowWrapperBuilt(renderDockerRunArgs(spec));
    return spec;
}

/** Argv form of {@link applyAgentRunLaunchWrapper} for launches still assembled as raw `docker run` arguments. */
export function wrapDockerRunArgsWithRepoSetup(
    dockerArgs: string[],
    dockerImage: string,
    agentType: AgentType
): string[] {
    const imageIndex = dockerArgs.indexOf(dockerImage);
    if (imageIndex === -1) {
        throw new Error(`Cannot enable repo setup hook: Docker image '${dockerImage}' was not found in docker run arguments`);
    }

    const beforeImage = dockerArgs.slice(0, imageIndex);
    const afterImage = dockerArgs.slice(imageIndex + 1);
    const resourceArgs = buildAgentContainerResourceArgs();
    const setup = buildAgentRunRepoSetup(agentType);
    const setupEnv = renderDockerEnvArgs(setup.env);
    const beforeImageWithSetupEnv = beforeImage[0] === 'run'
        ? [beforeImage[0], ...resourceArgs, ...setupEnv, ...beforeImage.slice(1)]
        : [...resourceArgs, ...setupEnv, ...beforeImage];

    const args = [
        ...beforeImageWithSetupEnv,
        '--entrypoint', setup.shell,
        dockerImage,
        '-lc',
        setup.script,
        setup.providerEntrypoint,
        ...afterImage
    ];
    if (repositoryWorkflowExecution.getStore()) markWorkflowWrapperBuilt(args);
    return args;
}
