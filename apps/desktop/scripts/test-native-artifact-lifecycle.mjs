import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch as hostArch, platform as hostPlatform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createHeldDmgArtifact,
  inspectArtifactArchitecture,
  inspectExecutableBytes,
} from './release-architecture.mjs';
import {
  createPrivateSmokeProfile,
  createSmokeChildEnvironment,
  removePrivateSmokeProfile,
} from './packaged-smoke-support.mjs';

const EXECUTABLE = 'propr-desktop';
const APP_ID = 'dev.propr.desktop';
const PROCESS_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 64 * 1024;
const COLD_MANUAL = 'propr://connect?api=http%3A%2F%2Flocalhost%3A44111';
const COLD_TUNNEL = 'propr://connect?api=https%3A%2F%2Ft-native-relaunch.propr.dev';
const WARM_MANUAL = 'propr://connect?api=http%3A%2F%2F127.0.0.1%3A44112';
const WARM_TUNNEL = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
const WARM_OPEN = 'propr://open?path=%2Ftasks%3Fstatus%3Dopen';
const REQUIRED_FIRST_EVENTS = [
  'desktop.smoke.authorized',
  'desktop.native.identity_verified',
  'desktop.deeplink.cold_manual_once',
  'desktop.native.secure_storage_enforced',
  'desktop.native.profile_fresh',
  'desktop.renderer.ready',
  'desktop.deeplink.warm_manual_once',
  'desktop.deeplink.warm_tunnel_once',
  'desktop.deeplink.warm_open_once',
  'desktop.deeplink.rejected_malformed',
  'desktop.deeplink.rejected_oversized',
  'desktop.deeplink.rejected_unsafe_scheme',
  'desktop.deeplink.confirmation_required',
  'desktop.app.shutdown',
];
const REQUIRED_RELAUNCH_EVENTS = [
  'desktop.smoke.authorized',
  'desktop.native.identity_verified',
  'desktop.deeplink.cold_tunnel_once',
  'desktop.native.profile_preserved',
  'desktop.deeplink.confirmation_required',
  'desktop.renderer.ready',
  'desktop.app.shutdown',
];

export const parseArguments = args => {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Native artifact lifecycle arguments are missing, duplicated, or malformed');
    }
    values.set(name, value);
  }
  const platform = values.get('--platform');
  const arch = values.get('--arch');
  const version = values.get('--version');
  const artifactDirectory = values.get('--artifact-directory');
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')
    || !artifactDirectory || values.size !== 4) {
    throw new Error('Native artifact lifecycle target is invalid');
  }
  return { platform, arch, version, artifactDirectory: resolve(artifactDirectory) };
};

const appendBounded = (current, chunk) => {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= OUTPUT_CAP ? next : next.subarray(next.length - OUTPUT_CAP);
};

const run = (file, args, { cwd, env, timeout = COMMAND_TIMEOUT_MS, input } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, {
    cwd,
    env,
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.once('error', error => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new Error(`${basename(file)} failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
      return;
    }
    resolveRun({ stdout, stderr });
  });
});

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const inspectStagedArtifact = async ({ artifact, kind, target, workRoot }) => {
  if (kind !== 'dmg') {
    return inspectArtifactArchitecture({ path: artifact, kind, platform: target.platform, arch: target.arch });
  }
  const privatePath = join(workRoot, 'held-artifact.dmg');
  await copyFile(artifact, privatePath, fsConstants.COPYFILE_EXCL);
  await chmod(privatePath, 0o600);
  const handle = await open(privatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const heldArtifact = createHeldDmgArtifact(handle, 'staged native lifecycle DMG', privatePath);
    return await inspectArtifactArchitecture({
      heldArtifact,
      kind,
      platform: target.platform,
      arch: target.arch,
    });
  } finally {
    await handle.close();
    await rm(privatePath, { force: true });
  }
};

const canonicalArtifact = ({ directory, platform, arch, version, kind }) => join(
  directory,
  `ProPR-Desktop-${version}-${platform === 'darwin' ? 'macos' : 'linux'}-${arch}.${kind}`,
);

export const assertArtifactSet = async target => {
  const expectedKinds = target.platform === 'linux' ? ['deb', 'rpm', 'zip'] : ['dmg', 'zip'];
  const entries = await readdir(target.artifactDirectory, { withFileTypes: true });
  for (const kind of expectedKinds) {
    const path = canonicalArtifact({ directory: target.artifactDirectory, ...target, kind });
    const entry = entries.find(candidate => candidate.name === basename(path));
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Native lifecycle requires exactly the canonical staged ${kind} artifact`);
    }
  }
  const unexpected = entries.filter(entry => {
    if (entry.name === 'release-fragment.json') return false;
    return !expectedKinds.some(kind => entry.name === basename(canonicalArtifact({
      directory: target.artifactDirectory, ...target, kind,
    })));
  });
  if (unexpected.length) throw new Error('Native lifecycle artifact directory contains an unexpected or duplicate identity');
  return expectedKinds;
};

const assertSafeExtractedTree = async root => {
  const canonicalRoot = await realpath(root);
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        const fromRoot = relative(canonicalRoot, target);
        if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw new Error('Native artifact contains a symlink escaping its install root');
        }
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (!entry.isFile()) {
        throw new Error('Native artifact contains an unsupported filesystem entry');
      }
    }
  };
  await visit(root);
};

const extractRpm = async (artifact, root) => {
  await new Promise((resolveExtraction, reject) => {
    const converter = spawn('/usr/bin/rpm2cpio', [artifact], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const extractor = spawn(
      '/usr/bin/cpio',
      ['--extract', '--make-directories', '--no-absolute-filenames', '--quiet'],
      { cwd: root, shell: false, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    converter.stdout.pipe(extractor.stdin);
    let failure;
    let diagnostics = Buffer.alloc(0);
    converter.stderr.on('data', chunk => { diagnostics = appendBounded(diagnostics, chunk); });
    extractor.stderr.on('data', chunk => { diagnostics = appendBounded(diagnostics, chunk); });
    converter.once('error', error => { failure = error; extractor.kill('SIGKILL'); });
    extractor.once('error', error => { failure = error; converter.kill('SIGKILL'); });
    converter.once('close', code => {
      if (code !== 0 && !failure) {
        failure = new Error(`rpm2cpio failed with code ${code ?? 'null'}`);
        extractor.kill('SIGKILL');
      }
    });
    const timer = setTimeout(() => {
      failure = new Error('RPM extraction deadline expired');
      converter.kill('SIGKILL');
      extractor.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);
    extractor.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`cpio failed with code ${code ?? 'null'}`));
      else if (diagnostics.length !== 0) reject(new Error('RPM extraction emitted unexpected diagnostics'));
      else resolveExtraction();
    });
  });
};

const locateApplication = async ({ platform, arch, kind, installRoot }) => {
  if (platform === 'linux') {
    const packagePayload = join(installRoot, 'usr', 'lib', EXECUTABLE);
    const zipPayload = join(installRoot, `propr-desktop-linux-${arch}`);
    const applicationRoot = kind === 'zip' ? zipPayload : packagePayload;
    return {
      applicationRoot,
      executable: join(applicationRoot, EXECUTABLE),
      desktopFile: kind === 'zip' ? null : join(installRoot, 'usr', 'share', 'applications', `${EXECUTABLE}.desktop`),
    };
  }
  const candidates = (await readdir(installRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (candidates.length !== 1) throw new Error('Native macOS artifact has a missing or duplicate application identity');
  const applicationRoot = join(installRoot, candidates[0].name);
  return {
    applicationRoot,
    executable: join(applicationRoot, 'Contents', 'MacOS', EXECUTABLE),
    desktopFile: null,
  };
};

const extractArtifact = async ({ artifact, kind, target, installRoot, mountRoot }) => {
  if (kind === 'deb') {
    await run('/usr/bin/dpkg-deb', ['--extract', artifact, installRoot]);
  } else if (kind === 'rpm') {
    await extractRpm(artifact, installRoot);
  } else if (kind === 'zip' && target.platform === 'linux') {
    await run('/usr/bin/unzip', ['-q', artifact, '-d', installRoot]);
  } else if (kind === 'zip') {
    await run('/usr/bin/ditto', ['-x', '-k', artifact, installRoot]);
  } else {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountRoot, artifact]);
    const applications = (await readdir(mountRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (applications.length !== 1) throw new Error('Mounted DMG has a missing or duplicate application identity');
    await run('/usr/bin/ditto', [join(mountRoot, applications[0].name), join(installRoot, applications[0].name)]);
  }
};

const validateIdentity = async ({ target, kind, application }) => {
  const handle = await open(application.executable, 'r');
  const bytes = Buffer.alloc(4096);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(bytes, 0, bytes.length, 0));
  } finally {
    await handle.close();
  }
  const executable = inspectExecutableBytes(bytes.subarray(0, bytesRead));
  const expectedFormat = target.platform === 'linux' ? 'elf' : 'mach-o';
  if (executable.format !== expectedFormat || executable.architectures.length !== 1
    || executable.architectures[0] !== target.arch) {
    throw new Error('Extracted native artifact executable architecture mismatch');
  }
  const executableStats = await lstat(application.executable);
  if (!executableStats.isFile() || executableStats.isSymbolicLink() || (executableStats.mode & 0o111) === 0) {
    throw new Error('Extracted native artifact executable identity is invalid');
  }
  if (target.platform === 'linux') {
    if (kind !== 'zip') {
      const desktop = await readFile(application.desktopFile, 'utf8');
      if (!/^Name=ProPR Desktop$/m.test(desktop) || !/^Exec=propr-desktop(?:\s+%U)?$/m.test(desktop)
        || !/^MimeType=.*x-scheme-handler\/propr;.*$/m.test(desktop)) {
        throw new Error('Linux package launcher identity or protocol declaration is invalid');
      }
    }
    return;
  }
  const plist = join(application.applicationRoot, 'Contents', 'Info.plist');
  const readPlist = async key => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.toString().trim();
  if (await readPlist('CFBundleIdentifier') !== APP_ID
    || await readPlist('CFBundleShortVersionString') !== target.version
    || await readPlist('CFBundleExecutable') !== EXECUTABLE
    || await readPlist('CFBundleURLTypes.0.CFBundleURLSchemes.0') !== 'propr') {
    throw new Error('macOS application identity, version, or protocol declaration is invalid');
  }
};

const waitForEvents = async (path, events, child, timeout = PROCESS_TIMEOUT_MS) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Native application exited before producing required evidence');
    try {
      const records = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const names = records.map(record => record.event);
      if (records.some(record => Object.keys(record).length !== 1 || typeof record.event !== 'string')) {
        throw new Error('Native application emitted secret-capable evidence fields');
      }
      if (events.every(event => names.includes(event))) return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error('Native application evidence deadline expired');
};

const signalApplicationGroup = (child, signal) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};

const assertApplicationGroupGone = async child => {
  if (!child.pid) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  signalApplicationGroup(child, 'SIGKILL');
  throw new Error('Native application left a process in its owned process group');
};

const waitForExit = (child, timeout = PROCESS_TIMEOUT_MS) => new Promise((resolveExit, reject) => {
  const complete = (code, signal) => {
    void assertApplicationGroupGone(child).then(() => {
      if (code === 0) resolveExit();
      else reject(new Error(`Native application exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    }, reject);
  };
  if (child.exitCode !== null) {
    complete(child.exitCode, child.signalCode);
    return;
  }
  const timer = setTimeout(() => {
    signalApplicationGroup(child, 'SIGKILL');
    reject(new Error('Native application shutdown deadline expired'));
  }, timeout);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    complete(code, signal);
  });
});

const startApplication = (application, args, env, cwd) => spawn(application.executable, args, {
  cwd,
  env,
  detached: true,
  shell: false,
  stdio: ['ignore', 'ignore', 'ignore'],
});

const dispatchDirect = async (application, userData, link, env) => {
  const child = startApplication(application, [`--user-data-dir=${userData}`, link], env, dirname(application.applicationRoot));
  await waitForExit(child, 15_000);
};

const linuxProtocolDispatch = async ({ application, profile, link, env }) => {
  if (!application.desktopFile) {
    await dispatchDirect(application, profile.userData, link, env);
    return 'direct-second-instance; ZIP has no OS launcher registration';
  }
  const applications = join(profile.xdgData, 'applications');
  await mkdir(applications, { recursive: true, mode: 0o700 });
  const registered = join(applications, `${EXECUTABLE}.desktop`);
  const source = await readFile(application.desktopFile, 'utf8');
  const relocated = source.replace(/^Exec=.*$/m, `Exec=${application.executable} --user-data-dir=${profile.userData} %U`);
  if (relocated === source) throw new Error('Linux launcher relocation did not replace exactly one Exec declaration');
  await writeFile(registered, relocated, { mode: 0o600 });
  await run('/usr/bin/update-desktop-database', [applications], { env });
  await run('/usr/bin/xdg-mime', ['default', `${EXECUTABLE}.desktop`, 'x-scheme-handler/propr'], { env });
  const query = await run('/usr/bin/xdg-mime', ['query', 'default', 'x-scheme-handler/propr'], { env });
  if (query.stdout.toString().trim() !== `${EXECUTABLE}.desktop`) {
    throw new Error('Linux native protocol registration query did not resolve the installed launcher');
  }
  await run('/usr/bin/gio', ['open', link], { env, timeout: 15_000 });
  return 'xdg-mime-registration+gio-dispatch (CI-relocated package launcher)';
};

const macProtocolDispatch = async ({ application, link, env }) => {
  const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  await run(launchServices, ['-f', application.applicationRoot], { env });
  await run('/usr/bin/open', ['-b', APP_ID, link], { env, timeout: 15_000 });
  return 'LaunchServices-registration+open-bundle-dispatch';
};

const assertProfileAuthority = async profile => {
  const desktop = join(profile.userData, 'desktop');
  const state = join(desktop, 'profiles.json');
  const [rootStats, desktopStats, stateStats] = await Promise.all([lstat(profile.root), lstat(desktop), lstat(state)]);
  if ((rootStats.mode & 0o777) !== 0o700 || (desktopStats.mode & 0o777) !== 0o700
    || (stateStats.mode & 0o777) !== 0o600 || stateStats.isSymbolicLink()) {
    throw new Error('Native profile state did not retain 0700/0600 authority');
  }
  const contents = await readFile(state, 'utf8');
  if (/credential|token|password|secret/i.test(contents)) {
    throw new Error('Native non-secret profile state contains a secret-bearing field');
  }
};

const createProfileApi = async () => {
  const server = createServer((request, response) => {
    const allowed = request.method === 'GET'
      && ['/api/compatibility', '/api/desktop/discovery'].includes(request.url ?? '')
      && request.headers.origin === 'propr-app://renderer';
    response.writeHead(allowed ? 200 : 403, {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': 'propr-app://renderer',
      'Content-Type': 'application/json',
    });
    response.end(request.url === '/api/desktop/discovery'
      ? '{"product":"ProPR","desktopAuthentication":{"protocolVersion":1}}'
      : '{"profileEndpoint":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native profile API did not bind safely');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const closeServer = async server => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
};

const defaultUserDataCandidates = target => {
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error('Native lifecycle runner home is invalid');
  const applicationNames = [EXECUTABLE, 'ProPR Desktop'];
  return target.platform === 'darwin'
    ? applicationNames.flatMap(name => [
        join(home, 'Library', 'Application Support', name),
        join(home, 'Library', 'Logs', name),
      ])
    : applicationNames.flatMap(name => [join(home, '.config', name), join(home, '.cache', name)]);
};

const assertDefaultUserDataUntouched = async target => {
  for (const path of defaultUserDataCandidates(target)) {
    try {
      await lstat(path);
      throw new Error('Native lifecycle wrote outside the isolated user-data root');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
};

const lifecycleForArtifact = async ({ target, kind, artifact, report }) => {
  const workRoot = await mkdtemp(join(tmpdir(), `propr-native-${kind}-`));
  await chmod(workRoot, 0o700);
  const installRoot = join(workRoot, 'install');
  const mountRoot = join(workRoot, 'mount');
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(mountRoot, { mode: 0o700 });
  const beforeDigest = await digest(artifact);
  const profile = await createPrivateSmokeProfile(workRoot);
  const profileApi = await createProfileApi();
  let application;
  let mounted = false;
  try {
    await assertDefaultUserDataUntouched(target);
    await inspectStagedArtifact({ artifact, kind, target, workRoot });
    await extractArtifact({ artifact, kind, target, installRoot, mountRoot });
    mounted = kind === 'dmg';
    application = await locateApplication({ ...target, kind, installRoot });
    await assertSafeExtractedTree(installRoot);
    await validateIdentity({ target, kind, application });
    if (target.platform === 'linux') {
      const sandbox = join(application.applicationRoot, 'chrome-sandbox');
      await run('/usr/bin/sudo', ['/usr/bin/chown', 'root:root', sandbox]);
      await run('/usr/bin/sudo', ['/usr/bin/chmod', '4755', sandbox]);
    }

    const baseEnvironment = await createSmokeChildEnvironment({
      profile,
      profileApiUrl: profileApi.url,
    });
    const firstEnvironment = Object.freeze({
      ...baseEnvironment,
      PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE: 'first',
      PROPR_DESKTOP_NATIVE_EXPECTED_ARCH: target.arch,
      PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM: target.platform,
      PROPR_DESKTOP_NATIVE_EXPECTED_VERSION: target.version,
    });
    const dispatchEnvironment = { ...baseEnvironment };
    delete dispatchEnvironment.PROPR_DESKTOP_SMOKE_TEST;
    delete dispatchEnvironment.PROPR_DESKTOP_SMOKE_PROFILE_API_URL;

    const first = startApplication(application, [
      '--propr-smoke-test',
      `--user-data-dir=${profile.userData}`,
      COLD_MANUAL,
    ], firstEnvironment, workRoot);
    const firstEvidence = join(profile.userData, 'application.smoke-evidence.first.jsonl');
    await waitForEvents(firstEvidence, ['desktop.renderer.ready', 'desktop.deeplink.cold_manual_once'], first);
    await dispatchDirect(application, profile.userData, WARM_MANUAL, dispatchEnvironment);
    const protocol = target.platform === 'linux'
      ? await linuxProtocolDispatch({ application, profile, link: WARM_TUNNEL, env: dispatchEnvironment })
      : await macProtocolDispatch({ application, link: WARM_TUNNEL, env: dispatchEnvironment });
    await dispatchDirect(application, profile.userData, WARM_OPEN, dispatchEnvironment);
    await dispatchDirect(application, profile.userData, 'native-evidence-malformed', dispatchEnvironment);
    await dispatchDirect(application, profile.userData, 'https://native-evidence.invalid/unsafe', dispatchEnvironment);
    await dispatchDirect(
      application,
      profile.userData,
      `propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev%2F${'a'.repeat(2_100)}`,
      dispatchEnvironment,
    );
    await waitForExit(first);
    await waitForEvents(firstEvidence, REQUIRED_FIRST_EVENTS, { exitCode: null });
    await assertProfileAuthority(profile);

    const relaunchEnvironment = Object.freeze({
      ...baseEnvironment,
      PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE: 'relaunch',
      PROPR_DESKTOP_NATIVE_EXPECTED_ARCH: target.arch,
      PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM: target.platform,
      PROPR_DESKTOP_NATIVE_EXPECTED_VERSION: target.version,
    });
    const relaunch = startApplication(application, [
      '--propr-smoke-test',
      `--user-data-dir=${profile.userData}`,
      COLD_TUNNEL,
    ], relaunchEnvironment, workRoot);
    await waitForExit(relaunch);
    await waitForEvents(
      join(profile.userData, 'application.smoke-evidence.relaunch.jsonl'),
      REQUIRED_RELAUNCH_EVENTS,
      { exitCode: null },
    );
    await assertProfileAuthority(profile);
    if (await digest(artifact) !== beforeDigest) throw new Error('Native lifecycle mutated the staged artifact bytes');
    await assertDefaultUserDataUntouched(target);
    report.push({ kind, protocol, lifecycle: 'extract-or-mount-copy/launch/shutdown/relaunch/remove' });
  } finally {
    await closeServer(profileApi.server).catch(() => undefined);
    if (target.platform === 'darwin' && application) {
      const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
      await run(launchServices, ['-u', application.applicationRoot]).catch(() => undefined);
    }
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mountRoot]).catch(() => undefined);
    if (target.platform === 'linux' && application) {
      await run('/usr/bin/sudo', ['/bin/rm', '-f', join(application.applicationRoot, 'chrome-sandbox')]).catch(() => undefined);
    }
    await removePrivateSmokeProfile(profile).catch(() => undefined);
    await rm(installRoot, { recursive: true, force: true });
    await rm(mountRoot, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
    for (const path of [installRoot, profile.root]) {
      try {
        await stat(path);
        throw new Error('Native uninstall/remove left an owned root behind');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
};

export const runNativeArtifactLifecycle = async target => {
  if (hostPlatform() !== target.platform || hostArch() !== target.arch) {
    throw new Error(`Native lifecycle requires ${target.platform}-${target.arch}, got ${hostPlatform()}-${hostArch()}`);
  }
  const kinds = await assertArtifactSet(target);
  const report = [];
  for (const kind of kinds) {
    const artifact = canonicalArtifact({ directory: target.artifactDirectory, ...target, kind });
    await lifecycleForArtifact({ target, kind, artifact, report });
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    target: `${target.platform}-${target.arch}`,
    evidence: report,
    limitations: target.platform === 'linux'
      ? 'ZIP has no OS launcher; its warm dispatch is direct. Package launchers use an isolated CI relocation.'
      : 'Unsigned internal-RC evidence uses local LaunchServices only; signing, notarization, and Gatekeeper assessment are not claimed.',
  }));
};

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await runNativeArtifactLifecycle(parseArguments(process.argv.slice(2)));
