import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDesktopAuthenticationLauncher, type TerminalCandidate } from './authentication-handoff';

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
};

const serverBackedTerminal = (command: string): TerminalCandidate => ({
  command,
  // This fixture has the defining behavior of a server-capable terminal: it
  // admits the child elsewhere, then its launcher exits immediately.
  args: (_title, childCommand, args) => [childCommand, ...args],
});

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path)).length > 0) return;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for controlled authentication fixture');
};

const waitForProcessExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled authentication process was not reaped');
};

const readFixturePid = async (path: string): Promise<number> => {
  const recorded = await readFile(path, 'utf8');
  assert.match(recorded, /^[1-9][0-9]{0,9}$/);
  const pid = Number(recorded);
  assert.ok(Number.isSafeInteger(pid));
  return pid;
};

const fixtureOwnsProcess = async (pid: number, command: string): Promise<boolean> => {
  if (process.platform !== 'linux') return false;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return commandLine.split('\0').includes(command);
  }
  catch {
    return false;
  }
};

const stopFixtureProcess = async (pid: number, command: string): Promise<void> => {
  if (!await fixtureOwnsProcess(pid, command)) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }

  try {
    await waitForProcessExit(pid);
    return;
  }
  catch {
    if (!await fixtureOwnsProcess(pid, command)) return;
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  await waitForProcessExit(pid);
};

const waitForPublishedStatus = (path: string, expected: string): void => {
  const deadline = Date.now() + 2_000;
  const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (Date.now() < deadline) {
    try {
      const status = readFileSync(path, 'utf8');
      if (status.length > 0) {
        assert.equal(status, expected);
        return;
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    Atomics.wait(pause, 0, 0, 10);
  }
  throw new Error('Timed out waiting for the authentication wrapper to publish its result');
};

describe('desktop terminal authentication handoff', () => {
  it('preserves terminal stdin and /dev/tty for an interactive authentication command', { skip: process.platform !== 'linux' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-pty-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const completed = join(directory, 'completed');
    try {
      await writeExecutable(terminal, '#!/bin/sh\nprintf "controlled\\nstandard\\n" | script -qfec "\\"$1\\" \\"$2\\" \\"$3\\"" /dev/null >/dev/null 2>&1\n');
      await writeExecutable(authentication, `#!/bin/sh\n[ -t 0 ] || exit 91\nexec 3</dev/tty || exit 92\n[ -t 3 ] || exit 93\nIFS= read -r controlled <&3 || exit 94\nIFS= read -r standard || exit 95\n[ "$controlled" = controlled ] || exit 96\n[ "$standard" = standard ] || exit 97\nprintf interactive > "${completed}"\n`);

      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      assert.deepEqual(await launch(authentication, [], { title: 'Controlled interactive authentication' }), { status: 0 });
      assert.equal(await readFile(completed, 'utf8'), 'interactive');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for the actual command after a server-capable terminal launcher exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-handoff-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const completed = join(directory, 'completed');
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\nsleep 0.2\nprintf complete > "${completed}"\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      let settled = false;
      const handoff = launch(authentication, [], { title: 'Controlled authentication' })
        .finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(settled, false, 'terminal launcher exit was mistaken for authentication completion');
      assert.deepEqual(await handoff, { status: 0 });
      assert.equal(await readFile(completed, 'utf8'), 'complete');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminates and awaits a terminal that never starts the wrapper before removing runtime state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-start-timeout-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'terminal.pid');
    const readyPath = join(directory, 'terminal.ready');
    const cleanupPath = join(directory, 'terminal.cleanup');
    try {
      await writeExecutable(terminal, `#!/bin/sh
printf '%s' "$$" > "${pidPath}"
wrapper_path=$1
on_term() {
  sleep 0.1
  if [ -x "$wrapper_path" ]; then
    printf preserved > "${cleanupPath}"
  else
    printf removed > "${cleanupPath}"
  fi
  exit 0
}
trap on_term TERM
printf ready > "${readyPath}"
# Keep the fixture responsive when terminal cleanup has to fall back from
# process-group termination to signalling only the owned launcher process. A
# shell defers its TERM trap while waiting for a foreground command, so a
# one-second sleep consumed the entire production grace before on_term's
# intentional delay could prove that runtime state was still present.
while :; do sleep 0.05; done
`);
      await writeExecutable(authentication, '#!/bin/sh\nexit 0\n');
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);

      const handoff = launch(authentication, [], { title: 'Controlled startup timeout' });
      await waitForFile(readyPath);
      assert.deepEqual(await handoff, { status: null });
      const pid = Number(await readFile(pidPath, 'utf8'));
      assert.equal(await readFile(cleanupPath, 'utf8'), 'preserved');
      await waitForProcessExit(pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not signal an already-closed terminal that never starts the wrapper', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-closed-terminal-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'terminal.pid');
    const signalAttempts: Array<{ pid: number; signal: string | number | undefined }> = [];
    const originalKill = process.kill;
    try {
      await writeExecutable(terminal, `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\nexit 23\n`);
      await writeExecutable(authentication, '#!/bin/sh\nexit 0\n');
      process.kill = ((pid: number, signal?: string | number) => {
        signalAttempts.push({ pid, signal });
        return true;
      }) as typeof process.kill;

      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      assert.deepEqual(await launch(authentication, [], { title: 'Controlled closed terminal' }), { status: 23 });
      const terminalPid = Number(await readFile(pidPath, 'utf8'));
      assert.equal(
        signalAttempts.some(attempt => Math.abs(attempt.pid) === terminalPid),
        false,
        'a reaped launcher PID was reused to signal a process or process group',
      );
    } finally {
      process.kill = originalKill;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels and reaps a TERM-resistant command owned by a server-capable terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-cancel-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'authentication.pid');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\ntrap '' TERM INT HUP\nprintf '%s' "$$" > "${pidPath}"\nwhile :; do sleep 1; done\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled authentication', signal: controller.signal });
      await waitForFile(pidPath);
      const pid = Number(await readFile(pidPath, 'utf8'));
      controller.abort();
      await assert.rejects(handoff, error => (error as Error).name === 'AbortError');
      await waitForProcessExit(pid);
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets a published completion win a concurrent cancellation request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-race-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const readyPath = join(directory, 'authentication.ready');
    const triggerPath = join(directory, 'authentication.finish');
    const statePath = join(directory, 'authentication.state');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, `#!/bin/sh
printf '%s' "$2" > "${statePath}"
"$@" >/dev/null 2>&1 &
exit 0
`);
      await writeExecutable(authentication, `#!/bin/sh\nprintf ready > "${readyPath}"\nwhile [ ! -f "${triggerPath}" ]; do sleep 0.01; done\nexit 0\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled completion race', signal: controller.signal });
      await waitForFile(readyPath);
      const stateBase = await readFile(statePath, 'utf8');
      writeFileSync(triggerPath, '', { mode: 0o600 });
      // Keep the handoff's async poll paused until the external wrapper has
      // actually published completion, then request cancellation in that gap.
      waitForPublishedStatus(`${stateBase}.result`, '0\n');
      controller.abort();
      assert.deepEqual(await handoff, { status: 0 });
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rechecks completion published after the initial result read before admitting cancellation', { timeout: 5_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-admission-race-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const statePath = join(directory, 'authentication.state');
    const initialReadCompletedPath = join(directory, 'authentication.initial-read-completed');
    const releaseStartedReadPath = join(directory, 'authentication.release-started-read');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, `#!/bin/sh
state_base=$2
mkfifo "$state_base.started" || exit 91
printf '%s' "$state_base" > "${statePath}"
# Opening the FIFO for writing completes only after the handoff has finished
# its first result read and started awaiting the following started-marker read.
exec 3>"$state_base.started"
printf ready > "${initialReadCompletedPath}"
while [ ! -f "${releaseStartedReadPath}" ]; do sleep 0.01; done
printf 'process:%s\n' "$$" >&3
exec 3>&-
`);
      await writeExecutable(authentication, '#!/bin/sh\nexit 0\n');

      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled cancellation admission race', signal: controller.signal });
      await waitForFile(initialReadCompletedPath);
      const stateBase = await readFile(statePath, 'utf8');

      // Publish completion only after the first result read returned no status,
      // then abort while the started-marker read still blocks admission.
      writeFileSync(`${stateBase}.result`, '0\n', { mode: 0o600 });
      controller.abort();
      writeFileSync(releaseStartedReadPath, '', { mode: 0o600 });

      assert.deepEqual(await handoff, { status: 0 });
    } finally {
      controller.abort();
      await writeFile(releaseStartedReadPath, '', { mode: 0o600 });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains a TERM-resistant command after HUP following admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-hup-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'authentication.pid');
    const admittedPath = join(directory, 'wrapper.command-admitted');
    const terminationObservedPath = join(directory, 'wrapper.termination-observed');
    const releaseHandlerPath = join(directory, 'wrapper.release-handler');
    try {
      await writeExecutable(terminal, `#!/bin/sh
controlled_wrapper="$1.controlled"
awk \\
  -v admitted="${admittedPath}" \\
  -v termination_observed="${terminationObservedPath}" \\
  -v release_handler="${releaseHandlerPath}" '
BEGIN { handler = 0; admission = 0; quote = sprintf("%c", 34) }
{
  if ($0 == "terminate() {") {
    print
    print "  printf ready > " quote termination_observed quote
    handler++
    next
  }
  print
  if (index($0, "admit >") > 0 && index($0, "admission_file") > 0) {
    print "printf ready > " quote admitted quote
    print "while [ ! -f " quote release_handler quote " ]; do sleep 0.01; done"
    admission++
  }
}
END { if (handler != 1 || admission != 1) exit 1 }
' "$1" > "$controlled_wrapper" || exit 91
chmod 700 "$controlled_wrapper" || exit 92
shift
"$controlled_wrapper" "$@" >/dev/null 2>&1 &
wrapper=$!
while [ ! -s "${admittedPath}" ] || [ ! -s "${pidPath}" ]; do sleep 0.01; done
kill -HUP "$wrapper"
while [ ! -s "${terminationObservedPath}" ]; do sleep 0.01; done
printf release > "${releaseHandlerPath}"
wait "$wrapper"
`);
      await writeExecutable(authentication, `#!/bin/sh\ntrap '' TERM INT HUP\nprintf '%s' "$$" > "${pidPath}"\nwhile :; do sleep 1; done\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled terminal close' });
      await waitForFile(pidPath);
      const pid = Number(await readFile(pidPath, 'utf8'));
      assert.deepEqual(await handoff, { status: 137 });
      await waitForProcessExit(pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not execute authentication after HUP between the guard and admission commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-early-hup-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const executedPath = join(directory, 'authentication.executed');
    const guardPassedPath = join(directory, 'wrapper.guard-passed');
    const terminationObservedPath = join(directory, 'wrapper.termination-observed');
    const terminalCompletedPath = join(directory, 'terminal.completed');
    const terminalPidPath = join(directory, 'terminal.pid');
    const controller = new AbortController();
    let terminalPid: number | undefined;
    let terminalReaped = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Add a test-only barrier after the last flag guard and before the
      // signal-handler transition that commits admission.
      await writeExecutable(terminal, `#!/bin/sh
printf '%s' "$$" > "${terminalPidPath}"
wrapper=
cleanup() {
  if [ -n "$wrapper" ]; then
    kill -TERM "$wrapper" 2>/dev/null || true
    wait "$wrapper" 2>/dev/null || true
  fi
}
wait_for_nonempty_file() {
  attempts=0
  while [ ! -s "$1" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 500 ] || return 1
    sleep 0.01
  done
}
trap cleanup 0
trap 'exit 143' HUP INT TERM
controlled_wrapper="$1.controlled"
awk \\
  -v guard_passed="${guardPassedPath}" \\
  -v termination_observed="${terminationObservedPath}" '
BEGIN { guard = 0; rejection = 0; quote = sprintf("%c", 34) }
{
  if ($0 == "reject_before_admission() {") {
    print
    print "  printf ready > " quote termination_observed quote
    rejection++
    next
  }
  print
  if (index($0, "termination_requested") > 0 && index($0, "|| reject_before_admission") > 0) {
    print "printf ready > " quote guard_passed quote
    print "while :; do sleep 0.01; done"
    guard++
  }
}
END { if (guard != 1 || rejection != 1) exit 1 }
' "$1" > "$controlled_wrapper" || exit 91
chmod 700 "$controlled_wrapper" || exit 92
shift
"$controlled_wrapper" "$@" >/dev/null 2>&1 &
wrapper=$!
wait_for_nonempty_file "${guardPassedPath}" || exit 93
kill -HUP "$wrapper" || exit 94
wait_for_nonempty_file "${terminationObservedPath}" || exit 95
wait "$wrapper"
wrapper_status=$?
wrapper=
printf complete > "${terminalCompletedPath}"
exit "$wrapper_status"
`);
      await writeExecutable(authentication, `#!/bin/sh\nprintf executed > "${executedPath}"\n`);

      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      timeout = setTimeout(() => controller.abort(), 3_000);
      const handoff = launch(authentication, [], { title: 'Controlled early terminal close', signal: controller.signal });
      await waitForFile(terminalPidPath);
      terminalPid = await readFixturePid(terminalPidPath);
      assert.deepEqual(await handoff, { status: 1 });
      await waitForFile(terminalCompletedPath);
      await waitForProcessExit(terminalPid);
      terminalReaped = true;
      await assert.rejects(readFile(executedPath), { code: 'ENOENT' });
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      if (terminalPid !== undefined && !terminalReaped) await stopFixtureProcess(terminalPid, terminal);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
