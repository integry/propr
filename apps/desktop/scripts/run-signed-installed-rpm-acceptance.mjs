import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstalledLinuxAcceptanceArtifact, cleanupOwnedContainer } from './run-installed-linux-package-acceptance.mjs';
import { prepareSignedRpmAcceptanceContext } from './signed-rpm-acceptance-context.mjs';
import { requireRpmIdentity, verifyRpm } from './rpm-signing.mjs';
import { SIGNED_RPM_ACCEPTANCE_CHECKS, validateSignedRpmAcceptanceEvidence } from './signed-rpm-acceptance-evidence.mjs';
import {
  SignedRpmAcceptanceFailure, classifyFailure, inPhase, runAcceptancePhase, withCleanupFailures,
} from './signed-rpm-acceptance-diagnostics.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// `docker`, `verify` and `prepareContext` are substitutable only for failure-injection tests;
// the CLI below always uses the real Docker CLI, native RPM verification and allowlisted context.
export const runSignedInstalledRpmAcceptance = async ({ rpm, sourceRevision, signingRunId, identity, outputDirectory }, {
  docker = 'docker', verify = verifyRpm, prepareContext = prepareSignedRpmAcceptanceContext,
} = {}) => {
  if (process.platform !== 'linux' || process.arch !== 'x64'
    || process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE !== '1') {
    throw new Error('Signed RPM acceptance requires native Linux x64 and explicit disposable-container opt-in');
  }
  requireRpmIdentity(identity);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || !/^[1-9][0-9]*$/.test(signingRunId)) throw new Error('Invalid signed RPM acceptance identity');
  rpm = resolve(rpm);
  await assertInstalledLinuxAcceptanceArtifact(rpm);
  const run = (phase, args, options = {}) => runAcceptancePhase(docker, args, { ...options, phase });
  const daemon = await run('docker-info', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { timeout: 30_000 });
  if (!['linux/amd64', 'linux/x86_64'].includes(daemon.stdout.trim())) throw new Error('Signed RPM acceptance requires a native x64 Docker daemon');
  await verify({ path: rpm, identity });
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
  let evidence, primary;
  try {
    await inPhase('workspace-setup', async () => {
      await writeFile(join(directory, 'public.asc'), identity.publicKey, { mode: 0o600 });
      await mkdir(join(directory, 'evidence'), { mode: 0o700 });
    });
    // Send only the allowlisted context; see signed-rpm-acceptance-context.mjs.
    const context = join(directory, 'context');
    await inPhase('context-preparation', () => prepareContext({ root, context }));
    await run('image-build', ['build', '--platform=linux/amd64', '--tag', image, '--file', join(context, 'apps/desktop/scripts/signed-rpm-acceptance.Dockerfile'), context]);
    // Chromium needs an active interface for navigator.onLine, even though all
    // fixtures use loopback. An internal bridge provides it without external egress.
    await run('network-create', ['network', 'create', '--driver=bridge', '--internal', '--label', invocation.label, network]);
    await run('installed-acceptance', ['run', '--rm', '--init', '--platform=linux/amd64', '--network', network, '--shm-size=1g', '--cap-add=SYS_ADMIN', '--cap-add=IPC_LOCK',
      '--name', name, '--label', invocation.label,
      '--mount', `type=bind,src=${rpm},dst=/input/preview.rpm,readonly`,
      '--mount', `type=bind,src=${join(directory, 'public.asc')},dst=/input/public.asc,readonly`,
      '--mount', `type=bind,src=${join(directory, 'evidence')},dst=/evidence`,
      '--env', `PROPR_RPM_HOST_UID=${process.getuid()}`, '--env', `PROPR_RPM_HOST_GID=${process.getgid()}`,
      '--env', `PROPR_RPM_SHA256=${rpmSha256}`, '--env', `PROPR_RPM_FINGERPRINT=${identity.fingerprint}`, '--env', `PROPR_RPM_SOURCE_SHA=${sourceRevision}`, image],
    { trackStages: true });
    await inPhase('evidence-collection', async () => {
      if (await artifactDigest() !== rpmSha256) throw new SignedRpmAcceptanceFailure({ phase: 'evidence-collection', outcome: 'artifact-changed' });
      const checks = JSON.parse(await readFile(join(directory, 'evidence/browser.json'), 'utf8'));
      evidence = { schemaVersion: 1, status: 'passed', target: 'linux-x64-rpm-opensuse', sourceRevision, rpmSha256,
        signingRunId, fingerprint: identity.fingerprint,
        checks: Object.fromEntries(SIGNED_RPM_ACCEPTANCE_CHECKS.map(key => [key,
          ['configuredKeyOnly', 'nativeSignature', 'zypperInstall', 'rpmVerify', 'installedPayload', 'sourceManifest'].includes(key) || checks[key] === true])) };
      try { validateSignedRpmAcceptanceEvidence(evidence, evidence); }
      catch { throw new SignedRpmAcceptanceFailure({ phase: 'evidence-collection', outcome: 'evidence-invalid' }); }
    });
    await inPhase('evidence-export', async () => {
      // Do not overwrite prior evidence or merge unrelated acceptance outputs.
      await mkdir(resolve(outputDirectory), { mode: 0o700 });
      await cp(join(directory, 'evidence/pairing-evidence'), join(resolve(outputDirectory), 'pairing-evidence'), { recursive: true });
      await cp(join(directory, 'evidence/desktop-acceptance-artifacts'), join(resolve(outputDirectory), 'desktop-acceptance-artifacts'), { recursive: true });
    });
  } catch (error) {
    primary = error;
  }
  // Every owned-resource cleanup runs even when an earlier one fails; failures are
  // reported after, never instead of, the substantive acceptance failure.
  const cleanupFailures = [];
  const cleanup = async (phase, task) => {
    try { await task(); } catch (error) { cleanupFailures.push(classifyFailure(error, phase)); }
  };
  await cleanup('container-cleanup', () => cleanupOwnedContainer(docker, invocation,
    (file, args, options) => runAcceptancePhase(file, args, { ...options, phase: 'container-cleanup' })));
  await cleanup('network-cleanup', async () => {
    const inspected = await run('network-inspect', ['network', 'inspect', '--format', '{{ index .Labels "dev.propr.acceptance" }}', network], { allowFailure: true, timeout: 30_000 });
    if (inspected.code === 0) {
      if (inspected.stdout.trim() !== id) throw new SignedRpmAcceptanceFailure({ phase: 'network-cleanup', outcome: 'ownership-refused' });
      await run('network-cleanup', ['network', 'rm', network], { timeout: 30_000 });
    }
  });
  await cleanup('image-cleanup', () => run('image-cleanup', ['image', 'rm', image], { allowFailure: true, timeout: 30_000 }));
  await cleanup('workspace-cleanup', () => rm(directory, { recursive: true, force: true }));
  if (primary) throw cleanupFailures.length ? withCleanupFailures(primary, cleanupFailures) : primary;
  if (cleanupFailures.length) throw new SignedRpmAcceptanceFailure(cleanupFailures[0], { cleanup: cleanupFailures.slice(1) });
  await inPhase('evidence-write', () => writeFile(join(resolve(outputDirectory), 'signed-rpm-acceptance.json'),
    JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 }));
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
  try {
    await runSignedInstalledRpmAcceptance({ rpm: arg('--rpm'), sourceRevision: arg('--source-revision'),
      signingRunId: arg('--signing-run-id'), identity: rpmIdentityFromEnvironment(), outputDirectory: arg('--output') });
  } catch (error) {
    if (!(error instanceof SignedRpmAcceptanceFailure)) throw error;
    // Print only the bounded message and diagnostic; never a stack, cause or child output.
    console.error(error.message);
    console.error(JSON.stringify({ signedRpmAcceptanceFailure: error.diagnostic }));
    process.exitCode = 1;
  }
}
