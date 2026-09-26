import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_ICON_SHA256,
  TRAY_ICON_SHA256,
} from './desktop-icon-assets.mjs';
import { releaseFileName } from './release-profiles.mjs';

export const INSTALLED_LINUX_ACCEPTANCE_OPT_IN = 'PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE';
export const DEFAULT_LINUX_PACKAGE_IMAGES = Object.freeze({
  deb: 'debian:12-slim',
  rpm: 'rockylinux:9',
});
export const INSTALLED_LINUX_SANDBOX_ISOLATIONS = Object.freeze([
  'docker-default',
  'docker-cap-sys-admin',
]);
export const INSTALLED_LINUX_ADDED_CAPABILITIES = Object.freeze([
  'SYS_ADMIN',
  'IPC_LOCK',
]);
export const INSTALLED_LINUX_EVIDENCE_PREFIX = 'PROPR_INSTALLED_LINUX_EVIDENCE=';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IMAGE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const OUTPUT_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 20 * 60_000;
const scriptPath = fileURLToPath(new URL('./test-installed-linux-package.sh', import.meta.url));

const compareVersions = (left, right) => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

export const parseInstalledLinuxAcceptanceArguments = args => {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Installed Linux package acceptance arguments are missing, duplicated, or malformed');
    }
    values.set(name, value);
  }
  const allowed = new Set([
    '--arch', '--previous-version', '--version', '--previous-deb', '--deb',
    '--previous-rpm', '--rpm', '--deb-image', '--rpm-image', '--sandbox-isolation',
  ]);
  if ([...values.keys()].some(name => !allowed.has(name))) {
    throw new Error('Installed Linux package acceptance argument is unknown');
  }
  const arch = values.get('--arch');
  const previousVersion = values.get('--previous-version');
  const version = values.get('--version');
  if (!['x64', 'arm64'].includes(arch) || !VERSION.test(previousVersion ?? '')
    || !VERSION.test(version ?? '') || compareVersions(previousVersion, version) >= 0) {
    throw new Error('Installed Linux package acceptance target or upgrade versions are invalid');
  }
  const images = {
    deb: values.get('--deb-image') ?? DEFAULT_LINUX_PACKAGE_IMAGES.deb,
    rpm: values.get('--rpm-image') ?? DEFAULT_LINUX_PACKAGE_IMAGES.rpm,
  };
  if (!IMAGE.test(images.deb) || !IMAGE.test(images.rpm)) {
    throw new Error('Installed Linux package acceptance image reference is invalid');
  }
  const sandboxIsolation = values.get('--sandbox-isolation');
  if (!INSTALLED_LINUX_SANDBOX_ISOLATIONS.includes(sandboxIsolation)) {
    throw new Error('Installed Linux package acceptance requires an explicit sandbox isolation mode; value is missing or invalid');
  }
  const artifacts = {};
  for (const family of ['deb', 'rpm']) {
    const extension = family;
    const previous = values.get(`--previous-${family}`);
    const current = values.get(`--${family}`);
    const expectedPrevious = releaseFileName(previousVersion, 'linux', arch, extension);
    const expectedCurrent = releaseFileName(version, 'linux', arch, extension);
    if (!previous || !current || basename(previous) !== expectedPrevious || basename(current) !== expectedCurrent) {
      throw new Error(`Installed Linux package acceptance requires canonical ${family.toUpperCase()} artifact names`);
    }
    artifacts[family] = { previous: resolve(previous), current: resolve(current) };
  }
  if (values.size < 8 || values.size > 10) {
    throw new Error('Installed Linux package acceptance arguments are incomplete');
  }
  return Object.freeze({
    arch,
    previousVersion,
    version,
    sandboxIsolation,
    images: Object.freeze(images),
    artifacts: Object.freeze(artifacts),
  });
};

export const assertInstalledLinuxAcceptanceArtifact = async path => {
  if (typeof path !== 'string' || /[\0\r\n,]/.test(path)) {
    throw new Error('Installed Linux package acceptance artifact path is unsafe for a read-only container mount');
  }
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error('Installed Linux package acceptance artifact must be a non-empty regular non-link file');
  }
  if (await realpath(path) !== path) {
    throw new Error('Installed Linux package acceptance artifact path must be canonical');
  }
};

const dockerPlatform = arch => arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
const packageArchitecture = (family, arch) => family === 'deb'
  ? (arch === 'x64' ? 'amd64' : 'arm64')
  : (arch === 'x64' ? 'x86_64' : 'aarch64');

const mount = (source, target) => `type=bind,src=${source},dst=${target},readonly`;

export const parseInstalledLinuxContainerEvidence = (stdout, expected) => {
  const line = String(stdout).split(/\r?\n/u)
    .filter(candidate => candidate.startsWith(INSTALLED_LINUX_EVIDENCE_PREFIX)).at(-1);
  if (!line) throw new Error('Installed Linux package acceptance container emitted no lifecycle evidence');
  let evidence;
  try { evidence = JSON.parse(line.slice(INSTALLED_LINUX_EVIDENCE_PREFIX.length)); }
  catch { throw new Error('Installed Linux package acceptance container emitted malformed lifecycle evidence'); }
  const keys = [
    'architecture', 'artifactMetadataVerified', 'environmentLimitation', 'failedPhase', 'family',
    'installedPayloadsVerified', 'lastCompletedPhase', 'launchesAttempted', 'launchesPassed', 'outcome',
    'sandboxIsolation', 'schemaVersion', 'uninstallCompleted', 'upgradeCompleted', 'userDataPreserved',
  ];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(keys)
    || evidence.schemaVersion !== 1 || evidence.family !== expected.family
    || evidence.architecture !== expected.architecture || evidence.sandboxIsolation !== expected.sandboxIsolation
    || !['passed', 'failed', 'environment-limited'].includes(evidence.outcome)
    || typeof evidence.lastCompletedPhase !== 'string' || typeof evidence.failedPhase !== 'string'
    || !Number.isInteger(evidence.installedPayloadsVerified) || evidence.installedPayloadsVerified < 0
    || evidence.installedPayloadsVerified > 2 || !Number.isInteger(evidence.launchesAttempted)
    || evidence.launchesAttempted < 0 || evidence.launchesAttempted > 2
    || !Number.isInteger(evidence.launchesPassed) || evidence.launchesPassed < 0
    || evidence.launchesPassed > evidence.launchesAttempted
    || !['artifactMetadataVerified', 'upgradeCompleted', 'uninstallCompleted', 'userDataPreserved']
      .every(name => typeof evidence[name] === 'boolean')
    || (evidence.environmentLimitation !== null
      && (typeof evidence.environmentLimitation !== 'string' || evidence.environmentLimitation.length > 1024))) {
    throw new Error('Installed Linux package acceptance container emitted invalid lifecycle evidence');
  }
  if (evidence.outcome === 'passed') {
    if (evidence.failedPhase !== '' || evidence.environmentLimitation !== null
      || !evidence.artifactMetadataVerified || evidence.installedPayloadsVerified !== 2
      || evidence.launchesAttempted !== 2 || evidence.launchesPassed !== 2
      || !evidence.upgradeCompleted || !evidence.uninstallCompleted || !evidence.userDataPreserved) {
      throw new Error('Installed Linux package acceptance container emitted an incomplete success claim');
    }
  } else if (!evidence.failedPhase
    || (evidence.outcome === 'environment-limited' && !evidence.environmentLimitation)) {
    throw new Error('Installed Linux package acceptance container emitted an incomplete failure claim');
  }
  return Object.freeze(evidence);
};

export const createInstalledLinuxContainerInvocation = ({ family, target, isolationId }) => {
  if (!['deb', 'rpm'].includes(family) || !/^[a-f0-9]{16}$/.test(isolationId ?? '')
    || !INSTALLED_LINUX_SANDBOX_ISOLATIONS.includes(target.sandboxIsolation)) {
    throw new Error('Installed Linux package acceptance container identity is invalid');
  }
  const name = `propr-package-${family}-${isolationId}`;
  const beforeTarget = `/propr-acceptance/before.${family}`;
  const afterTarget = `/propr-acceptance/after.${family}`;
  return Object.freeze({
    name,
    label: `dev.propr.acceptance=${isolationId}`,
    args: Object.freeze([
      'run', '--rm', '--init', `--platform=${dockerPlatform(target.arch)}`,
      '--name', name, '--label', `dev.propr.acceptance=${isolationId}`,
      ...(target.sandboxIsolation === 'docker-cap-sys-admin'
        ? INSTALLED_LINUX_ADDED_CAPABILITIES.map(capability => `--cap-add=${capability}`)
        : []),
      '--mount', mount(scriptPath, '/propr-acceptance/test-installed-linux-package.sh'),
      '--mount', mount(target.artifacts[family].previous, beforeTarget),
      '--mount', mount(target.artifacts[family].current, afterTarget),
      target.images[family],
      '/bin/bash', '/propr-acceptance/test-installed-linux-package.sh',
      family, target.arch, packageArchitecture(family, target.arch),
      target.previousVersion, target.version, beforeTarget, afterTarget,
      DESKTOP_ICON_SHA256, TRAY_ICON_SHA256, target.sandboxIsolation,
    ]),
  });
};

const appendBounded = (current, chunk) => {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= OUTPUT_LIMIT ? next : next.subarray(next.length - OUTPUT_LIMIT);
};

const resolveDocker = async pathValue => {
  for (const directory of String(pathValue ?? '/usr/bin:/bin').split(':').filter(Boolean)) {
    const candidate = resolve(directory, 'docker');
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
};

const run = (file, args, { allowFailure = false, timeout = COMMAND_TIMEOUT_MS } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk); process.stderr.write(chunk); });
  let interruptedSignal;
  const interrupt = signal => {
    interruptedSignal = signal;
    child.kill('SIGTERM');
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const finish = () => {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.once('error', error => { finish(); reject(error); });
  child.once('close', (code, signal) => {
    finish();
    const result = { code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
    if (interruptedSignal) {
      reject(new Error(`Installed Linux acceptance command was interrupted by ${interruptedSignal}`));
      return;
    }
    if (code === 0 || allowFailure) resolveRun(result);
    else reject(new Error(`Installed Linux acceptance command failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
  });
});

export const cleanupOwnedContainer = async (docker, invocation, runCommand) => {
  const inspected = await runCommand(docker, [
    'inspect', '--format', '{{ index .Config.Labels "dev.propr.acceptance" }}', invocation.name,
  ], { allowFailure: true, timeout: 30_000 });
  if (inspected.code !== 0) return;
  if (inspected.stdout.trim() !== invocation.label.split('=')[1]) {
    throw new Error('Installed Linux package acceptance refused to remove a container it does not own');
  }
  await runCommand(docker, ['rm', '--force', invocation.name], { timeout: 30_000 });
};

export const runInstalledLinuxPackageAcceptance = async (target, {
  environment = process.env,
  runCommand = run,
} = {}) => {
  if (environment[INSTALLED_LINUX_ACCEPTANCE_OPT_IN] !== '1') {
    throw new Error(`Set ${INSTALLED_LINUX_ACCEPTANCE_OPT_IN}=1 to authorize disposable package-manager containers`);
  }
  if (hostPlatform() !== 'linux' || hostArch() !== target.arch) {
    throw new Error(`Installed package acceptance requires native linux-${target.arch}; emulation is not validation`);
  }
  await Promise.all(Object.values(target.artifacts).flatMap(pair => (
    [assertInstalledLinuxAcceptanceArtifact(pair.previous), assertInstalledLinuxAcceptanceArtifact(pair.current)]
  )));
  await assertInstalledLinuxAcceptanceArtifact(scriptPath);
  const docker = await resolveDocker(environment.PATH);
  if (!docker) throw new Error('Installed Linux package acceptance requires the Docker CLI');
  const daemon = await runCommand(docker, ['info', '--format', '{{.OSType}}/{{.Architecture}}'], {
    allowFailure: true,
    timeout: 30_000,
  });
  if (daemon.code !== 0 || !daemon.stdout.trim().startsWith('linux/')) {
    throw new Error('Installed Linux package acceptance requires a reachable Linux Docker daemon');
  }

  const evidence = [];
  for (const family of ['deb', 'rpm']) {
    const invocation = createInstalledLinuxContainerInvocation({
      family,
      target,
      isolationId: randomBytes(8).toString('hex'),
    });
    let primaryError;
    try {
      const result = await runCommand(docker, invocation.args, { allowFailure: true });
      const containerEvidence = parseInstalledLinuxContainerEvidence(result.stdout, {
        family,
        architecture: target.arch,
        sandboxIsolation: target.sandboxIsolation,
      });
      evidence.push(Object.freeze({
        ...containerEvidence,
        image: target.images[family],
        lifecycle: 'package-manager-install/launch/upgrade/relaunch/remove',
      }));
      if (result.code !== 0 || containerEvidence.outcome !== 'passed') {
        const limitation = containerEvidence.environmentLimitation
          ? ` Environment limitation: ${containerEvidence.environmentLimitation}` : '';
        throw new Error(`Installed Linux ${family.toUpperCase()} acceptance failed at ${containerEvidence.failedPhase}.${limitation}`);
      }
    } catch (error) {
      primaryError = error;
    }
    let cleanupError;
    try { await cleanupOwnedContainer(docker, invocation, runCommand); }
    catch (error) { cleanupError = error; }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Installed Linux acceptance and cleanup failed');
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  }
  const report = Object.freeze({
    schemaVersion: 1,
    target: `linux-${target.arch}`,
    previousVersion: target.previousVersion,
    version: target.version,
    sandboxIsolation: target.sandboxIsolation,
    evidence,
    limitations: target.arch === 'arm64'
      ? 'Native ARM64 host evidence; this does not infer coverage from x64 emulation.'
      : 'Concrete native x64 evidence. ARM64 requires a separate native ARM64 run; emulation is not accepted.',
  });
  console.log(JSON.stringify(report));
  return report;
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  await runInstalledLinuxPackageAcceptance(parseInstalledLinuxAcceptanceArguments(process.argv.slice(2)));
}
