/**
 * The sandbox half of the clone workspace transport: a bash wrapper that runs
 * outside the repository setup wrapper and the provider entrypoint.
 *
 * 1. Takes the repository-scoped token out of its environment, so neither the
 *    setup hook nor the agent inherits it, and keeps it only as a git
 *    `http.extraheader` passed through the environment of its own git commands
 *    (never argv, never `.git/config`, never a file).
 * 2. Fetches the base ref the worker published and checks out the task branch
 *    at exactly the base commit.
 * 3. Runs the wrapped entrypoint as a child (stdin and termination signals are
 *    forwarded) and keeps its exit status.
 * 4. Snapshots the workspace (agent HEAD plus every non-ignored change, and
 *    `.propr/previews`) as one commit, pushes it to the run's temporary result
 *    ref, and falls back to a bundle in the result directory when the push
 *    fails. A `status` file there records which path was taken.
 * 5. Drops the token and exits with the agent's status.
 */

export const WORKSPACE_TRANSPORT_TOKEN_ENV = 'PROPR_WORKSPACE_GIT_TOKEN';
export const WORKSPACE_TRANSPORT_RESULT_DIR = '/tmp/propr-workspace-result';
export const WORKSPACE_RESULT_STATUS_FILE = 'status';
export const WORKSPACE_RESULT_BUNDLE_FILE = 'result.bundle';
/** Ref the bundle fallback carries the snapshot under. */
export const WORKSPACE_RESULT_BUNDLE_REF = 'refs/propr/result';
/** Exit status of a run whose workspace could not be prepared (the agent never started). */
export const WORKSPACE_BOOTSTRAP_FAILURE_EXIT = 86;

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

transport_git() {
    GIT_CONFIG_COUNT=3 \\
    GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\
    GIT_CONFIG_KEY_1=http.https://github.com/.extraheader GIT_CONFIG_VALUE_1="$auth_header" \\
    GIT_CONFIG_KEY_2=core.hooksPath GIT_CONFIG_VALUE_2=/dev/null \\
    GIT_TERMINAL_PROMPT=0 git "$@"
}
local_git() {
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git "$@"
}
record() {
    printf '%s\\n' "$*" > "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}.tmp" && mv "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}.tmp" "$result_dir/${WORKSPACE_RESULT_STATUS_FILE}"
}
bootstrap_failed() {
    echo "ProPR workspace transport: $*" >&2
    record "failed bootstrap"
    auth_header=""
    exit ${WORKSPACE_BOOTSTRAP_FAILURE_EXIT}
}

mkdir -p "$result_dir" && chmod 700 "$result_dir" || { echo "ProPR workspace transport: cannot create $result_dir" >&2; exit ${WORKSPACE_BOOTSTRAP_FAILURE_EXIT}; }
mkdir -p "$workspace" || bootstrap_failed "cannot create $workspace"
cd "$workspace" || bootstrap_failed "cannot enter $workspace"
[ -z "$(ls -A . 2>/dev/null)" ] || bootstrap_failed "$workspace is not empty"
local_git init -q . || bootstrap_failed "git init failed"
local_git remote add origin "$remote" || bootstrap_failed "cannot add origin"
transport_git fetch -q --no-tags origin "+$base_ref:refs/propr/base" || bootstrap_failed "cannot fetch the task base"
[ "$(local_git rev-parse refs/propr/base)" = "$base_commit" ] || bootstrap_failed "fetched base does not match $base_commit"
local_git checkout -q -B "$branch" "$base_commit" || bootstrap_failed "cannot check out $branch"
local_git update-ref -d refs/propr/base
if [ "$(id -u)" = "0" ] && id node >/dev/null 2>&1; then
    chown -R node:node "$workspace" 2>/dev/null || true
fi
echo "ProPR workspace transport: cloned $base_commit into $workspace" >&2

exec 3<&0
/bin/bash -lc "$inner_script" "$@" <&3 3<&- &
child=$!
exec 3<&-
trap 'kill -s TERM "$child" 2>/dev/null' TERM
trap 'kill -s INT "$child" 2>/dev/null' INT
trap 'kill -s HUP "$child" 2>/dev/null' HUP
while :; do
    wait "$child"
    status=$?
    kill -0 "$child" 2>/dev/null || break
done
trap - TERM INT HUP

if [ -n "$result_ref" ]; then
    cd "$workspace" 2>/dev/null || { record "failed workspace"; auth_header=""; exit "$status"; }
    export GIT_AUTHOR_NAME="\${GIT_AUTHOR_NAME:-ProPR}" GIT_AUTHOR_EMAIL="\${GIT_AUTHOR_EMAIL:-bot@propr.dev}"
    export GIT_COMMITTER_NAME="\${GIT_COMMITTER_NAME:-ProPR}" GIT_COMMITTER_EMAIL="\${GIT_COMMITTER_EMAIL:-bot@propr.dev}"
    snapshot=""
    if local_git add -A . >/dev/null 2>&1; then
        if [ -d .propr/previews ]; then local_git add -A -f -- .propr/previews >/dev/null 2>&1; fi
        tree="$(local_git write-tree 2>/dev/null)"
        head="$(local_git rev-parse --verify -q HEAD)"
        if [ -n "$tree" ] && [ -n "$head" ]; then
            snapshot="$(local_git commit-tree "$tree" -p "$head" -m "ProPR workspace result" 2>/dev/null)"
        fi
    fi
    if [ -z "$snapshot" ]; then
        echo "ProPR workspace transport: could not snapshot the workspace" >&2
        record "failed snapshot"
    elif transport_git push -q --no-verify origin "$snapshot:$result_ref" 2>/dev/null; then
        record "pushed $snapshot"
    else
        echo "ProPR workspace transport: result push failed; leaving a bundle for the worker" >&2
        if local_git update-ref ${WORKSPACE_RESULT_BUNDLE_REF} "$snapshot" \\
            && local_git bundle create -q "$result_dir/${WORKSPACE_RESULT_BUNDLE_FILE}" ${WORKSPACE_RESULT_BUNDLE_REF} "^$base_commit" 2>/dev/null; then
            record "bundle $snapshot"
        else
            record "failed bundle"
        fi
    fi
fi
auth_header=""
exit "$status"
`.trim();
