// Real APT acceptance; all sources, trust, status, lists and downloads live in a
// disposable directory. The HTTP server is loopback-only and closed afterward.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
const exec = promisify(execFile);

export async function aptAcceptance({ root, directory, manifest, identity }) {
  const home = join(root, 'apt-test');
  await mkdir(home);
  const files = new Map();
  for (const arch of ['amd64', 'arm64']) files.set(`/dists/preview/main/binary-${arch}/Packages`, await readFile(join(directory, `APT-Packages-${arch}`)));
  for (const name of ['Release', 'InRelease', 'Release.gpg']) files.set(`/dists/preview/${name}`, await readFile(join(directory, `APT-${name}`)));
  for (const a of manifest.artifacts.filter(a => a.kind === 'deb')) files.set(`/pool/${a.fileName}`, await readFile(join(directory, a.fileName)));
  const server = createServer((req, res) => {
    const bytes = files.get(req.url);
    res.writeHead(bytes ? 200 : 404);
    res.end(bytes || 'not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const keyPath = join(home, 'release.asc');
    await writeFile(keyPath, identity.publicKey);
    await mkdir(join(home, 'empty'));
    await writeFile(join(home, 'status'), '');
    await writeFile(join(home, 'sources.list'), `deb [signed-by=${keyPath}] http://127.0.0.1:${server.address().port} preview main\n`);
    const config = join(home, 'apt.conf');
    await writeFile(config, `Dir::Etc::main "-";\nDir::Etc::parts "${home}/empty";\nDir::Etc::sourcelist "${home}/sources.list";\nDir::Etc::sourceparts "${home}/empty";\nDir::Etc::trusted "${home}/absent.gpg";\nDir::Etc::trustedparts "${home}/empty";\nDir::State "${home}/state";\nDir::State::status "${home}/status";\nDir::Cache "${home}/cache";\nDir::Log "${home}/log";\nAPT::Sandbox::User "${userInfo().username}";\nAPT::Architecture "amd64";\nAPT::Architectures { "amd64"; "arm64"; };\nAcquire::Languages "none";\nAcquire::Retries "0";\n`);
    const apt = args => exec('apt-get', args, { cwd: home, env: { ...process.env, APT_CONFIG: config }, timeout: 30_000 });
    const fresh = async () => {
      await rm(join(home, 'state'), { recursive: true, force: true });
      await mkdir(join(home, 'state/lists/partial'), { recursive: true });
      await mkdir(join(home, 'cache/archives/partial'), { recursive: true });
    };
    const update = () => apt(['-o', 'APT::Update::Error-Mode=any', 'update']);
    await fresh();
    await update();
    for (const arch of ['amd64', 'arm64']) {
      await apt(['download', `propr-desktop:${arch}=${manifest.version}`]);
      const artifact = manifest.artifacts.find(a => a.kind === 'deb' && a.arch === (arch === 'amd64' ? 'x64' : 'arm64'));
      const downloaded = join(home, `propr-desktop_${manifest.version}_${arch}.deb`);
      assert.deepEqual(await readFile(downloaded), await readFile(join(directory, artifact.fileName)));
      await rm(downloaded);
      const path = `/pool/${artifact.fileName}`;
      const original = files.get(path);
      const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
      files.set(path, corrupt);
      await assert.rejects(apt(['download', `propr-desktop:${arch}=${manifest.version}`]), /Hash Sum mismatch/);
      files.set(path, original);
    }
    // Force fresh indexes; cached trusted data must not hide repository tampering.
    const indexPath = '/dists/preview/main/binary-amd64/Packages';
    const index = files.get(indexPath);
    files.set(indexPath, Buffer.concat([index, Buffer.from('tamper')]));
    await fresh();
    await assert.rejects(update(), /Hash Sum mismatch|unexpected size/);
    files.set(indexPath, index);
    const inlinePath = '/dists/preview/InRelease';
    const inline = files.get(inlinePath);
    files.set(inlinePath, Buffer.from(inline.toString().replace('Origin: ProPR', 'Origin: Wrong')));
    await fresh();
    await assert.rejects(update(), /invalid|signature|not signed/i);
    // Real APT must also accept the detached Release.gpg fallback.
    files.delete(inlinePath);
    await fresh();
    await update();
    files.delete('/dists/preview/Release.gpg');
    await fresh();
    await assert.rejects(update(), /not signed/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
