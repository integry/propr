import fs from 'node:fs';
import path from 'node:path';
import { envFileValues } from '../../credentials/hostCredentialStaging.js';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../../git/workspaceTransportScript.js';
import type { AgentType } from '../../types.js';
import { renderAgentRunEntrypoint } from '../dockerRunArgs.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';
import { isSafeSpritesTarget, SPRITES_AGENT_HOME, SPRITES_ANTIGRAVITY_HOME } from './spritesCredentialRecords.js';
import { SPRITES_SECURE_PATH_FUNCTION } from './spritesPathSafety.js';

export {
    spritesLiveOutputRecord, spritesOutputRecord, SPRITES_AGENT_HOME, SPRITES_ANTIGRAVITY_HOME, SPRITES_LIVE_CREDENTIAL_ROOTS,
} from './spritesCredentialRecords.js';
export { SPRITES_SCRUB_SCRIPT, SPRITES_SECURE_PATH_FUNCTION } from './spritesPathSafety.js';

/**
 * How an {@link AgentRunSpec} becomes a command on a Sprite.
 *
 * A Sprite cannot boot the `propr/agent` image, so the setup script
 * (`scripts/sprites-agent-setup.sh`) reproduces the parts of it the provider
 * entrypoints rely on: an unprivileged `node` user with `/home/node`, the
 * `docker/`-equivalent entrypoint scripts, `su-exec`/`gosu`, the `gh` wrapper
 * and pinned CLI versions. The spec's entrypoint, wrappers and CLI arguments
 * are then run, as root, by {@link SPRITES_LAUNCHER_SCRIPT}, as
 * `docker run --user 0:0` would; only the image's `/home/node/<agent>-entrypoint.sh`
 * paths are mapped to their root-owned copies in {@link SPRITES_ENTRYPOINT_DIR}.
 */

/** Per-run directories on the Sprite, private to the Sprite's own user (never readable by the agent). */
export const SPRITES_RUN_ROOT = '/tmp/propr-sprite-runs';
/**
 * Where setup installs the entrypoint scripts root runs. The image keeps them
 * in `/home/node`, which the agent user owns: the repository setup hook (run as
 * `node` before the root-run provider entrypoint) could replace them there. This
 * directory and every ancestor are root-owned and not writable by `node`
 * (setup verifies it), and the installed copies refer to each other here.
 */
export const SPRITES_ENTRYPOINT_DIR = '/opt/propr/entrypoints';
/** Entrypoint scripts setup installs in {@link SPRITES_ENTRYPOINT_DIR}. */
export const SPRITES_INSTALLED_ENTRYPOINTS: readonly string[] = Object.freeze(['agent-entrypoint.sh', 'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh']);
/** The image's default entrypoint (`ENTRYPOINT [tini, --, /home/node/agent-entrypoint.sh]`), at its protected path. */
export const SPRITES_DEFAULT_ENTRYPOINT = `${SPRITES_ENTRYPOINT_DIR}/agent-entrypoint.sh`;
/** Locations the agent user can write to (or create entries in): root never executes a file from them. */
const AGENT_WRITABLE_PREFIXES: readonly string[] = ['/home/', '/tmp/', '/var/tmp/', '/dev/shm/', '/run/propr-'];
export const SPRITES_LAUNCHER_EXIT_FAILURE = 125;

/** Providers whose CLI the setup script pins; others follow the same entrypoint contract once their CLI is pinned on the Sprite. */
export const SPRITES_SUPPORTED_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(['claude', 'codex', 'antigravity']);

/** Where each provider's credential copy goes; removed before and after every run so no account outlives its run. */
export const SPRITES_CREDENTIAL_TARGETS: readonly string[] = Object.freeze([
    '/home/node/.claude', '/home/node/.claude.json', '/home/node/.codex', '/home/node/.gemini', '/home/node/.gemini-source',
    '/home/node/.config/opencode', '/home/node/.local/share/opencode', '/home/node/.vibe', '/run/propr-claude',
]);

/** Removed before every run (with every credential target): a live copy an earlier run left is never returned as this run's token. */
export const SPRITES_RUN_PURGE_TARGETS: readonly string[] = Object.freeze([...SPRITES_CREDENTIAL_TARGETS, SPRITES_ANTIGRAVITY_HOME]);

/**
 * Everything a run leaves outside its run directory: the clone workspace
 * (with `.git`), the workspace result (`result.bundle`), Antigravity's
 * disposable HOME and every credential target. Removed when the run is
 * released and the Sprite cannot be restored to its clean checkpoint. With
 * `keepLiveCredentials` (their export was not confirmed, so they may hold the
 * only valid token) the credential targets and Antigravity's HOME stay.
 */
export function spritesRunLeftovers(spec: Pick<AgentRunSpec, 'workdir' | 'name'>, { keepLiveCredentials = false } = {}): string[] {
    const workdir = path.posix.normalize(spec.workdir);
    const safeWorkdir = path.posix.isAbsolute(workdir) && [`${SPRITES_AGENT_HOME}/`, '/tmp/'].some(prefix => workdir.startsWith(prefix) && workdir.length > prefix.length);
    if (!safeWorkdir) throw new Error(`Agent runtime "sprites" cannot run ${spec.name} in ${spec.workdir} (the workdir must be under ${SPRITES_AGENT_HOME}/ or /tmp/)`);
    return keepLiveCredentials ? [workdir, WORKSPACE_TRANSPORT_RESULT_DIR] : [workdir, WORKSPACE_TRANSPORT_RESULT_DIR, SPRITES_ANTIGRAVITY_HOME, ...SPRITES_CREDENTIAL_TARGETS];
}

/**
 * A root-started run's PATH has only root-owned directories: root resolves the
 * entrypoints' commands (`su-exec`, `id`, `chown`, ...) through it after the
 * repository setup hook ran as `node`, so a directory `node` can write to would
 * let the hook plant them. The agent inherits it through `su-exec`.
 */
const ROOT_PATH = '/opt/propr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** A run started as `node` also gets the agent's own `~/.local/bin`, as in the image. */
const AGENT_PATH = '/opt/propr/bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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
    /** Written by the launcher only once every refreshed credential was returned to `returned/`. */
    credentialsExported: string;
    /** What each refreshable credential was when the run received it (written before the copy is uploaded), so a reattached worker can tell an unchanged return. */
    credentialBaseline: string;
    result: string;
}

export function spritesRunPaths(runId: string): SpritesRunPaths {
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(runId)) throw new Error(`Invalid Sprites run id: ${runId}`);
    const root = path.posix.join(SPRITES_RUN_ROOT, runId);
    const at = (name: string) => path.posix.join(root, name);
    return {
        root, argv: at('argv'), env: at('env'), manifest: at('manifest'), workdir: at('workdir'), user: at('user'), stdin: at('stdin'), pid: at('pid'),
        launcher: at('launch.sh'), stdoutLog: at('stdout.log'), stderrLog: at('stderr.log'), exitStatus: at('exit-status'), credentialsExported: at('credentials-exported'),
        credentialBaseline: at('credential-baseline.json'), result: at('result'),
    };
}

type BindMount = Extract<AgentRunMount, { type: 'bind' }>;

/** Why the Sprites runtime cannot provide `mount`, or undefined when it can. */
export function spritesMountRefusal(mount: BindMount): string | undefined {
    if (!isSafeSpritesTarget(mount.target)) return `cannot provide a mount at ${mount.target} (Sprite targets must be under ${SPRITES_AGENT_HOME}/, /tmp/ or /run/propr-)`;
    if (mount.credentialStore && !mount.credentialStore.perRun) {
        // The provider session a resumed run continues lives in the store between launches; a Sprite gets only the
        // manifest's files and is restored to its clean checkpoint before every run, so that session would be gone.
        return `cannot preserve the ${mount.credentialStore.provider} ${mount.credentialStore.store} store at ${mount.target} between runs, which this run needs for its provider session (goal sessions resumed by id); use the Docker runtime`;
    }
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
            if (!isSafeSpritesTarget(mount.target)) throw new Error(`Agent runtime "sprites" cannot provide a tmpfs at ${mount.target} for ${spec.name}`);
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

/** The root-owned Sprite copy of an image entrypoint (`/home/node/<agent>-entrypoint.sh`); any other path as it is. */
export function spritesProtectedEntrypoint(file: string): string {
    const name = path.posix.basename(file);
    return path.posix.dirname(file) === SPRITES_AGENT_HOME && SPRITES_INSTALLED_ENTRYPOINTS.includes(name) ? path.posix.join(SPRITES_ENTRYPOINT_DIR, name) : file;
}

/** A bare command name resolves through the run's root-only PATH; a relative path from the agent-owned workspace. */
function agentWritable(file: string): boolean {
    if (!path.posix.isAbsolute(file)) return file.includes('/');
    const normalized = path.posix.normalize(file);
    return AGENT_WRITABLE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * `argv` the launcher runs: the entrypoint the image would use, its wrappers,
 * then the provider CLI. Image entrypoint paths become their root-owned
 * copies, and a root-started run whose entrypoint or provider entrypoint is
 * still a file the agent user could replace is refused.
 */
export function renderSpritesArgv(spec: AgentRunSpec): string[] {
    if (!SPRITES_SUPPORTED_AGENTS.has(spec.profile.agentType)) {
        throw new Error(`Agent runtime "sprites" does not run ${spec.profile.agentType} agents yet; supported: ${[...SPRITES_SUPPORTED_AGENTS].join(', ')}`);
    }
    if (spec.workspace.mode !== 'clone') throw new Error(`Agent runtime "sprites" runs only the clone workspace transport (run ${spec.name})`);
    spritesRunLeftovers(spec);
    const { entrypoint, wrapperArgs } = renderAgentRunEntrypoint(spec);
    const launch = [entrypoint ?? SPRITES_DEFAULT_ENTRYPOINT, ...wrapperArgs].map(spritesProtectedEntrypoint);
    if (spritesRunUser(spec) === 'root') {
        const rootExecuted = [launch[0], ...(spec.repoSetup ? [spritesProtectedEntrypoint(spec.repoSetup.providerEntrypoint)] : [])];
        const exposed = rootExecuted.find(agentWritable);
        if (exposed) throw new Error(`Agent runtime "sprites" will not run ${exposed} as root for ${spec.name}: the agent user can replace files there`);
    }
    return [...launch, ...spec.args];
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
        ['PATH', user === 'root' ? ROOT_PATH : AGENT_PATH], ['HOME', user === 'root' ? '/root' : SPRITES_AGENT_HOME], ['USER', user], ['LANG', 'C.UTF-8'],
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
 * `purge <target>`, `stamp <run-relative file> <epoch seconds>` (the modification time of an uploaded store file),
 * `store <run-relative dir> <target>`, `dir <target>`, `file <run-relative file> <target> <octal mode>`,
 * `output <boundary> <path below it> <run-relative return path>` (see `spritesOutputRecord`),
 * `live <boundary> <path below it> <run-relative return path>` (see `spritesLiveOutputRecord`).
 */
export function spritesManifest(records: ReadonlyArray<readonly string[]>): Buffer {
    return encodeNulList(records.flat());
}

/** Environment variable every process of a run inherits (its value is the run directory). */
export const SPRITES_RUN_TAG = 'PROPR_SPRITES_RUN';

/** The line of {@link SPRITES_RUN_MEMBERS_FUNCTIONS} that resolves the agent UID (tests substitute an unused UID). */
export const SPRITES_AGENT_UID_LINE = 'agent_uid="$(id -u node 2>/dev/null)"';

/**
 * Bash functions shared by the launcher and {@link SPRITES_SIGNAL_SCRIPT}:
 * `run_members <run dir> <session id>` lists the run's live processes (its
 * session or process group, anything carrying its {@link SPRITES_RUN_TAG},
 * and every process of the dedicated agent user `node`, whichever of its
 * real, effective, saved or filesystem UIDs that is), and `kill_run_members`
 * SIGKILLs them until none is left (status 1 when some survive). The UID is
 * the enforced boundary: a process can leave the session and clear its
 * environment (`setsid env -i ...`), but cannot stop being `node`. Only runs
 * use that user, and a Sprite hosts one run at a time.
 */
export const SPRITES_RUN_MEMBERS_FUNCTIONS = `
${SPRITES_AGENT_UID_LINE}
case "$agent_uid" in ''|0|*[!0-9]*) agent_uid="" ;; esac
agent_member() {
    local uid
    [ -n "$agent_uid" ] || return 1
    for uid in $(sed -n 's/^Uid:[[:space:]]*//p' "$1/status" 2>/dev/null); do [ "$uid" != "$agent_uid" ] || return 0; done
    return 1
}
run_members() {
    local tag="${SPRITES_RUN_TAG}=$1" group="$2" entry pid stat own_group own_session
    local -a fields
    case "$group" in ''|*[!0-9]*|0|1) group="" ;; esac
    read -r -a fields <<< "$(sed 's/^.*) //' "/proc/$$/stat")"
    own_group="\${fields[2]}"; own_session="\${fields[3]}"
    { [ "$group" != "$own_group" ] && [ "$group" != "$own_session" ]; } || group=""
    for entry in /proc/[0-9]*; do
        pid="\${entry#/proc/}"
        [ "$pid" != "$$" ] || continue
        stat="$(cat -- "$entry/stat" 2>/dev/null)" || continue
        read -r -a fields <<< "\${stat##*) }"
        [ "\${fields[0]}" != "Z" ] || continue
        if [ -n "$group" ] && { [ "\${fields[2]}" = "$group" ] || [ "\${fields[3]}" = "$group" ]; }; then echo "$pid"; continue; fi
        if agent_member "$entry"; then echo "$pid"; continue; fi
        if tr '\\0' '\\n' < "$entry/environ" 2>/dev/null | grep -qxF -- "$tag"; then echo "$pid"; fi
    done
}
# Zombies are dead: only their parent's wait is pending.
pid_alive() {
    local stat
    stat="$(cat -- "/proc/$1/stat" 2>/dev/null)" || return 1
    stat="\${stat##*) }"
    [ "\${stat%% *}" != "Z" ]
}
kill_run_members() {
    local attempt pids
    for attempt in $(seq 1 20); do
        pids="$(run_members "$1" "$2")"
        [ -n "$pids" ] || return 0
        kill -s KILL -- $pids 2>/dev/null
        sleep 0.25
    done
    [ -z "$(run_members "$1" "$2")" ]
}
`.trim();

const RESULT_DIR = WORKSPACE_TRANSPORT_RESULT_DIR;

/**
 * Runs as root (`sudo -n bash launch.sh <run dir>`) in a detachable Sprite
 * session (which the SDK opens as a TTY, so nothing the run needs passes
 * through it). It records its PID, installs the run's files, runs the spec's
 * command as root or `node` with only the spec's environment, the prompt on
 * stdin from a file, and stdout/stderr appended to separate log files the
 * worker follows. The command runs in its own session (`setsid`) and carries
 * `PROPR_SPRITES_RUN=<run dir>` in its environment; with the agent user's UID
 * that is the run's process boundary, which TERM is forwarded to and which is
 * killed before the run starts (leftovers of an earlier run) and once the
 * command exits (as a container's processes die with it). Then it returns the
 * refreshable credentials and the workspace result through the run
 * directory and records the exit status. Every step of the credential return
 * is checked: only when all succeeded does it record `credentials-exported`
 * and remove the credential copies; otherwise the live copies stay (they may
 * hold the only valid rotated token) and the worker keeps the recovery obligation.
 */
export const SPRITES_LAUNCHER_SCRIPT = `
set -u
run_dir="$1"
${SPRITES_RUN_MEMBERS_FUNCTIONS}
[ "$(id -u)" = "0" ] || { echo "ProPR Sprites runtime: the launcher must run as root through passwordless sudo" >&2; exit ${SPRITES_LAUNCHER_EXIT_FAILURE}; }
owner="$(stat -c %u:%g "$run_dir")" || exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
stores=()
record_status() {
    printf '%s\\n' "$1" > "$run_dir/exit-status.tmp" && chown "$owner" -- "$run_dir/exit-status.tmp" && mv -f -- "$run_dir/exit-status.tmp" "$run_dir/exit-status"
}
${SPRITES_SECURE_PATH_FUNCTION}
remove_credentials() { for dst in "\${stores[@]}"; do secure_path "$dst" && rm -rf -- "$dst"; done; }
# plain_file <boundary> <path below it>: 0 when it is a regular file reached only through real directories,
# 1 when a component is absent, 2 when one is a symlink or another file type (or the path is not plain).
plain_file() {
    local current="$1" index last
    local -a parts
    [ -d "$current" ] || return 2
    case "$2" in ''|/*|*/|*$'\n'*) return 2 ;; esac
    IFS=/ read -r -a parts <<< "$2"
    last=$((\${#parts[@]} - 1))
    for index in "\${!parts[@]}"; do
        case "\${parts[$index]}" in ''|.|..) return 2 ;; esac
        current="$current/\${parts[$index]}"
        [ ! -L "$current" ] || return 2
        [ -e "$current" ] || return 1
        if [ "$index" -lt "$last" ]; then [ -d "$current" ] || return 2; else [ -f "$current" ] || return 2; fi
    done
}
# Confirms that every refreshed credential is in returned/ (or that none can have refreshed).
record_export() {
    printf 'ok\n' > "$run_dir/credentials-exported.tmp" && chown "$owner" -- "$run_dir/credentials-exported.tmp" && mv -f -- "$run_dir/credentials-exported.tmp" "$run_dir/credentials-exported"
}
# Before the command started: the copies were never used, so the canonical stores are current.
fail() {
    echo "ProPR Sprites runtime: $*" >> "$run_dir/stderr.log"
    remove_credentials
    record_export
    record_status ${SPRITES_LAUNCHER_EXIT_FAILURE}
    exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
}
rm -f -- "$run_dir/credentials-exported" "$run_dir/credentials-exported.tmp"
: > "$run_dir/stdout.log" && : > "$run_dir/stderr.log" && chown "$owner" -- "$run_dir/stdout.log" "$run_dir/stderr.log" || exit ${SPRITES_LAUNCHER_EXIT_FAILURE}
printf '%s\\n' "$$" > "$run_dir/pid.tmp" && chown "$owner" -- "$run_dir/pid.tmp" && mv -f -- "$run_dir/pid.tmp" "$run_dir/pid" || fail "cannot record the launcher PID"
id node >/dev/null 2>&1 || fail "the Sprite has no node user; the ProPR setup script has not run"
[ -n "$agent_uid" ] || fail "the node user must have a non-root UID (the run's process boundary)"
command -v setsid >/dev/null 2>&1 || fail "the Sprite has no setsid (util-linux)"
mapfile -d '' -t argv < "$run_dir/argv" || fail "cannot read the command"
mapfile -d '' -t envv < "$run_dir/env" || fail "cannot read the environment"
envv+=("${SPRITES_RUN_TAG}=$run_dir")
rm -f -- "$run_dir/env"
# Nothing of an earlier run (a process that escaped its cleanup, or one a crashed worker never stopped) may see this run's credentials or workspace.
kill_run_members "$run_dir" "" || fail "processes of an earlier run on this Sprite survived SIGKILL"
mapfile -d '' -t manifest < "$run_dir/manifest" || fail "cannot read the manifest"
workdir="$(cat "$run_dir/workdir")"
run_user="$(cat "$run_dir/user")"
outputs=()
declare -A live_boundary=() live_below=()
i=0
count=\${#manifest[@]}
while [ "$i" -lt "$count" ]; do
    kind="\${manifest[$i]}"
    case "$kind" in
        purge)
            dst="\${manifest[$((i + 1))]}"; i=$((i + 2))
            { secure_path "$dst" && rm -rf -- "$dst"; } || fail "cannot remove $dst" ;;
        stamp)
            touch -m -d "@\${manifest[$((i + 2))]}" -- "$run_dir/\${manifest[$((i + 1))]}" || fail "cannot keep the modification time of \${manifest[$((i + 1))]}"
            i=$((i + 3)) ;;
        store)
            src="$run_dir/\${manifest[$((i + 1))]}"; dst="\${manifest[$((i + 2))]}"; i=$((i + 3))
            stores+=("$dst")
            secure_path "$dst" && rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && cp -a -- "$src" "$dst" \\
                && chown -R node:node -- "$dst" && chmod 700 -- "$dst" || fail "cannot install credentials at $dst" ;;
        dir)
            dst="\${manifest[$((i + 1))]}"; i=$((i + 2))
            # An empty directory stands in for the host bind: what an earlier run left there may be a planted symlink.
            secure_path "$dst" && { [ -d "$dst" ] || rm -f -- "$dst"; } && mkdir -p -- "$dst" && chown node:node -- "$dst" || fail "cannot create $dst" ;;
        file)
            src="$run_dir/\${manifest[$((i + 1))]}"; dst="\${manifest[$((i + 2))]}"; mode="\${manifest[$((i + 3))]}"; i=$((i + 4))
            stores+=("$dst")
            secure_path "$dst" && rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && install -m "$mode" -o node -g node -- "$src" "$dst" || fail "cannot install $dst" ;;
        output) outputs+=("\${manifest[$((i + 1))]}" "\${manifest[$((i + 2))]}" "$run_dir/\${manifest[$((i + 3))]}"); i=$((i + 4)) ;;
        live)
            live_boundary["$run_dir/\${manifest[$((i + 3))]}"]="\${manifest[$((i + 1))]}"
            live_below["$run_dir/\${manifest[$((i + 3))]}"]="\${manifest[$((i + 2))]}"
            i=$((i + 4)) ;;
        *) fail "unknown manifest record $kind" ;;
    esac
done
rm -rf -- "$run_dir/store" "$run_dir/files" "${RESULT_DIR}"
secure_path "$workdir" || fail "cannot prepare $workdir"
if [ -f "$run_dir/clone" ]; then rm -rf -- "$workdir"; fi
mkdir -p -- "$workdir" || fail "cannot create $workdir"
[ -f "$run_dir/clone" ] || chown node:node -- "$workdir"
cd "$workdir" || fail "cannot enter $workdir"
if [ "$run_user" = "root" ]; then runner=(env -i); else runner=(su-exec node env -i); fi
input=/dev/null
[ ! -f "$run_dir/stdin" ] || input="$run_dir/stdin"
# Not a process group leader (no job control), so setsid makes the command the leader of a new session without forking.
setsid "\${runner[@]}" "\${envv[@]}" "\${argv[@]}" <"$input" >>"$run_dir/stdout.log" 2>>"$run_dir/stderr.log" &
child=$!
printf '%s\\n' "$child" > "$run_dir/pgid.tmp" && chown "$owner" -- "$run_dir/pgid.tmp" && mv -f -- "$run_dir/pgid.tmp" "$run_dir/pgid"
forward() { kill -s "$1" -- "-$child" 2>/dev/null || kill -s "$1" "$child" 2>/dev/null; }
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP
while :; do
    wait "$child"
    status=$?
    kill -0 "$child" 2>/dev/null || break
done
trap - TERM INT HUP
exported=1
# Nothing the run started outlives it (background jobs, daemons that left the session). A survivor could
# still swap the paths checked below, so nothing is returned (the live copies stay for recovery).
if ! kill_run_members "$run_dir" "$child"; then
    echo "ProPR Sprites runtime: processes of the run survived SIGKILL" >> "$run_dir/stderr.log"
    exported=0
    outputs=()
fi
j=0
while [ "$j" -lt "\${#outputs[@]}" ]; do
    boundary="\${outputs[$j]}"; below="\${outputs[$((j + 1))]}"; ret="\${outputs[$((j + 2))]}"; j=$((j + 3))
    # The entrypoint's live copy, when it made one, is the run's current token: its sync back to the store may never have run (KILL).
    if [ -n "\${live_below[$ret]+set}" ]; then
        plain_file "\${live_boundary[$ret]}" "\${live_below[$ret]}"
        case $? in
            0) boundary="\${live_boundary[$ret]}"; below="\${live_below[$ret]}" ;;
            1) ;; # No live copy: the store's copy is the run's token.
            *)
                exported=0
                echo "ProPR Sprites runtime: not returning the live credential \${live_boundary[$ret]}/\${live_below[$ret]}: a symlink or non-regular file is on its path" >> "$run_dir/stderr.log"
                continue ;;
        esac
    fi
    src="$boundary/$below"
    plain_file "$boundary" "$below"
    case $? in
        0)
            if ! { mkdir -p -- "$(dirname -- "$ret")" && cp -p -- "$src" "$ret" && chmod 600 -- "$ret"; }; then
                exported=0
                echo "ProPR Sprites runtime: cannot return the refreshed credential $src" >> "$run_dir/stderr.log"
            fi ;;
        1) ;; # Deleted by the run: a deletion is never propagated.
        *)
            exported=0
            echo "ProPR Sprites runtime: not returning the credential $src: a symlink or non-regular file is on its path" >> "$run_dir/stderr.log" ;;
    esac
done
if [ -d "$run_dir/returned" ] && ! chown -R "$owner" -- "$run_dir/returned"; then
    exported=0
    echo "ProPR Sprites runtime: cannot hand the returned credentials to the worker" >> "$run_dir/stderr.log"
fi
# The agent user can create the result directory: a symlink there is not followed, nor kept inside it.
if [ -d "${RESULT_DIR}" ] && [ ! -L "${RESULT_DIR}" ]; then
    mkdir -p -- "$run_dir/result" && cp -a -- "${RESULT_DIR}/." "$run_dir/result/" \
        && find "$run_dir/result" -mindepth 1 ! -type f ! -type d -delete && chown -R "$owner" -- "$run_dir/result"
fi
if [ "$exported" = 1 ] && record_export; then
    remove_credentials
else
    echo "ProPR Sprites runtime: kept the run's live credential copies; their return was not confirmed" >> "$run_dir/stderr.log"
fi
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


/**
 * Stops a run: `bash -c <script> propr-signal <TERM|KILL> <run dir>`. TERM goes
 * to the launcher, which forwards it to the run's session. KILL kills every
 * process of the run (session, process group, tagged processes and every
 * process of the agent user), then the
 * launcher if it does not finish within a few seconds, and exits 0 only when
 * none of them is left: the run is verifiably stopped.
 */
export const SPRITES_SIGNAL_SCRIPT = `
run_dir="$2"
${SPRITES_RUN_MEMBERS_FUNCTIONS}
pid="$(cat "$run_dir/pid" 2>/dev/null)"
case "$pid" in ''|*[!0-9]*|0|1) pid="" ;; esac
if [ "$1" != "KILL" ]; then
    [ -z "$pid" ] || kill -s "$1" "$pid" 2>/dev/null
    exit 0
fi
kill_run_members "$run_dir" "$(cat "$run_dir/pgid" 2>/dev/null)"
members=$?
if [ -n "$pid" ]; then
    for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.25; done
    if pid_alive "$pid"; then kill -s KILL "$pid" 2>/dev/null; sleep 0.25; fi
    if pid_alive "$pid"; then echo "the launcher $pid survived SIGKILL" >&2; exit 1; fi
fi
[ "$members" = 0 ] || { echo "processes of the run survived SIGKILL: $(run_members "$run_dir" "$(cat "$run_dir/pgid" 2>/dev/null)" | tr '\\n' ' ')" >&2; exit 1; }
exit 0
`.trim();
