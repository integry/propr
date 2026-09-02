import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { Server as SocketIOServer } from 'socket.io';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';
import { assertPackagedLayout, parseEventLayout, parseEventRecord } from './packaged-layout.mjs';
import {
  createPackagedSmokeLaunch,
  LAYOUT_READY_EVENT,
  MVP_FLOWS_PROOF,
  PACKAGED_SMOKE_LAUNCH_MODES,
  REDUCED_NATIVE_WINDOW_READY_EVENT,
  TRANSPORT_PROOF,
  TRANSPORT_SMOKE_ENVIRONMENT_NAMES,
} from './packaged-smoke-plan.mjs';
import {
  assertPackagedNativeWindowSizing,
  createPrivateSmokeProfile,
  createSmokeChildEnvironment,
  removePrivateSmokeProfile,
} from './packaged-smoke-support.mjs';

const MAIN_PROCESS_ERROR_MARKERS = [
  'desktop.main_process.uncaught_exception',
  'A JavaScript error occurred in the main process',
  'Uncaught Exception:',
];
const TIMEOUT_MS = 45_000;
const RELEASE_GUARD_TIMEOUT_MS = 30_000;
const INVALID_INSTANCE_TOKEN = 'INVALID_INSTANCE_TOKEN';
const binaryPath = process.platform === 'darwin'
  ? resolve('out', `propr-desktop-darwin-${process.arch}`, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : resolve(
      'out',
      `propr-desktop-${process.platform}-${process.arch}`,
      `propr-desktop${process.platform === 'win32' ? '.exe' : ''}`,
    );
const inspectOnly = process.argv.includes('--inspect-only');

if (process.platform === 'win32') {
  const resources = resolve('out', `propr-desktop-win32-${process.arch}`, 'resources');
  const entries = (await readdir(resources)).map(name => name.toLocaleLowerCase('en-US'));
  if (entries.some(name => name.includes('windows-authority') || name.includes('windows-update-authority'))) {
    throw new Error('Packaged Windows MVP contains a deferred update authority resource');
  }
}

await access(binaryPath);

const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);
const actualFuses = await getCurrentFuseWire(binaryPath);
if (actualFuses.version !== FuseVersion.V1) {
  throw new Error(`Expected fuse wire version ${FuseVersion.V1}, received ${actualFuses.version}`);
}
for (const [fuse, expectedState] of expectedFuses) {
  const actualState = actualFuses[fuse];
  if (actualState !== expectedState) {
    throw new Error(
      `Unexpected ${FuseV1Options[fuse]} fuse state: expected ${FuseState[expectedState]}, received ${FuseState[actualState] ?? actualState}`,
    );
  }
}

if (inspectOnly) {
  console.log(`Packaged ${process.platform}-${process.arch} desktop artifact passed executable and fuse inspection.`);
  process.exit(0);
}
if (process.platform !== 'linux' && process.platform !== 'win32') {
  throw new Error('The packaged transport smoke requires Linux or Windows');
}

const requests = [];
const fixtures = [];
const corsHeaders = {
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, X-ProPR-Desktop-Transport-Scope',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
const discovery = JSON.stringify({
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 2,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
});

const profileApiRequests = [];
const profileApiServer = createServer((request, response) => {
  const record = {
    method: request.method,
    url: request.url,
    origin: request.headers.origin ?? null,
  };
  profileApiRequests.push(record);
  if (
    record.method !== 'GET'
    || !['/api/compatibility', '/api/desktop/discovery'].includes(record.url ?? '')
    || record.origin !== DESKTOP_RENDERER_ORIGIN
  ) {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end('{"error":"CORS origin rejected"}');
    return;
  }
  response.writeHead(200, {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
    'Content-Type': 'application/json',
  });
  response.end(record.url === '/api/desktop/discovery'
    ? '{"product":"ProPR","desktopAuthentication":{"protocolVersion":1}}'
    : '{"profileEndpoint":true}');
});

const listenProfileApiFixture = async () => {
  profileApiServer.listen(0, '127.0.0.1');
  await once(profileApiServer, 'listening');
  const address = profileApiServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Packaged desktop release-guard profile API did not bind to a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
};

const listenFixture = async name => {
  const server = createServer((request, response) => {
    const record = {
      fixture: name,
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      origin: request.headers.origin ?? null,
      socketIo: false,
    };
    requests.push(record);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if (request.url === '/smoke-storage') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>storage fixture</title>');
      return;
    }
    if (request.url === '/smoke-sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
      response.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    if (request.url === '/api/desktop/discovery') {
      response.writeHead(200, { ...corsHeaders, 'Set-Cookie': 'discovery=must-not-persist; HttpOnly; SameSite=None' });
      response.end(discovery);
      return;
    }
    if (request.method === 'DELETE' && request.url === '/api/desktop/tokens/current') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if ((request.url === '/api/auth/user' || request.url === '/api/smoke/rest')
      && /^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')) {
      response.writeHead(200, { ...corsHeaders, 'Set-Cookie': 'remote=must-not-persist; HttpOnly; SameSite=None' });
      response.end(request.url === '/api/auth/user' ? '{"username":"packaged-smoke"}' : '{"ok":true}');
      return;
    }
    response.writeHead(401, corsHeaders);
    response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
  });
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    transports: ['websocket'],
    cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false },
  });
  io.of('/').use((socket, next) => {
    const queryScopes = new URL(socket.handshake.url, 'http://fixture.invalid')
      .searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
    const activationScope = socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY];
    const record = {
      fixture: name,
      method: 'SOCKET.IO',
      url: socket.handshake.url,
      authorization: socket.handshake.headers.authorization ?? null,
      cookie: socket.handshake.headers.cookie ?? null,
      origin: socket.handshake.headers.origin ?? null,
      socketIo: true,
      namespace: socket.nsp.name,
      engineProtocol: socket.conn.protocol,
    };
    requests.push(record);
    if (!/^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')
      || queryScopes.length !== 1 || typeof activationScope !== 'string'
      || activationScope !== queryScopes[0]) {
      const error = new Error(INVALID_INSTANCE_TOKEN);
      error.data = { code: INVALID_INSTANCE_TOKEN };
      next(error);
      return;
    }
    next();
  });
  io.of('/').on('connection', socket => socket.emit('packaged-smoke:connected', { ok: true }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Packaged ${name} fixture did not bind`);
  const fixture = { server, io, origin: `http://127.0.0.1:${address.port}` };
  fixtures.push(fixture);
  return fixture;
};

const scanPathsForSecrets = async (paths, secrets) => {
  const visit = async path => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (await visit(child)) return true;
      } else {
        const bytes = await readFile(child);
        if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) return true;
      }
    }
    return false;
  };
  for (const path of paths) if (await visit(path)) return true;
  return false;
};

let first;
let second;
let profileApiOrigin;
const runs = [];
const smokeProfiles = [];
const shutdownSteps = [
  'admission-closed',
  'ipc-closed',
  'session-closed',
  'protocol-disposed',
  'credentials-dispose-started',
  'authentication-cleared',
  'lifecycle-drain-started',
  'ipc-drain-started',
  'service-drain-finished',
  'profiles-close-started',
  'profiles-close-finished',
  'session-disposed',
  'ipc-disposed',
  'window-destroyed',
  'final-quit',
];

const launch = async mode => {
  const smokeProfile = await createPrivateSmokeProfile();
  smokeProfiles.push(smokeProfile);
  const userDataPath = smokeProfile.userData;
  const transport = mode !== 'release-guard';
  const baseChildEnvironment = await createSmokeChildEnvironment({
    profile: smokeProfile,
    profileApiUrl: transport ? first.origin : profileApiOrigin,
  });
  const dbusSessionAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (process.platform === 'linux' && (
    typeof dbusSessionAddress !== 'string'
    || dbusSessionAddress.length > 4096
    || !/^unix:path=\/[^\0\r\n,]+(?:,guid=[0-9a-f]{32})?$/.test(dbusSessionAddress)
  )) {
    throw new Error('Packaged Linux smoke requires one validated D-Bus session address');
  }
  const launchPlan = createPackagedSmokeLaunch({
    mode,
    platform: process.platform,
    userDataPath,
    baseChildEnvironment,
    firstOrigin: first.origin,
    secondOrigin: second.origin,
    dbusSessionAddress,
  });
  const { childEnvironment, launchArguments, requiredMarkers } = launchPlan;
  if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
    throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
  }
  if (!transport && TRANSPORT_SMOKE_ENVIRONMENT_NAMES.some(name => Object.hasOwn(childEnvironment, name))) {
    throw new Error('Packaged desktop release-guard launch inherited a transport-smoke environment variable');
  }
  const requestStart = requests.length;
  const profileApiRequestStart = profileApiRequests.length;
  let output = '';
  const child = spawn(binaryPath, launchArguments, {
    cwd: smokeProfile.root,
    env: childEnvironment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = chunk => {
    const value = chunk.toString();
    output += value;
    process.stdout.write(value);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const result = await new Promise((resolveResult, reject) => {
    const timeoutMs = transport ? TIMEOUT_MS : RELEASE_GUARD_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Packaged desktop ${mode} smoke exceeded ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal });
    });
  });

  const mainProcessError = MAIN_PROCESS_ERROR_MARKERS.find(marker => output.includes(marker));
  if (mainProcessError) throw new Error(`Packaged desktop reported an uncaught exception (${mainProcessError})`);
  if (result.code !== 0) {
    throw new Error(`Packaged desktop exited with code ${result.code ?? 'null'} (signal ${result.signal ?? 'none'})`);
  }
  const missingMarkers = requiredMarkers.filter(marker => !output.includes(marker));
  if (missingMarkers.length !== 0) {
    throw new Error(`Packaged desktop ${mode} smoke missed required markers: ${missingMarkers.join(', ')}`);
  }
  const runRequests = requests.slice(requestStart);
  if (!transport) {
    const releaseGuardRequests = profileApiRequests.slice(profileApiRequestStart);
    const expectedProfileApiPaths = ['/api/compatibility', '/api/desktop/discovery'];
    if (releaseGuardRequests.length !== expectedProfileApiPaths.length
      || expectedProfileApiPaths.some(path => !releaseGuardRequests.some(request => request.url === path))
      || releaseGuardRequests.some(request => (
        request.method !== 'GET' || request.origin !== DESKTOP_RENDERER_ORIGIN
      ))) {
      throw new Error('Packaged desktop release guard did not make both profile API requests from its exact renderer origin');
    }
    const mvpProof = parseEventRecord(output, MVP_FLOWS_PROOF);
    if (mvpProof?.localProfile !== true
      || mvpProof?.remoteActiveProfile !== true
      || mvpProof?.lifecycleBoundary !== true
      || mvpProof?.connectUiPopulated !== true) {
      throw new Error('Packaged desktop release guard did not prove local/remote profiles, lifecycle, and Connect UI population');
    }
    if (runRequests.length !== 0 || output.includes(TRANSPORT_PROOF)) {
      throw new Error('Packaged desktop release guard unexpectedly entered the transport-smoke branch');
    }
  } else {
    const socketShutdownDeadline = Date.now() + 2_000;
    while (fixtures.some(fixture => fixture.io.of('/').sockets.size !== 0)
      && Date.now() < socketShutdownDeadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    if (fixtures.some(fixture => fixture.io.of('/').sockets.size !== 0)) {
      throw new Error(`Packaged ${mode} shutdown left late authenticated Socket.IO work alive`);
    }
    const expectedBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
    if (!output.includes(`"storageBackend":"${expectedBackend}"`)) {
      throw new Error(`Packaged desktop did not use ${expectedBackend} production credential protection`);
    }
    let previousStep = -1;
    for (const step of shutdownSteps) {
      const marker = `"step":"${step}"`;
      if (output.split(marker).length - 1 !== 1 || output.indexOf(marker) <= previousStep) {
        throw new Error(`Packaged ${mode} shutdown did not run ${step} exactly once in order`);
      }
      previousStep = output.indexOf(marker);
    }
    const forced = output.includes('desktop.app.shutdown_forced');
    if (forced !== (mode === 'forced-timeout')) {
      throw new Error(`Packaged ${mode} forced-timeout evidence was incorrect`);
    }
    if (mode === 'retry' && (!output.includes('desktop.app.shutdown_retry_requested')
      || !output.includes('desktop.app.shutdown_retry'))) {
      throw new Error('Packaged retry did not exercise a repeated prevented before-quit event');
    }
  }
  const packagedLayout = parseEventLayout(output, LAYOUT_READY_EVENT);
  assertPackagedLayout(packagedLayout);
  assertPackagedNativeWindowSizing(packagedLayout);
  assertPackagedNativeWindowSizing(
    parseEventLayout(output, REDUCED_NATIVE_WINDOW_READY_EVENT),
    { requireReducedWorkArea: true },
  );

  if (!transport) {
    runs.push({ mode, userDataPath, output, launchArguments, secrets: [] });
    return;
  }
  const authenticated = runRequests.filter(request => request.authorization?.startsWith('Bearer propr_it_'));
  const secrets = [...new Set(authenticated.map(request => request.authorization.slice('Bearer '.length)))];
  if (secrets.length !== 2) throw new Error(`Expected two ${mode} activation credentials, observed ${secrets.length}`);
  for (const name of ['first', 'second']) {
    const fixtureRequests = authenticated.filter(request => request.fixture === name);
    const namespaceConnections = fixtureRequests.filter(request => request.socketIo);
    if (!fixtureRequests.some(request => request.url === '/api/auth/user')
      || !fixtureRequests.some(request => request.url === '/api/smoke/rest')
      || namespaceConnections.length < (name === 'second' ? 2 : 1)
      || namespaceConnections.some(request => request.namespace !== '/' || request.engineProtocol !== 4)) {
      throw new Error(`Packaged ${mode} ${name} fixture missed REST, Engine.IO, namespace auth, or reconnect proof`);
    }
    if (new Set(fixtureRequests.map(request => request.authorization)).size !== 1) {
      throw new Error(`Packaged ${mode} ${name} fixture observed cross-generation bearer use`);
    }
  }
  if (runRequests.some(request => request.cookie !== null)
    || runRequests.some(request => secrets.some(secret => request.url?.includes(secret)))) {
    throw new Error('Packaged renderer transport sent cookies or placed a credential in a URL');
  }
  if (secrets.some(secret => output.includes(secret) || launchArguments.some(argument => argument.includes(secret)))) {
    throw new Error('Packaged credential entered stdout, stderr, or argv');
  }
  const credentialFiles = await readdir(join(userDataPath, 'desktop', 'credentials'));
  if (credentialFiles.length === 0 || await scanPathsForSecrets([userDataPath], secrets)) {
    throw new Error('Packaged credential material was missing or plaintext anywhere under isolated userData');
  }
  runs.push({ mode, userDataPath, output, launchArguments, secrets });
};

try {
  profileApiOrigin = await listenProfileApiFixture();
  first = await listenFixture('first');
  second = await listenFixture('second');
  for (const mode of PACKAGED_SMOKE_LAUNCH_MODES) await launch(mode);
  const allSecrets = runs.flatMap(run => run.secrets);
  const scanRoots = [
    ...runs.map(run => run.userDataPath),
    ...(process.env.PROPR_DESKTOP_SMOKE_KEYRING_ROOT ? [resolve(process.env.PROPR_DESKTOP_SMOKE_KEYRING_ROOT)] : []),
  ];
  if (await scanPathsForSecrets(scanRoots, allSecrets)) {
    throw new Error('A packaged credential entered the isolated userData or OS keyring scan roots');
  }
  console.log(
    `Packaged ${process.platform} desktop smoke passed (4/4 isolated launches): release-guard protocol-1 profile `
    + 'and Connect UI proof; 3/3 protocol-2 transport shutdown modes with production OS credentials, real '
    + 'Socket.IO/Engine.IO namespace auth, scope rotation/reconnect/error handling, five-type both-origin '
    + `rollback cleanup, compiled welcome-card layout, no cookies, and byte scans of ${scanRoots.join(', ')}.`,
  );
} finally {
  try {
    for (const { io, server } of fixtures) {
      await new Promise(resolveClose => io.close(resolveClose));
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    }
  } finally {
    try {
      if (profileApiServer.listening) {
        profileApiServer.closeAllConnections();
        await new Promise((resolveClose, rejectClose) => profileApiServer.close(error => {
          if (error) rejectClose(error);
          else resolveClose();
        }));
      }
    } finally {
      for (const smokeProfile of smokeProfiles) await removePrivateSmokeProfile(smokeProfile);
    }
  }
}
