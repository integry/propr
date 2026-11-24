import fs from 'node:fs';
import path from 'node:path';
import { envFileValues } from '../../credentials/hostCredentialStaging.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../../git/workspaceTransportScript.js';
import type { AgentType } from '../../types.js';
import { renderAgentRunEntrypoint } from '../dockerRunArgs.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';

/**
 * How an {@link AgentRunSpec} becomes a command on a Sprite.
 *
 * A Sprite cannot boot the `propr/agent` image, so the setup script
 * (`scripts/sprites-agent-setup.sh`) reproduces the parts of it the provider
 * entrypoints rely on: an unprivileged `node` user with `/home/node`, the
 * `docker/`-equivalent entrypoint scripts at `/home/node/<agent>-entrypoint.sh`,
 * `su-exec`/`gosu`, the `gh` wrapper and pinned CLI versions. The spec's
 * entrypoint, wrappers and CLI arguments are then run unchanged, as root, by
 * {@link SPRITES_LAUNCHER_SCRIPT}, exactly as `docker run --user 0:0` would.
 */

/** Per-run directories on the Sprite, private to the Sprite's own user (never readable by the agent). */
export const SPRITES_RUN_ROOT = '/tmp/propr-sprite-runs';
/** The image's default entrypoint (`ENTRYPOINT [tini, --, /home/node/agent-entrypoint.sh]`). */
export const SPRITES_DEFAULT_ENTRYPOINT = '/home/node/agent-entrypoint.sh';
export const SPRITES_AGENT_HOME = '/home/node';
export const SPRITES_LAUNCHER_EXIT_FAILURE = 125;

/** Providers the runtime maps today; others follow the same entrypoint contract once their CLI is pinned on the Sprite. */
export const SPRITES_SUPPORTED_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(['claude', 'codex']);

/** Where each provider's credential copy goes; removed before and after every run so no account outlives its run. */
export const SPRITES_CREDENTIAL_TARGETS: readonly string[] = Object.freeze([
    '/home/node/.claude', '/home/node/.claude.json', '/home/node/.codex', '/home/node/.gemini', '/home/node/.gemini-source',
    '/home/node/.config/opencode', '/home/node/.local/share/opencode', '/home/node/.vibe', '/run/propr-claude',
]);

const BASE_PATH = '/opt/propr/bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Host binds whose content the run never needs back: an empty directory stands in. */
const EMPTY_DIRECTORY_PURPOSES = new Set<AgentRunMount['purpose']>(['logs', 'scratch']);
/** Read-only files copied into the run (e.g. Claude's `.claude.json` seed). */
export const MAX_SPRITES_UPLOAD_BYTES = 1024 * 1024;

export interface SpritesRunPaths {
    root: string;
    argv: string;
    env: string;
    manifest: string;
    workdir: string;
    user: string;
    stdin: string;
    pid: string;
    launcher: string;
    stdoutLog: string;
    stderrLog: string;
    exitStatus: string;
    result: string;
}

export function spritesRunPaths(runId: string): SpritesRunPaths {
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(runId)) throw new Error(`Invalid Sprites run id: ${runId}`);
    const root = path.posix.join(SPRITES_RUN_ROOT, runId);
    const at = (name: string) => path.posix.join(root, name);
    return {
        root, argv: at('argv'), env: at('env'), manifest: at('manifest'), workdir: at('workdir'), user: at('user'), stdin: at('stdin'), pid: at('pid'),
        launcher: at('launch.sh'), stdoutLog: at('stdout.log'), stderrLog: at('stderr.log'), exitStatus: at('exit-status'), result: at('result'),
    };
}

type BindMount = Extract<AgentRunMount, { type: 'bind' }>;

function isSafeTarget(target: string): boolean {
    const normalized = path.posix.normalize(target);
    if (normalized !== target || !path.posix.isAbsolute(target) || target.endsWith('/')) return false;
    return [`${SPRITES_AGENT_HOME}/`, '/tmp/', '/run/propr-'].some(prefix => target.startsWith(prefix) && target.length > prefix.length)
        && target !== `${SPRITES_AGENT_HOME}/workspace`;
}

/** Why the Sprites runtime cannot provide `mount`, or undefined when it can. */
export function spritesMountRefusal(mount: BindMount): string | undefined {
    if (!isSafeTarget(mount.target)) return `cannot provide a mount at ${mount.target} (Sprite targets must be under ${SPRITES_AGENT_HOME}/, /tmp/ or /run/propr-)`;
    if (mount.credentialStore) return undefined;
    if (EMPTY_DIRECTORY_PURPOSES.has(mount.purpose) && !mount.readOnly) return undefined;
    if (mount.purpose === 'workspace' || mount.purpose === 'git') return 'cannot bind-mount the worker worktree; use the clone workspace transport';
    if (mount.readOnly) {
        try {
            const stat = fs.statSync(mount.source);
            if (stat.isFile() && stat.size <= MAX_SPRITES_UPLOAD_BYTES) return undefined;
        } catch (error) {
            // A strict (`--mount`) bind of a missing source fails in Docker too.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && mount.syntax !== 'mount') return undefined;
        }
        return `can only copy read-only regular files up to ${MAX_SPRITES_UPLOAD_BYTES} bytes into a Sprite, not ${mount.source}`;
    }
    return `cannot share the host directory ${mount.source} read-write with a Sprite`;
}

/** What the launcher installs before the run starts. */
export interface SpritesMountPlan {
    credentialStores: BindMount[];
    files: Array<{ source: string; target: string; mode: number }>;
    directories: string[];
}

export function planSpritesMounts(spec: AgentRunSpec): SpritesMountPlan {
    const plan: SpritesMountPlan = { credentialStores: [], files: [], directories: [] };
    for (const mount of [...spec.mounts].sort((left, right) => left.order - right.order)) {
        if (mount.type === 'tmpfs') {
            if (!isSafeTarget(mount.target)) throw new Error(`Agent runtime "sprites" cannot provide a tmpfs at ${mount.target} for ${spec.name}`);
            plan.directories.push(mount.target);
            continue;
        }
        const refusal = spritesMountRefusal(mount);
        if (refusal) throw new Error(`Agent runtime "sprites" ${refusal} for ${spec.name}`);
        if (mount.credentialStore) plan.credentialStores.push(mount);
        else if (EMPTY_DIRECTORY_PURPOSES.has(mount.purpose) && !mount.readOnly) plan.directories.push(mount.target);
        else if (fs.existsSync(mount.source)) plan.files.push({ source: mount.source, target: mount.target, mode: fs.statSync(mount.source).mode & 0o444 });
    }
    return plan;
}

/** `argv` the launcher runs: the entrypoint the image would use, its wrappers, then the provider CLI. */
export function renderSpritesArgv(spec: AgentRunSpec): string[] {
    if (!SPRITES_SUPPORTED_AGENTS.has(spec.profile.agentType)) {
        throw new Error(`Agent runtime "sprites" does not run ${spec.profile.agentType} agents yet; supported: ${[...SPRITES_SUPPORTED_AGENTS].join(', ')}`);
    }
    if (spec.workspace.mode !== 'clone') throw new Error(`Agent runtime "sprites" runs only the clone workspace transport (run ${spec.name})`);
    const { entrypoint, wrapperArgs } = renderAgentRunEntrypoint(spec);
    return [entrypoint ?? SPRITES_DEFAULT_ENTRYPOINT, ...wrapperArgs, ...spec.args];
}

/** `root` for a spec that starts as uid 0 (as every ProPR provider does), else the image user. */
export function spritesRunUser(spec: Pick<AgentRunSpec, 'user'>): 'root' | 'node' {
    const uid = spec.user?.split(':')[0]?.trim();
    return uid === '0' || uid === 'root' ? 'root' : 'node';
}

/**
 * The run's environment with Docker's precedence: the image's base, then env
 * files in order, then `-e` variables (the repository setup's first); a
 * name-only variable takes its value from the launch environment, and is
 * dropped when unset there, as `docker run -e NAME` does.
 */
export function resolveSpritesEnvironment(spec: AgentRunSpec, launchEnvironment: Record<string, string | undefined>): Map<string, string> {
    const user = spritesRunUser(spec);
    const environment = new Map<string, string>([
        ['PATH', BASE_PATH], ['HOME', user === 'root' ? '/root' : SPRITES_AGENT_HOME], ['USER', user], ['LANG', 'C.UTF-8'],
        ['AGY_CLI_DISABLE_AUTO_UPDATE', 'true'], ['DISABLE_AUTOUPDATER', '1'],
    ]);
    for (const file of [...spec.envFiles].sort((left, right) => left.order - right.order)) {
        for (const [name, value] of envFileValues(file.path, launchEnvironment)) environment.set(name, value);
    }
    const variables = [...(spec.repoSetup?.env ?? []), ...[...spec.env].sort((left, right) => left.order - right.order)];
    for (const variable of variables) {
        const value = variable.value ?? launchEnvironment[variable.name];
        if (value === undefined) environment.delete(variable.name);
        else environment.set(variable.name, value);
    }
    for (const name of environment.keys()) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Agent run ${spec.name} has an invalid environment variable name: ${name}`);
    }
    return environment;
}

/** NUL-separated records, as the launcher reads them with `mapfile -d ''`. */
export function encodeNulList(values: readonly string[]): Buffer {
    for (const value of values) if (value.includes('\0')) throw new Error('Sprites launcher values cannot contain NUL bytes');
    return Buffer.from(values.map(value => `${value}\0`).join(''), 'utf8');
}

/**
 * Launcher manifest records:
 * `purge <target>`, `store <run-relative dir> <target>`, `dir <target>`,
 * `file <run-relative file> <target> <octal mode>`, `output <sprite path> <run-relative return path>`.
 */
export function spritesManifest(records: ReadonlyArray<readonly string[]>): Buffer {
    return encodeNulList(records.flat());
}

const RESULT_DIR = WORKSPACE_TRANSPORT_RESULT_DIR;

/**
 * Runs as root (`sudo -n bash launch.sh <run dir>`) in a detachable Sprite
 * session (which the SDK opens as a TTY, so nothing the run needs passes
 * through it). It records its PID, installs the run's files, runs the spec's
 * command as root or `node` with only the spec's environment, the prompt on
 * stdin from a file, and stdout/stderr appended to separate log files the
 * worker follows. Then it returns the refreshable credentials and the
 * workspace result through the run directory, removes every credential copy
 * and records the command's exit status.
 */
export const SPRITES_LAUNCHER_SCRIPT = `
set -u
run_dir="$1"
[ "$(id -u)" = "0" ] || { echo "ProPR Sprites runtime: the launcher must run as root through passwordless sudo" >&2; exit ${SPRITES_LAUNCHER_EXIT_FAILURE}; }
owner="$(stat -c %u:%g "$run_dir")" || exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
stores=()
record_status() {
    printf '%s\\n' "$1" > "$run_dir/exit-status.tmp" && chown "$owner" -- "$run_dir/exit-status.tmp" && mv -f -- "$run_dir/exit-status.tmp" "$run_dir/exit-status"
}
remove_credentials() { for dst in "\${stores[@]}"; do rm -rf -- "$dst"; done; }
fail() {
    echo "ProPR Sprites runtime: $*" >> "$run_dir/stderr.log"
    remove_credentials
    record_status ${SPRITES_LAUNCHER_EXIT_FAILURE}
    exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
}
: > "$run_dir/stdout.log" && : > "$run_dir/stderr.log" && chown "$owner" -- "$run_dir/stdout.log" "$run_dir/stderr.log" || exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
printf '%s\\n' "$$" > "$run_dir/pid.tmp" && chown "$owner" -- "$run_dir/pid.tmp" && mv -f -- "$run_dir/pid.tmp" "$run_dir/pid" || fail "cannot record the launcher PID"
id node >/dev/null 2>&1 || fail "the Sprite has no node user; the ProPR setup script has not run"
mapfile -d '' -t argv < "$run_dir/argv" || fail "cannot read the command"
mapfile -d '' -t envv < "$run_dir/env" || fail "cannot read the environment"
rm -f -- "$run_dir/env"
mapfile -d '' -t manifest < "$run_dir/manifest" || fail "cannot read the manifest"
workdir="$(cat "$run_dir/workdir")"
run_user="$(cat "$run_dir/user")"
outputs=()
i=0
count=\${#manifest[@]}
while [ "$i" -lt "$count" ]; do
    kind="\${manifest[$i]}"
    case "$kind" in
        purge) rm -rf -- "\${manifest[$((i + 1))]}"; i=$((i + 2)) ;;
        store)
            src="$run_dir/\${manifest[$((i + 1))]}"; dst="\${manifest[$((i + 2))]}"; i=$((i + 3))
            stores+=("$dst")
            rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && cp -a -- "$src" "$dst" \\
                && chown -R node:node -- "$dst" && chmod 700 -- "$dst" || fail "cannot install credentials at $dst" ;;
        dir)
            dst="\${manifest[$((i + 1))]}"; i=$((i + 2))
            mkdir -p -- "$dst" && chown node:node -- "$dst" || fail "cannot create $dst" ;;
        file)
            src="$run_dir/\${manifest[$((i + 1))]}"; dst="\${manifest[$((i + 2))]}"; mode="\${manifest[$((i + 3))]}"; i=$((i + 4))
            stores+=("$dst")
            mkdir -p -- "$(dirname -- "$dst")" && install -m "$mode" -o node -g node -- "$src" "$dst" || fail "cannot install $dst" ;;
        output) outputs+=("\${manifest[$((i + 1))]}" "$run_dir/\${manifest[$((i + 2))]}"); i=$((i + 3)) ;;
        *) fail "unknown manifest record $kind" ;;
    esac
done
rm -rf -- "$run_dir/store" "$run_dir/files" "${RESULT_DIR}"
if [ -f "$run_dir/clone" ]; then rm -rf -- "$workdir"; fi
mkdir -p -- "$workdir" || fail "cannot create $workdir"
[ -f "$run_dir/clone" ] || chown node:node -- "$workdir"
cd "$workdir" || fail "cannot enter $workdir"
if [ "$run_user" = "root" ]; then runner=(env -i); else runner=(su-exec node env -i); fi
input=/dev/null
[ ! -f "$run_dir/stdin" ] || input="$run_dir/stdin"
"\${runner[@]}" "\${envv[@]}" "\${argv[@]}" <"$input" >>"$run_dir/stdout.log" 2>>"$run_dir/stderr.log" &
child=$!
trap 'kill -s TERM "$child" 2>/dev/null' TERM
trap 'kill -s INT "$child" 2>/dev/null' INT
trap 'kill -s HUP "$child" 2>/dev/null' HUP
while :; do
    wait "$child"
    status=$?
    kill -0 "$child" 2>/dev/null || break
done
trap - TERM INT HUP
j=0
while [ "$j" -lt "\${#outputs[@]}" ]; do
    src="\${outputs[$j]}"; ret="\${outputs[$((j + 1))]}"; j=$((j + 2))
    if [ -f "$src" ] && [ ! -L "$src" ]; then
        mkdir -p -- "$(dirname -- "$ret")" && cp -p -- "$src" "$ret" && chmod 600 -- "$ret"
    fi
done
[ ! -d "$run_dir/returned" ] || chown -R "$owner" -- "$run_dir/returned"
if [ -d "${RESULT_DIR}" ]; then
    mkdir -p -- "$run_dir/result" && cp -a -- "${RESULT_DIR}/." "$run_dir/result/" && chown -R "$owner" -- "$run_dir/result"
fi
remove_credentials
record_status "$status"
exit "$status"
`.trim();

/** Exit status of {@link SPRITES_FOLLOW_SCRIPT} when the launcher never recorded its PID. */
export const SPRITES_FOLLOW_NO_LAUNCHER_EXIT = 3;

/**
 * Follows one output log from a byte offset until the launcher exits
 * (`tail --pid` reads what is left, then stops): `bash -c <script> _ <offset> <pid file> <log>`.
 * Run as a plain (non-TTY) exec, so output arrives byte for byte and a dropped
 * connection resumes from the bytes already received.
 */
export const SPRITES_FOLLOW_SCRIPT = `
for _ in $(seq 1 300); do [ -s "$2" ] && break; sleep 0.1; done
[ -s "$2" ] || exit ${SPRITES_FOLLOW_NO_LAUNCHER_EXIT}
exec tail -c "+$1" --pid="$(cat "$2")" -s 0.5 -F -- "$3" 2>/dev/null
`.trim();

/** Signals the launcher (which forwards TERM/INT/HUP to the agent); KILL also kills its children. */
export const SPRITES_SIGNAL_SCRIPT = `
pid="$(cat "$2" 2>/dev/null)" || exit 0
[ -n "$pid" ] || exit 0
if [ "$1" = "KILL" ]; then
    for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do kill -s KILL "$child" 2>/dev/null; done
fi
kill -s "$1" "$pid" 2>/dev/null || true
`.trim();
