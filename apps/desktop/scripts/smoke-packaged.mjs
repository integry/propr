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
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import {
  assertPackagedLayout,
  assertPackagedNativeWindowSizing,
  createPrivateSmokeProfile,
  createSmokeChildEnvironment,
  removePrivateSmokeProfile,
} from './packaged-smoke-support.mjs';
import { scopedCurrentUserRequestGeneration } from './packaged-acceptance-current-user.mjs';

const READY_EVENT = 'desktop.renderer.ready';
const PRELOAD_BRIDGE_PROOF = '"preloadBridgeExposed":true';
const PROFILE_API_PROOF = 'desktop.renderer.profile_api.ready';
const MVP_FLOWS_PROOF = 'desktop.renderer.mvp_flows.ready';
const TRANSPORT_PROOF = 'desktop.renderer.transport_smoke.ready';
const LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
const REDUCED_NATIVE_WINDOW_READY_EVENT = 'desktop.native.reduced_window.ready';
const MAIN_PROCESS_ERROR_MARKERS = [
  'desktop.main_process.uncaught_exception',
  'A JavaScript error occurred in the main process',
  'Uncaught Exception:',
];
const TIMEOUT_MS = 45_000;
const INVALID_INSTANCE_TOKEN = 'INVALID_INSTANCE_TOKEN';
const binaryPath = process.platform === 'darwin'
  ? resolve('out', `propr-desktop-darwin-${process.arch}`, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : resolve('out', `propr-desktop-${process.platform}-${process.arch}`, `propr-desktop${process.platform === 'win32' ? '.exe' : ''}`);
const inspectOnly = process.argv.includes('--inspect-only');

const parseEventLayout = (output, expectedEvent) => {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(expectedEvent)) continue;
    try {
      const record = JSON.parse(line.slice(line.indexOf('{')));
      if (record.event === expectedEvent) return record.layout;
    } catch {
      // Chromium may emit unrelated non-JSON diagnostics containing an event name.
    }
  }
  return undefined;
};

const parseEventRecords = (output, expectedEvent) => {
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(expectedEvent)) continue;
    try {
      const record = JSON.parse(line.slice(line.indexOf('{')));
      if (record.event === expectedEvent) records.push(record);
    } catch {
      // Chromium may emit unrelated non-JSON diagnostics containing an event name.
    }
  }
  return records;
};

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
    throw new Error(`Unexpected ${FuseV1Options[fuse]} fuse state: expected ${FuseState[expectedState]}, received ${FuseState[actualState] ?? actualState}`);
  }
}
if (process.platform === 'win32') {
  const resources = resolve('out', `propr-desktop-win32-${process.arch}`, 'resources');
  const entries = (await readdir(resources)).map(name => name.toLocaleLowerCase('en-US'));
  if (entries.some(name => name.includes('windows-authority') || name.includes('windows-update-authority'))) {
    throw new Error('Packaged Windows MVP contains a deferred update authority resource');
  }
}
if (inspectOnly) {
  console.log(`Packaged ${process.platform}-${process.arch} desktop artifact passed executable and fuse inspection.`);
  process.exit(0);
}
if (process.platform !== 'linux' && process.platform !== 'win32') {
  throw new Error('Executable packaged transport smoke requires Linux or Windows');
}

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
const requests = [];
const fixtures = [];
const listenTransportFixture = async name => {
  const socketBoundary = { authenticationAttempts: 0, rejectedAuthenticationAttempts: 0, connections: 0 };
  const server = createServer((request, response) => {
    const currentUserScopeGeneration = scopedCurrentUserRequestGeneration(request.method, request.url);
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
    if ((currentUserScopeGeneration !== null || request.url === '/api/smoke/rest')
      && /^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')) {
      response.writeHead(200, { ...corsHeaders, 'Set-Cookie': 'remote=must-not-persist; HttpOnly; SameSite=None' });
      response.end(currentUserScopeGeneration !== null ? '{"username":"packaged-smoke"}' : '{"ok":true}');
      return;
    }
    response.writeHead(401, corsHeaders);
    response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
  });
  const io = new SocketIOServer(server, {
    path: '/socket.io/', transports: ['websocket'], cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false },
  });
  io.of('/').use((socket, next) => {
    socketBoundary.authenticationAttempts += 1;
    const queryScopes = new URL(socket.handshake.url, 'http://fixture.invalid').searchParams
      .getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
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
      || queryScopes.length !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(queryScopes[0])
      || Object.keys(socket.handshake.auth).length !== 0) {
      socketBoundary.rejectedAuthenticationAttempts += 1;
      const error = new Error(INVALID_INSTANCE_TOKEN);
      error.data = { code: INVALID_INSTANCE_TOKEN };
      next(error);
      return;
    }
    next();
  });
  io.of('/').on('connection', socket => {
    socketBoundary.connections += 1;
    socket.emit('packaged-smoke:connected', { ok: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Packaged ${name} fixture did not bind`);
  const fixture = { server, io, origin: `http://127.0.0.1:${address.port}`, socketBoundary };
  fixtures.push(fixture);
  return fixture;
};

const profileApiServer = createServer((request, response) => {
  if (request.method !== 'GET'
    || !['/api/compatibility', '/api/desktop/discovery'].includes(request.url ?? '')
    || request.headers.origin !== DESKTOP_RENDERER_ORIGIN) {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end('{"error":"CORS origin rejected"}');
    return;
  }
  response.writeHead(200, {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
    'Content-Type': 'application/json',
  });
  response.end(request.url === '/api/desktop/discovery'
    ? '{"product":"ProPR","desktopAuthentication":{"protocolVersion":1}}'
    : '{"profileEndpoint":true}');
});

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

const inheritedSecretServiceEnvironment = () => {
  if (process.platform !== 'linux') return {};
  const result = {};
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL']) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!value || value.length > 4096 || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error(`Packaged smoke inherited invalid ${name}`);
    }
    result[name] = value;
  }
  if (!result.DBUS_SESSION_BUS_ADDRESS) throw new Error('Packaged Linux OS-secret smoke requires a D-Bus session');
  return result;
};

const first = await listenTransportFixture('first');
const second = await listenTransportFixture('second');
profileApiServer.listen(0, '127.0.0.1');
await once(profileApiServer, 'listening');
const profileApiAddress = profileApiServer.address();
if (!profileApiAddress || typeof profileApiAddress === 'string') throw new Error('Packaged profile API fixture did not bind');
const profileApiUrl = `http://127.0.0.1:${profileApiAddress.port}`;
const runs = [];
const shutdownSteps = [
  'admission-closed', 'ipc-closed', 'session-closed', 'protocol-disposed',
  'credentials-dispose-started', 'authentication-cleared', 'lifecycle-drain-started', 'ipc-drain-started',
  'service-drain-finished', 'profiles-close-started', 'profiles-close-finished', 'session-disposed',
  'ipc-disposed', 'window-destroyed', 'final-quit',
];

const launch = async mode => {
  const smokeProfile = await createPrivateSmokeProfile();
  const requestStart = requests.length;
  const socketBoundaryStart = new Map(fixtures.map(fixture => [fixture, { ...fixture.socketBoundary }]));
  let output = '';
  try {
    const launchArguments = [
      '--disable-gpu',
      '--propr-smoke-test',
      `--user-data-dir=${smokeProfile.userData}`,
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev',
      ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
    ];
    if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
      throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
    }
    const childEnvironment = {
      ...await createSmokeChildEnvironment({ profile: smokeProfile, profileApiUrl }),
      ...inheritedSecretServiceEnvironment(),
      PROPR_DESKTOP_SMOKE_FIRST_ORIGIN: first.origin,
      PROPR_DESKTOP_SMOKE_SECOND_ORIGIN: second.origin,
      PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE: mode,
    };
    const child = spawn(binaryPath, launchArguments, {
      cwd: smokeProfile.root,
      env: childEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const capture = chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const result = await new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Packaged desktop ${mode} smoke exceeded ${TIMEOUT_MS / 1000} seconds`));
      }, TIMEOUT_MS);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolveResult({ code, signal });
      });
    });
    const mainProcessError = MAIN_PROCESS_ERROR_MARKERS.find(marker => output.includes(marker));
    if (mainProcessError) throw new Error(`Packaged desktop reported an uncaught exception (${mainProcessError})`);
    if (result.code !== 0) throw new Error(`Packaged desktop exited with code ${result.code ?? 'null'} (signal ${result.signal ?? 'none'})`);
    for (const proof of [READY_EVENT, PRELOAD_BRIDGE_PROOF, PROFILE_API_PROOF, MVP_FLOWS_PROOF, TRANSPORT_PROOF]) {
      if (!output.includes(proof)) throw new Error(`Packaged desktop did not publish required proof ${proof}`);
    }
    const expectedBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
    if (!output.includes(`"storageBackend":"${expectedBackend}"`)) {
      throw new Error(`Packaged desktop did not use ${expectedBackend} production credential protection`);
    }
    const staleBoundaryRecords = parseEventRecords(output, 'desktop.transport_smoke.stale_socket_boundary');
    if (staleBoundaryRecords.length !== 1) {
      throw new Error(`Packaged ${mode} smoke missed exact main stale-socket boundary evidence`);
    }
    const staleBoundary = staleBoundaryRecords[0];
    if (staleBoundary.schemaVersion !== 1 || staleBoundary.mainAttempts !== 2
      || staleBoundary.staleRejectedByMain !== true || staleBoundary.staleRejectionCategory !== 'stale-scope'
      || staleBoundary.freshAcceptedByMain !== true || staleBoundary.exactPath !== true
      || staleBoundary.exactTransport !== true || staleBoundary.exactResource !== true
      || staleBoundary.queryCount !== 1 || staleBoundary.activeBindingPresent !== true
      || staleBoundary.profileGenerationCurrent !== true || staleBoundary.originEqualsActive !== true
      || staleBoundary.rendererBearerPresent !== false || staleBoundary.rendererCookiePresent !== false
      || staleBoundary.staleOutboundBearerPresent !== false || staleBoundary.staleBearerMainInjected !== false
      || staleBoundary.freshBearerMainInjected !== true) {
      throw new Error(`Packaged ${mode} smoke main stale-socket boundary evidence was invalid`);
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
    if (forced !== (mode === 'forced-timeout')) throw new Error(`Packaged ${mode} forced-timeout evidence was incorrect`);
    if (mode === 'retry' && (!output.includes('desktop.app.shutdown_retry_requested')
      || !output.includes('desktop.app.shutdown_retry'))) {
      throw new Error('Packaged retry did not exercise a repeated prevented before-quit event');
    }
    assertPackagedLayout(parseEventLayout(output, LAYOUT_READY_EVENT));
    assertPackagedNativeWindowSizing(parseEventLayout(output, REDUCED_NATIVE_WINDOW_READY_EVENT), {
      requireReducedWorkArea: true,
    });

    const runRequests = requests.slice(requestStart);
    const authenticated = runRequests.filter(request => request.authorization?.startsWith('Bearer propr_it_'));
    const secrets = [...new Set(authenticated.map(request => request.authorization.slice('Bearer '.length)))];
    if (secrets.length !== 2) throw new Error(`Expected two ${mode} activation credentials, observed ${secrets.length}`);
    for (const name of ['first', 'second']) {
      const fixture = name === 'first' ? first : second;
      const boundaryStart = socketBoundaryStart.get(fixture);
      const fixtureBoundaryAttempts = boundaryStart
        ? fixture.socketBoundary.authenticationAttempts - boundaryStart.authenticationAttempts
        : -1;
      const fixtureBoundaryRejections = boundaryStart
        ? fixture.socketBoundary.rejectedAuthenticationAttempts - boundaryStart.rejectedAuthenticationAttempts
        : -1;
      const fixtureBoundaryConnections = boundaryStart
        ? fixture.socketBoundary.connections - boundaryStart.connections
        : -1;
      if (!boundaryStart
        || fixtureBoundaryAttempts < (name === 'second' ? 2 : 1)
        || fixtureBoundaryRejections !== 0
        || fixtureBoundaryConnections !== fixtureBoundaryAttempts) {
        throw new Error(`Packaged ${mode} ${name} fixture observed an unexpected Socket.IO boundary count`);
      }
      const fixtureRequests = authenticated.filter(request => request.fixture === name);
      const currentUserRequests = fixtureRequests.filter(request => {
        if (request.method !== 'GET') return false;
        try {
          return new URL(request.url, 'http://fixture.invalid').pathname === '/api/auth/user';
        } catch {
          return false;
        }
      });
      const namespaceConnections = fixtureRequests.filter(request => request.socketIo);
      const allNamespaceAttempts = runRequests.filter(request => request.fixture === name && request.socketIo);
      if (currentUserRequests.length === 0
        || currentUserRequests.some(request => scopedCurrentUserRequestGeneration(request.method, request.url) === null)
        || !fixtureRequests.some(request => request.url === '/api/smoke/rest')
        || namespaceConnections.length < (name === 'second' ? 2 : 1)
        || allNamespaceAttempts.length !== namespaceConnections.length
        || allNamespaceAttempts.length !== fixtureBoundaryAttempts
        || namespaceConnections.some(request => request.namespace !== '/' || request.engineProtocol !== 4)) {
        throw new Error(`Packaged ${mode} ${name} fixture missed REST, Engine.IO, namespace auth, or reconnect proof`);
      }
      if (new Set(fixtureRequests.map(request => request.authorization)).size !== 1) {
        throw new Error(`Packaged ${mode} ${name} fixture observed cross-generation bearer use`);
      }
    }
    if (runRequests.some(request => request.cookie !== null)
      || runRequests.some(request => secrets.some(secret => {
        if (request.url?.includes(secret)) return true;
        try {
          return [...new URL(request.url, 'http://fixture.invalid').searchParams]
            .some(([key, value]) => key.includes(secret) || value.includes(secret));
        } catch {
          return false;
        }
      }))) {
      throw new Error('Packaged renderer transport sent cookies or placed a credential in a URL');
    }
    if (secrets.some(secret => output.includes(secret) || launchArguments.some(argument => argument.includes(secret)))) {
      throw new Error('Packaged credential entered stdout, stderr, or argv');
    }
    const credentialFiles = await readdir(join(smokeProfile.userData, 'desktop', 'credentials'));
    if (credentialFiles.length === 0 || await scanPathsForSecrets([smokeProfile.userData], secrets)) {
      throw new Error('Packaged credential material was missing or plaintext under isolated userData');
    }
    runs.push({ mode, secrets });
  } finally {
    await removePrivateSmokeProfile(smokeProfile);
  }
};

try {
  for (const mode of ['success', 'retry', 'forced-timeout']) await launch(mode);
  const allSecrets = runs.flatMap(run => run.secrets);
  const keyringRoot = process.env.PROPR_DESKTOP_SMOKE_KEYRING_ROOT;
  if (keyringRoot && await scanPathsForSecrets([resolve(keyringRoot)], allSecrets)) {
    throw new Error('A packaged credential entered the OS keyring scan root as plaintext');
  }
  console.log(`Packaged ${process.platform}-${process.arch} transport smoke passed all shutdown modes with real REST/Socket.IO scope auth, origin rollback, and OS secret custody.`);
} finally {
  for (const { io, server } of fixtures) {
    await new Promise(resolveClose => io.close(resolveClose));
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  }
  if (profileApiServer.listening) {
    profileApiServer.closeAllConnections();
    await new Promise((resolveClose, rejectClose) => profileApiServer.close(error => error ? rejectClose(error) : resolveClose()));
  }
}
