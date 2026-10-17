import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstalledLinuxAcceptanceArtifact, cleanupOwnedContainer } from './run-installed-linux-package-acceptance.mjs';
import { prepareSignedRpmAcceptanceContext } from './signed-rpm-acceptance-context.mjs';
import { requireRpmIdentity, verifyRpm } from './rpm-signing.mjs';
import { SIGNED_RPM_ACCEPTANCE_CHECKS, validateSignedRpmAcceptanceEvidence } from './signed-rpm-acceptance-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// Keep subprocess diagnostics bounded and private: only fixed failure categories reach CI logs.
const run = (file, args, { allowFailure = false, timeout = 30 * 60_000 } = {}) => new Promise((done, reject) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', () => {});
  let interrupted = false;
  const interrupt = () => { interrupted = true; child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const finish = () => { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.once('error', error => { finish(); reject(error); });
  child.once('close', code => {
    finish();
    if (interrupted) { reject(new Error('Signed installed RPM acceptance interrupted')); return; }
    if (code !== 0 && !allowFailure) reject(new Error('Signed installed RPM acceptance subprocess failed; no success evidence emitted'));
    else done({ code, stdout });
  });
});

export const runSignedInstalledRpmAcceptance = async ({ rpm, sourceRevision, signingRunId, identity, outputDirectory }) => {
  if (process.platform !== 'linux' || process.arch !== 'x64'
    || process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE !== '1') {
    throw new Error('Signed RPM acceptance requires native Linux x64 and explicit disposable-container opt-in');
  }
  requireRpmIdentity(identity);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || !/^[1-9][0-9]*$/.test(signingRunId)) throw new Error('Invalid signed RPM acceptance identity');
  rpm = resolve(rpm);
  await assertInstalledLinuxAcceptanceArtifact(rpm);
  const daemon = await run('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { timeout: 30_000 });
  if (!['linux/amd64', 'linux/x86_64'].includes(daemon.stdout.trim())) throw new Error('Signed RPM acceptance requires a native x64 Docker daemon');
  await verifyRpm({ path: rpm, identity });
  const artifactDigest = async () => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(rpm)) hash.update(chunk);
    return hash.digest('hex');
  };
  const rpmSha256 = await artifactDigest();
  const directory = await mkdtemp(join(tmpdir(), 'propr-signed-rpm-'));
  const id = randomBytes(8).toString('hex');
  const name = `propr-signed-rpm-${id}`;
  const image = `propr-signed-rpm-acceptance:${id}`;
  const network = `propr-signed-rpm-network-${id}`;
  const invocation = { name, label: `dev.propr.acceptance=${id}` };
  let evidence;
  try {
    await writeFile(join(directory, 'public.asc'), identity.publicKey, { mode: 0o600 });
    await mkdir(join(directory, 'evidence'), { mode: 0o700 });
    // Send only the allowlisted context; see signed-rpm-acceptance-context.mjs.
    const context = join(directory, 'context');
    await prepareSignedRpmAcceptanceContext({ root, context });
    await run('docker', ['build', '--platform=linux/amd64', '--tag', image, '--file', join(context, 'apps/desktop/scripts/signed-rpm-acceptance.Dockerfile'), context]);
    // Chromium needs an active interface for navigator.onLine, even though all
    // fixtures use loopback. An internal bridge provides it without external egress.
    await run('docker', ['network', 'create', '--driver=bridge', '--internal', '--label', invocation.label, network]);
    await run('docker', ['run', '--rm', '--init', '--platform=linux/amd64', '--network', network, '--shm-size=1g', '--cap-add=SYS_ADMIN', '--cap-add=IPC_LOCK',
      '--name', name, '--label', invocation.label,
      '--mount', `type=bind,src=${rpm},dst=/input/preview.rpm,readonly`,
      '--mount', `type=bind,src=${join(directory, 'public.asc')},dst=/input/public.asc,readonly`,
      '--mount', `type=bind,src=${join(directory, 'evidence')},dst=/evidence`,
      '--env', `PROPR_RPM_HOST_UID=${process.getuid()}`, '--env', `PROPR_RPM_HOST_GID=${process.getgid()}`,
      '--env', `PROPR_RPM_SHA256=${rpmSha256}`, '--env', `PROPR_RPM_FINGERPRINT=${identity.fingerprint}`, '--env', `PROPR_RPM_SOURCE_SHA=${sourceRevision}`, image]);
    if (await artifactDigest() !== rpmSha256) throw new Error('Signed RPM bytes changed during acceptance');
    const checks = JSON.parse(await readFile(join(directory, 'evidence/browser.json'), 'utf8'));
    evidence = { schemaVersion: 1, status: 'passed', target: 'linux-x64-rpm-opensuse', sourceRevision, rpmSha256,
      signingRunId, fingerprint: identity.fingerprint,
      checks: Object.fromEntries(SIGNED_RPM_ACCEPTANCE_CHECKS.map(key => [key,
        ['configuredKeyOnly', 'nativeSignature', 'zypperInstall', 'rpmVerify', 'installedPayload', 'sourceManifest'].includes(key) || checks[key] === true])) };
    validateSignedRpmAcceptanceEvidence(evidence, evidence);
    // Do not overwrite prior evidence or merge unrelated acceptance outputs.
    await mkdir(resolve(outputDirectory), { mode: 0o700 });
    await cp(join(directory, 'evidence/pairing-evidence'), join(resolve(outputDirectory), 'pairing-evidence'), { recursive: true });
    await cp(join(directory, 'evidence/desktop-acceptance-artifacts'), join(resolve(outputDirectory), 'desktop-acceptance-artifacts'), { recursive: true });
  } finally {
    try { await cleanupOwnedContainer('docker', invocation, run); }
    finally {
      try {
        const inspected = await run('docker', ['network', 'inspect', '--format', '{{ index .Labels "dev.propr.acceptance" }}', network], { allowFailure: true, timeout: 30_000 });
        if (inspected.code === 0) {
          if (inspected.stdout.trim() !== id) throw new Error('Signed RPM acceptance refused to remove a network it does not own');
          await run('docker', ['network', 'rm', network], { timeout: 30_000 });
        }
      } finally {
        try { await run('docker', ['image', 'rm', image], { allowFailure: true, timeout: 30_000 }); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }
  await writeFile(join(resolve(outputDirectory), 'signed-rpm-acceptance.json'), JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 });
  return evidence;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ['--rpm', '--source-revision', '--signing-run-id', '--output'];
  const values = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!names.includes(args[index]) || values.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Missing, unknown or duplicated signed installed RPM acceptance arguments');
    }
    values.set(args[index], args[index + 1]);
  }
  if (values.size !== names.length) throw new Error('Incomplete signed installed RPM acceptance arguments');
  const arg = name => values.get(name);
  const { rpmIdentityFromEnvironment } = await import('./rpm-signing.mjs');
  await runSignedInstalledRpmAcceptance({ rpm: arg('--rpm'), sourceRevision: arg('--source-revision'),
    signingRunId: arg('--signing-run-id'), identity: rpmIdentityFromEnvironment(), outputDirectory: arg('--output') });
}
