import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
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
const MVP_FLOWS_PROOF = 'desktop.renderer.mvp_flows.ready';
const LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
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

if (process.platform === 'win32') {
  const resources = resolve('out', `propr-desktop-win32-${process.arch}`, 'resources');
  const entries = (await readdir(resources)).map(name => name.toLocaleLowerCase('en-US'));
  if (entries.some(name => name.includes('windows-authority') || name.includes('windows-update-authority'))) {
    throw new Error('Packaged Windows MVP contains a deferred update authority resource');
  }
}

const parseLayout = smokeOutput => {
  for (const line of smokeOutput.split(/\r?\n/)) {
    if (!line.includes(LAYOUT_READY_EVENT)) continue;
    try {
      const record = JSON.parse(line.slice(line.indexOf('{')));
      if (record.event === LAYOUT_READY_EVENT) return record.layout;
    } catch {
      // Ignore non-JSON Chromium output that happens to mention the event name.
    }
  }
  return undefined;
};

const assertGap = (before, after, minimum, description) => {
  const gap = after.top - before.bottom;
  if (gap < minimum) {
    throw new Error(`Packaged layout ${description} gap was ${gap}px; expected at least ${minimum}px`);
  }
};

const assertPackagedLayout = layout => {
  if (!layout) throw new Error('Packaged desktop did not report renderer layout bounds');
  if (layout.missing?.length) {
    throw new Error(`Packaged renderer layout was missing: ${layout.missing.join(', ')}`);
  }
  if (layout.windowBounds?.width !== 1280 || layout.windowBounds?.height !== 820) {
    throw new Error(`Packaged window was not 1280x820: ${JSON.stringify(layout.windowBounds)}`);
  }
  if (layout.viewport.width < 1200 || layout.viewport.height < 740) {
    throw new Error(`Packaged renderer viewport is unexpectedly small: ${JSON.stringify(layout.viewport)}`);
  }
  if (layout.logo.height < 18 || layout.logo.height > 22 || layout.logo.width < 40 || layout.logo.width > 100) {
    throw new Error(`Packaged title-bar logo has unreasonable bounds: ${JSON.stringify(layout.logo)}`);
  }
  if (
    layout.logo.top < layout.titlebar.top
    || layout.logo.bottom > layout.titlebar.bottom
    || layout.card.left < 0
    || layout.card.right > layout.viewport.width
    || layout.card.top < layout.titlebar.bottom
    || layout.card.bottom > layout.viewport.height
  ) {
    throw new Error('Packaged logo or connection card extends outside its layout container');
  }
  for (const name of ['connectionName', 'apiUrl', 'submit']) {
    const control = layout[name];
    if (control.height < 36 || control.left < layout.card.left || control.right > layout.card.right) {
      throw new Error(`Packaged ${name} control has unreasonable bounds: ${JSON.stringify(control)}`);
    }
  }
  assertGap(layout.connectionName, layout.apiUrl, 28, 'between connection inputs');
  assertGap(layout.apiUrl, layout.apiHelp, 6, 'between API input and help text');
  assertGap(layout.apiHelp, layout.submit, 16, 'between API help and submit button');
  assertGap(layout.submit, layout.footer, 20, 'between submit button and runtime footer');
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
const launchArguments = [
  '--disable-gpu',
  '--propr-smoke-test',
  `--user-data-dir=${userDataPath}`,
  'propr://connect?api=https%3A%2F%2Fconnect.propr.dev',
];
if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
  throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
}

let output = '';
let receivedProfileApiOrigin;
const profileApiServer = createServer((request, response) => {
  receivedProfileApiOrigin = request.headers.origin;
  if (
    request.method !== 'GET'
    || !['/api/compatibility', '/api/desktop/discovery'].includes(request.url ?? '')
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
  response.end(request.url === '/api/desktop/discovery'
    ? '{"product":"ProPR","desktopAuthentication":{"protocolVersion":1}}'
    : '{"profileEndpoint":true}');
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
  if (!output.includes(MVP_FLOWS_PROOF)) {
    throw new Error('Packaged desktop did not complete local/remote/API profile and Connect discovery flows');
  }
  assertPackagedLayout(parseLayout(output));

  console.log(`Packaged ${process.platform}-${process.arch} desktop reached renderer-ready with compiled layout, sandboxing, and profile API proof.`);
} finally {
  profileApiServer.closeAllConnections();
  await new Promise(resolveClose => profileApiServer.close(resolveClose));
  await rm(userDataPath, { recursive: true, force: true });
}
