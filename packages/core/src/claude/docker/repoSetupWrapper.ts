import type { AgentType } from '../../agents/types.js';

const ENTRYPOINT_PATHS: Record<AgentType, string> = {
    claude: '/home/node/claude-entrypoint.sh',
    codex: '/home/node/codex-entrypoint.sh',
    antigravity: '/home/node/antigravity-entrypoint.sh',
    opencode: '/home/node/opencode-entrypoint.sh',
    vibe: '/home/node/vibe-entrypoint.sh'
};

const WORKSPACE_PATH = '/home/node/workspace';
const DEFAULT_CACHE_ROOT = '/tmp/git-processor/propr-cache';

const REPO_SETUP_WRAPPER_SCRIPT = `
set -e

entrypoint="$0"
setup_script="\${PROPR_WORKSPACE:-/home/node/workspace}/.propr/setup.sh"

export PROPR_WORKSPACE="\${PROPR_WORKSPACE:-/home/node/workspace}"
export PROPR_CACHE_DIR="\${PROPR_CACHE_DIR:-/tmp/git-processor/propr-cache/\${PROPR_AGENT_TYPE:-agent}}"

if [ "\${PROPR_REPO_SETUP:-1}" != "0" ] && [ -f "$setup_script" ]; then
    mkdir -p "$PROPR_CACHE_DIR" 2>/dev/null || true
    chown node:node "$PROPR_CACHE_DIR" 2>/dev/null || true

    echo "Running ProPR repo setup hook: $setup_script" >&2
    set +e
    if [ "$(id -u)" = "0" ] && command -v sudo >/dev/null 2>&1 && id node >/dev/null 2>&1; then
        cd "$PROPR_WORKSPACE"
        sudo -E -u node -H /bin/bash "$setup_script" </dev/null >&2
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
    const cacheDir = `${DEFAULT_CACHE_ROOT}/${agentType}`;
    const setupEnv = [
        '-e', `PROPR_AGENT_TYPE=${agentType}`,
        '-e', `PROPR_WORKSPACE=${WORKSPACE_PATH}`,
        '-e', `PROPR_CACHE_DIR=${cacheDir}`
    ];
    const beforeImageWithSetupEnv = beforeImage[0] === 'run'
        ? [beforeImage[0], ...setupEnv, ...beforeImage.slice(1)]
        : [...setupEnv, ...beforeImage];

    return [
        ...beforeImageWithSetupEnv,
        '--entrypoint', '/bin/bash',
        dockerImage,
        '-lc',
        REPO_SETUP_WRAPPER_SCRIPT,
        ENTRYPOINT_PATHS[agentType],
        ...afterImage
    ];
}
