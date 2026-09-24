import { spawn } from 'node:child_process';

// Runs a native Electron probe fixture and returns the single JSON evidence
// line it writes to stdout, wrapping the launch in `xvfb-run` when the resolved
// setup asks for one.
//
// Two properties of the packaging jobs shape this. First, the desktop test
// files run in parallel, so more than one Electron instance — each behind its
// own `xvfb-run --auto-servernum` X server — starts on the same worker at the
// same time. Under that contention the process itself can die before it reaches
// any assertion: the linux-arm64 validation job saw the frame-semantics fixture
// killed by a signal (`xvfb-run` reported 135) with nothing on stderr, while the
// same commit passed on linux-x64 and both macOS targets. A launch that reports
// no evidence answered no question, so it is retried — a fresh `--auto-servernum`
// scan also lands on a different display — and only a run that keeps failing
// fails the test.
//
// Second, the evidence outranks the exit status. A fixture prints its report as
// the last thing it does and then asks Electron to quit, so a crash inside that
// shutdown says nothing about the behaviour under test. A complete report is
// therefore accepted and the odd exit status is recorded as a diagnostic.

// The switches every Linux Electron probe needs. `--disable-dev-shm-usage`
// belongs here with the others: Chromium keeps its shared-memory segments in
// /dev/shm, and a fault on a segment it cannot back there arrives as SIGBUS —
// `xvfb-run` reporting 135 with no message, which is exactly how the
// linux-arm64 fixture died while a second Electron ran beside it. Backing the
// segments with the ordinary temp directory instead removes that failure mode
// and costs nothing on a worker with room to spare.
export const linuxProbeArguments = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

const describeExit = ({ code, signal, timedOut }) => [
  code === null || code === undefined ? String(signal) : String(code),
  ...(timedOut ? ['after exhausting its own budget'] : []),
].join(' ');

// Both streams are quoted, not just stderr. `xvfb-run` runs its child as
// `"$@" 2>&1`, so a crashing Electron's diagnostics land on stdout and stderr
// is empty: the linux-arm64 failure that motivated this runner reported
// nothing whatsoever after its exit code, which is what made it unreadable.
const describeStreams = ({ stderr, stdout }) => [['stderr', stderr], ['stdout', stdout]]
  .map(([stream, value]) => [stream, (value ?? '').trim()])
  .filter(([, value]) => value.length > 0)
  .map(([stream, value]) => `${stream}: ${value.slice(-2_000)}`)
  .join(' | ') || 'both output streams were empty';

const readEvidence = stdout => {
  const line = stdout.trim().split(/\r?\n/u).findLast(candidate => candidate.startsWith('{'));
  if (!line) return { detail: 'reported no evidence' };
  try {
    return { report: JSON.parse(line) };
  } catch (error) {
    return { detail: `reported unparseable evidence (${error.message})` };
  }
};

const spawnFixture = ({ args, command, timeout }) => new Promise(resolveRun => {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  child.once('error', error => {
    clearTimeout(timer);
    resolveRun({ spawnError: error, stderr, stdout, timedOut });
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    resolveRun({ code, signal, stderr, stdout, timedOut });
  });
});

export const runElectronFixture = async ({
  attempts = 2,
  diagnostic,
  electronArguments,
  name,
  runAttempt = spawnFixture,
  setup,
  timeout,
}) => {
  const command = setup.xvfbRun ?? setup.electronExecutable;
  const args = setup.xvfbRun
    ? ['--auto-servernum', setup.electronExecutable, ...electronArguments]
    : electronArguments;
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Attempts are deliberately serial: a concurrent retry would add to the
    // contention that made the first launch fail.
    const outcome = await runAttempt({ args, command, timeout });
    if (outcome.spawnError) {
      failures.push(`attempt ${attempt} could not start (${outcome.spawnError.message})`);
      continue;
    }
    const { detail, report } = readEvidence(outcome.stdout);
    if (!report) {
      failures.push(`attempt ${attempt} exited ${describeExit(outcome)} and ${detail} (${describeStreams(outcome)})`);
      continue;
    }
    if (outcome.code !== 0) {
      diagnostic?.(`${name} reported its evidence, then exited ${describeExit(outcome)}`);
    }
    if (attempt > 1) {
      diagnostic?.(`${name} needed ${attempt} launches on this worker: ${failures.join('; ')}`);
    }
    return report;
  }
  throw new Error(`${name} failed: ${failures.join('; ')}`);
};
