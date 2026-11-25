import { repositoryWorkflowExecution } from '../../workflow/workflowExecution.js';
import { envFileValues } from '../credentials/hostCredentialStaging.js';
import { WORKSPACE_AGENT_USER, WORKSPACE_RESULT_PHASE_FILE } from '../../git/workspaceTransportScript.js';
import { AgentRuntimeCapabilityError, restrictedNetworkRefusal, specNetworkRestriction } from './agentRuntimeCapabilityError.js';
import { renderAgentRunCommand } from './dockerRunArgs.js';
import type { FlyCreateMachineRequest, FlyMachineFile } from './flyMachinesApi.js';
import { FLY_CREATION_METADATA_KEY } from './flyMachinesCreation.js';
import { FLY_MACHINES_RUNTIME_KIND, flyMachineGuest, MIN_FLY_RESULT_LINGER_SECONDS, type FlyMachinesConfig } from './flyMachinesConfig.js';
import type { AgentRunSpec } from './types.js';

/**
 * Renders an {@link AgentRunSpec} to a Fly Machine create request. The
 * Machine runs the run's image with its entrypoint chain (repository setup
 * wrapper, clone transport wrapper, provider entrypoint) under a small
 * launcher that:
 *
 * - creates the uploaded directories and hands uploaded paths to the agent user;
 * - enforces the run's mount restrictions (see {@link flyMachineMounts}):
 *   read-only uploads become read-only bind mounts of themselves, and each
 *   declared tmpfs is mounted with its options; a mount that fails, or a
 *   launcher not running as root, refuses the run;
 * - feeds the prompt from an uploaded file (Machines have no stdin);
 * - keeps the agent's exact stdout/stderr in files and mirrors them, line
 *   marked, to the console so the logs API streams them live;
 * - forwards termination signals to the agent, never to a clone transport
 *   wrapper that outlives it to publish the workspace (see `forward()`), and
 *   records the exit status;
 * - then waits, up to the configured linger, for the worker to read the
 *   result files and destroy the Machine (`auto_destroy` removes it if the
 *   worker never does). The linger is never shorter than
 *   {@link MIN_FLY_RESULT_LINGER_SECONDS}, which outlasts the worker's whole
 *   collection, so the Machine holds its result for the worker from its
 *   creation. A run the worker retained (its {@link FLY_RUN_FILES.retain}
 *   marker exists) keeps waiting until the Machine is destroyed. Once the
 *   agent exited, termination signals are ignored: a deadline or `stop()`
 *   that has not yet seen the exit must not end the linger (and let
 *   `auto_destroy` remove the uncollected result); the worker destroys the
 *   Machine through the API instead.
 */

/** Launcher state inside the Machine: root-only, outside the workspace. */
export const FLY_RUN_DIR = '/tmp/propr-fly-run';
export const FLY_RUN_FILES = {
    stdout: `${FLY_RUN_DIR}/stdout`,
    stderr: `${FLY_RUN_DIR}/stderr`,
    exitStatus: `${FLY_RUN_DIR}/exit-status`,
    /** The agent's pid, which is also its process group (it runs in its own session). */
    pid: `${FLY_RUN_DIR}/pid`,
    /** Present once the worker retained the run: the launcher keeps lingering until the Machine is destroyed. */
    retain: `${FLY_RUN_DIR}/retain`,
    stdin: `${FLY_RUN_DIR}/stdin`,
    uploads: `${FLY_RUN_DIR}/uploads`,
    /** Mount restrictions the launcher sets up before the agent starts (read-only uploads, tmpfs). */
    mounts: `${FLY_RUN_DIR}/mounts`,
} as const;

/** Identity the Machine's launcher process is started as. */
export const FLY_LAUNCHER_USER = 'root';

/** Console line prefixes the launcher writes; logs without one are Fly's own (init, health) and are ignored. */
export const FLY_LOG_MARKERS = { stdout: '\u001epropr:o\u001e', stderr: '\u001epropr:e\u001e', exit: '\u001epropr:x\u001e' } as const;

/** User the launcher hands uploaded files to (the image's unprivileged agent user). */
const AGENT_FILE_OWNER = 'node:node';

const LAUNCHER_SCRIPT = `set -u
run_dir=$1; linger=$2; workdir=$3; run_user=$4; no_new_privs=$5; phase_file=$6; shift 6
mark_out=$'${'\\x1e'}propr:o${'\\x1e'}'; mark_err=$'${'\\x1e'}propr:e${'\\x1e'}'; mark_exit=$'${'\\x1e'}propr:x${'\\x1e'}'
mkdir -p -m 700 "$run_dir"
is_root=0; [ "$(id -u)" = 0 ] && is_root=1
if [ -f "$run_dir/uploads" ]; then
  while IFS=$'\\t' read -r kind mode target; do
    [ -n "$target" ] || continue
    if [ "$kind" = d ]; then mkdir -p "$target" && chmod "$mode" "$target"; fi
    if [ "$is_root" = 1 ]; then chown -h ${AGENT_FILE_OWNER} "$target" 2>/dev/null || true; fi
  done < "$run_dir/uploads"
fi
[ -d "$workdir" ] && cd "$workdir"
stdin=/dev/null; [ -f "$run_dir/stdin" ] && stdin=$run_dir/stdin
refused=
case "$run_user" in
  ''|0|0:*|root|root:*) if [ -n "$run_user" ] && [ "$is_root" != 1 ]; then refused="the run must start as root, but the Machine started it as uid $(id -u)"; fi ;;
  *) if [ "$is_root" = 1 ]; then gid=\${run_user#*:}; set -- setpriv --reuid="\${run_user%%:*}" --regid="$gid" --clear-groups -- "$@"; fi ;;
esac
# Mount restrictions, as root before the agent starts: every tmpfs mount point first (one may lie inside a
# read-only upload), then, in order, read-only self-binds and the tmpfs mounts. Any failure refuses the run.
if [ -z "$refused" ] && [ -f "$run_dir/mounts" ]; then
  if [ "$is_root" != 1 ]; then
    refused="the run declares read-only or tmpfs mounts, which only root can set up, but the Machine started it as uid $(id -u)"
  else
    while IFS=$'\\t' read -r kind options target; do
      [ "$kind" = t ] && [ -n "$target" ] && { mkdir -p "$target" || refused="could not create the tmpfs mount point $target"; }
    done < "$run_dir/mounts"
    while [ -z "$refused" ] && IFS=$'\\t' read -r kind options target; do
      [ -n "$target" ] || continue
      case "$kind" in
        r) { mount --bind "$target" "$target" && mount -o remount,bind,ro "$target"; } || refused="could not make $target read-only" ;;
        t) mount -t tmpfs -o "$options" tmpfs "$target" || refused="could not mount a tmpfs at $target" ;;
        *) refused="unknown mount restriction $kind for $target" ;;
      esac
    done < "$run_dir/mounts"
  fi
fi
# Like Docker's no-new-privileges: inherited across exec, so no setuid binary in the run regains privileges.
[ "$no_new_privs" = 1 ] && set -- setpriv --no-new-privs -- "$@"
p=$run_dir/pipe; rm -f "$p".*; : > "$run_dir/stdout"; : > "$run_dir/stderr"
if [ -n "$refused" ]; then
  # The refusal is the run's result: kept like a finished run's (see the linger below).
  trap '' TERM INT HUP
  echo "propr: $refused" >> "$run_dir/stderr"; echo "$mark_err""propr: $refused" >&2; status=126
else
  # Each reader is its own process (no pipelines), so a stuck one can be killed on its own.
  mkfifo -m 600 "$p.out" "$p.out-mark" "$p.err" "$p.err-mark"
  sed -u "s/^/$mark_out/" < "$p.out-mark" & out_mark=$!
  sed -u "s/^/$mark_err/" < "$p.err-mark" >&2 & err_mark=$!
  tee -a "$run_dir/stdout" < "$p.out" > "$p.out-mark" & out_tee=$!
  tee -a "$run_dir/stderr" < "$p.err" > "$p.err-mark" & err_tee=$!
  # Its own session, so a forced stop can kill everything the agent started (process group = pid).
  setsid "$@" < "$stdin" > "$p.out" 2> "$p.err" &
  child=$!
  printf '%s\n' "$child" > "$run_dir/pid"
  # A termination signal (the deadline's, a stop's, Fly's) must not end a clone transport wrapper, which
  # outlives its agent to snapshot and publish the workspace and drops its own forwarding traps once it
  # finalizes. The wrapper is held stopped while its phase file is read, unless
  # a forced stop already holds it. No phase yet (bootstrap, nothing to keep): the wrapper gets the signal.
  # Otherwise its running children get it in its place: the agent, or none once the agent exited. While it
  # finalizes, nothing does.
  forward() {
    local sig=$1 held= line stat
    if [ -z "$phase_file" ]; then kill -s "$sig" "$child" 2>/dev/null; return 0; fi
    if { read -r line < "/proc/$child/stat"; } 2>/dev/null; then
      set -- \${line##*) }
      [ "\${1:-}" = T ] || { kill -s STOP "$child" 2>/dev/null && held=1; }
    fi
    if [ ! -e "$phase_file" ]; then
      kill -s "$sig" "$child" 2>/dev/null
    elif [ "$(cat "$phase_file" 2>/dev/null)" != finalizing ]; then
      for stat in /proc/[0-9]*/stat; do
        { read -r line < "$stat"; } 2>/dev/null || continue
        set -- \${line##*) }
        [ "\${2:-}" = "$child" ] && [ "\${1:-}" != Z ] || continue
        stat=\${stat#/proc/}; kill -s "$sig" "\${stat%/stat}" 2>/dev/null
      done
    fi
    [ -z "$held" ] || kill -s CONT "$child" 2>/dev/null
    return 0
  }
  trap 'forward TERM' TERM
  trap 'forward INT' INT
  trap 'forward HUP' HUP
  while kill -0 "$child" 2>/dev/null; do wait "$child"; done
  wait "$child"; status=$?
  # The run finished: from here on its capture, exit status and result files are kept until the worker
  # destroys the Machine through the API. A termination signal now (a deadline or stop() that has not seen
  # the exit yet, Fly's) has nothing left to stop and must neither cut the output drain short nor end the
  # linger, which would let auto_destroy remove the uncollected result.
  trap '' TERM INT HUP
  # A process the agent left behind may hold the pipes open: drain them for a few seconds only.
  ( sleep 5; kill "$out_tee" "$err_tee" 2>/dev/null ) & reaper=$!
  wait "$out_tee" "$err_tee" "$out_mark" "$err_mark" 2>/dev/null
  kill "$reaper" 2>/dev/null
  rm -f "$p".*
fi
printf '%s\\n' "$status" > "$run_dir/exit-status.tmp" && mv -f "$run_dir/exit-status.tmp" "$run_dir/exit-status"
printf '\\n%s%s\\n' "$mark_exit" "$status"
# The linger ignores termination signals (see above); only its end, or the Machine's destroy, ends it. A
# retained run (the worker may need its result later) lingers until the Machine is destroyed.
sleep "$linger" & sleeper=$!
while :; do
  while kill -0 "$sleeper" 2>/dev/null; do wait "$sleeper"; done
  [ -f "$run_dir/retain" ] || break
  sleep 3600 & sleeper=$!
done
exit "$status"
`;

/**
 * Forced stop of a timed-out run, executed in the Machine (as root) as
 * `sh -c <script> sh <pid file> <wrapper phase file or ''> <agent user>`. The
 * recorded pid leads the run's session. An agent process can leave that
 * session (`setsid`), so session membership alone does not find everything
 * the agent started: every process running as the agent user (any of its
 * real, effective or saved user IDs) is the agent's too, since the Machine
 * runs nothing else under that identity. The launcher, which holds the
 * output pipes, is always spared; when it runs as the agent user itself the
 * user cannot tell the agent apart, and only the session is used.
 *
 * Without a phase file (no clone transport) or before the wrapper started the
 * agent, the whole process group and every agent-user process are killed. A
 * clone transport wrapper leads the session and must outlive its agent to
 * snapshot and publish the workspace, so it is held stopped while its phase
 * is read (it cannot start finalizing meanwhile) and then:
 *
 * - `agent`: every other process in the session and every agent-user process
 *   is killed, rescanning until none is left running; the wrapper then sees
 *   its agent exit and finalizes. Prints `killed`. Should one survive, the
 *   wrapper is killed too (nothing is published while an agent process may
 *   still change the checkout) and the script fails.
 * - `finalizing`: the agent already exited; nothing is killed. Prints `finalizing`.
 *
 * A fourth argument replaces `/proc` (tests only).
 */
export const FLY_FORCED_STOP_SCRIPT = `pid=$(cat "$1") || exit 1
phase_file=\${2:-}; agent_user=\${3:-}; proc_root=\${4:-/proc}; self=$$
agent_uid=
case "$agent_user" in
  '') ;;
  *[!0-9]*) agent_uid=$(id -u "$agent_user" 2>/dev/null) || agent_uid= ;;
  *) agent_uid=$agent_user ;;
esac
[ "$agent_uid" = 0 ] && agent_uid=
launcher=
if line=$(cat "$proc_root/$pid/stat" 2>/dev/null); then set -- \${line##*) }; launcher=\${2:-}; fi
runs_as_agent() {
  [ -n "$agent_uid" ] || return 1
  uids=$(grep '^Uid:' "$proc_root/$1/status" 2>/dev/null) || return 1
  for uid in $uids; do [ "$uid" = "$agent_uid" ] && return 0; done
  return 1
}
# The launcher's readers run as the launcher: the agent user is no criterion when that is the launcher's own.
[ -n "$launcher" ] && runs_as_agent "$launcher" && agent_uid=
# One pass: KILL each running agent process (the leader too unless $1 = spare); succeeds when none was found.
sweep() {
  spare=$1; found=0
  for stat in "$proc_root"/[0-9]*/stat; do
    proc=\${stat#"$proc_root"/}; proc=\${proc%/stat}
    [ "$proc" = "$self" ] || [ "$proc" = "$launcher" ] && continue
    [ "$proc" = "$pid" ] && [ "$spare" = spare ] && continue
    line=$(cat "$stat" 2>/dev/null) || continue
    set -- \${line##*) }
    [ "\${1:-}" = Z ] && continue
    if [ "\${4:-}" = "$pid" ] || runs_as_agent "$proc"; then kill -s KILL "$proc" 2>/dev/null && found=1; fi
  done
  [ "$found" = 0 ]
}
# Rescans until nothing is left running (a dying process stays listed until it is a zombie).
kill_agent() {
  passes=0
  while [ "$passes" -lt 20 ]; do
    sweep "$1" && return 0
    passes=$((passes + 1))
    [ "$passes" -lt 3 ] || sleep 0.1 2>/dev/null || sleep 1
  done
  echo "agent processes survived the forced stop" >&2
  return 1
}
if [ -n "$phase_file" ] && kill -s STOP "$pid" 2>/dev/null; then
  trap 'kill -s CONT "$pid" 2>/dev/null' EXIT
  phase=$(cat "$phase_file" 2>/dev/null)
  case "$phase" in
    agent)
      if kill_agent spare; then echo killed; exit 0; fi
      trap - EXIT
      kill -s KILL -- "-$pid" 2>/dev/null; kill -s KILL "$pid" 2>/dev/null
      exit 1 ;;
    finalizing) echo finalizing; exit 0 ;;
  esac
  kill -s CONT "$pid" 2>/dev/null
  trap - EXIT
fi
status=0
kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" || status=1
kill_agent all || status=1
exit "$status"
`;

/**
 * The forced-stop command (see {@link FLY_FORCED_STOP_SCRIPT}) for a run: a
 * clone run's agent runs as {@link WORKSPACE_AGENT_USER}; any other run's as
 * its `user` when that is not root, else as {@link WORKSPACE_AGENT_USER} too
 * (ProPR provider entrypoints drop to it).
 */
export function flyForcedStopCommand(spec: AgentRunSpec): string[] {
    const runUser = spec.user?.split(':')[0]?.trim();
    const agentUser = !spec.workspace.clone?.resultDir && runUser && runUser !== '0' && runUser !== 'root' ? runUser : WORKSPACE_AGENT_USER;
    return ['/bin/sh', '-c', FLY_FORCED_STOP_SCRIPT, 'sh', FLY_RUN_FILES.pid, flyClonePhaseFile(spec), agentUser];
}

/** Where a clone run's transport wrapper records its phase; '' for a run without one. */
export function flyClonePhaseFile(spec: AgentRunSpec): string {
    const resultDir = spec.workspace.clone?.resultDir;
    return resultDir ? `${resultDir.replace(/\/+$/, '')}/${WORKSPACE_RESULT_PHASE_FILE}` : '';
}

export interface FlyMachineLaunchInput {
    config: Pick<FlyMachinesConfig, 'region' | 'size' | 'memoryMb' | 'image' | 'resultLingerSeconds'>;
    /** Environment `-e NAME` (no value) and bare env-file names inherit from: the launch environment. */
    launchEnvironment: Record<string, string | undefined>;
    /** The prompt, delivered as a file the launcher feeds to the agent's stdin. */
    stdinData?: string;
    /** The run's unique creation id, kept in the Machine's metadata so a create whose response was lost can be found. */
    creationId?: string;
}

function assertGuestPath(path: string): void {
    if (!path.startsWith('/') || /[\t\n\r\0]/.test(path) || path.split('/').includes('..')) {
        throw new Error(`Cannot upload to ${JSON.stringify(path)}: not an absolute path without control characters or "..".`);
    }
}

/** Variables as Docker resolves them: env files in order, then `-e` (repository setup first), bare names from the launch environment. */
export function flyMachineEnvironment(spec: AgentRunSpec, launchEnvironment: Record<string, string | undefined>): Record<string, string> {
    const environment = new Map<string, string>();
    for (const file of [...spec.envFiles].sort((left, right) => left.order - right.order)) {
        // Docker would refuse an unreadable env file; the Machine receives the values instead, so fail here.
        for (const [name, value] of envFileValues(file.path, launchEnvironment, { required: true })) environment.set(name, value);
    }
    for (const variable of [...(spec.repoSetup?.env ?? []), ...[...spec.env].sort((left, right) => left.order - right.order)]) {
        const value = variable.value ?? launchEnvironment[variable.name];
        if (value === undefined) environment.delete(variable.name);
        else environment.set(variable.name, value);
    }
    return Object.fromEntries(environment);
}

/** A Machine name derived from the run name: lowercase letters, digits and dashes, at most 63 characters. */
export function flyMachineName(runName: string): string {
    const normalized = runName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let start = 0;
    let end = Math.min(normalized.length, 63);
    while (start < end && normalized[start] === '-') start++;
    while (end > start && normalized[end - 1] === '-') end--;
    return normalized.slice(start, end) || 'propr-run';
}

function metadata(spec: AgentRunSpec, creationId: string | undefined): Record<string, string> {
    const entries = Object.entries(spec.labels).map(([key, value]) => [key.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63), value.slice(0, 256)]);
    // Last, so no label can replace the creation id the handle finds the Machine by.
    const creation = creationId ? [[FLY_CREATION_METADATA_KEY, creationId]] : [];
    return Object.fromEntries([...entries, ['propr_run', spec.name.slice(0, 256)], ['propr_agent', spec.profile.agentType], ...creation]);
}

/** Inside `ancestor` (or `ancestor` itself). */
function within(target: string, ancestor: string): boolean {
    const root = ancestor.replace(/\/+$/, '');
    return target === ancestor || target === root || target.startsWith(`${root}/`);
}

/** Linux tmpfs mount options a Docker `--tmpfs` spec may carry; anything else (e.g. Docker's `tmpcopyup`) cannot be honoured. */
const TMPFS_OPTION = /^(?:rw|ro|nosuid|suid|nodev|dev|noexec|exec|sync|async|dirsync|atime|noatime|diratime|nodiratime|relatime|norelatime|strictatime|nostrictatime|lazytime|nolazytime|(?:size|nr_blocks|nr_inodes)=\d+[kKmMgG%]?|mode=[0-7]{3,4}|[ug]id=\d+)$/;
/** Docker's defaults for a `--tmpfs` mount; the spec's own options follow and override them. */
const DOCKER_TMPFS_DEFAULTS = 'noexec,nosuid,nodev';

/**
 * The launcher's mount restrictions (`kind\toptions\ttarget` lines), or
 * throws for one the Machine cannot enforce as declared:
 *
 * - each outermost read-only upload becomes a read-only bind of itself; a
 *   writable upload inside one, or the launcher's run directory, could not
 *   stay writable and refuses the run;
 * - each tmpfs is mounted (memory-backed, as in Docker) with Docker's defaults
 *   and its own options; options Linux tmpfs does not take, an upload it
 *   would hide, or a mount over the run directory refuse the run.
 */
export function flyMachineMounts(spec: AgentRunSpec): string[] {
    const refuse = (what: string): never => { throw new Error(`Agent run ${spec.name} ${what}, which Fly Machines cannot enforce`); };
    const uploads = spec.files ?? [];
    const readOnly = uploads.filter(upload => upload.readOnly).map(upload => upload.path);
    const roots = readOnly.filter(target => !readOnly.some(other => other !== target && within(target, other)));
    const lines: string[] = [];
    for (const root of [...new Set(roots)]) {
        assertGuestPath(root);
        if (within(FLY_RUN_DIR, root)) refuse(`mounts ${root} read-only over the launcher's run directory`);
        const writable = uploads.find(upload => !upload.readOnly && within(upload.path, root));
        if (writable) refuse(`uploads writable ${writable.path} inside read-only ${root}`);
        lines.push(`r\t-\t${root}`);
    }
    const tmpfs = spec.mounts.flatMap(mount => (mount.type === 'tmpfs' ? [mount] : [])).sort((left, right) => left.order - right.order);
    for (const mount of tmpfs) {
        assertGuestPath(mount.target);
        const options = mount.options.split(',').map(option => option.trim()).filter(Boolean);
        const unsupported = options.find(option => !TMPFS_OPTION.test(option));
        if (unsupported !== undefined) refuse(`requires tmpfs option ${JSON.stringify(unsupported)} at ${mount.target}`);
        if (within(FLY_RUN_DIR, mount.target)) refuse(`mounts a tmpfs at ${mount.target} over the launcher's run directory`);
        // The tmpfs would hide them, unlike Docker, which mounts a bind declared after it on top.
        const hidden = uploads.find(upload => within(upload.path, mount.target) && !(upload.type === 'directory' && upload.path === mount.target));
        if (hidden) refuse(`uploads ${hidden.path} under its tmpfs at ${mount.target}`);
        lines.push(`t\t${[DOCKER_TMPFS_DEFAULTS, ...options].join(',')}\t${mount.target}`);
    }
    return lines;
}

function machineFiles(spec: AgentRunSpec, stdinData: string | undefined): FlyMachineFile[] {
    const uploads = spec.files ?? [];
    const files: FlyMachineFile[] = [];
    const manifest: string[] = [];
    for (const upload of uploads) {
        assertGuestPath(upload.path);
        const mode = (upload.mode & 0o7777).toString(8).padStart(4, '0');
        manifest.push(`${upload.type === 'directory' ? 'd' : 'f'}\t${mode}\t${upload.path}`);
        if (upload.type === 'file') files.push({ guest_path: upload.path, raw_value: (upload.content ?? Buffer.alloc(0)).toString('base64'), mode: upload.mode & 0o7777 });
    }
    if (manifest.length > 0) files.push({ guest_path: FLY_RUN_FILES.uploads, raw_value: Buffer.from(`${manifest.join('\n')}\n`).toString('base64'), mode: 0o600 });
    const mounts = flyMachineMounts(spec);
    if (mounts.length > 0) files.push({ guest_path: FLY_RUN_FILES.mounts, raw_value: Buffer.from(`${mounts.join('\n')}\n`).toString('base64'), mode: 0o600 });
    if (spec.stdin && stdinData !== undefined) files.push({ guest_path: FLY_RUN_FILES.stdin, raw_value: Buffer.from(stdinData).toString('base64'), mode: 0o600 });
    return files;
}

/** Security options that only relax Docker's default confinement, which a Machine (a VM, no seccomp or AppArmor profile) does not apply. */
const RELAXING_SECURITY_OPTS = /^(?:seccomp|apparmor)[=:]unconfined$/;
const NO_NEW_PRIVILEGES_OPT = /^no-new-privileges(?:[=:]true)?$/;

/**
 * Refuses restrictions the Machine cannot enforce. Enforced: no-new-privileges
 * (the launcher runs the agent under `setpriv --no-new-privs`). Added
 * capabilities need nothing: the Machine starts the run as root with every
 * capability. A read-only root filesystem, dropped capabilities and any other
 * security option are not implemented and fail the launch.
 */
function flyMachineNoNewPrivileges(spec: AgentRunSpec): boolean {
    const { security } = spec;
    const refuse = (what: string): never => { throw new Error(`Agent run ${spec.name} requires ${what}, which Fly Machines cannot enforce`); };
    if (security.readOnlyRootFilesystem) refuse('a read-only root filesystem');
    if (security.capDrop.length > 0) refuse(`dropped capabilities (${security.capDrop.join(', ')})`);
    let noNewPrivileges = security.noNewPrivileges;
    for (const option of security.securityOpts) {
        if (NO_NEW_PRIVILEGES_OPT.test(option)) noNewPrivileges = true;
        else if (!RELAXING_SECURITY_OPTS.test(option)) refuse(`security option ${JSON.stringify(option)}`);
    }
    return noNewPrivileges;
}

/**
 * A Machine has no outbound allowlist: refuses (with the registry's typed
 * error) a run whose network is restricted by its spec (its restriction or
 * a restricted neutral policy) or by `applicable`, the policy applying at
 * launch. The runtime checks both before it creates a Machine, so a caller
 * using it directly, without the registry's capability check, is refused too.
 */
export function assertFlyNetworkUnrestricted(spec: AgentRunSpec, applicable?: { source?: string }): void {
    const restricted = specNetworkRestriction(spec) ?? applicable;
    if (!restricted) return;
    const refusal = restrictedNetworkRefusal({ kind: FLY_MACHINES_RUNTIME_KIND, capabilities: { supportsRestrictedNetwork: false } }, restricted.source);
    throw new AgentRuntimeCapabilityError(`${refusal} (run ${spec.name})`, FLY_MACHINES_RUNTIME_KIND, 'restricted_network');
}

/**
 * The create request for one run. Throws for a spec the Machine cannot run
 * as declared: a restricted network, no explicit entrypoint (the image's own
 * cannot be chained), a remaining bind mount (the upload step converts every
 * bind it can), a security or mount restriction it cannot enforce, or an
 * unreadable env file.
 */
export function renderFlyMachineRequest(spec: AgentRunSpec, input: FlyMachineLaunchInput): FlyCreateMachineRequest {
    assertFlyNetworkUnrestricted(spec);
    const bind = spec.mounts.find(mount => mount.type === 'bind');
    if (bind) throw new Error(`Agent run ${spec.name} still bind-mounts ${bind.target}; Fly Machines receive files only`);
    const { entrypoint, args } = renderAgentRunCommand(spec);
    if (!entrypoint) throw new Error(`Agent run ${spec.name} needs an explicit entrypoint or repository setup wrapper to run on Fly Machines`);
    const environment = flyMachineEnvironment(spec, input.launchEnvironment);
    const workflow = repositoryWorkflowExecution.getStore();
    const requiresMarkers = spec.repoSetup?.requiresWorkflowMarkers || (workflow && args.some(arg => arg.includes(workflow.marker)));
    if (requiresMarkers && environment.PROPR_REPO_SETUP !== '0') {
        throw new AgentRuntimeCapabilityError('Fly Machines cannot capture repository workflow markers. Choose a runtime that supports workflow markers (docker).', FLY_MACHINES_RUNTIME_KIND, 'workflow_markers');
    }
    const noNewPrivileges = flyMachineNoNewPrivileges(spec);
    const { config } = input;
    const launcher = {
        entrypoint: ['/bin/bash', '-c', LAUNCHER_SCRIPT, 'propr-fly-run'],
        // Never below the minimum, however the config was built: the worker cannot extend the linger once it runs.
        cmd: [
            FLY_RUN_DIR, String(Math.max(config.resultLingerSeconds, MIN_FLY_RESULT_LINGER_SECONDS)), spec.workdir, spec.user ?? '',
            noNewPrivileges ? '1' : '0', flyClonePhaseFile(spec), entrypoint, ...args,
        ],
    };
    return {
        name: flyMachineName(spec.name),
        ...(config.region ? { region: config.region } : {}),
        skip_service_registration: true,
        config: {
            image: config.image ?? spec.profile.image,
            init: launcher,
            // The launcher must start as root (it mounts, then drops to spec.user), but Fly starts
            // the image's USER (`node` for ProPR images) unless a process overrides it. A process
            // with only `user` would run the image's default command, so it repeats the launcher.
            processes: [{ user: FLY_LAUNCHER_USER, entrypoint: [...launcher.entrypoint], cmd: [...launcher.cmd] }],
            env: environment,
            guest: flyMachineGuest(config, spec.resources),
            files: machineFiles(spec, input.stdinData),
            metadata: metadata(spec, input.creationId),
            // One Machine per run: never restarted, removed once it exits.
            auto_destroy: true,
            restart: { policy: 'no' },
        },
    };
}

/** A live log line, classified by the launcher's marker; undefined for Fly's own lines. */
export function parseFlyLogLine(message: string): { stream: 'stdout' | 'stderr'; text: string } | { exitCode: number } | undefined {
    const line = message.replace(/\r?\n$/, '');
    if (line.startsWith(FLY_LOG_MARKERS.stdout)) return { stream: 'stdout', text: `${line.slice(FLY_LOG_MARKERS.stdout.length)}\n` };
    if (line.startsWith(FLY_LOG_MARKERS.stderr)) return { stream: 'stderr', text: `${line.slice(FLY_LOG_MARKERS.stderr.length)}\n` };
    if (line.startsWith(FLY_LOG_MARKERS.exit)) {
        const code = Number(line.slice(FLY_LOG_MARKERS.exit.length).trim());
        return Number.isInteger(code) ? { exitCode: code } : undefined;
    }
    return undefined;
}
