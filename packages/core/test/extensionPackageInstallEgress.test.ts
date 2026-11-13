import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { npmRegistryFixture } from './helpers/npmRegistryFixture.js';
import { ExtensionPackageCache, ExtensionPackageError, type NpmRunner } from '../src/extensions/packageCache.js';
import { assertRegistryDependencies, packageInstallEgressPolicy, startPackageInstallProxy } from '../src/extensions/packageInstallEgress.js';

/** An internal service on the worker's network that serves a valid package archive and records every request. */
async function internalService(t: TestContext, tarball: () => Promise<Buffer>) {
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(await tarball());
  });
  // Raw connections too: a git client speaking SSH never sends an HTTP request.
  let connections = 0; server.on('connection', () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/private-package.tgz`, port, requests, connections: () => connections };
}

async function installFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-package-egress-'));
  t.after(async () => { await fs.chmod(root, 0o755).catch(() => {}); await import('node:child_process').then(c => c.execFileSync('chmod', ['-R', 'u+w', root])); await fs.rm(root, { recursive: true, force: true }); });
  let registryUrl = '';
  // Any valid package archive: the registry's own dependency tarball.
  const internal = await internalService(t, async () => Buffer.from(await (await fetch(`${registryUrl}/propr-fixture-dep/-/propr-fixture-dep-1.0.0.tgz`)).arrayBuffer()));
  const localDirectory = path.join(root, 'worker-only'); await fs.mkdir(localDirectory);
  await fs.writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({ name: 'worker-only', version: '1.0.0' }));
  await fs.writeFile(path.join(localDirectory, 'credentials.txt'), 'worker-only file');
  const server = (name: string, dependency: string | ((base: string) => string)) => ({
    name, version: '1.0.0', files: { 'bin.js': '#!/usr/bin/env node\n' },
    manifest: (base: string) => ({ bin: 'bin.js', dependencies: { 'propr-fixture-dep': '1.0.0', 'internal-package': typeof dependency === 'function' ? dependency(base) : dependency } }),
  });
  const registry = await npmRegistryFixture([
    // A public package whose dependency names a tarball on the worker's private network.
    server('propr-fixture-private-url', internal.url),
    // The same destination reached through a redirect from the allowed registry host.
    server('propr-fixture-redirect', base => `${base}/-/redirect/${encodeURIComponent(internal.url)}`),
    // Git sources on the same private service, over HTTP and SSH.
    server('propr-fixture-git-http', `git+http://127.0.0.1:${internal.port}/repo.git`),
    server('propr-fixture-git-ssh', `git+ssh://git@127.0.0.1:${internal.port}/repo.git`),
    // A dependency read from the worker's own filesystem.
    server('propr-fixture-file', `file:${localDirectory}`),
  ]);
  registryUrl = registry.url;
  t.after(() => registry.close());
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-package-custody', PROPR_EXTENSION_NPM_REGISTRY: registry.url, PROPR_EGRESS_SOCKET_DIR: path.join(root, 'egress'), PATH: process.env.PATH };
  const npm: NpmRunner = (args, options) => new Promise((resolve, reject) => {
    const child = spawn('npm', args, { ...options, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`npm ${code}`))));
  });
  const cache = new ExtensionPackageCache(environment, npm);
  const pinned = (name: string) => ({ ecosystem: 'npm' as const, package: name, version: '1.0.0', integrity: registry.integrity(name, '1.0.0'), bin: undefined });
  return { cache, registry, internal, pinned, environment };
}

test('a dependency pointing at a private tarball endpoint, directly, through a redirect or as a git source, is never requested; the install is refused', async t => {
  const { cache, registry, internal, pinned } = await installFixture(t);
  for (const name of ['propr-fixture-private-url', 'propr-fixture-redirect', 'propr-fixture-git-http', 'propr-fixture-git-ssh']) {
    await assert.rejects(cache.ensure(pinned(name)), (error: unknown) => error instanceof ExtensionPackageError && error.reason === 'package_unavailable', name);
    await assert.rejects(fs.lstat(path.join(cache.roots().local, cache.key(pinned(name)))), /ENOENT/, `${name} left no install`);
  }
  assert.ok(registry.requests.some(url => url.startsWith('/-/redirect/')), 'the redirecting registry URL was requested');
  assert.deepEqual(internal.requests, [], 'the internal service was never reached');
  assert.equal(internal.connections(), 0, 'not even a connection was opened to it');
  // The ordinary package from the same registry still installs through the same policy.
  const installed = await cache.ensure(pinned('propr-fixture-mcp'));
  assert.ok(await fs.stat(path.join(installed.localDirectory, 'node_modules', 'propr-fixture-dep', 'index.js')));
});

test('a dependency from the worker filesystem is refused before anything is recorded or mounted', async t => {
  const { cache, pinned } = await installFixture(t);
  await assert.rejects(cache.ensure(pinned('propr-fixture-file')), (error: unknown) => error instanceof ExtensionPackageError && error.reason === 'package_unavailable');
  await assert.rejects(fs.lstat(path.join(cache.roots().local, cache.key(pinned('propr-fixture-file')))), /ENOENT/);
  const leftovers = await fs.readdir(cache.roots().local);
  assert.deepEqual(leftovers, [], 'no work directory remains');
});

test('the install policy admits only the registry host and port; the public registry must resolve publicly', async t => {
  const publicPolicy = packageInstallEgressPolicy({});
  assert.equal(publicPolicy.registry, 'https://registry.npmjs.org');
  assert.ok(publicPolicy.allowlist.allows('registry.npmjs.org', 443));
  for (const [host, port] of [['registry.npmjs.org', 80], ['registry.npmjs.org', 8443], ['evil.example.com', 443], ['127.0.0.1', 443], ['169.254.169.254', 80], ['registry.yarnpkg.com', 443]] as const) assert.equal(publicPolicy.allowlist.allows(host, port), false, `${host}:${port}`);
  assert.equal(publicPolicy.addressAllowlist.allows('10.0.0.7', 443), false, 'no private address is ever opened for the public registry');
  const mirror = packageInstallEgressPolicy({ PROPR_EXTENSION_NPM_REGISTRY: 'http://npm-mirror:4873/' });
  assert.ok(mirror.allowlist.allows('npm-mirror', 4873));
  assert.equal(mirror.allowlist.allows('npm-mirror', 80), false);
  assert.equal(mirror.allowlist.allows('other-service', 4873), false);
  assert.ok(mirror.addressAllowlist.allows('172.18.0.4', 4873), 'an operator mirror may resolve to a private address');

  // Through the running proxy: the public registry name answering with a private address is refused, as is any other host.
  const proxy = await startPackageInstallProxy({}, { lookup: async host => host === 'registry.npmjs.org' ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.215.14', family: 4 }] });
  t.after(() => proxy.close());
  const connect = (authority: string) => new Promise<number>((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    const request = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: 'CONNECT', path: authority });
    request.on('connect', response => { response.socket.destroy(); resolve(response.statusCode ?? 0); });
    request.on('response', response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', reject); request.end();
  });
  assert.equal(await connect('registry.npmjs.org:443'), 403);
  assert.equal(await connect('evil.example.com:443'), 403);
  assert.equal(await connect('10.0.0.7:443'), 403);
  const plain = await new Promise<number>((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    http.get({ host: proxyUrl.hostname, port: proxyUrl.port, path: 'http://169.254.169.254/latest/meta-data/' }, response => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject);
  });
  assert.equal(plain, 403);
  assert.equal(proxy.stats().allowedConnections, 0);
});

test('the lockfile check accepts only registry-resolved dependencies with integrity values', () => {
  const registry = 'http://127.0.0.1:4873';
  const ok = { resolved: `${registry}/a/-/a-1.0.0.tgz`, integrity: 'sha512-x' };
  assert.doesNotThrow(() => assertRegistryDependencies({ packages: { '': {}, 'node_modules/a': ok, 'node_modules/a/node_modules/b': { inBundle: true } } }, registry));
  for (const entry of [{ resolved: 'http://127.0.0.1:9999/a.tgz', integrity: 'sha512-x' }, { resolved: `${registry}evil.example/a.tgz`, integrity: 'sha512-x' }, { resolved: 'file:../x' }, { resolved: '/etc', link: true }, { ...ok, integrity: undefined }, { resolved: 'git+ssh://git@github.com/a/b.git#abc', integrity: 'sha512-x' }, {}]) {
    assert.throws(() => assertRegistryDependencies({ packages: { 'node_modules/a': entry } }, registry), JSON.stringify(entry));
  }
});
