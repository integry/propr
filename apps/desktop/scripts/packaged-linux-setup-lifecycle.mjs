import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { DESKTOP_RENDERER_ORIGIN } from '@propr/shared';
import {
  createPrivateSmokeProfile,
  removePrivateSmokeProfile,
} from './packaged-smoke-support.mjs';
import { waitForUsableElectronRenderer } from './packaged-acceptance-renderer.mjs';

export const LINUX_SETUP_ACCEPTANCE_OPT_IN = 'PROPR_DESKTOP_REAL_LINUX_SETUP_ACCEPTANCE';
export const LINUX_SETUP_ACCEPTANCE_SOURCE_SHA = 'PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA';
export const LINUX_SETUP_ACCEPTANCE_OUTPUT = 'PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT';

const TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 64 * 1024;
const SAFE_DOCKER_OPERATIONS = new Set(['version', 'info', 'images', 'image-inspect']);
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const ISOLATION_ID = /^[a-f0-9]{16}$/;
const INTERRUPTED_RECOVERY_MESSAGE = 'Setup was interrupted. Review the saved choices to continue.';
const RELAUNCH_DIAGNOSTIC_EVENT_LIMIT = 12;

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

const processExists = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
};

const boundedAppend = (current, chunk) => {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= OUTPUT_LIMIT ? next : next.subarray(next.length - OUTPUT_LIMIT);
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

export const createLinuxSetupIsolation = (id = randomBytes(8).toString('hex')) => {
  if (!ISOLATION_ID.test(id)) throw new Error('Linux setup acceptance isolation id is invalid');
  const stack = `propr-desktop-acceptance-${id}`;
  const network = `${stack}-net`;
  if (stack === 'propr' || network === 'propr-net' || /propr-desktop-test/i.test(stack)) {
    throw new Error('Linux setup acceptance refused a default or protected stack name');
  }
  return Object.freeze({ id, stack, network, ownershipLabel: `propr.stack=${stack}` });
};

export const validateSourceSha = value => {
  if (!SOURCE_SHA.test(value ?? '')) {
    throw new Error(`${LINUX_SETUP_ACCEPTANCE_SOURCE_SHA} must be the exact 40-character source SHA`);
  }
  return value;
};

const reserveFreeLoopbackPort = async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1'
    || !Number.isSafeInteger(address.port) || address.port <= 0) {
    server.close();
    throw new Error('Linux setup acceptance could not reserve a loopback port');
  }
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
};

export const reserveFreeLoopbackPorts = async (count = 3) => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
    throw new Error('Linux setup acceptance port count is invalid');
  }
  const ports = [];
  while (ports.length < count) {
    const port = await reserveFreeLoopbackPort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
};

export const createIsolatedSetupEnvironment = ({
  baseEnvironment,
  profile,
  wrapperDirectory,
  isolation,
  ports,
}) => {
  if (!baseEnvironment || typeof baseEnvironment !== 'object'
    || !profile?.root || !wrapperDirectory || !ISOLATION_ID.test(isolation?.id ?? '')
    || !Array.isArray(ports) || ports.length !== 3
    || !ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65_535)
    || new Set(ports).size !== ports.length) {
    throw new Error('Linux setup acceptance environment input is invalid');
  }
  const allowed = {};
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'GNOME_KEYRING_CONTROL', 'LANG', 'PATH', 'XAUTHORITY']) {
    if (baseEnvironment[name]) allowed[name] = baseEnvironment[name];
  }
  return Object.freeze({
    ...allowed,
    HOME: profile.home,
    TMPDIR: profile.temporary,
    XDG_CACHE_HOME: profile.xdgCache,
    XDG_CONFIG_HOME: profile.xdgConfig,
    XDG_DATA_HOME: profile.xdgData,
    XDG_RUNTIME_DIR: profile.xdgRuntime,
    PATH: `${wrapperDirectory}:${allowed.PATH ?? '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8',
    LANGUAGE: 'en_US:en',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    PROPR_STACK: isolation.stack,
    PROPR_NETWORK: isolation.network,
    API_PORT: `127.0.0.1:${ports[0]}`,
    UI_PORT: `127.0.0.1:${ports[1]}`,
    DOCS_PORT: `127.0.0.1:${ports[2]}`,
    DOCS_ENABLED: 'false',
    PROPR_SKIP_REMOTE_IMAGE_CHECK: '1',
    PROPR_UI_TUNNEL_ENABLED: 'false',
    [LINUX_SETUP_ACCEPTANCE_OPT_IN]: '1',
  });
};

const dockerOperation = args => {
  if (args.length === 1 && args[0] === '--version') return 'version';
  if (args[0] === 'info') return 'info';
  if (args[0] === 'images' && args[1] === '-q' && args.length === 3) return 'images';
  if (args.length === 3 && args[0] === 'image' && args[1] === 'inspect'
    && args[2].length > 0 && args[2] === args[2].trim() && !args[2].startsWith('-')) {
    return 'image-inspect';
  }
  if (args[0] === 'pull' && args.length === 2) return 'pull';
  return 'rejected';
};

export const dockerWrapperSource = ({ realDockerPath, eventPath }) => {
  if (!realDockerPath?.startsWith('/') || !eventPath?.startsWith('/')) {
    throw new Error('Linux setup acceptance Docker wrapper paths must be absolute');
  }
  return `#!/usr/bin/env node
'use strict';
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const realDocker = ${JSON.stringify(realDockerPath)};
const eventPath = ${JSON.stringify(eventPath)};
const args = process.argv.slice(2);
const operation = (${dockerOperation.toString()})(args);
const record = event => appendFileSync(eventPath, JSON.stringify({ schemaVersion: 1, event, operation, pid: process.pid, ppid: process.ppid, time: Date.now() }) + '\\n', { encoding: 'utf8' });
if (operation === 'pull') {
  const stop = signal => { record(signal); process.exit(signal === 'sigterm' ? 143 : 130); };
  process.once('SIGTERM', () => stop('sigterm'));
  process.once('SIGINT', () => stop('sigint'));
  setInterval(() => undefined, 1000);
}
// Pull admission must only become visible once cancellation handlers are ready.
record('invoked');
if (${JSON.stringify([...SAFE_DOCKER_OPERATIONS])}.includes(operation)) {
  const result = spawnSync(realDocker, args, { stdio: 'inherit' });
  if (result.error) { record('delegate-error'); process.exit(96); }
  process.exit(Number.isInteger(result.status) ? result.status : 95);
} else if (operation !== 'pull') {
  record('rejected');
  process.exit(97);
}
`;
};

export const parseDockerEvents = contents => {
  if (typeof contents !== 'string') throw new Error('Linux setup acceptance Docker evidence is invalid');
  return contents.split(/\r?\n/).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== ['event', 'operation', 'pid', 'ppid', 'schemaVersion', 'time'].sort().join(',')
      || value.schemaVersion !== 1 || !['invoked', 'sigterm', 'sigint', 'delegate-error', 'rejected'].includes(value.event)
      || !['version', 'info', 'images', 'image-inspect', 'pull', 'rejected'].includes(value.operation)
      || !Number.isSafeInteger(value.pid) || value.pid <= 1
      || !Number.isSafeInteger(value.ppid) || value.ppid <= 0
      || !Number.isSafeInteger(value.time) || value.time <= 0) {
      throw new Error('Linux setup acceptance Docker evidence record is malformed');
    }
    return value;
  });
};

export const createInterruptedRelaunchDiagnostics = ({ interrupted, events }) => {
  const pullInvocations = events.filter(event => event.event === 'invoked' && event.operation === 'pull').length;
  const rejectedCommands = events.filter(event => event.event === 'rejected').length;
  const recoveryMessagePresent = typeof interrupted?.error === 'string';
  const recoveryMessageMatches = interrupted?.error === INTERRUPTED_RECOVERY_MESSAGE;
  const finalConditions = {
    phase: typeof interrupted?.phase === 'string' ? interrupted.phase : null,
    recoveryMessagePresent,
    recoveryMessageMatches,
    recoveryMessageBytes: recoveryMessagePresent ? Buffer.byteLength(interrupted.error, 'utf8') : 0,
    recoveryMessageSha256: recoveryMessagePresent ? sha256(interrupted.error) : null,
    pullInvocations,
    rejectedCommands,
  };
  return {
    failedConditions: [
      ...(finalConditions.phase === 'interrupted' ? [] : ['interrupted-phase']),
      ...(recoveryMessageMatches ? [] : ['recovery-message']),
      ...(pullInvocations === 2 ? [] : ['pull-count']),
      ...(rejectedCommands === 0 ? [] : ['rejected-command']),
    ],
    finalConditions,
    totalOperationEvents: events.length,
    recentOperationEvents: events.slice(-RELAUNCH_DIAGNOSTIC_EVENT_LIMIT)
      .map(({ event, operation }) => ({ event, operation })),
  };
};

const readDockerEvents = async eventPath => {
  try { return parseDockerEvents(await readFile(eventPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

const waitFor = async (description, predicate, timeoutMs = TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
};

const runDocker = (dockerPath, args, { allowFailure = false } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(dockerPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    const result = { code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
    if (code === 0 || allowFailure) resolveRun(result);
    else reject(new Error(`Docker command failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
  });
});

const runningProcessGroupMembers = async processGroupId => {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error('Linux setup acceptance process-group identity is invalid');
  }
  const result = await runDocker('/bin/ps', ['-axo', 'pid=,pgid=,stat=']);
  const members = [];
  for (const line of result.stdout.split(/\r?\n/).filter(value => value.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Linux setup acceptance process-group inspection was malformed');
    if (Number(match[2]) === processGroupId && match[3][0] !== 'Z') members.push(Number(match[1]));
  }
  return members;
};

const resolveDocker = async pathValue => {
  const directories = String(pathValue ?? '/usr/bin:/bin').split(':').filter(Boolean);
  for (const directory of directories) {
    const candidate = resolve(directory, 'docker');
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
};

export const probeDockerSupport = async (dockerPath, run = runDocker) => {
  if (!dockerPath) return { supported: false, phase: 'docker-cli', limitation: 'Docker CLI was not available.' };
  const result = await run(dockerPath, ['info'], { allowFailure: true });
  if (result.code !== 0) {
    return { supported: false, phase: 'docker-daemon-inspection', limitation: 'Docker CLI was available, but the daemon was not reachable by the current user.' };
  }
  return { supported: true };
};

const dockerBaseline = async dockerPath => {
  const [containers, networks] = await Promise.all([
    runDocker(dockerPath, ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}']),
    runDocker(dockerPath, ['network', 'ls', '--no-trunc', '--format', '{{.ID}}\t{{.Name}}']),
  ]);
  return {
    containers: containers.stdout.trim().split('\n').filter(Boolean).sort(),
    networks: networks.stdout.trim().split('\n').filter(Boolean).sort(),
  };
};

const assertNoOwnedDockerResources = async (dockerPath, isolation) => {
  const [containers, network] = await Promise.all([
    runDocker(dockerPath, ['ps', '-a', '--no-trunc', '--filter', `label=${isolation.ownershipLabel}`, '--format', '{{.ID}}\t{{.Names}}']),
    runDocker(dockerPath, ['network', 'inspect', isolation.network], { allowFailure: true }),
  ]);
  if (containers.stdout.trim()) throw new Error('Linux setup acceptance left an owned container behind');
  if (network.code === 0) throw new Error('Linux setup acceptance left its unique network behind');
  return { containersAbsent: true, networkAbsent: true };
};

const prepareIsolatedRoot = async ({ profile, isolation, ports }) => {
  const rootDir = join(profile.userData, 'local-runtime');
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  const env = [
    `PROPR_STACK=${isolation.stack}`,
    `PROPR_NETWORK=${isolation.network}`,
    `API_PORT=127.0.0.1:${ports[0]}`,
    `UI_PORT=127.0.0.1:${ports[1]}`,
    `DOCS_PORT=127.0.0.1:${ports[2]}`,
    'DOCS_ENABLED=false',
    'PROPR_UI_TUNNEL_ENABLED=false',
  ].join('\n');
  await writeFile(join(rootDir, '.env'), `${env}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(join(profile.root, 'setup-acceptance-owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    isolationId: isolation.id,
    stack: isolation.stack,
    network: isolation.network,
  })}\n`, { mode: 0o600, flag: 'wx' });
  return rootDir;
};

const launchPackagedApp = async ({ binaryPath, userData, environment }) => {
  const child = spawn(binaryPath, [
    '--disable-background-networking',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userData}`,
    '--password-store=gnome-libsecret',
  ], {
    cwd: userData,
    detached: true,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close').catch(error => [{ error }]);
  let output = Buffer.alloc(0);
  let remainder = '';
  let resolveEndpoint;
  let rejectEndpoint;
  const endpoint = new Promise((resolveValue, rejectValue) => {
    resolveEndpoint = resolveValue;
    rejectEndpoint = rejectValue;
  });
  const capture = chunk => {
    output = boundedAppend(output, chunk);
    const text = `${remainder}${chunk.toString('utf8')}`;
    const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) resolveEndpoint(match[1]);
    remainder = text.slice(-2048);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', rejectEndpoint);
  child.once('close', code => rejectEndpoint(new Error(`Packaged Electron exited before CDP startup (${code ?? 'signal'})`)));
  const timer = setTimeout(() => rejectEndpoint(new Error('Packaged Electron CDP endpoint did not start')), 20_000);
  let browser;
  try {
    const wsEndpoint = await endpoint.finally(() => clearTimeout(timer));
    browser = await chromium.connectOverCDP(wsEndpoint);
    const { page } = await waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: DESKTOP_RENDERER_ORIGIN,
      timeoutMs: 20_000,
    });
    return { child, closed, browser, page, output: () => output };
  } catch (error) {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => undefined);
    if (Number.isSafeInteger(child.pid) && processExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    throw error;
  }
};

const terminateLaunch = async (launch, signal) => {
  if (!launch) return;
  const processGroupId = launch.child.pid;
  const send = requestedSignal => {
    try { process.kill(-processGroupId, requestedSignal); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
  };
  if ((await runningProcessGroupMembers(processGroupId)).length > 0) send(signal);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await runningProcessGroupMembers(processGroupId)).length > 0) {
    await delay(50);
  }
  if ((await runningProcessGroupMembers(processGroupId)).length > 0) {
    send('SIGKILL');
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline && (await runningProcessGroupMembers(processGroupId)).length > 0) {
      await delay(50);
    }
  }
  await Promise.race([launch.closed, delay(5_000)]);
  await launch.browser?.close().catch(() => undefined);
  if ((await runningProcessGroupMembers(processGroupId)).length > 0) {
    throw new Error('Linux setup acceptance left a running process in its owned process group');
  }
};

const openSetupAndStart = async page => {
  await page.getByRole('button', { name: /Set up this computer/i }).click();
  await page.getByRole('heading', { name: 'Check the essentials' }).waitFor();
  for (const heading of ['Check the essentials', 'Private local storage', 'Connect GitHub', 'GitHub event intake']) {
    await page.getByRole('heading', { name: heading }).waitFor();
    await page.getByRole('button', { name: /^Continue/ }).click();
  }
  await page.getByRole('heading', { name: 'Select coding agents' }).waitFor();
  const selected = page.locator('input[type="checkbox"]:checked');
  while (await selected.count()) await selected.first().click();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.getByRole('heading', { name: 'Ready to install' }).waitFor();
  await page.getByRole('button', { name: /Install ProPR/i }).click();
  await page.getByRole('heading', { name: 'Setting up ProPR' }).waitFor();
};

const setupStatus = page => page.evaluate(() => window.proprDesktop.localSetup.status());

const waitForPull = async (eventPath, expectedCount) => waitFor(`Docker pull admission ${expectedCount}`, async () => {
  const events = await readDockerEvents(eventPath);
  const pulls = events.filter(event => event.event === 'invoked' && event.operation === 'pull');
  if (pulls.length !== expectedCount) return false;
  return processExists(pulls.at(-1).pid) ? pulls.at(-1) : false;
});

const writeReport = async (outputPath, report) => {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
};

export const runPackagedLinuxSetupLifecycle = async ({
  environment = process.env,
  binaryPath = resolve('out', 'propr-desktop-linux-x64', 'propr-desktop'),
} = {}) => {
  if (environment[LINUX_SETUP_ACCEPTANCE_OPT_IN] !== '1') {
    throw new Error(`Real Linux setup acceptance is opt-in; set ${LINUX_SETUP_ACCEPTANCE_OPT_IN}=1`);
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Real packaged setup acceptance is supported only on Linux x64');
  }
  const sourceSha = validateSourceSha(environment[LINUX_SETUP_ACCEPTANCE_SOURCE_SHA]);
  const outputPath = resolve(environment[LINUX_SETUP_ACCEPTANCE_OUTPUT]
    || 'desktop-acceptance-artifacts/linux-setup-lifecycle.json');
  await access(binaryPath);
  const dockerPath = await resolveDocker(environment.PATH);
  const dockerSupport = await probeDockerSupport(dockerPath);
  const command = `${LINUX_SETUP_ACCEPTANCE_OPT_IN}=1 ${LINUX_SETUP_ACCEPTANCE_SOURCE_SHA}=${sourceSha} npm run desktop:acceptance:setup-linux`;
  if (!dockerSupport.supported) {
    const report = {
      schemaVersion: 1,
      result: 'unverified',
      sourceSha,
      command,
      platform: `${process.platform}-${process.arch}`,
      verifiedPhases: ['packaged-artifact-present'],
      unverifiedPhase: dockerSupport.phase,
      limitations: [dockerSupport.limitation, 'Cancellation, retry, and relaunch were not executed.'],
      cleanup: { applicationStarted: false, runtimeRootCreated: false, dockerResourcesCreated: false },
    };
    await writeReport(outputPath, report);
    return report;
  }

  const isolation = createLinuxSetupIsolation();
  const ports = await reserveFreeLoopbackPorts();
  const baseline = await dockerBaseline(dockerPath);
  const profile = await createPrivateSmokeProfile();
  const wrapperDirectory = join(profile.root, 'docker-command-boundary');
  const eventPath = join(profile.root, 'docker-events.jsonl');
  let launch;
  let relaunch;
  let firstPull;
  let secondPull;
  let primaryOutput = Buffer.alloc(0);
  let relaunchOutput = Buffer.alloc(0);
  let cleanupEvidence;
  try {
    await mkdir(wrapperDirectory, { mode: 0o700 });
    await prepareIsolatedRoot({ profile, isolation, ports });
    const wrapperPath = join(wrapperDirectory, 'docker');
    await writeFile(wrapperPath, dockerWrapperSource({ realDockerPath: dockerPath, eventPath }), { mode: 0o700, flag: 'wx' });
    await chmod(wrapperPath, 0o700);
    const childEnvironment = createIsolatedSetupEnvironment({
      baseEnvironment: environment,
      profile,
      wrapperDirectory,
      isolation,
      ports,
    });

    launch = await launchPackagedApp({ binaryPath, userData: profile.userData, environment: childEnvironment });
    await openSetupAndStart(launch.page);
    firstPull = await waitForPull(eventPath, 1);
    const running = await setupStatus(launch.page);
    if (running.phase !== 'running' || running.state?.steps.find(step => step.id === 'pull-images')?.status !== 'active') {
      throw new Error('Real setup did not visibly admit the held image pull');
    }
    await launch.page.getByRole('button', { name: 'Cancel safely' }).click();
    await launch.page.getByRole('heading', { name: 'Setup needs attention' }).waitFor();
    await launch.page.getByRole('button', { name: /Retry setup/i }).waitFor();
    const cancelled = await setupStatus(launch.page);
    const cancellationEvents = await readDockerEvents(eventPath);
    if (cancelled.phase !== 'cancelled' || processExists(firstPull.pid)
      || !cancellationEvents.some(event => event.pid === firstPull.pid && event.event === 'sigterm')) {
      throw new Error('Real setup cancellation did not settle or terminate its admitted child');
    }

    await launch.page.getByRole('button', { name: /Retry setup/i }).click();
    await launch.page.getByRole('heading', { name: 'Setting up ProPR' }).waitFor();
    await launch.page.getByText('Retrying setup with a fresh host inspection…').waitFor();
    secondPull = await waitForPull(eventPath, 2);
    const retryStatus = await setupStatus(launch.page);
    const retryEvents = await readDockerEvents(eventPath);
    if (retryStatus.phase !== 'running'
      || !retryStatus.logs.includes('Retrying setup with a fresh host inspection…')
      || retryEvents.filter(event => event.event === 'invoked' && event.operation === 'info').length !== 2
      || processExists(firstPull.pid) || !processExists(secondPull.pid)) {
      throw new Error('Real setup retry did not perform one fresh host inspection and one fresh execution');
    }

    primaryOutput = launch.output();
    await terminateLaunch(launch, 'SIGKILL');
    launch = undefined;
    await waitFor('interrupted setup child termination', () => !processExists(secondPull.pid));

    relaunch = await launchPackagedApp({ binaryPath, userData: profile.userData, environment: childEnvironment });
    await relaunch.page.getByRole('button', { name: /Set up this computer/i }).click();
    await relaunch.page.getByRole('heading', { name: 'Continue your setup' }).waitFor();
    const interrupted = await setupStatus(relaunch.page);
    const finalEvents = await readDockerEvents(eventPath);
    const relaunchDiagnostics = createInterruptedRelaunchDiagnostics({ interrupted, events: finalEvents });
    if (relaunchDiagnostics.failedConditions.length > 0) {
      throw new Error(`Relaunch did not present isolated interrupted recovery without duplicate execution: ${JSON.stringify(relaunchDiagnostics)}`);
    }
    relaunchOutput = relaunch.output();
    await terminateLaunch(relaunch, 'SIGTERM');
    relaunch = undefined;

    cleanupEvidence = await assertNoOwnedDockerResources(dockerPath, isolation);
    const after = await dockerBaseline(dockerPath);
    if (JSON.stringify(after) !== JSON.stringify(baseline)) {
      throw new Error('Docker container or network identity changed during pre-enrollment acceptance');
    }
    const events = await readDockerEvents(eventPath);
    const report = {
      schemaVersion: 1,
      result: 'verified',
      sourceSha,
      command,
      platform: `${process.platform}-${process.arch}`,
      packagedBinary: { path: binaryPath, sha256: sha256(await readFile(binaryPath)) },
      isolation: {
        stack: isolation.stack,
        network: isolation.network,
        ownershipLabel: isolation.ownershipLabel,
        loopbackPorts: ports,
        privateTemporaryRoot: true,
      },
      evidence: {
        realDockerDaemonInspections: events.filter(event => event.event === 'invoked' && event.operation === 'info').length,
        admittedPullExecutions: events.filter(event => event.event === 'invoked' && event.operation === 'pull').length,
        firstCancellationSettled: true,
        visibleCancellationRecovery: true,
        firstAdmittedProcessTerminated: true,
        retryFreshInspection: true,
        retryDuplicateExecutionAbsent: true,
        relaunchInterruptedRecoveryVisible: true,
        interruptedProcessTerminated: true,
        applicationOutput: {
          firstLaunchBytes: primaryOutput.length,
          firstLaunchSha256: sha256(primaryOutput),
          relaunchBytes: relaunchOutput.length,
          relaunchSha256: sha256(relaunchOutput),
        },
      },
      cleanup: {
        ...cleanupEvidence,
        existingContainerAndNetworkIdentitiesUnchanged: true,
        orphanedSetupProcesses: 0,
        temporaryRootRemoved: true,
      },
      limitations: [
        'The run intentionally stops at a held pre-enrollment image pull; it does not claim image download, GitHub authentication/enrollment, stack startup, health, pairing, or successful provisioning.',
        'The Docker command boundary delegates prerequisite and read-only inspection to the real daemon, admits but does not execute the mutating pull, and rejects every other Docker mutation.',
      ],
    };
    await removePrivateSmokeProfile(profile);
    await writeReport(outputPath, report);
    return report;
  } finally {
    if (launch) await terminateLaunch(launch, 'SIGKILL').catch(() => undefined);
    if (relaunch) await terminateLaunch(relaunch, 'SIGKILL').catch(() => undefined);
    if (firstPull && processExists(firstPull.pid)) {
      try { process.kill(firstPull.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (secondPull && processExists(secondPull.pid)) {
      try { process.kill(secondPull.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (!cleanupEvidence) await assertNoOwnedDockerResources(dockerPath, isolation).catch(() => undefined);
    await rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
  }
};
