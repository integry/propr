import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A minimal MCP server over stdio: `echo` and `secret_length` tools. It reads
 * FIXTURE_TOKEN (a secret variable) and FIXTURE_GREETING (a plain variable)
 * and requires its dependency, so a missing dependency fails the call.
 */
const SERVER = `#!/usr/bin/env node
const { prefix } = require('propr-fixture-dep');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) return;
  if (rpc.method === 'initialize') return send({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
  if (rpc.method === 'tools/list') return send({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }, { name: 'secret_length', inputSchema: { type: 'object' } }, { name: 'hidden', inputSchema: { type: 'object' } }] } });
  if (rpc.method === 'tools/call') {
    const text = rpc.params.name === 'echo' ? prefix + (process.env.FIXTURE_GREETING || '') + ':' + String(rpc.params.arguments?.text ?? '') + ':' + process.argv.slice(2).join(',')
      : rpc.params.name === 'secret_length' ? String((process.env.FIXTURE_TOKEN || '').length) + ':' + (process.env.FIXTURE_TOKEN || '') : 'hidden';
    return send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }] } });
  }
  send({ jsonrpc: '2.0', id: rpc.id, result: {} });
});
`;

/** A fixture package; a manifest function receives the registry's base URL, for dependencies that point back at it. */
export interface FixturePackage { name: string; version: string; files: Record<string, string>; manifest: Record<string, unknown> | ((base: string) => Record<string, unknown>) }
interface Published { manifest: Record<string, unknown>; tarball: Buffer; integrity: string }

/** Pack each fixture package with npm and serve packuments, version documents and tarballs over local HTTP. */
export async function npmRegistryFixture(extra: FixturePackage[] = [], marker = path.join(os.tmpdir(), `propr-lifecycle-${process.pid}-${Date.now()}`)) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-registry-fixture-'));
  const packages: FixturePackage[] = [
    { name: 'propr-fixture-dep', version: '1.0.0', files: { 'index.js': "exports.prefix = 'dep:';\n" },
      // A dependency's lifecycle script must never run during install.
      manifest: { main: 'index.js', scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` } } },
    { name: 'propr-fixture-mcp', version: '1.0.0', files: { 'bin/server.js': SERVER }, manifest: { bin: { 'propr-fixture-mcp': 'bin/server.js' }, dependencies: { 'propr-fixture-dep': '1.0.0' } } },
    { name: 'propr-fixture-multi', version: '2.0.0', files: { 'a.js': SERVER, 'b.js': SERVER }, manifest: { bin: { alpha: 'a.js', beta: 'b.js' }, dependencies: { 'propr-fixture-dep': '1.0.0' } } },
    { name: 'propr-fixture-scripts', version: '1.0.0', files: { 'bin.js': SERVER }, manifest: { bin: 'bin.js', scripts: { postinstall: 'node bin.js' } } },
    ...extra,
  ];
  const published = new Map<string, Map<string, Published>>();
  let base = '';
  const requests: string[] = [];
  const document = (name: string, version: string, entry: Published) => ({ ...entry.manifest, ...(entry.manifest.scripts && Object.keys(entry.manifest.scripts as object).some(s => ['preinstall', 'install', 'postinstall'].includes(s)) ? { hasInstallScript: true } : {}), dist: { integrity: entry.integrity, tarball: `${base}/${name}/-/${name}-${version}.tgz` } });
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '/'); requests.push(url);
    // `/-/redirect/<encoded URL>` answers with a redirect there, as a package-controlled tarball URL could.
    const redirect = /^\/-\/redirect\/([^/]+)$/.exec(request.url ?? '');
    if (redirect) { response.writeHead(302, { Location: decodeURIComponent(redirect[1]) }).end(); return; }
    const tar = /^\/([^/]+)\/-\/[^/]+-([^/]+)\.tgz$/.exec(url);
    if (tar) {
      const entry = published.get(tar[1])?.get(tar[2]);
      if (!entry) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(entry.tarball); return;
    }
    const [, name, version] = /^\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url) ?? [];
    const versions = name ? published.get(name) : undefined;
    if (!versions) { response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}'); return; }
    if (version) {
      const entry = versions.get(version);
      if (!entry) { response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(document(name, version, entry))); return;
    }
    const all = Object.fromEntries([...versions].map(([v, entry]) => [v, document(name, v, entry)]));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name, 'dist-tags': { latest: [...versions.keys()].at(-1) }, versions: all }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const pkg of packages) {
      const directory = path.join(work, `${pkg.name}-${pkg.version}`);
      for (const [file, content] of Object.entries(pkg.files)) {
        await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await fs.writeFile(path.join(directory, file), content, { mode: 0o755 });
      }
      const manifest = typeof pkg.manifest === 'function' ? pkg.manifest(base) : pkg.manifest;
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, license: 'MIT', ...manifest }));
      const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: directory, env: { ...process.env, npm_config_update_notifier: 'false' } });
      const filename = (JSON.parse(stdout) as { filename: string }[])[0].filename;
      const tarball = await fs.readFile(path.join(work, filename));
      const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
      if (!published.has(pkg.name)) published.set(pkg.name, new Map());
      published.get(pkg.name)!.set(pkg.version, { manifest: { name: pkg.name, version: pkg.version, ...manifest }, tarball, integrity });
    }
  } catch (error) { server.close(); await fs.rm(work, { recursive: true, force: true }); throw error; }
  return {
    url: base, marker, requests,
    integrity: (name: string, version: string) => published.get(name)!.get(version)!.integrity,
    close: async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(work, { recursive: true, force: true }); await fs.rm(marker, { force: true }); },
  };
}
