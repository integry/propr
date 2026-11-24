/**
 * The sandbox half of the clone workspace transport: a bash wrapper that runs
 * outside the repository setup wrapper and the provider entrypoint.
 *
 * 1. Takes the repository-scoped token out of its environment, so neither the
 *    setup hook nor the agent inherits it, and keeps it only as a git
 *    `http.extraheader` passed through the environment of its own git commands
 *    (never argv, never `.git/config`, never a file).
 *
 *    Removing the variable does not erase the process's initial environment
 *    (`/proc/<pid>/environ`) or its memory, which every process running under
 *    the same user ID can read. The credential boundary is therefore the user
 *    ID: the wrapper must start as root and be able to drop to the
 *    unprivileged `node` user ({@link WORKSPACE_AGENT_USER}). It refuses to
 *    run anything otherwise, before any credentialed operation. Everything
 *    agent-controlled runs as `node`: the setup hook (the repository setup and
 *    workflow wrappers drop to it), the agent (every ProPR provider entrypoint
 *    drops to it when started as root with a command; a direct entrypoint,
 *    which has no such wrapper, is started as `node` by this wrapper itself,
 *    see {@link WORKSPACE_DIRECT_AGENT_LAUNCH}) and the workspace snapshot
 *    (this wrapper drops to it).
 * 2. Fetches the base ref the worker published into a private, wrapper-owned
 *    bare repository, clones that into the workspace without credentials and
 *    checks out the task branch at exactly the base commit.
 *
 *    Every credentialed git command runs only in that private repository,
 *    against the fixed transport remote URL, with global configuration and
 *    git's command-selecting environment variables ignored. The workspace's
 *    `.git` (and `~/.gitconfig`) belong to the setup hook and agent once they
 *    start, so their configuration (`core.sshCommand`, `url.*.insteadOf`,
 *    remotes, credential helpers, filters) never reaches an authenticated
 *    operation.
 * 3. Runs the wrapped entrypoint as a child (stdin and termination signals are
 *    forwarded) and keeps its exit status. Its phase (`agent`, then
 *    `finalizing`) is recorded in the result directory, so a runtime that
 *    force-stops a run can kill the agent and spare this wrapper.
 * 4. Snapshots the workspace (agent HEAD plus every non-ignored change, and
 *    `.propr/previews`) as one commit under the agent's unprivileged identity
 *    (agent-configured filters run with the agent's privileges, never the
 *    wrapper's), carries it into the private repository as a bundle, pushes it
 *    from there to the run's temporary result ref, and falls back to a bundle
 *    in the result directory when the push fails. A `status` file there
 *    records which path was taken.
 * 5. Drops the token and exits with the agent's status.
 */

export const WORKSPACE_TRANSPORT_TOKEN_ENV = 'PROPR_WORKSPACE_GIT_TOKEN';
export const WORKSPACE_TRANSPORT_RESULT_DIR = '/tmp/propr-workspace-result';
export const WORKSPACE_RESULT_STATUS_FILE = 'status';
export const WORKSPACE_RESULT_BUNDLE_FILE = 'result.bundle';
/**
 * The wrapper's phase, for a runtime that has to force-stop a run without
 * losing its result: \`agent\` while the wrapped entrypoint runs (everything
 * else in the wrapper's session is the agent's), \`finalizing\` once it exited
 * and the wrapper snapshots and publishes the workspace. Absent while the
 * workspace is bootstrapped, before anything agent-controlled started.
 */
export const WORKSPACE_RESULT_PHASE_FILE = 'phase';
/** Ref the bundle fallback carries the snapshot under. */
export const WORKSPACE_RESULT_BUNDLE_REF = 'refs/propr/result';
/** Exit status of a run whose workspace could not be prepared (the agent never started). */
export const WORKSPACE_BOOTSTRAP_FAILURE_EXIT = 86;
/** Unprivileged identity the setup hook, agent and snapshot run as; never the credential-holding wrapper's. */
export const WORKSPACE_AGENT_USER = 'node';
/**
 * Inner launcher (`$0` of the wrapper) of a run without the repository setup
 * wrapper. Nothing trusted between this wrapper and such an entrypoint drops
 * privileges, so the wrapper starts the entrypoint and arguments that follow
 * as {@link WORKSPACE_AGENT_USER} itself, instead of running a root wrapper.
 */
export const WORKSPACE_DIRECT_AGENT_LAUNCH = 'propr-workspace-transport:run-as-agent';

/**
 * Whether a run's `user` (`uid[:gid]` or `name[:group]`) starts the transport
 * wrapper as root, the one identity that can drop the setup hook and agent to
 * {@link WORKSPACE_AGENT_USER} and keep its credential out of their reach.
 * An unset user is the image's own (`node` for ProPR agent images), so it does not.
 */
export function cloneRunStartsAsRoot(user: string | undefined): boolean {
    const uid = user?.split(':')[0]?.trim();
    return uid === '0' || uid === 'root';
}

/** Variables the wrapper reads, besides the token. */
export const WORKSPACE_TRANSPORT_ENVIRONMENT = {
    path: 'PROPR_WORKSPACE_CLONE_PATH',
    remote: 'PROPR_WORKSPACE_CLONE_REMOTE',
    baseRef: 'PROPR_WORKSPACE_CLONE_BASE_REF',
    baseCommit: 'PROPR_WORKSPACE_CLONE_BASE_COMMIT',
    branch: 'PROPR_WORKSPACE_CLONE_BRANCH',
    resultRef: 'PROPR_WORKSPACE_CLONE_RESULT_REF',
    resultDir: 'PROPR_WORKSPACE_CLONE_RESULT_DIR',
} as const;

const E = WORKSPACE_TRANSPORT_ENVIRONMENT;

export const WORKSPACE_TRANSPORT_SCRIPT = `
set -u
inner_script="$0"
token="\${${WORKSPACE_TRANSPORT_TOKEN_ENV}:-}"
unset ${WORKSPACE_TRANSPORT_TOKEN_ENV}
workspace="\${${E.path}}"
remote="\${${E.remote}}"
base_ref="\${${E.baseRef}}"
base_commit="\${${E.baseCommit}}"
branch="\${${E.branch}}"
result_ref="\${${E.resultRef}:-}"
result_dir="\${${E.resultDir}}"
auth_header=""
if [ -n "$token" ]; then
    auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\\n')"
fi
token=""
trusted=""

# Git in the wrapper's private repository only: no global config (HOME may be
# the agent's), no inherited variables that select programs or repositories.
git_isolation=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_CONFIG -u GIT_CONFIG_PARAMETERS -u GIT_SSH -u GIT_SSH_COMMAND
    -u GIT_SSH_VARIANT -u GIT_ASKPASS -u SSH_ASKPASS -u GIT_PROXY_COMMAND -u GIT_EXEC_PATH -u GIT_EXTERNAL_DIFF
    -u GIT_TEMPLATE_DIR -u GIT_ALLOW_PROTOCOL GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
    GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$workspace")
trusted_git() {
    "\${git_isolation[@]}" GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null \\
        git --git-dir="$trusted/repo.git" "$@"
}
# The only credentialed shape: private repository, fixed remote URL, trusted configuration.
transport_git() {
    "\${git_isolation[@]}" GIT_CONFIG_COUNT=4 \\
        GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null \\
        GIT_CONFIG_KEY_2=credential.helper GIT_CONFIG_VALUE_2= \\
        GIT_CONFIG_KEY_3=http.https://github.com/.extraheader GIT_CONFIG_VALUE_3="$auth_header" \\
        git --git-dir="$trusted/repo.git" "$@"
}
# The workspace as the wrapper sees it: possibly another user's directory (the
# image's /home/node/workspace belongs to node, the wrapper runs as root), which
# git refuses as dubiously owned. safe.directory is honoured from command-line
# configuration, which is what GIT_CONFIG_COUNT is, so it is set here (the
# wrapper replaces any inherited count). Exactly this checkout is trusted: as
# given and as resolved, since git compares the resolved path. Before anything
# agent-controlled starts, so its contents are the wrapper's own.
workspace_real=""
local_git() {
    GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \\
        GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1="$workspace" \\
        GIT_CONFIG_KEY_2=safe.directory GIT_CONFIG_VALUE_2="\${workspace_real:-$workspace}" \\
        git "$@"
}
# The token's boundary is the user ID: a process under the wrapper's identity can
# read its initial environment (/proc/<pid>/environ still holds the variable
# after unset) and its memory. Only a root wrapper with a separate unprivileged
# agent user keeps it out of the setup hook's and agent's reach.
drops_privileges() {
    [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1 && id ${WORKSPACE_AGENT_USER} >/dev/null 2>&1 && [ "$(id -u ${WORKSPACE_AGENT_USER})" != "0" ]
}
# Run a command as the agent's identity (as the repository setup wrapper does).
agent_identity=(su-exec ${WORKSPACE_AGENT_USER} env HOME=/home/${WORKSPACE_AGENT_USER} USER=${WORKSPACE_AGENT_USER} LOGNAME=${WORKSPACE_AGENT_USER})
as_agent() {
    "\${agent_identity[@]}" "$@"
}
drop_secrets() {
    auth_header=""
    [ -z "$trusted" ] || rm -rf "$trusted"
}
record() {
    printf '%s\\n' "$*" > "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}.tmp" && mv "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}.tmp" "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}"
}
bootstrap_failed() {
    echo "ProPR workspace transport: $*" >&2
    record "failed bootstrap"
    drop_secrets
    exit ${WORKSPACE_BOOTSTRAP_FAILURE_EXIT}
}

# Snapshot as the agent. Only the bundle bytes cross back through stdout.
snapshot_script='
set -u
workspace="$1"
cd "$workspace" || exit 1
g() { GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \\
        GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1="$workspace" git "$@"; }
g add -A . >/dev/null 2>&1 || exit 1
if [ -d .propr/previews ]; then g add -A -f -- .propr/previews >/dev/null 2>&1 || exit 1; fi
tree="$(g write-tree 2>/dev/null)" && [ -n "$tree" ] || exit 1
head="$(g rev-parse --verify -q HEAD)" && [ -n "$head" ] || exit 1
snapshot="$(g commit-tree "$tree" -p "$head" -m "ProPR workspace result" 2>/dev/null)" && [ -n "$snapshot" ] || exit 1
g update-ref ${WORKSPACE_RESULT_BUNDLE_REF} "$snapshot" || exit 1
g bundle create -q - ${WORKSPACE_RESULT_BUNDLE_REF} "^$2"
'

mkdir -p "$result_dir" && chmod 700 "$result_dir" || { echo "ProPR workspace transport: cannot create $result_dir" >&2; exit ${WORKSPACE_BOOTSTRAP_FAILURE_EXIT}; }
# Before any credentialed operation, and before anything agent-controlled starts.
drops_privileges || bootstrap_failed "the wrapper must start as root with an unprivileged ${WORKSPACE_AGENT_USER} user and su-exec, so the setup hook and agent run under a different user ID from its credential; refusing to run"
trusted="$(mktemp -d "\${TMPDIR:-/tmp}/propr-workspace-transport.XXXXXX")" && chmod 700 "$trusted" || bootstrap_failed "cannot create the transport repository"
git init -q --bare "$trusted/repo.git" >/dev/null 2>&1 || bootstrap_failed "cannot create the transport repository"
transport_git fetch -q --no-tags "$remote" "+$base_ref:refs/propr/base" || bootstrap_failed "cannot fetch the task base"
[ "$(trusted_git rev-parse --verify -q refs/propr/base)" = "$base_commit" ] || bootstrap_failed "fetched base does not match $base_commit"
mkdir -p "$workspace" || bootstrap_failed "cannot create $workspace"
cd "$workspace" || bootstrap_failed "cannot enter $workspace"
workspace_real="$(pwd -P)" || bootstrap_failed "cannot resolve $workspace"
[ -z "$(ls -A . 2>/dev/null)" ] || bootstrap_failed "$workspace is not empty"
local_git init -q . || bootstrap_failed "git init failed"
local_git remote add origin "$remote" || bootstrap_failed "cannot add origin"
local_git fetch -q --no-tags "$trusted/repo.git" "+refs/propr/base:refs/propr/base" || bootstrap_failed "cannot copy the task base"
local_git checkout -q -B "$branch" "$base_commit" || bootstrap_failed "cannot check out $branch"
local_git update-ref -d refs/propr/base
chown -R ${WORKSPACE_AGENT_USER}:${WORKSPACE_AGENT_USER} "$workspace" 2>/dev/null || true
echo "ProPR workspace transport: cloned $base_commit into $workspace" >&2

exec 3<&0
if [ "$inner_script" = "${WORKSPACE_DIRECT_AGENT_LAUNCH}" ]; then
    # A direct entrypoint has no trusted wrapper that drops privileges: start it as the agent.
    "\${agent_identity[@]}" "$@" <&3 3<&- &
else
    # The repository setup or workflow wrapper drops the setup hook, and the ProPR
    # provider entrypoint it execs drops the agent, to the agent user.
    /bin/bash -lc "$inner_script" "$@" <&3 3<&- &
fi
child=$!
exec 3<&-
printf 'agent\\n' > "$result_dir/${WORKSPACE_RESULT_PHASE_FILE}"
trap 'kill -s TERM "$child" 2>/dev/null' TERM
trap 'kill -s INT "$child" 2>/dev/null' INT
trap 'kill -s HUP "$child" 2>/dev/null' HUP
while :; do
    wait "$child"
    status=$?
    kill -0 "$child" 2>/dev/null || break
done
trap - TERM INT HUP
printf 'finalizing\\n' > "$result_dir/${WORKSPACE_RESULT_PHASE_FILE}"
cd / || exit 1

if [ -n "$result_ref" ]; then
    export GIT_AUTHOR_NAME="\${GIT_AUTHOR_NAME:-ProPR}" GIT_AUTHOR_EMAIL="\${GIT_AUTHOR_EMAIL:-bot@propr.dev}"
    export GIT_COMMITTER_NAME="\${GIT_COMMITTER_NAME:-ProPR}" GIT_COMMITTER_EMAIL="\${GIT_COMMITTER_EMAIL:-bot@propr.dev}"
    snapshot=""
    # The agent has only a pipe. The credentialed git process reads a file in
    # its own private directory after the last writer has closed the pipe.
    if (set -o pipefail; cd / && as_agent /bin/bash -c "$snapshot_script" propr-snapshot "$workspace" "$base_commit" </dev/null | cat > "$trusted/snapshot.bundle") \\
        && trusted_git bundle verify "$trusted/snapshot.bundle" >/dev/null 2>&1 \\
        && trusted_git fetch -q --no-tags "$trusted/snapshot.bundle" "+${WORKSPACE_RESULT_BUNDLE_REF}:${WORKSPACE_RESULT_BUNDLE_REF}" >/dev/null 2>&1; then
        snapshot="$(trusted_git rev-parse --verify -q ${WORKSPACE_RESULT_BUNDLE_REF})"
    fi
    if [ -z "$snapshot" ]; then
        echo "ProPR workspace transport: could not snapshot the workspace" >&2
        record "failed snapshot"
    elif transport_git push -q --no-verify "$remote" "$snapshot:$result_ref" 2>/dev/null; then
        record "pushed $snapshot"
    else
        echo "ProPR workspace transport: result push failed; leaving a bundle for the worker" >&2
        if trusted_git bundle create -q "$result_dir/${WORKSPACE_RESULT_BUNDLE_FILE}" ${WORKSPACE_RESULT_BUNDLE_REF} "^$base_commit" 2>/dev/null; then
            record "bundle $snapshot"
        else
            record "failed bundle"
        fi
    fi
fi
drop_secrets
exit "$status"
`.trim();
