import { createHash } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

// The only paths sent to Docker: test code, dependency manifests and the
// reviewed tarballs the lockfile installs from. Never a host checkout's
// profiles, signing bundle, environment files, credentials or other vendor content.
export const SIGNED_RPM_ACCEPTANCE_CONTEXT = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json',
  'apps/desktop/package.json', 'propr-ui/package.json',
  ...['api', 'cli', 'client', 'core', 'local-setup', 'shared'].map(name => `packages/${name}/package.json`),
  'packages/shared/tsconfig.json', 'packages/shared/src', 'apps/desktop/scripts',
  'vendor/braces-3.0.4-depthguard.1.tgz']);

// Lockfile packages npm ci installs from a local tarball rather than a registry.
export const lockfileFileDependencies = lock => Object.entries(lock?.packages ?? {})
  .filter(([, entry]) => typeof entry?.resolved === 'string' && entry.resolved.startsWith('file:'))
  .map(([name, entry]) => {
    const path = posix.normalize(entry.resolved.slice('file:'.length));
    if (path.startsWith('../') || posix.isAbsolute(path) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) {
      throw new Error(`Signed RPM acceptance refuses unpinned local dependency ${name}`);
    }
    return { name, path, integrity: entry.integrity };
  });

// Fail before docker build when npm ci would miss or reject a local tarball.
export const assertLockfileFileDependencies = async directory => {
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  const dependencies = lockfileFileDependencies(lock);
  for (const { name, path, integrity } of dependencies) {
    let bytes;
    try { bytes = await readFile(join(directory, path)); }
    catch { throw new Error(`Signed RPM acceptance context is missing ${path} for ${name}`); }
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
      throw new Error(`Signed RPM acceptance context has altered ${path} for ${name}`);
    }
  }
  return dependencies;
};

export const prepareSignedRpmAcceptanceContext = async ({ root, context }) => {
  for (const relative of SIGNED_RPM_ACCEPTANCE_CONTEXT) {
    const target = join(context, relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(join(root, relative), target, { recursive: true });
  }
  await assertLockfileFileDependencies(context);
};
