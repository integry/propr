import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLockfileFileDependencies, lockfileFileDependencies, prepareSignedRpmAcceptanceContext,
  SIGNED_RPM_ACCEPTANCE_CONTEXT } from './signed-rpm-acceptance-context.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = fileURLToPath(new URL('./signed-rpm-acceptance.Dockerfile', import.meta.url));
const files = async directory => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/')).sort();

const withDirectory = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'signed-rpm-context-'));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

// Apply the Dockerfile's context COPY instructions that precede `npm ci`, so the
// result is the filesystem npm ci actually sees inside the acceptance image.
const imageBeforeNpmCi = async (source, context, image) => {
  let workdir = '/';
  for (const line of source.split('\n')) {
    const [instruction, ...args] = line.trim().split(/\s+/);
    if (instruction === 'WORKDIR') workdir = posix.resolve(workdir, args[0]);
    if (instruction === 'RUN' && /\bnpm ci\b/.test(line)) return join(image, workdir);
    if (instruction !== 'COPY' || args.some(arg => arg.startsWith('--'))) continue;
    const destination = args.pop();
    for (const input of args) {
      const target = posix.resolve(workdir, destination.endsWith('/') && !input.endsWith('/') ? posix.join(destination, posix.basename(input)) : destination);
      await mkdir(join(image, posix.dirname(target)), { recursive: true });
      await cp(join(context, input), join(image, target), { recursive: true });
    }
  }
  throw new Error('Dockerfile never runs npm ci');
};

test('sanitized context carries every lockfile file: tarball with its pinned bytes into npm ci', () => withDirectory(async directory => {
  const context = join(directory, 'context');
  await prepareSignedRpmAcceptanceContext({ root: repoRoot, context });
  const lock = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8'));
  const dependencies = lockfileFileDependencies(lock);
  assert.ok(dependencies.some(({ name }) => name === 'node_modules/braces'), 'braces must still resolve from a vendored tarball');
  const workdir = await imageBeforeNpmCi(await readFile(dockerfile, 'utf8'), context, join(directory, 'image'));
  assert.deepEqual(await assertLockfileFileDependencies(workdir), dependencies);
  for (const { path } of dependencies) {
    assert.deepEqual(await readFile(join(workdir, path)), await readFile(join(repoRoot, path)));
  }
}));

test('Docker inputs without the vendored tarball fail before npm ci', () => withDirectory(async directory => {
  const context = join(directory, 'context');
  await prepareSignedRpmAcceptanceContext({ root: repoRoot, context });
  const source = (await readFile(dockerfile, 'utf8')).split('\n').filter(line => !/^COPY\s+vendor\//.test(line)).join('\n');
  const workdir = await imageBeforeNpmCi(source, context, join(directory, 'image'));
  await assert.rejects(assertLockfileFileDependencies(workdir), /missing vendor\/braces-3\.0\.4-depthguard\.1\.tgz/);
}));

test('context preparation rejects a missing or altered lockfile tarball', () => withDirectory(async directory => {
  const root = join(directory, 'root');
  await prepareSignedRpmAcceptanceContext({ root: repoRoot, context: root });
  const [{ path }] = lockfileFileDependencies(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')));
  const bytes = await readFile(join(root, path));
  await rm(join(root, path));
  await assert.rejects(prepareSignedRpmAcceptanceContext({ root, context: join(directory, 'missing') }), /ENOENT|missing/);
  const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 0xff;
  await writeFile(join(root, path), altered);
  await assert.rejects(prepareSignedRpmAcceptanceContext({ root, context: join(directory, 'altered') }), /altered/);
}));

test('lockfile file: dependencies must stay inside the checkout and carry sha512 integrity', () => {
  for (const entry of [{ resolved: 'file:../outside.tgz', integrity: 'sha512-AA==' }, { resolved: 'file:/etc/x.tgz', integrity: 'sha512-AA==' },
    { resolved: 'file:vendor/x.tgz' }, { resolved: 'file:vendor/x.tgz', integrity: 'sha1-AA==' }]) {
    assert.throws(() => lockfileFileDependencies({ packages: { 'node_modules/x': entry } }), /unpinned local dependency/);
  }
});

test('sanitized context excludes host profiles, credentials, signing bundles and unrelated vendor content', () => withDirectory(async directory => {
  const root = join(directory, 'root');
  await prepareSignedRpmAcceptanceContext({ root: repoRoot, context: root });
  const sensitive = ['.env', 'apps/desktop/.env.local', 'profiles/default.json', 'signing/bundle.p12', '.npmrc', '.git/config',
    'vendor/braces/index.js', 'vendor/unreviewed-1.0.0.tgz', 'packages/api/src/secret.ts', 'node_modules/x/index.js', 'keys/private.asc'];
  for (const path of sensitive) {
    await mkdir(join(root, posix.dirname(path)), { recursive: true });
    await writeFile(join(root, path), 'sentinel-secret');
  }
  const context = join(directory, 'context');
  await prepareSignedRpmAcceptanceContext({ root, context });
  const sent = await files(context);
  for (const path of sensitive) assert.ok(!sent.includes(path), `${path} must not reach Docker`);
  for (const path of sent) {
    assert.ok(SIGNED_RPM_ACCEPTANCE_CONTEXT.some(allowed => path === allowed || path.startsWith(`${allowed}/`)), `${path} is not allowlisted`);
  }
  assert.deepEqual(sent.filter(path => path.startsWith('vendor/')), ['vendor/braces-3.0.4-depthguard.1.tgz']);
  const tarball = await readFile(join(context, 'vendor/braces-3.0.4-depthguard.1.tgz'));
  const lock = JSON.parse(await readFile(join(context, 'package-lock.json'), 'utf8'));
  assert.equal(`sha512-${createHash('sha512').update(tarball).digest('base64')}`, lock.packages['node_modules/braces'].integrity);
}));
