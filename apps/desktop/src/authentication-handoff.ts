import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticationCommandHandoff } from '@propr/cli/desktop-local-setup';

export interface TerminalCandidate {
  command: string;
  args(title: string, command: string, args: string[]): string[];
}

const terminals: TerminalCandidate[] = [
  { command: 'x-terminal-emulator', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
  { command: 'gnome-terminal', args: (title, command, args) => ['--wait', `--title=${title}`, '--', command, ...args] },
  { command: 'konsole', args: (title, command, args) => ['--nofork', '-p', `tabtitle=${title}`, '-e', command, ...args] },
  { command: 'xterm', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
];

const START_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const TERMINAL_STOP_GRACE_MS = 1_000;

// A terminal such as xfce4-terminal can hand the command to an existing server
// and exit before that command finishes. Keep the command lifecycle in this
// wrapper instead of treating the terminal launcher's close event as success.
// Every caller-controlled value remains a positional argv entry; none is
// interpolated into shell source.
const commandWrapper = `#!/bin/sh
set -u
if [ "\${1-}" = --await-admission ]; then
  admission_file=$2
  shift 2
  while [ ! -s "$admission_file" ]; do sleep 0.025; done
  IFS= read -r admission < "$admission_file" || exit 1
  [ "$admission" = admit ] || exit 1
  exec "$@"
fi
state_base=$1
shift
started_file="\${state_base}.started"
result_file="\${state_base}.result"
cancel_file="\${state_base}.cancel"
admission_file="\${state_base}.admission"
umask 077
wrapper=$$
gate_wrapper=$0
termination_requested=0
# Record terminal shutdowns while the child is being spawned and its identity is
# captured. The full handler cannot safely signal until child ownership is known.
trap 'termination_requested=1' HUP INT TERM
if [ -t 0 ]; then
  # Keep the command in the terminal's session so /dev/tty remains its
  # controlling terminal. Starting a new session here preserves the tty file
  # descriptor but makes interactive programs unable to open /dev/tty.
  "$gate_wrapper" --await-admission "$admission_file" "$@" </dev/tty &
  mode=process
elif command -v setsid >/dev/null 2>&1; then
  setsid -- "$gate_wrapper" --await-admission "$admission_file" "$@" &
  mode=group
else
  "$gate_wrapper" --await-admission "$admission_file" "$@" &
  mode=process
fi
child=$!
terminating=0
force_killer=
cancel_watcher=
child_start=
observed_child_parent=
observed_child_start=
load_child_identity() {
  stat_line=
  if [ -r "/proc/$child/stat" ]; then
    IFS= read -r stat_line < "/proc/$child/stat" || return 1
    stat_rest=\${stat_line##*) }
    set -- $stat_rest
    [ "$#" -ge 20 ] || return 1
    observed_child_parent=$2
    shift 19
    observed_child_start=$1
    return 0
  fi
  observed_child_parent=$(ps -o ppid= -p "$child" 2>/dev/null) || return 1
  observed_child_parent=$(printf '%s' "$observed_child_parent" | tr -d '[:space:]')
  observed_child_start=unavailable
}
if load_child_identity && [ "$observed_child_parent" = "$wrapper" ]; then
  child_start=$observed_child_start
fi
child_is_owned() {
  [ -n "$child_start" ] || return 1
  load_child_identity || return 1
  [ "$observed_child_parent" = "$wrapper" ] && [ "$observed_child_start" = "$child_start" ]
}
signal_child() {
  child_is_owned || return 1
  if [ "$mode" = group ]; then
    kill -TERM "-$child" 2>/dev/null
  else
    kill -TERM "$child" 2>/dev/null
  fi
}
force_kill_child() {
  child_is_owned || return 0
  if [ "$mode" = group ]; then
    kill -KILL "-$child" 2>/dev/null || true
  else
    kill -KILL "$child" 2>/dev/null || true
  fi
}
terminate() {
  if [ "$terminating" -ne 0 ]; then
    return
  fi
  terminating=1
  if signal_child; then
    (
      trap 'exit 0' TERM
      trap '' HUP INT
      sleep 1
      force_kill_child
    ) &
    force_killer=$!
  fi
}
reject_before_admission() {
  trap '' HUP INT TERM
  printf '%s\n' reject > "$admission_file"
  wait "$child" 2>/dev/null || true
  printf '%s\n' 1 > "$result_file"
  exit 1
}
# Signals handled before the commit below reject the gated child. This closes
# the check-to-launch gap: authentication cannot execute while this trap owns
# termination, including after the following flag check has completed.
trap reject_before_admission HUP INT TERM
[ "$termination_requested" -eq 0 ] || reject_before_admission
[ -n "$child_start" ] || reject_before_admission

# Admission commits at this signal-handler transition. A signal handled before
# it rejects the gate; a signal handled after it drains the admitted child.
trap terminate HUP INT TERM
printf '%s\n' admit > "$admission_file"
(
  trap 'exit 0' TERM
  trap '' HUP INT
  while [ ! -f "$cancel_file" ]; do sleep 0.025; done
  kill -TERM "$wrapper" 2>/dev/null || true
) &
cancel_watcher=$!
printf '%s:%s\n' "$mode" "$child" > "$started_file"

status=127
while :; do
  wait "$child"
  status=$?
  if ! child_is_owned; then
    break
  fi
done

kill -TERM "$cancel_watcher" 2>/dev/null || true
wait "$cancel_watcher" 2>/dev/null || true
if [ -n "$force_killer" ]; then
  if child_is_owned; then
    wait "$force_killer" 2>/dev/null || true
  else
    kill -TERM "$force_killer" 2>/dev/null || true
    wait "$force_killer" 2>/dev/null || true
  fi
fi
printf '%s\n' "$status" > "$result_file"
exit "$status"
`;

const abortError = (): Error => Object.assign(new Error('Authentication was cancelled.'), { name: 'AbortError' });
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

const stopProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
};

const waitForClose = async (closed: Promise<void>, timeout: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeout);
  });
  const didClose = await Promise.race([closed.then(() => true), timedOut]);
  if (timer) clearTimeout(timer);
  return didClose;
};

const relinquishTerminal = async (
  child: ChildProcess,
  closed: Promise<void>,
  isClosed: () => boolean,
): Promise<void> => {
  // Once the launcher is reaped, its numeric PID no longer proves ownership of
  // either a process or process group and must not be used for signaling.
  if (isClosed()) return;
  stopProcessGroup(child, 'SIGTERM');
  if (await waitForClose(closed, TERMINAL_STOP_GRACE_MS)) return;
  stopProcessGroup(child, 'SIGKILL');
  await closed;
};

const readOwnedMarker = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const hasStartedCommand = (value: string | null): boolean => {
  const match = /^(group|process):([1-9][0-9]{0,9})\n?$/.exec(value ?? '');
  if (!match) return false;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid);
};

const parseStatus = (value: string | null): number | null => {
  if (!/^[0-9]{1,3}\n?$/.test(value ?? '')) return null;
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 0 && status <= 255 ? status : null;
};

const tryTerminal = async (
  terminal: TerminalCandidate,
  command: string,
  args: string[],
  title: string,
  signal?: AbortSignal,
): Promise<number | null | undefined> => {
  signal?.throwIfAborted();
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'propr-desktop-auth-'));
  const wrapperPath = join(runtimeDirectory, 'run-authentication');
  const stateBase = join(runtimeDirectory, 'command');
  const resultPath = `${stateBase}.result`;
  const cancelPath = `${stateBase}.cancel`;
  let terminalChild: ChildProcess | null = null;
  let terminalClosed = false;
  let terminalStatus: number | null = null;
  let terminalAdmitted = false;
  let resolveTerminalClose: () => void = () => undefined;
  const terminalClose = new Promise<void>(resolve => { resolveTerminalClose = resolve; });
  let started = false;
  let completed = false;
  let cancellationWritten = false;
  try {
    await writeFile(wrapperPath, commandWrapper, { mode: 0o700, flag: 'wx' });
    const admission = await new Promise<'spawned' | 'missing'>((resolve, reject) => {
      const child = spawn(terminal.command, terminal.args(title, wrapperPath, [stateBase, command, ...args]), {
        stdio: 'ignore',
        detached: true,
      });
      terminalChild = child;
      child.once('spawn', () => resolve('spawned'));
      child.once('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve('missing');
        else reject(error);
      });
      child.once('close', status => {
        terminalClosed = true;
        terminalStatus = status;
        resolveTerminalClose();
      });
    });
    if (admission === 'missing') return undefined;
    terminalAdmitted = true;

    const startDeadline = Date.now() + START_TIMEOUT_MS;
    while (true) {
      const status = parseStatus(await readOwnedMarker(resultPath));
      if (status !== null) {
        completed = true;
        if (cancellationWritten) throw abortError();
        return status;
      }

      started ||= hasStartedCommand(await readOwnedMarker(`${stateBase}.started`));
      if (signal?.aborted && !cancellationWritten) {
        // The result read above may have completed before the awaited started
        // read. Revalidate at cancellation admission so a completion published
        // in that gap remains the terminal outcome.
        const completedStatus = parseStatus(await readOwnedMarker(resultPath));
        if (completedStatus !== null) {
          completed = true;
          return completedStatus;
        }
        await writeFile(cancelPath, '', { mode: 0o600, flag: 'wx' });
        cancellationWritten = true;
      }
      if (!started && terminalClosed && terminalStatus !== 0) {
        if (signal?.aborted) throw abortError();
        return terminalStatus;
      }
      if (!started && Date.now() >= startDeadline) {
        if (signal?.aborted) throw abortError();
        return terminalStatus === null ? null : terminalStatus || 1;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    if (terminalAdmitted && !completed && terminalChild && !started) {
      await relinquishTerminal(terminalChild, terminalClose, () => terminalClosed);
    }
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
};

/** Build a launcher with injectable candidates for controlled terminal-server lifecycle tests. */
export const createDesktopAuthenticationLauncher = (
  terminalCandidates: readonly TerminalCandidate[] = terminals,
): AuthenticationCommandHandoff => async (command, args, options) => {
  for (const terminal of terminalCandidates) {
    const status = await tryTerminal(terminal, command, args, options.title, options.signal);
    if (status !== undefined) return { status };
  }
  throw new Error('No supported desktop terminal is installed. Install x-terminal-emulator, GNOME Terminal, Konsole, or xterm and retry.');
};

/** Open interactive authentication in a real desktop terminal without blocking Electron's main loop. */
export const launchDesktopAuthentication: AuthenticationCommandHandoff = createDesktopAuthenticationLauncher();
