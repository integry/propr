import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DESKTOP_RENDERER_ORIGIN } from '@propr/shared';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';

const READY_EVENT = 'desktop.renderer.ready';
const PRELOAD_BRIDGE_PROOF = '"preloadBridgeExposed":true';
const PROFILE_API_PROOF = 'desktop.renderer.profile_api.ready';
const MAIN_PROCESS_ERROR_MARKERS = [
  'desktop.main_process.uncaught_exception',
  'A JavaScript error occurred in the main process',
  'Uncaught Exception:',
];
const TIMEOUT_MS = 30_000;
const binaryPath = process.platform === 'darwin'
  ? resolve('out', `propr-desktop-darwin-${process.arch}`, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : resolve(
      'out',
      `propr-desktop-${process.platform}-${process.arch}`,
      `propr-desktop${process.platform === 'win32' ? '.exe' : ''}`,
    );
const inspectOnly = process.argv.includes('--inspect-only');

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

const userDataPath = await mkdtemp(resolve(tmpdir(), 'propr-desktop-smoke-'));
const launchArguments = ['--disable-gpu', `--user-data-dir=${userDataPath}`];
if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
  throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
}

let output = '';
let receivedProfileApiOrigin;
const profileApiServer = createServer((request, response) => {
  receivedProfileApiOrigin = request.headers.origin;
  if (
    request.method !== 'GET'
    || request.url !== '/api/compatibility'
    || receivedProfileApiOrigin !== DESKTOP_RENDERER_ORIGIN
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
  response.end('{"profileEndpoint":true}');
});
profileApiServer.listen(0, '127.0.0.1');
await once(profileApiServer, 'listening');
const profileApiAddress = profileApiServer.address();
if (!profileApiAddress || typeof profileApiAddress === 'string') {
  throw new Error('Packaged desktop smoke profile API did not bind to a TCP port');
}
const profileApiUrl = `http://127.0.0.1:${profileApiAddress.port}`;

try {
  const child = spawn(binaryPath, launchArguments, {
    env: {
      ...process.env,
      PROPR_DESKTOP_SMOKE_PROFILE_API_URL: profileApiUrl,
      PROPR_DESKTOP_SMOKE_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
      reject(new Error(`Packaged desktop did not reach renderer-ready within ${TIMEOUT_MS / 1000} seconds`));
    }, TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal });
    });
  });

  const mainProcessError = MAIN_PROCESS_ERROR_MARKERS.find(marker => output.includes(marker));
  if (mainProcessError) {
    throw new Error(`Packaged desktop reported a main-process uncaught exception (${mainProcessError})`);
  }
  if (result.code !== 0) {
    throw new Error(`Packaged desktop exited with code ${result.code ?? 'null'} (signal ${result.signal ?? 'none'})`);
  }
  if (!output.includes(READY_EVENT)) {
    throw new Error('Packaged desktop exited without reporting renderer-ready');
  }
  if (!output.includes(PRELOAD_BRIDGE_PROOF)) {
    throw new Error('Packaged desktop reported renderer-ready without proving window.proprDesktop is exposed');
  }
  if (!output.includes(PROFILE_API_PROOF) || receivedProfileApiOrigin !== DESKTOP_RENDERER_ORIGIN) {
    throw new Error('Packaged desktop did not complete a profile API request from its exact renderer origin');
  }

    console.log(`Packaged ${process.platform}-${process.arch} desktop reached renderer-ready and completed a profile API request.`);
} finally {
  profileApiServer.closeAllConnections();
  await new Promise(resolveClose => profileApiServer.close(resolveClose));
  await rm(userDataPath, { recursive: true, force: true });
}
