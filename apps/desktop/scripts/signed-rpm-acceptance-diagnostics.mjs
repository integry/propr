// Bounded, privacy-preserving failure classification for signed RPM acceptance.
// Only fixed phase/stage names, numeric exit statuses, Node signal names and
// spawn error codes are reported. Child output, arguments, environment values,
// paths and key material never enter a message or diagnostic.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export const SIGNED_RPM_ACCEPTANCE_PHASES = Object.freeze([
  'docker-info', 'workspace-setup', 'context-preparation', 'image-build', 'network-create', 'installed-acceptance',
  'evidence-collection', 'evidence-export', 'evidence-write',
  'container-cleanup', 'network-inspect', 'network-cleanup', 'image-cleanup', 'workspace-cleanup',
]);
// Printed by test-signed-installed-rpm.sh on entry to each step inside the container.
export const SIGNED_RPM_CONTAINER_STAGES = Object.freeze([
  'container-preflight', 'key-trust', 'signature-verify', 'package-install', 'installed-verify', 'runtime-manifest',
  'browser-acceptance', 'evidence-export', 'post-verify',
]);
export const SIGNED_RPM_STAGE_MARKER = 'PROPR_RPM_ACCEPTANCE_STAGE=';
const OUTCOMES = new Set(['exit', 'signal', 'timeout', 'spawn', 'interrupted', 'error', 'ownership-refused', 'artifact-changed', 'evidence-invalid']);
const signals = new Set(Object.keys(constants.signals));

const phaseName = phase => SIGNED_RPM_ACCEPTANCE_PHASES.includes(phase) ? phase : 'unknown';
const spawnCode = code => typeof code === 'string' && /^E[A-Z0-9]{1,24}$/.test(code) ? code : 'unknown';

// Rebuild every diagnostic from allowlisted fields so no caller-provided value leaks through.
export const boundedDiagnostic = ({ phase, outcome, exitCode, signal, spawnError, stage }) => {
  const diagnostic = { phase: phaseName(phase), outcome: OUTCOMES.has(outcome) ? outcome : 'error' };
  if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) diagnostic.exitCode = exitCode;
  if (signals.has(signal)) diagnostic.signal = signal;
  if (spawnError !== undefined) diagnostic.spawnError = spawnCode(spawnError);
  if (SIGNED_RPM_CONTAINER_STAGES.includes(stage)) diagnostic.stage = stage;
  return diagnostic;
};

const describe = diagnostic => Object.entries(diagnostic).map(([key, value]) => `${key}=${value}`).join(' ');

export class SignedRpmAcceptanceFailure extends Error {
  constructor(diagnostic, { cleanup = [] } = {}) {
    const primary = boundedDiagnostic(diagnostic);
    const failures = cleanup.map(boundedDiagnostic);
    super(`Signed installed RPM acceptance failed; no success evidence emitted [${describe(primary)}]`
      + (failures.length ? `; owned cleanup also failed [${failures.map(describe).join('; ')}]` : ''));
    this.name = 'SignedRpmAcceptanceFailure';
    this.diagnostic = Object.freeze({ ...primary, ...(failures.length ? { cleanup: Object.freeze(failures) } : {}) });
  }
}

// Unknown errors keep only the phase: their messages can embed paths or child-produced content.
export const classifyFailure = (error, phase) => error instanceof SignedRpmAcceptanceFailure
  ? error.diagnostic : boundedDiagnostic({ phase, outcome: 'error' });

export const inPhase = async (phase, task) => {
  try { return await task(); }
  catch (error) { throw new SignedRpmAcceptanceFailure(classifyFailure(error, phase)); }
};

export const withCleanupFailures = (primary, cleanup) => {
  const { cleanup: earlier = [], ...diagnostic } = classifyFailure(primary, 'unknown');
  return new SignedRpmAcceptanceFailure(diagnostic, { cleanup: [...earlier, ...cleanup] });
};

export const runAcceptancePhase = (file, args, {
  phase, allowFailure = false, timeout = 30 * 60_000, trackStages = false,
} = {}) => new Promise((done, reject) => {
  let settled = false, timedOut = false, interrupted = false, stage, partial = '', overflow = false, stdout = '';
  const fail = details => reject(new SignedRpmAcceptanceFailure({ phase, ...details, stage }));
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout = (stdout + chunk).slice(-65536);
    if (!trackStages) return;
    // Recognize only complete, short marker lines naming an allowlisted stage.
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      const name = !overflow && line.startsWith(SIGNED_RPM_STAGE_MARKER) && line.slice(SIGNED_RPM_STAGE_MARKER.length).trimEnd();
      if (SIGNED_RPM_CONTAINER_STAGES.includes(name)) stage = name;
      overflow = false;
    }
    if (partial.length > 128) { partial = ''; overflow = true; }
  });
  child.stderr.resume();
  const interrupt = () => { interrupted = true; child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  const finish = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    return true;
  };
  child.once('error', error => { if (finish()) fail({ outcome: 'spawn', spawnError: error?.code }); });
  child.once('close', (code, signal) => {
    if (!finish()) return;
    if (interrupted) fail({ outcome: 'interrupted' });
    else if (timedOut) fail({ outcome: 'timeout' });
    else if (code === null) fail({ outcome: 'signal', signal });
    else if (code !== 0 && !allowFailure) fail({ outcome: 'exit', exitCode: code });
    else done({ code, stdout });
  });
});
