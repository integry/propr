import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import { ConfigManager } from '../../config/ConfigManager.js';
import type { OrchestratorConfig, OrchestratorModule } from '../../orchestrator/index.js';

const real = await import('../../orchestrator/index.js');
let orch: OrchestratorModule;
let cfg: OrchestratorConfig;
let configError: Error | undefined;
let resolveTestConfig: (() => OrchestratorConfig) | undefined;
mock.module('../../orchestrator/index.js', { namedExports: {
  ...real,
  loadOrchestrator: async () => orch,
  getHostConfig: async () => {
    if (configError) throw configError;
    return { orch, cfg: resolveTestConfig?.() ?? cfg, rootDir: '/tmp/propr-selected-review-test' };
  },
} });
const { createDefaultActions } = await import('./hostActions.js');
const { runChecks } = await import('../checkCommands.js');

for (const host of ['::1', '127.0.0.1']) {
  test(`local setup avoids a UI port occupied only on ${host} and preserves localhost OAuth`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'propr-ui-port-'));
    t.after(() => { resolveTestConfig = undefined; rmSync(root, { recursive: true, force: true }); });
    const unrelated = createServer();
    t.after(() => new Promise<void>(resolve => { if (unrelated.listening) unrelated.close(() => resolve()); else resolve(); }));
    try {
      await new Promise<void>((resolve, reject) => {
        unrelated.once('error', reject);
        unrelated.listen({ host, port: 0, ipv6Only: host === '::1' }, resolve);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(code ?? '')) {
        t.skip('IPv6 loopback unavailable'); return;
      }
      throw error;
    }
    const basePort = (unrelated.address() as { port: number }).port;
    // The regression is an IPv4 Docker publish with a separate IPv6 owner.
    writeFileSync(join(root, '.env'), `UI_PORT=127.0.0.1:${basePort}\nFRONTEND_URL=http://localhost:${basePort}\n# preserve configuration\nSESSION_SECRET=fixture\n`, { mode: 0o600 });
    const { readEnvVars } = await import('@propr/local-setup');
    // @ts-expect-error dependency-free launcher has no TypeScript declaration
    const { resolveHostConfig } = await import('../../../../../docker/launcher/orchestrator.mjs');
    resolveTestConfig = () => resolveHostConfig({ rootDir: root, env: {} }) as OrchestratorConfig;
    let started: OrchestratorConfig | undefined;
    let existingUi: ReturnType<typeof createServer> | undefined;
    t.after(() => new Promise<void>(resolve => { if (existingUi?.listening) existingUi.close(() => resolve()); else resolve(); }));
    orch = {
      dockerAsync: async () => ({ status: existingUi?.listening ? 0 : 1, stdout: JSON.stringify([
        `/${resolveTestConfig!().stack}-ui`, { Running: true },
        { 'propr.stack': resolveTestConfig!().stack, 'propr.service': 'ui' },
        { '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: String((existingUi?.address() as { port: number } | null)?.port) }] },
      ]) }),
      validateEnv: () => ({ ok: true, warnings: [] }),
      ensureNetworkAsync: async () => {},
      replaceStackContainersAsync: async () => {
        await new Promise<void>(resolve => existingUi!.close(() => resolve()));
      },
      startStackAsync: async (config: OrchestratorConfig) => {
        started = config;
        if (existingUi?.listening) {
          assert.equal((existingUi.address() as { port: number }).port, Number(config.uiPort.split(':').at(-1)));
          return;
        }
        existingUi = createServer();
        await new Promise<void>((resolve, reject) => {
          existingUi!.once('error', reject);
          existingUi!.listen(Number(config.uiPort.split(':').at(-1)), '127.0.0.1', resolve);
        });
      },
    } as unknown as OrchestratorModule;
    const actions = createDefaultActions();
    if (host === '::1') {
      existingUi = createServer();
      await new Promise<void>((resolve, reject) => {
        existingUi!.once('error', reject);
        existingUi!.listen(basePort, '127.0.0.1', resolve);
      });
      const health = await actions.checkBackendHealth({ rootDir: root });
      assert.equal(health.healthy, false);
      assert.equal(health.recoveryAction, 'replace-running-stack');
      assert.match(health.detail, /IPv6 loopback/);
      await actions.replaceRunningStack!({ rootDir: root });
    } else {
      await actions.startStack({ rootDir: root });
    }
    assert.ok(started);
    const port = Number(started.uiPort.split(':').at(-1));
    assert.ok(port > basePort);
    assert.equal(started.uiPort, `127.0.0.1:${port}`);
    assert.equal(started.frontendUrl, `http://localhost:${port}`);
    assert.equal(new URL(started.apiPublicUrl).hostname, 'localhost');
    assert.equal(new URL(started.ghOauthCallbackUrl).hostname, 'localhost');
    assert.equal(await actions.resolveUiUrl(root), started.frontendUrl);
    assert.equal(readEnvVars(root).UI_PORT, started.uiPort);
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /# preserve configuration\nSESSION_SECRET=fixture/);
    assert.equal(unrelated.listening, true);
    // The selection survives rerunning setup without drifting to another port.
    const selected = started.uiPort;
    const selectedUrl = started.frontendUrl;
    await actions.startStack({ rootDir: root });
    await actions.startStack({ rootDir: root });
    assert.equal(started.uiPort, selected);
    assert.equal(started.frontendUrl, selectedUrl);
    assert.equal(readEnvVars(root).UI_PORT, selected);
    assert.equal(readEnvVars(root).FRONTEND_URL, selectedUrl);
    assert.equal(existingUi!.listening, true);
  });
}

test('repeat starts preserve an already-running managed IPv4 UI and its persisted OAuth URL', async t => {
  const root = mkdtempSync(join(tmpdir(), 'propr-managed-ui-port-'));
  const managedUi = createServer();
  t.after(() => { resolveTestConfig = undefined; rmSync(root, { recursive: true, force: true }); });
  t.after(() => new Promise<void>(resolve => { if (managedUi.listening) managedUi.close(() => resolve()); else resolve(); }));
  await new Promise<void>((resolve, reject) => {
    managedUi.once('error', reject);
    managedUi.listen(0, '127.0.0.1', resolve);
  });
  const port = (managedUi.address() as { port: number }).port;
  const env = `UI_PORT=127.0.0.1:${port}\nFRONTEND_URL=http://localhost:${port}\n`;
  writeFileSync(join(root, '.env'), env, { mode: 0o600 });
  // @ts-expect-error dependency-free launcher has no TypeScript declaration
  const { resolveHostConfig } = await import('../../../../../docker/launcher/orchestrator.mjs');
  resolveTestConfig = () => resolveHostConfig({ rootDir: root, env: {} }) as OrchestratorConfig;
  let managedState: { Running: boolean; Health?: { Status: string }; Restarting?: boolean } = { Running: true };
  let starts = 0;
  let started: OrchestratorConfig | undefined;
  orch = {
    dockerAsync: async (args: string[]) => {
      assert.equal(args[0], 'inspect');
      assert.equal(args.at(-1), `${resolveTestConfig!().stack}-ui`);
      return { status: 0, stdout: JSON.stringify([
        `/${resolveTestConfig!().stack}-ui`, managedState,
        { 'propr.stack': resolveTestConfig!().stack, 'propr.service': 'ui' },
        { '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
      ]) };
    },
    validateEnv: () => ({ ok: true, warnings: [] }),
    ensureNetworkAsync: async () => {},
    startStackAsync: async (config: OrchestratorConfig) => {
      starts++;
      started = config;
    },
  } as unknown as OrchestratorModule;
  const actions = createDefaultActions();
  for (const state of [
    { Running: true, Health: { Status: 'healthy' } },
    { Running: true, Health: { Status: 'starting' } },
    { Running: true, Health: { Status: 'unhealthy' } },
    { Running: true, Restarting: true },
  ]) {
    managedState = state;
    await actions.startStack({ rootDir: root });
    assert.equal(started!.uiPort, `127.0.0.1:${port}`);
    assert.equal(started!.frontendUrl, `http://localhost:${port}`);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
    assert.equal(await actions.resolveUiUrl(root), `http://localhost:${port}`);
    assert.equal(managedUi.listening, true);
  }
  assert.equal(starts, 4);
  await t.test('direct start persists the selected port before replacing the managed IPv4 UI with an IPv6 conflict', async sub => {
    const unrelated = createServer();
    sub.after(() => new Promise<void>(resolve => { if (unrelated.listening) unrelated.close(() => resolve()); else resolve(); }));
    try {
      await new Promise<void>((resolve, reject) => {
        unrelated.once('error', reject);
        unrelated.listen({ host: '::1', port, ipv6Only: true }, resolve);
      });
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        sub.skip('IPv6 loopback unavailable'); return;
      }
      throw error;
    }
    // Exercise the real async stack orchestrator through a fake Docker CLI.
    // The daemon fixture actually releases/rebinds IPv4 on rm/run, so a
    // persisted port change cannot pass while the UI still serves the old port.
    const core = await real.loadOrchestrator();
    const { readEnvVars } = await import('@propr/local-setup');
    const commands: string[][] = [];
    const containers = new Map<string, string[]>();
    const uiName = `${resolveTestConfig!().stack}-ui`;
    containers.set(uiName, []);
    const daemon = createHttpServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const args: string[] = JSON.parse(Buffer.concat(chunks).toString());
        commands.push(args);
        let stdout = '';
        if (args[0] === 'ps') {
          const nameFilter = args.find(arg => arg.startsWith('name=^'));
          if (nameFilter && args.includes('-a')) {
            const name = nameFilter.slice(6, -1);
            if (containers.has(name)) stdout = name;
          }
        } else if (args[0] === 'images') stdout = 'local-image';
        else if (args[0] === 'rm') {
          const name = args.at(-1)!;
          if (name === uiName) {
            const persisted = readEnvVars(root);
            assert.notEqual(persisted.UI_PORT, `127.0.0.1:${port}`);
            assert.equal(persisted.UI_PORT, started!.uiPort);
            assert.equal(persisted.FRONTEND_URL, started!.frontendUrl);
            assert.equal((managedUi.address() as { port: number }).port, port);
            await new Promise<void>(resolve => managedUi.close(() => resolve()));
          }
          containers.delete(name);
        } else if (args[0] === 'run' && args.includes('-d')) {
          const name = args[args.indexOf('--name') + 1];
          assert.equal(containers.has(name), false, 'existing container must be removed first');
          if (name === uiName) {
            const binding = args[args.indexOf('-p') + 1];
            assert.equal(managedUi.listening, false, 'old UI binding must be released before running the new spec');
            assert.equal(binding, `${readEnvVars(root).UI_PORT}:5173`);
            await new Promise<void>((resolve, reject) => {
              managedUi.once('error', reject);
              managedUi.listen(Number(binding.split(':')[1]), '127.0.0.1', resolve);
            });
          }
          containers.set(name, args);
        }
        response.end(JSON.stringify({ stdout }));
      } catch (error) {
        console.error(error);
        response.statusCode = 500;
        response.end('Fake Docker daemon request failed');
      }
    });
    sub.after(() => new Promise<void>(resolve => daemon.close(() => resolve())));
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    const daemonPort = (daemon.address() as { port: number }).port;
    writeFileSync(join(root, 'docker'), `#!${process.execPath}
const http = require('node:http');
const request = http.request({host:'127.0.0.1', port:${daemonPort}, method:'POST'}, response => {
  let body = '';
  response.on('data', chunk => body += chunk);
  response.on('end', () => {
    if (response.statusCode !== 200) { process.stderr.write(body); process.exitCode = 1; }
    else process.stdout.write(JSON.parse(body).stdout);
  });
});
request.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
request.end(JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    const previousSkip = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
    process.env.PATH = `${root}${delimiter}${previousPath}`;
    process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
    sub.after(() => {
      process.env.PATH = previousPath;
      if (previousSkip === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
      else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = previousSkip;
    });
    orch = { ...orch, replaceStackContainersAsync: async () => {
      assert.fail('direct start must replace the UI through startStackAsync');
    }, startStackAsync: async (config, options) => {
      started = config;
      assert.equal(readEnvVars(root).UI_PORT, config.uiPort);
      assert.equal(readEnvVars(root).FRONTEND_URL, config.frontendUrl);
      assert.equal((managedUi.address() as { port: number }).port, port);
      return core.startStackAsync(config, options);
    } };
    await actions.startStack({ rootDir: root });
    const selectedPort = Number(started!.uiPort.split(':').at(-1));
    assert.ok(selectedPort > port);
    assert.equal(started!.frontendUrl, `http://localhost:${selectedPort}`);
    assert.equal((managedUi.address() as { port: number }).port, selectedPort);
    const oldPortProbe = createServer();
    sub.after(() => new Promise<void>(resolve => { if (oldPortProbe.listening) oldPortProbe.close(() => resolve()); else resolve(); }));
    await new Promise<void>((resolve, reject) => {
      oldPortProbe.once('error', reject);
      oldPortProbe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>(resolve => oldPortProbe.close(() => resolve()));
    const removal = commands.findIndex(args => args[0] === 'rm' && args.at(-1) === uiName);
    const uiRun = commands.findIndex(args => args[0] === 'run' && args.includes(uiName));
    assert.ok(removal >= 0 && uiRun > removal);
    assert.ok(containers.get(uiName)!.includes(`127.0.0.1:${selectedPort}:5173`));
    assert.ok(containers.get(`${started!.stack}-api`)!.includes(`FRONTEND_URL=http://localhost:${selectedPort}`));
    assert.equal(await actions.resolveUiUrl(root), started!.frontendUrl);
    assert.equal(new URL(started!.apiPublicUrl).hostname, new URL(started!.frontendUrl).hostname);
    assert.equal(new URL(started!.ghOauthCallbackUrl).hostname, 'localhost');
    assert.equal(unrelated.listening, true);
  });
});

test('direct propr start recreates the managed UI and API with the selected port', async t => {
  const root = mkdtempSync(join(tmpdir(), 'propr-direct-start-'));
  t.after(() => { resolveTestConfig = undefined; rmSync(root, { recursive: true, force: true }); });
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const selectedPort = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  writeFileSync(join(root, '.env'), `UI_PORT=127.0.0.1:${selectedPort}\nFRONTEND_URL=http://localhost:${selectedPort}\nDOCS_ENABLED=false\n`);
  const core = await real.loadOrchestrator();
  resolveTestConfig = () => core.resolveHostConfig({ rootDir: root, env: {} });
  const stack = resolveTestConfig().stack;
  // Existing containers have stale configuration. The real sync orchestrator
  // must remove them before docker run can install the selected configuration.
  const statePath = join(root, 'containers.json');
  const logPath = join(root, 'docker.jsonl');
  writeFileSync(statePath, JSON.stringify({ [`${stack}-ui`]: ['old-ui-port'], [`${stack}-api`]: ['old-frontend-url'] }));
  writeFileSync(join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const containers = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps' && args.includes('-a')) {
  const filter = args.find(arg => arg.startsWith('name=^'));
  if (filter) { const name = filter.slice(6, -1); if (containers[name]) process.stdout.write(name); }
  else if (args.some(arg => arg.startsWith('label=propr.stack='))) {
    const names = Object.keys(containers);
    process.stdout.write(names.map(name => args.some(arg => arg.includes('{{.State}}'))
      ? name + '\\t' + 'running' + '\\t' + 'Up 1 minute' + '\\t' : name).join('\\n'));
  }
} else if (args[0] === 'images') process.stdout.write('local-image');
else if (args[0] === 'rm') delete containers[args.at(-1)];
else if (args[0] === 'run' && args.includes('-d')) {
  const name = args[args.indexOf('--name') + 1];
  if (containers[name]) { process.stderr.write('container already exists'); process.exit(1); }
  containers[name] = args;
}
fs.writeFileSync(statePath, JSON.stringify(containers));
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousSkip = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  process.env.PATH = `${root}${delimiter}${previousPath}`;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousSkip === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
    else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = previousSkip;
  });
  orch = { ...core, dockerAvailable: () => true, validateEnv: () => ({ ok: true, errors: [], warnings: [] }) };
  const { runStart } = await import('../../tui/render.js');
  const config = new ConfigManager(root);
  t.mock.method(console, 'log', () => {});
  await runStart(config, { root, pull: false, tui: false, restart: true });
  const containers = JSON.parse(readFileSync(statePath, 'utf8'));
  const commands: string[][] = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const service of ['ui', 'api']) {
    const name = `${stack}-${service}`;
    const removal = commands.findIndex(args => args[0] === 'rm' && args.at(-1) === name);
    const run = commands.findIndex(args => args[0] === 'run' && args.includes(name));
    const stop = commands.findIndex(args => args[0] === 'stop' && args.at(-1) === name);
    assert.ok(stop >= 0 && removal > stop && run > removal);
  }
  assert.ok(containers[`${stack}-ui`].includes(`127.0.0.1:${selectedPort}:5173`));
  assert.ok(containers[`${stack}-api`].includes(`FRONTEND_URL=http://localhost:${selectedPort}`));
  assert.equal(new URL(resolveTestConfig().apiPublicUrl).hostname, 'localhost');
  assert.equal(new URL(resolveTestConfig().ghOauthCallbackUrl).hostname, 'localhost');
});

test('UI-disabled setup ignores an unrelated IPv6 UI-port listener and reaches the API health poll', async t => {
  const root = mkdtempSync(join(tmpdir(), 'propr-disabled-ui-'));
  t.after(() => { resolveTestConfig = undefined; rmSync(root, { recursive: true, force: true }); });
  const unrelated = createServer();
  t.after(() => new Promise<void>(resolve => { if (unrelated.listening) unrelated.close(() => resolve()); else resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      unrelated.once('error', reject);
      unrelated.listen({ host: '::1', port: 0, ipv6Only: true }, resolve);
    });
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('IPv6 loopback unavailable'); return;
    }
    throw error;
  }
  const port = (unrelated.address() as { port: number }).port;
  const env = `UI_PORT=127.0.0.1:${port}\nFRONTEND_URL=http://localhost:${port}\n`;
  writeFileSync(join(root, '.env'), env);
  // @ts-expect-error dependency-free launcher has no TypeScript declaration
  const { resolveHostConfig } = await import('../../../../../docker/launcher/orchestrator.mjs');
  resolveTestConfig = () => resolveHostConfig({ rootDir: root, env: {} }) as OrchestratorConfig;
  const config = new ConfigManager(root);
  t.mock.method(config, 'getUiEnabled', () => false);
  let starts = 0;
  orch = {
    validateEnv: () => ({ ok: true, warnings: [] }),
    ensureNetworkAsync: async () => {},
    startStackAsync: async (config: OrchestratorConfig, options: { ui: boolean }) => {
      starts++;
      assert.equal(options.ui, false);
      assert.equal(config.uiPort, `127.0.0.1:${port}`);
    },
    dockerAsync: async () => { assert.fail('disabled UI must not inspect UI ownership'); },
  } as unknown as OrchestratorModule;
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    polls++;
    assert.equal(url, `${resolveTestConfig!().apiPublicUrl}/api/status`);
    return Response.json({ api: 'healthy', daemon: 'running', worker: 'running' });
  });
  const actions = createDefaultActions(config);
  await actions.startStack({ rootDir: root });
  assert.equal((await actions.checkBackendHealth({ rootDir: root })).healthy, true);
  assert.equal(starts, 1);
  assert.equal(polls, 1);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
  assert.equal(unrelated.listening, true);
});

test('failed browser token save cannot leak through a later stack-root write and allows retry', async t => {
  const configDir = mkdtempSync(join(tmpdir(), 'propr-browser-save-'));
  try {
    const config = new ConfigManager(configDir);
    await config.init();
    await config.setStackRoot('/previous/root');
    let token = 'rejected-token';
    const actions = createDefaultActions(config, { githubBrowserLogin: async () => token });
    const failedSave = t.mock.method(config, 'save', async () => { throw new Error('fixture save failure'); });

    assert.equal(await actions.loginWithGithub!(), false);
    assert.equal(actions.hasGithubToken!(), false);
    assert.equal(config.getGithubToken(), undefined);
    await assert.rejects(actions.fetchRelayInstallations!({}), /sign-in could not be saved/);

    failedSave.mock.restore();
    await actions.persistStackRoot!('/next/root');
    const disk = new ConfigManager(configDir);
    await disk.init();
    assert.equal(disk.getStackRoot(), '/next/root');
    assert.equal(disk.getGithubToken(), undefined);
    assert.equal(actions.hasGithubToken!(), false);

    token = 'retry-token';
    assert.equal(await actions.loginWithGithub!(), true);
    assert.equal(actions.hasGithubToken!(), true);
    assert.equal(config.getGithubToken(), token);
    await disk.load();
    assert.equal(disk.getGithubToken(), token);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

function platform(t: TestContext, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('Docker checks precede config errors, verify Linux containers, and honor Darwin endpoint precedence', async t => {
  const originalPath = process.env.PATH;
  for (const row of [
    { os: 'linux', engine: 'linux', context: '', host: '', endpoint: 'unix:///socket', local: undefined, remediation: false },
    { os: 'linux', engine: 'windows', context: '', host: '', endpoint: '', local: undefined, remediation: true },
    { os: 'darwin', engine: 'windows', context: '', host: '', endpoint: '', local: undefined, remediation: false },
    { os: 'darwin', engine: 'linux', context: '', host: 'unix:///selected', endpoint: 'ssh://remote', local: 'ok', remediation: false },
    { os: 'darwin', engine: 'linux', context: 'remote', host: 'unix:///selected', endpoint: 'ssh://remote', local: 'fail', remediation: false },
    { os: 'darwin', engine: 'linux', context: '', host: '', endpoint: 'unix:///desktop', local: 'ok', remediation: false },
  ]) {
    await t.test(JSON.stringify(row), async sub => {
      platform(sub, row.os);
      const old = { context: process.env.DOCKER_CONTEXT, host: process.env.DOCKER_HOST };
      process.env.DOCKER_CONTEXT = row.context;
      process.env.DOCKER_HOST = row.host;
      sub.after(() => {
        for (const [key, value] of [['DOCKER_CONTEXT', old.context], ['DOCKER_HOST', old.host]]) {
          if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
        }
      });
      const calls: string[][] = [];
      orch = { dockerAsync: async (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: args[0] === '--version' ? 'Docker fixture' : args[0] === 'info' ? row.engine : row.endpoint };
      } } as unknown as OrchestratorModule;
      configError = new Error('manifest unavailable');
      const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
      try {
        await assert.rejects(runChecks({ onResult: result => results.push(result) }), configError);
        assert.equal(results.find(r => r.name === 'Docker installed')?.status, 'ok');
        assert.equal(results.find(r => r.name === 'Docker daemon')?.status, row.engine === 'linux' ? 'ok' : 'fail');
        assert.equal(results.find(r => r.name === 'Docker daemon')?.remediation?.kind === 'start-docker', row.remediation);
        assert.equal(results.find(r => r.name === 'Docker local endpoint')?.status, row.local);
        assert.equal(calls.some(args => args[0] === 'context'), row.os === 'darwin' && row.engine === 'linux' && Boolean(row.context || !row.host));
        assert.equal(process.env.PATH, originalPath);
      } finally { configError = undefined; }
    });
  }
});

test('a Docker-compatible CLI without an OSType field is accepted only on Linux and only when plain info succeeds', async t => {
  const templateError = 'Error: template: info:1:2: executing "info" at <.OSType>: can\'t evaluate field OSType in type *define.Info';
  for (const row of [
    { os: 'linux', plainStatus: 0, status: 'ok', fallback: true },
    { os: 'linux', plainStatus: 125, status: 'fail', fallback: true },
    { os: 'darwin', plainStatus: 0, status: 'fail', fallback: false },
  ]) {
    await t.test(JSON.stringify(row), async sub => {
      platform(sub, row.os);
      const calls: string[][] = [];
      orch = { dockerAsync: async (args: string[]) => {
        calls.push(args);
        if (args[0] === '--version') return { status: 0, stdout: 'podman version 5.0.0' };
        if (args[0] === 'info' && args[1] === '--format') return { status: 125, stdout: '', stderr: templateError };
        if (args[0] === 'info') return { status: row.plainStatus, stdout: row.plainStatus === 0 ? 'host:\n  os: linux' : '', stderr: row.plainStatus === 0 ? '' : 'Cannot connect to Podman' };
        return { status: 1, stdout: '', stderr: 'unexpected' };
      } } as unknown as OrchestratorModule;
      configError = new Error('manifest unavailable');
      const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
      try {
        await assert.rejects(runChecks({ onResult: result => results.push(result) }), configError);
        const daemon = results.find(r => r.name === 'Docker daemon')!;
        assert.equal(daemon.status, row.status);
        assert.deepEqual(calls.filter(args => args[0] === 'info'), row.fallback
          ? [['info', '--format', '{{.OSType}}'], ['info']]
          : [['info', '--format', '{{.OSType}}']]);
        if (row.status === 'ok') {
          assert.match(daemon.detail, /does not report the engine OS type/);
        } else {
          // The original template failure stays the reported cause; a plain
          // info retry must not reach the daemon more than once.
          assert.match(daemon.detail, /^cannot reach the Docker daemon \(docker info failed\): Error: template:/);
          assert.equal(daemon.detail.split('\n').length, 1);
        }
      } finally { configError = undefined; }
    });
  }
});

test('an unreachable daemon is not retried with plain info and its detail omits the home path', async t => {
  platform(t, 'darwin');
  const { homedir } = await import('node:os');
  const home = homedir();
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0, stdout: 'Docker version 27.0.0' };
    return { status: 1, stdout: '', stderr: `failed to connect to the docker API at unix://${home}/.docker/run/docker.sock; check if the path is correct and if the daemon is running\nmore ${home}` };
  } } as unknown as OrchestratorModule;
  configError = new Error('manifest unavailable');
  const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
  try {
    await assert.rejects(runChecks({ onResult: result => results.push(result) }), configError);
    const daemon = results.find(r => r.name === 'Docker daemon')!;
    assert.equal(daemon.status, 'fail');
    assert.deepEqual(calls, [['--version'], ['info', '--format', '{{.OSType}}']]);
    assert.ok(!daemon.detail.includes(home), daemon.detail);
    assert.ok(!daemon.detail.includes('more'), daemon.detail);
    assert.match(daemon.detail, /unix:\/\/~\/\.docker\/run\/docker\.sock/);
  } finally { configError = undefined; }
});

test('missing Docker emits install and daemon guidance before a config failure', async t => {
  platform(t, 'darwin');
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => { calls.push(args); return { status: null }; } } as unknown as OrchestratorModule;
  configError = new Error('manifest unavailable');
  const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
  try {
    await assert.rejects(runChecks({ onResult: row => results.push(row) }), configError);
    assert.deepEqual(calls, [['--version']]);
    assert.match(results.find(r => r.name === 'Docker installed')!.fix!, /Docker Desktop/);
    assert.equal(results.find(r => r.name === 'Docker daemon')!.remediation, undefined);
  } finally { configError = undefined; }
});

test('Darwin pulls share architecture inspection, keep missing source failures structured, and use local metadata offline', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'local/app', ui: 'local/ui', redis: 'redis:7' }, docsEnabled: false,
    manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } },
  } as unknown as OrchestratorConfig;
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'manifest') throw new Error('local images must not need a registry');
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args.at(-1) === 'local/app') return { status: 1 };
    if (args[0] === 'pull') return { status: 1, stderr: 'registry offline' };
    return { status: 0, stdout: JSON.stringify({ Os: 'linux', Architecture: 'arm64' }) };
  }, tagAgentLatest: () => {} } as unknown as OrchestratorModule;
  const result = await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] });
  assert.deepEqual(result.failedCore, ['local/app']);
  assert.deepEqual(result.pulledCore, ['local/ui', 'redis:7']);
  assert.equal(calls.filter(args => args[0] === 'info').length, 1);
  assert.equal(calls.filter(args => args[0] === 'image' && args.includes('--format') && args.at(-1) === 'redis:7').length, 2);
});

test('offline skip avoids pulls and failed pull cannot reuse a vanished local image', async t => {
  platform(t, 'darwin');
  cfg = { images: { redis: 'redis:7' }, manifest: {} } as unknown as OrchestratorConfig;
  const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
  let pulled = false;
  orch = { dockerAsync: async (args: string[]) => {
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args[0] === 'pull') { pulled = true; return { status: 1 }; }
    return pulled ? { status: 1 } : { status: 0, stdout: JSON.stringify({ Os: 'linux', Architecture: 'arm64' }) };
  } } as unknown as OrchestratorModule;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).pulledCore, ['redis:7']);
  assert.equal(pulled, false);
  delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).failedCore, ['redis:7']);
});

for (const cached of [true, false]) {
  test(`Mac acceptance environment admits and cancels a production pull (cached=${cached})`, async t => {
    // The acceptance harness is JavaScript and has no TypeScript declaration.
    // @ts-expect-error untyped desktop test harness
    const { createIsolatedSetupEnvironment, createLinuxSetupIsolation } = await import('../../../../../apps/desktop/scripts/packaged-linux-setup-lifecycle.mjs');
    const environment = createIsolatedSetupEnvironment({
      platform: 'darwin', baseEnvironment: { HOME: '/Users/tester', PROPR_SKIP_REMOTE_IMAGE_CHECK: '1' },
      profile: { root: '/tmp/private', home: '/tmp/private/home' }, wrapperDirectory: '/tmp/private/bin',
      isolation: createLinuxSetupIsolation(), ports: [40001, 40002, 40003],
    });
    platform(t, 'darwin');
    const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
    t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
    assert.equal(environment.PROPR_SKIP_REMOTE_IMAGE_CHECK, undefined);
    delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
    cfg = { images: { app: 'local/app', ui: 'local/ui', redis: 'redis:7' }, docsEnabled: false,
      manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } },
    } as unknown as OrchestratorConfig;
    const calls: string[][] = [];
    const controller = new AbortController();
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    let tagged = false;
    orch = { dockerAsync: async (args: string[], options: { signal: AbortSignal }) => {
      calls.push(args);
      if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
      if (args[0] === 'pull') {
        // Match the held boundary: publish admission only after cancellation is armed.
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          admit();
        });
      }
      if (args[0] === 'manifest') return { status: 0, stdout: '{"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]}' };
      if (!cached && args.at(-1) === 'redis:7') return { status: 1 };
      return { status: 0, stdout: '{"Os":"linux","Architecture":"arm64"}' };
    }, tagAgentLatest: () => { tagged = true; } } as unknown as OrchestratorModule;
    let settled = false;
    const pulling = createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [], signal: controller.signal });
    void pulling.then(() => { settled = true; }, () => { settled = true; });
    const aborted = assert.rejects(pulling, { name: 'AbortError' });
    try {
      await Promise.race([admitted, pulling.then(() => { throw new Error('production setup skipped the held pull'); })]);
      assert.equal(settled, false);
      assert.deepEqual(calls.filter(args => args[0] === 'pull'), [['pull', '--platform', 'linux/arm64', 'redis:7']]);
      assert.equal(calls.some(args => args[0] === 'manifest'), !cached);
      assert.equal(tagged, false);
    } finally { controller.abort(); }
    await aborted;
    assert.equal(tagged, false);
  });
}

test('Darwin unrelated stack errors preserve identity without mount guidance', async t => {
  platform(t, 'darwin');
  cfg = {} as OrchestratorConfig;
  class Conflict extends Error { code = 'STACK_INCOMPATIBLE'; }
  const conflict = new Conflict('incompatible stack');
  orch = {
    validateEnv: () => ({ ok: true, warnings: [] }),
    ensureNetworkAsync: async () => {},
    startStackAsync: async () => { throw conflict; },
  } as unknown as OrchestratorModule;
  await assert.rejects(createDefaultActions().startStack({ rootDir: '/tmp/root' }), error => {
    assert.equal(error, conflict);
    assert.equal(conflict.code, 'STACK_INCOMPATIBLE');
    assert.doesNotMatch(conflict.message, /File sharing/);
    return true;
  });
});


test('an incompatible cached core variant can be replaced from its published manifest', async t => {
  platform(t, 'darwin');
  cfg = { images: { redis: 'redis:7' }, manifest: {} } as unknown as OrchestratorConfig;
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args[0] === 'manifest') return { status: 0, stdout: '{"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]}' };
    return { status: 0, stdout: '{"Os":"linux","Architecture":"amd64"}' };
  } } as unknown as OrchestratorModule;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).pulledCore, ['redis:7']);
  assert.deepEqual(calls.find(args => args[0] === 'pull'), ['pull', '--platform', 'linux/arm64', 'redis:7']);
});

test('source image disappearance during platform inspection remains a failedCore result', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'local/app' }, manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } } } as unknown as OrchestratorConfig;
  orch = { dockerAsync: async (args: string[]) => {
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    return { status: args.includes('--format') ? 1 : 0 };
  } } as unknown as OrchestratorModule;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).failedCore, ['local/app']);
});

test('GitHub probes retain Finder tool discovery without changing the parent PATH', async t => {
  platform(t, 'darwin');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const childProcess = await import('node:child_process');
  const parentPath = process.env.PATH;
  const paths: string[] = [];
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    spawn: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      paths.push(options.env.PATH!);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      process.nextTick(() => {
        child.stdout.write(args[0] === '--version' ? 'gh fixture' : 'fixture-token');
        child.emit('close', 0);
      });
      return child;
    },
  } });
  const { loginWithGithubCli } = await import('../../auth/githubLogin.js');
  let stored: string | undefined;
  const result = await loginWithGithubCli({ setGithubToken: async (token: string) => { stored = token; } } as never, {
    authenticationHandoff: async () => { throw new Error('existing session should be reused'); },
  });
  assert.equal(result.ok, true);
  assert.equal(stored, 'fixture-token');
  assert.equal(paths.length, 2);
  assert.ok(paths.every(path => path.includes('/opt/homebrew/bin')));
  assert.equal(process.env.PATH, parentPath);
});

for (const skip of [false, true]) {
  test(`Darwin image failures remain structured and cancellation propagates (skipRemote=${skip})`, async t => {
    platform(t, 'darwin');
    const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
    t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
    process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = String(skip);
    cfg = { images: { redis: 'redis:7', agent: 'agent:latest' }, manifest: {} } as unknown as OrchestratorConfig;
    const calls: string[][] = [];
    const logs: string[] = [];
    const controller = new AbortController();
    let cancel = false;
    orch = { dockerAsync: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
      if (cancel) controller.abort();
      return { status: 1, stderr: 'registry access denied' };
    } } as unknown as OrchestratorModule;
    const result = await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: ['claude'], onLog: line => logs.push(line) });
    assert.deepEqual(result.failedCore, ['redis:7']);
    assert.deepEqual(result.failedAgents, ['agent:latest']);
    assert.equal(calls.some(args => args[0] === 'manifest'), !skip);
    assert.equal(calls.some(args => args[0] === 'pull'), false);
    assert.match(logs.join('\n'), skip ? /remote image checks are disabled/ : /registry access denied/);
    cancel = true;
    await assert.rejects(createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: ['claude'], signal: controller.signal }), { name: 'AbortError' });
  });
}

test('Darwin verified offline agent is retagged best-effort without registry access', async t => {
  platform(t, 'darwin');
  const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  cfg = { images: { agent: 'agent:pinned' }, manifest: {} } as unknown as OrchestratorConfig;
  const tags: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    assert.ok(!['manifest', 'pull'].includes(args[0]));
    return { status: 0, stdout: args[0] === 'info' ? 'arm64' : '{"Os":"linux","Architecture":"amd64"}' };
  }, tagAgentLatest: (key: string, tag: string) => { tags.push([key, tag]); throw new Error('best effort'); } } as unknown as OrchestratorModule;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: ['claude'] })).pulledAgents, ['agent:pinned']);
  assert.deepEqual(tags, [['agent', 'agent:pinned']]);
});

test('Darwin thrown manifest errors and incompatible offline cache remain per-image failures', async t => {
  platform(t, 'darwin');
  const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
  cfg = { images: { redis: 'redis:7' }, manifest: {} } as unknown as OrchestratorConfig;
  for (const skip of [false, true]) {
    process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = String(skip);
    orch = { dockerAsync: async (args: string[]) => {
      if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
      if (args[0] === 'manifest') throw new Error('registry transport unavailable');
      assert.notEqual(args[0], 'pull');
      return { status: 0, stdout: '{"Os":"linux","Architecture":"amd64"}' };
    } } as unknown as OrchestratorModule;
    const logs: string[] = [];
    const result = await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [], onLog: line => logs.push(line) });
    assert.deepEqual(result.failedCore, ['redis:7']);
    assert.match(logs.join('\n'), skip ? /required linux\/arm64/ : /registry transport unavailable/);
  }
});

for (const action of ['startStack', 'replaceRunningStack'] as const) {
  test(`Darwin ${action} limits file-sharing guidance to mount refusals`, async t => {
    platform(t, 'darwin');
    cfg = {} as OrchestratorConfig;
    for (const [message, expected] of [
      ['Failed to start api: Mounts denied: path is not shared from the host', true],
      ['Failed to start api: error while creating mount source path: permission denied', true],
      ['Failed to start api: bind mount operation not permitted', true],
      ['Failed to start api: permission denied connecting to Docker socket', false],
      ['Failed to start api: registry access denied', false],
    ] as const) {
      const failure = new Error(message);
      orch = {
        validateEnv: () => ({ ok: true, warnings: [] }),
        ensureNetworkAsync: async () => {},
        replaceStackContainersAsync: async () => {},
        startStackAsync: async () => { throw failure; },
      } as unknown as OrchestratorModule;
      await assert.rejects(createDefaultActions()[action]!({ rootDir: '/tmp/root' }), error => {
        assert.equal(error, failure);
        assert.equal(failure.message.includes('File sharing'), expected);
        return true;
      });
    }
  });
}

test('Darwin architecture failure is reported once for core, source-built and selected agent images; retry probes afresh', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'local/app', ui: 'local/ui', redis: 'redis:7', agent: 'agent:1', docs: 'docs:1' }, docsEnabled: false,
    manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } },
  } as unknown as OrchestratorConfig;
  const calls: string[][] = [];
  const logs: string[] = [];
  orch = { dockerAsync: async (args: string[]) => { calls.push(args); return { status: 1 }; } } as unknown as OrchestratorModule;
  const actions = createDefaultActions();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await actions.pullImages({ rootDir: '/tmp/root', agentTypes: ['codex'], onLog: line => logs.push(line) });
    assert.deepEqual(result, { pulledCore: [], pulledAgents: [], failedCore: ['local/app', 'local/ui', 'redis:7'], failedAgents: ['agent:1'] });
    assert.equal(calls.length, attempt);
    assert.deepEqual(calls.at(-1), ['info', '--format', '{{.Architecture}}']);
    assert.equal(logs.length, attempt);
  }
});

test('Darwin cancellation during the architecture probe does not become a cached failure', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'app', redis: 'redis' }, manifest: {} } as unknown as OrchestratorConfig;
  const controller = new AbortController();
  const cancelled = new Error('cancelled architecture inspection');
  let calls = 0;
  orch = { dockerAsync: async () => { calls++; controller.abort(cancelled); return { status: 1 }; } } as unknown as OrchestratorModule;
  await assert.rejects(createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [], signal: controller.signal }), cancelled);
  assert.equal(calls, 1);
});
