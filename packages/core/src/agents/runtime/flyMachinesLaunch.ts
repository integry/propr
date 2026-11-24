import { envFileValues } from '../credentials/hostCredentialStaging.js';
import { renderAgentRunCommand } from './dockerRunArgs.js';
import type { FlyCreateMachineRequest, FlyMachineFile } from './flyMachinesApi.js';
import { flyMachineGuest, type FlyMachinesConfig } from './flyMachinesConfig.js';
import type { AgentRunSpec } from './types.js';

/**
 * Renders an {@link AgentRunSpec} to a Fly Machine create request. The
 * Machine runs the run's image with its entrypoint chain (repository setup
 * wrapper, clone transport wrapper, provider entrypoint) under a small
 * launcher that:
 *
 * - creates the uploaded directories and hands uploaded paths to the agent user;
 * - feeds the prompt from an uploaded file (Machines have no stdin);
 * - keeps the agent's exact stdout/stderr in files and mirrors them, line
 *   marked, to the console so the logs API streams them live;
 * - forwards termination signals to the agent and records its exit status;
 * - then waits, up to the configured linger, for the worker to read the
 *   result files and destroy the Machine (`auto_destroy` removes it if the
 *   worker never does). A run the worker retained (its {@link FLY_RUN_FILES.retain}
 *   marker exists) keeps waiting until the Machine is destroyed.
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
} as const;

/** Console line prefixes the launcher writes; logs without one are Fly's own (init, health) and are ignored. */
export const FLY_LOG_MARKERS = { stdout: '\u001epropr:o\u001e', stderr: '\u001epropr:e\u001e', exit: '\u001epropr:x\u001e' } as const;

/** User the launcher hands uploaded files to (the image's unprivileged agent user). */
const AGENT_FILE_OWNER = 'node:node';

const LAUNCHER_SCRIPT = `set -u
run_dir=$1; linger=$2; workdir=$3; run_user=$4; no_new_privs=$5; shift 5
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
# Like Docker's no-new-privileges: inherited across exec, so no setuid binary in the run regains privileges.
[ "$no_new_privs" = 1 ] && set -- setpriv --no-new-privs -- "$@"
p=$run_dir/pipe; rm -f "$p".*; : > "$run_dir/stdout"; : > "$run_dir/stderr"
if [ -n "$refused" ]; then
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
  trap 'kill -s TERM "$child" 2>/dev/null' TERM
  trap 'kill -s INT "$child" 2>/dev/null' INT
  trap 'kill -s HUP "$child" 2>/dev/null' HUP
  while kill -0 "$child" 2>/dev/null; do wait "$child"; done
  wait "$child"; status=$?
  # A process the agent left behind may hold the pipes open: drain them for a few seconds only.
  ( sleep 5; kill "$out_tee" "$err_tee" 2>/dev/null ) & reaper=$!
  wait "$out_tee" "$err_tee" "$out_mark" "$err_mark" 2>/dev/null
  kill "$reaper" 2>/dev/null
  rm -f "$p".*
fi
printf '%s\\n' "$status" > "$run_dir/exit-status.tmp" && mv -f "$run_dir/exit-status.tmp" "$run_dir/exit-status"
printf '\\n%s%s\\n' "$mark_exit" "$status"
# A retained run (the worker may need its result later) lingers until the Machine is destroyed.
stopping=
sleep "$linger" & sleeper=$!
trap 'stopping=1; kill "$sleeper" 2>/dev/null' TERM INT HUP
while :; do
  wait "$sleeper"
  [ -z "$stopping" ] && [ -f "$run_dir/retain" ] || break
  sleep 3600 & sleeper=$!
done
exit "$status"
`;

/**
 * Forced stop of a timed-out run, executed in the Machine as
 * `sh -c <script> sh <pid file> [<wrapper phase file>]`. The recorded pid
 * leads the run's session. Without a phase file (no clone transport) or
 * before the wrapper started the agent, the whole process group is killed.
 * A clone transport wrapper leads the session and must outlive its agent to
 * snapshot and publish the workspace, so it is held stopped while its phase
 * is read (it cannot start finalizing meanwhile) and then:
 *
 * - `agent`: every other process in the session (the agent, its children and
 *   whatever it left behind) is killed; the wrapper then sees its agent exit
 *   and finalizes. Prints `killed`.
 * - `finalizing`: the agent already exited; nothing is killed. Prints `finalizing`.
 */
export const FLY_FORCED_STOP_SCRIPT = `pid=$(cat "$1") || exit 1
phase_file=\${2:-}
kill_session_except_leader() {
  for pass in 1 2 3; do
    for stat in /proc/[0-9]*/stat; do
      proc=\${stat#/proc/}; proc=\${proc%/stat}
      [ "$proc" = "$pid" ] && continue
      line=$(cat "$stat" 2>/dev/null) || continue
      set -- \${line##*) }
      [ "\${4:-}" = "$pid" ] && kill -s KILL "$proc" 2>/dev/null
    done
  done
  return 0
}
if [ -n "$phase_file" ] && kill -s STOP "$pid" 2>/dev/null; then
  trap 'kill -s CONT "$pid" 2>/dev/null' EXIT
  phase=$(cat "$phase_file" 2>/dev/null)
  case "$phase" in
    agent) kill_session_except_leader; echo killed; exit 0 ;;
    finalizing) echo finalizing; exit 0 ;;
  esac
  kill -s CONT "$pid" 2>/dev/null
  trap - EXIT
fi
kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid"
`;

export interface FlyMachineLaunchInput {
    config: Pick<FlyMachinesConfig, 'region' | 'size' | 'memoryMb' | 'image' | 'resultLingerSeconds'>;
    /** Environment `-e NAME` (no value) and bare env-file names inherit from: the launch environment. */
    launchEnvironment: Record<string, string | undefined>;
    /** The prompt, delivered as a file the launcher feeds to the agent's stdin. */
    stdinData?: string;
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

function metadata(spec: AgentRunSpec): Record<string, string> {
    const entries = Object.entries(spec.labels).map(([key, value]) => [key.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63), value.slice(0, 256)]);
    return Object.fromEntries([...entries, ['propr_run', spec.name.slice(0, 256)], ['propr_agent', spec.profile.agentType]]);
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
 * The create request for one run. Throws for a spec the Machine cannot run
 * as declared: no explicit entrypoint (the image's own cannot be chained), a
 * remaining bind mount (the upload step converts every bind it can), a
 * security restriction it cannot enforce, or an unreadable env file.
 */
export function renderFlyMachineRequest(spec: AgentRunSpec, input: FlyMachineLaunchInput): FlyCreateMachineRequest {
    const bind = spec.mounts.find(mount => mount.type === 'bind');
    if (bind) throw new Error(`Agent run ${spec.name} still bind-mounts ${bind.target}; Fly Machines receive files only`);
    const { entrypoint, args } = renderAgentRunCommand(spec);
    if (!entrypoint) throw new Error(`Agent run ${spec.name} needs an explicit entrypoint or repository setup wrapper to run on Fly Machines`);
    const noNewPrivileges = flyMachineNoNewPrivileges(spec);
    const { config } = input;
    return {
        name: flyMachineName(spec.name),
        ...(config.region ? { region: config.region } : {}),
        skip_service_registration: true,
        config: {
            image: config.image ?? spec.profile.image,
            init: {
                entrypoint: ['/bin/bash', '-c', LAUNCHER_SCRIPT, 'propr-fly-run'],
                cmd: [FLY_RUN_DIR, String(config.resultLingerSeconds), spec.workdir, spec.user ?? '', noNewPrivileges ? '1' : '0', entrypoint, ...args],
            },
            env: flyMachineEnvironment(spec, input.launchEnvironment),
            guest: flyMachineGuest(config, spec.resources),
            files: machineFiles(spec, input.stdinData),
            metadata: metadata(spec),
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
