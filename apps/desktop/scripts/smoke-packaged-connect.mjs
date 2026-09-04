import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Server as SocketIOServer } from 'socket.io';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  createIdempotentJourneyFixtureClose,
  preservePrimaryWithCleanup,
  removeAuthorizedConnectFixture,
  runPackagedConnectLifecycle,
} from './packaged-connect-lifecycle.mjs';
import {
  createPackagedConnectLaunchArguments,
  spawnPackagedConnectBinary,
} from './packaged-connect-launch.mjs';
import {
  canonicalizeWindowsFixtureEntry,
  encodedWindowsFixtureAcl,
  windowsPowerShell51Path,
} from './windows-fixture-acl.mjs';
import {
  describeWindowsArtifactFailure,
  packagedConnectArtifactSensitiveNeedles,
  parseWindowsStagedPackageHandoff,
  validateWindowsStagedPackage,
} from './windows-packaged-connect-staging.mjs';

if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
  throw new Error('Packaged Connect discovery smoke requires Darwin, Linux, or Windows');
}
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error('Packaged Connect discovery smoke requires x64 or arm64');
}

let artifactRoot = resolve('out', `propr-desktop-${process.platform}-${process.arch}`);
let binaryPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : join(artifactRoot, process.platform === 'linux' ? 'propr-desktop' : 'propr-desktop.exe');
let resourcesPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'Resources')
  : join(artifactRoot, 'resources');
let unpackedNative = join(resourcesPath, 'app.asar.unpacked', '.vite', 'native', 'prebuilds');
const endpoint = 'https://t-packaged123.propr.dev';
const identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secrets = [
  'tunnel-secret-SENTINEL', 'connector-secret-SENTINEL',
  'relay-secret-SENTINEL', 'github-secret-SENTINEL',
];
const nativeHashes = {
  darwin: {
    arm64: {
      'connect-authority-broker': '75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0',
      'directory-operations.node': '88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615',
    },
    x64: {
      'connect-authority-broker': 'e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b',
      'directory-operations.node': '62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53',
    },
  },
  linux: {
    arm64: {
      'directory-operations.node': '916679f413251c4b23c51167987a874bbbdd9d96991882bfac9093e0ea5fa051',
    },
    x64: {
      'directory-operations.node': '7199378f1c7b443a05c596eae7c66f9a77cc01b4a493c07748df0df1083950f6',
    },
  },
};
let packagedConnectPhase = 'fixture-setup';
let windowsStagedContract;
let windowsStagedHandoff;

const createPackagedJourneyFixture = async () => {
  const pairingId = `dpr_${'P'.repeat(22)}`;
  const deviceSecret = 'D'.repeat(43);
  const activationTicket = 'A'.repeat(43);
  const token = `propr_it_${'T'.repeat(43)}`;
  const receipt = 'R'.repeat(22);
  const requests = [];
  let endpoint;
  let approved = false;
  let active = false;
  let binding;
  let mode = 'success';
  const cors = {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ProPR-Desktop-Transport-Scope',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  const readJson = request => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) {
        rejectBody(new Error('oversized request'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { rejectBody(error); }
    });
    request.on('error', rejectBody);
  });
  const server = createServer(async (request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      origin: request.headers.origin ?? null,
      transportScope: request.headers[DESKTOP_TRANSPORT_SCOPE_HEADER.toLowerCase()] ?? null,
      socketIo: false,
    };
    requests.push(record);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    try {
      if (request.method === 'POST' && request.url?.startsWith('/__packaged/control/')) {
        const requestedMode = request.url.slice('/__packaged/control/'.length);
        if (!['success', 'malformed', 'oversized', 'expiry', 'cancel'].includes(requestedMode)) {
          throw new Error('invalid fixture mode');
        }
        mode = requestedMode;
        approved = false;
        binding = undefined;
        response.writeHead(204, cors);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/__packaged/evidence') {
        const authenticatedRest = requests.filter(item => item.socketIo === false
          && item.url === '/api/auth/user'
          && item.authorization === `Bearer ${token}`
          && item.transportScope === null);
        const authenticatedSockets = requests.filter(item => item.socketIo === true
          && item.authorization === `Bearer ${token}`
          && item.transportScope !== null
          && item.socketAuthScope === item.transportScope);
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          authenticatedRest: authenticatedRest.length,
          authenticatedSockets: authenticatedSockets.length,
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/desktop/discovery') {
        response.writeHead(200, cors);
        if (mode === 'malformed') {
          response.end('{"product":"ProPR"}');
          return;
        }
        if (mode === 'oversized') {
          response.end(`{"ignored":"${'x'.repeat(9 * 1024)}"}`);
          return;
        }
        response.end(JSON.stringify({
          schemaVersion: 1,
          product: 'ProPR',
          version: '0.8.15',
          apiCompatibility: PROPR_API_COMPATIBILITY,
          uiCompatibility: PROPR_UI_COMPATIBILITY,
          canonicalEndpoint: null,
          publicInstanceIdentity: identity,
          desktopAuthentication: {
            protocolVersion: 2,
            browserPairing: true,
            instanceBearerTokens: true,
            socketIoBearerAuthentication: true,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/desktop/pairings') {
        binding = await readJson(request);
        response.writeHead(201, cors);
        response.end(JSON.stringify({
          pairingId,
          deviceSecret,
          approvalUrl: `${endpoint}/api/desktop/pairings/${pairingId}/browser`,
          expiresAt: new Date(Date.now() + (mode === 'expiry' ? 200 : 60_000)).toISOString(),
          interval: 1,
        }));
        return;
      }
      if (request.method === 'GET' && request.url === `/api/desktop/pairings/${pairingId}/browser`) {
        approved = true;
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>Desktop approved</title><p>Approved</p>');
        return;
      }
      if (request.method === 'POST' && request.url === `/api/desktop/pairings/${pairingId}/poll`) {
        const body = await readJson(request);
        if (body.deviceSecret !== deviceSecret || !approved || !binding) throw new Error('pairing not approved');
        if (mode === 'cancel' || mode === 'expiry') {
          response.writeHead(202, cors);
          response.end('{"status":"pending","interval":1}');
          return;
        }
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          status: 'provisional', token, tokenType: 'Bearer', activationTicket,
          activationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          instanceId: binding.instanceId,
          origin: binding.origin,
          scope: binding.scope,
          credentialGeneration: binding.credentialGeneration,
        }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/desktop/pairings/${pairingId}/activate`) {
        const body = await readJson(request);
        if (body.deviceSecret !== deviceSecret || body.activationTicket !== activationTicket) {
          throw new Error('activation binding rejected');
        }
        active = true;
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          status: 'active', receipt, activatedAt: new Date().toISOString(), expiresAt: null,
        }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/api/desktop/tokens/current') {
        active = false;
        response.writeHead(204, cors);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/api/auth/user'
        && active && record.authorization === `Bearer ${token}`) {
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          id: 'packaged-owner', login: 'packaged-owner', username: 'packaged-owner',
          displayName: 'Packaged Owner', email: null, avatarUrl: null,
          role: 'admin', permissions: [], authorizationSource: 'bootstrap',
        }));
        return;
      }
      if (request.method === 'GET' && record.authorization === `Bearer ${token}`) {
        response.writeHead(200, cors);
        response.end('{}');
        return;
      }
    } catch {
      response.writeHead(400, cors);
      response.end('{"code":"INVALID_SMOKE_REQUEST"}');
      return;
    }
    response.writeHead(401, cors);
    response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
  });
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    transports: ['websocket'],
    cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false },
  });
  io.of('/').use((socket, next) => {
    const scopes = new URL(socket.handshake.url, 'http://fixture.invalid')
      .searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
    requests.push({
      method: 'SOCKET.IO',
      url: socket.handshake.url,
      authorization: socket.handshake.headers.authorization ?? null,
      origin: socket.handshake.headers.origin ?? null,
      transportScope: scopes[0] ?? null,
      socketAuthScope: socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY] ?? null,
      socketIo: true,
    });
    if (!active || socket.handshake.headers.authorization !== `Bearer ${token}`
      || scopes.length !== 1 || socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY] !== scopes[0]) {
      const error = new Error('INVALID_INSTANCE_TOKEN');
      error.data = { code: 'INVALID_INSTANCE_TOKEN' };
      next(error);
      return;
    }
    next();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Packaged journey fixture did not bind');
  endpoint = `http://127.0.0.1:${address.port}`;
  const close = createIdempotentJourneyFixtureClose({
    closeSocketServer: () => io.close(),
    closeHttpServer: () => new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    }),
  });
  return {
    endpoint,
    requests,
    secrets: [deviceSecret, activationTicket, token],
    close,
  };
};

const directoryContainsPlaintext = async (root, needles) => {
  const visit = async path => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (await visit(child)) return true;
      } else if (entry.isFile()) {
        const contents = await readFile(child);
        if (needles.some(needle => contents.includes(Buffer.from(needle)))) return true;
      }
    }
    return false;
  };
  return visit(root);
};

if (process.platform === 'win32') {
  try {
    packagedConnectPhase = 'staged-contract';
    [windowsStagedHandoff] = process.argv.slice(2);
    windowsStagedContract = parseWindowsStagedPackageHandoff(process.argv.slice(2));
    const staged = await validateWindowsStagedPackage({
      environment: {
        RUNNER_TEMP: windowsStagedContract.runnerTemp,
        PROPR_DESKTOP_CONNECT_STAGING_PARENT: windowsStagedContract.parent,
        PROPR_DESKTOP_CONNECT_STAGING_LEAF: windowsStagedContract.leaf,
      },
      expectedArchitecture: process.arch,
    });
    artifactRoot = staged.root;
    binaryPath = staged.executable;
    resourcesPath = staged.resources;
    unpackedNative = join(resourcesPath, 'app.asar.unpacked', '.vite', 'native', 'prebuilds');
  } catch (error) {
    const failure = describeWindowsArtifactFailure(error, packagedConnectPhase);
    process.stderr.write(`${JSON.stringify({
      event: 'packaged_connect.artifact_failed',
      ...failure,
    })}\n`);
    process.exit(1);
  }
}

const authorityMechanism = () => {
  if (process.platform === 'darwin') return 'packaged-broker';
  if (process.platform === 'linux') return 'in-process-native-addon';
  return 'inherited-standard-handle';
};

const windowsTreeKiller = async () => {
  if (process.platform !== 'win32') return undefined;
  const powershell = windowsPowerShell51Path();
  const candidate = join(dirname(dirname(dirname(powershell))), 'taskkill.exe');
  const stats = await lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Windows tree termination tool failed validation');
  }
  const canonical = await realpath(candidate);
  if (canonical.toLocaleLowerCase('en-US') !== candidate.toLocaleLowerCase('en-US')) {
    throw new Error('Windows tree termination tool failed validation');
  }
  return canonical;
};

const assertCanonicalParents = async candidate => {
  let parent = dirname(candidate);
  while (true) {
    const named = await lstat(parent);
    if (!named.isDirectory() || named.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error('Packaged native candidate has noncanonical parent ancestry');
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
};

const assertPackageAuthority = async () => {
  if (process.platform === 'win32') {
    try {
      await lstat(unpackedNative);
      throw new Error('Windows package unexpectedly contains an unused native authority helper');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  const selected = join(unpackedNative, `${process.platform}-${process.arch}`);
  for (const [name, expected] of Object.entries(nativeHashes[process.platform][process.arch])) {
    const candidate = join(selected, name);
    await assertCanonicalParents(candidate);
    const named = await lstat(candidate);
    if (!named.isFile()
      || named.isSymbolicLink()
      || (named.mode & 0o022) !== 0
      || (name === 'connect-authority-broker' && (named.mode & 0o111) === 0)) {
      throw new Error('Packaged native authority artifact failed type or mode verification');
    }
    const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
    if (digest !== expected) throw new Error('Packaged native authority artifact failed integrity verification');
  }
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  try {
    await lstat(join(unpackedNative, `${process.platform}-${otherArch}`));
    throw new Error('Package contains unselected architecture authority artifacts');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const windowsFixtureFailure = (phase, category) => {
  const error = new Error(`Could not prepare the ordinary-user Windows authority fixture [phase=${phase} category=${category}]`);
  error.stack = error.message;
  throw error;
};

const protectWindowsEntries = entries => {
  const powershell = windowsPowerShell51Path();
  const membership = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
  ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  if (membership.error || membership.signal || membership.status !== 0 || membership.stderr) {
    windowsFixtureFailure('membership', 'process-failed');
  }
  if (membership.stdout !== 'False') windowsFixtureFailure('membership', 'administrator');
  for (const entry of entries) {
    const canonicalEntry = canonicalizeWindowsFixtureEntry({
      entryKind: entry.kind,
      entryPath: entry.path,
      powershellPath: powershell,
    });
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWindowsFixtureAcl,
    ], {
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        PROPR_FIXTURE_ACL_KIND: entry.kind,
        PROPR_FIXTURE_ACL_PATH: canonicalEntry.path,
      },
    });
    if (result.error || result.signal) windowsFixtureFailure('powershell-invocation', 'process-failed');
    if (result.stdout.length !== 0) windowsFixtureFailure('powershell-invocation', 'powershell-stdout');
    if (result.stderr.length !== 0) windowsFixtureFailure('powershell-invocation', 'powershell-stderr');
    const failurePhase = new Map([
      [40, 'rooted-path'],
      [41, 'item-type'],
      [42, 'current-sid-lookup'],
      [43, 'sid-construction'],
      [44, 'access-control-read'],
      [45, 'dacl-protection'],
      [46, 'rule-create'],
      [47, 'rule-apply'],
      [48, 'full-path'],
      [49, 'canonical-equality'],
      [50, 'outer-invocation'],
    ]).get(result.status);
    if (failurePhase) windowsFixtureFailure(failurePhase, 'operation-failed');
    if (result.status !== 0) windowsFixtureFailure('powershell-invocation', 'unexpected-exit');
  }
};

let canonicalTemp;
let fixture;
let generatedFixtureLeaf;
let journeyFixture;
let outcome = { ok: false, category: 'fixture-setup', capture: 'complete', records: [] };
let failurePhase = 'fixture-setup';
try {
  canonicalTemp = await realpath(tmpdir());
  fixture = await mkdtemp(join(canonicalTemp, 'propr-desktop-connect-smoke-'));
  generatedFixtureLeaf = basename(fixture);
  const configRoot = join(fixture, 'config');
  const stackRoot = join(fixture, 'stack-private-path-SENTINEL');
  const dataRoot = join(stackRoot, 'data');
  const identityPath = join(dataRoot, 'public-instance-identity.json');
  const envPath = join(stackRoot, '.env');
  const configPath = join(configRoot, 'config.json');
  const userDataPath = join(fixture, 'desktop-user-data');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify({ stackRoot })}\n`, { mode: 0o600 });
  await writeFile(envPath, [
    'PROPR_STACK=packaged-connect-smoke',
    'PROPR_INSTANCE_ID=packaged123',
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    'PROPR_UI_TUNNEL_ENABLED=true',
    `PROPR_UI_TUNNEL_TOKEN=${secrets[0]}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(identityPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: identity })}\n`, { mode: 0o644 });
  if (process.platform !== 'win32') {
    await Promise.all([
      chmod(fixture, 0o700), chmod(configRoot, 0o700), chmod(stackRoot, 0o700),
      chmod(dataRoot, 0o700), chmod(userDataPath, 0o700), chmod(configPath, 0o600),
      chmod(envPath, 0o600), chmod(identityPath, 0o644),
    ]);
  } else {
    protectWindowsEntries([
      { path: stackRoot, kind: 'directory' },
      { path: dataRoot, kind: 'directory' },
      { path: envPath, kind: 'file' },
      { path: identityPath, kind: 'file' },
    ]);
  }
  if (relative(canonicalTemp, fixture) !== generatedFixtureLeaf
    || relative(canonicalTemp, configRoot) !== join(generatedFixtureLeaf, 'config')) {
    throw new Error('Connect smoke fixture escaped its fixed root');
  }
  if (process.platform !== 'win32') journeyFixture = await createPackagedJourneyFixture();
  failurePhase = 'package-validation';
  await assertPackageAuthority();
  const treeKillerPath = await windowsTreeKiller();
  const sensitiveNeedles = [
    ...secrets, fixture, configRoot, stackRoot, identity,
    ...(journeyFixture?.secrets ?? []),
    ...packagedConnectArtifactSensitiveNeedles({
      platform: process.platform,
      artifactRoot,
      binaryPath,
      stagedContract: windowsStagedContract,
      stagedHandoff: windowsStagedHandoff,
    }),
    'S-1-5-', 'volumeSerialNumber', 'fileId', 'authorityDiagnostic',
  ];
  const childEnvironment = {
    ...process.env,
    PROPR_DESKTOP_CONNECT_SMOKE_TEST: '1',
    PROPR_DESKTOP_CONNECT_SMOKE_CONFIG_ROOT: configRoot,
    PROPR_CONNECTOR_TOKEN: secrets[1],
    PROPR_RELAY_TOKEN: secrets[2],
    GITHUB_TOKEN: secrets[3],
    ...(journeyFixture ? {
      PROPR_DESKTOP_CONNECT_JOURNEY_ENDPOINT: journeyFixture.endpoint,
    } : {}),
  };
  delete childEnvironment.PROPR_DESKTOP_CONNECT_STAGING_PARENT;
  delete childEnvironment.PROPR_DESKTOP_CONNECT_STAGING_LEAF;
  const launchArguments = createPackagedConnectLaunchArguments({
    platform: process.platform,
    userDataPath,
  });
  const spawnLifecycleProcess = (executable, args, options) => {
    if (executable !== binaryPath) return spawn(executable, args, options);
    const child = spawnPackagedConnectBinary({
      binaryPath,
      launchArguments: args,
      options: {
        ...options,
        env: options.env,
      },
      spawn,
    });
    return child;
  };
  failurePhase = 'lifecycle-internal';
  const runPhase = async phase => await runPackagedConnectLifecycle({
      binaryPath,
      args: launchArguments,
      platform: process.platform,
      arch: process.arch,
      authorityMechanism: authorityMechanism(),
      sensitiveNeedles,
      treeKillerPath,
      env: {
        ...childEnvironment,
        ...(journeyFixture ? { PROPR_DESKTOP_CONNECT_JOURNEY_PHASE: phase } : {}),
      },
      spawn: spawnLifecycleProcess,
    });
  outcome = await runPhase('pair');
  if (outcome.ok && journeyFixture) {
    outcome = await runPhase('reprobe');
    if (outcome.ok) {
      const applicationRequests = journeyFixture.requests.filter(request => request.method !== 'OPTIONS');
      const discoveries = applicationRequests.filter(request => request.url === '/api/desktop/discovery');
      const bootstrap = applicationRequests.filter(request =>
        request.url === '/api/desktop/pairings'
        || /^\/api\/desktop\/pairings\/[^/]+\/(?:poll|activate)$/u.test(request.url ?? '')
        || /\/browser$/u.test(request.url ?? ''));
      const pairingStarts = bootstrap.filter(request => request.url === '/api/desktop/pairings');
      const pairingBrowsers = bootstrap.filter(request => /\/browser$/u.test(request.url ?? ''));
      const pairingPolls = bootstrap.filter(request => /\/poll$/u.test(request.url ?? ''));
      const pairingActivations = bootstrap.filter(request => /\/activate$/u.test(request.url ?? ''));
      const authenticatedRest = applicationRequests.filter(request =>
        request.socketIo === false
        && request.url === '/api/auth/user'
        && request.authorization === `Bearer ${journeyFixture.secrets[2]}`);
      const authenticatedSockets = applicationRequests.filter(request =>
        request.socketIo === true
        && request.authorization === `Bearer ${journeyFixture.secrets[2]}`
        && request.transportScope !== null
        && request.socketAuthScope === request.transportScope);
      const socketScopes = new Set(authenticatedSockets.map(request =>
        new URL(request.url, 'http://fixture.invalid').searchParams.get(DESKTOP_TRANSPORT_SCOPE_QUERY)));
      const restScopes = new Set(authenticatedRest.map(request => request.transportScope));
      const firstBearer = applicationRequests.findIndex(request => request.authorization !== null);
      const firstIdentity = applicationRequests.findIndex(request => request.url === '/api/desktop/discovery');
      const plaintextPersisted = await directoryContainsPlaintext(userDataPath, journeyFixture.secrets);
      if (discoveries.length !== 8
        || discoveries.some(request => request.authorization !== null)
        || pairingStarts.length !== 3
        || pairingBrowsers.length !== 3
        || pairingPolls.length < 3
        || pairingActivations.length !== 1
        || bootstrap.some(request => request.authorization !== null)
        || authenticatedRest.length < 2
        || authenticatedSockets.length < 2
        || restScopes.size !== 1
        || !restScopes.has(null)
        || socketScopes.has(null)
        || socketScopes.size < 2
        || plaintextPersisted
        || firstIdentity < 0
        || firstBearer <= firstIdentity) {
        outcome = { ok: false, category: 'journey-evidence', capture: 'complete', records: [] };
      }
    }
  }
} catch {
  outcome = { ok: false, category: failurePhase, capture: 'complete', records: [] };
} finally {
  let cleanup = { ok: true };
  if (journeyFixture) {
    try { await journeyFixture.close(); }
    catch { cleanup = { ok: false, category: 'fixture-cleanup-failed' }; }
  }
  if (fixture && canonicalTemp && generatedFixtureLeaf) {
    const directoryCleanup = await removeAuthorizedConnectFixture({
      fixture,
      canonicalTemporaryParent: canonicalTemp,
      generatedLeaf: generatedFixtureLeaf,
    });
    if (!directoryCleanup.ok) cleanup = directoryCleanup;
  }
  if (!cleanup.ok) {
    outcome = preservePrimaryWithCleanup(outcome, cleanup);
  }
  if (outcome.ok && cleanup.ok) {
    process.stdout.write(`Packaged Connect discovery passed for ${process.platform}-${process.arch}: ${authorityMechanism()}.\n`);
  } else {
    process.stderr.write(`${JSON.stringify({
      event: 'packaged_connect.smoke_failed',
      category: outcome.category,
      capture: outcome.capture,
      records: outcome.records,
      ...(outcome.secondary?.length ? { secondary: outcome.secondary } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}
