import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const PACKAGE_MAIN = '.vite/build/main.cjs';
const AUTHORITY_TOKEN = /windows-(?:update-)?authority|propr-windows-(?:authority|launcher|bootstrap)|--broker/i;

const normalizeArchiveEntry = entry => {
  if (typeof entry !== 'string' || entry.length < 2 || /[\u0000-\u001F\u007F]/.test(entry)) {
    throw new Error('Windows MVP application archive contains an invalid entry');
  }
  const separator = entry[0];
  if ((separator !== '/' && separator !== '\\') || entry[1] === '/' || entry[1] === '\\') {
    throw new Error('Windows MVP application archive entry is not represented from one root');
  }
  const otherSeparator = separator === '/' ? '\\' : '/';
  if (entry.slice(1).includes(otherSeparator)) {
    throw new Error('Windows MVP application archive entry mixes path representations');
  }
  const normalized = entry.slice(1).split('\\').join('/');
  const components = normalized.split('/');
  if (components.some(component => !component || component === '.' || component === '..' || component.includes(':'))) {
    throw new Error('Windows MVP application archive entry contains traversal or ambiguity');
  }
  return normalized;
};

const canonicalArchiveEntry = (archiveEntries, expected) => {
  if (!Array.isArray(archiveEntries) || archiveEntries.length > 10_000) {
    throw new Error('Windows MVP application archive entry bound exceeded');
  }
  const representations = new Map();
  let matchedEntry;
  for (const entry of archiveEntries) {
    const normalized = normalizeArchiveEntry(entry);
    const folded = normalized.toLocaleLowerCase('en-US');
    if (representations.has(folded)) {
      throw new Error('Windows MVP application archive contains duplicate or case-colliding entries');
    }
    representations.set(folded, entry);
    if (folded === expected.toLocaleLowerCase('en-US')) {
      if (normalized !== expected) {
        throw new Error(`Windows MVP application archive ${expected} entry has non-canonical casing`);
      }
      matchedEntry = entry.slice(1);
    }
  }
  if (!matchedEntry) {
    throw new Error(`Windows MVP application archive lacks one canonical ${expected} entry`);
  }
  return matchedEntry;
};

export const canonicalMainBundleEntry = archiveEntries => canonicalArchiveEntry(archiveEntries, PACKAGE_MAIN);

export const assertWindowsMvpPackage = async directory => {
  if (!directory || !isAbsolute(directory)) {
    throw new Error('Windows MVP package assertion requires one absolute application directory');
  }

  const root = resolve(directory);
  let applicationCount = 0;
  let entries = 0;
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const stats = await lstat(target);
      entries += 1;
      if (entries > 10_000) throw new Error('Windows MVP package entry bound exceeded');
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error('Windows MVP package contains a link or special resource');
      }
      if (AUTHORITY_TOKEN.test(entry.name)) {
        throw new Error('Windows MVP package contains a deferred update authority resource');
      }
      if (stats.isDirectory()) await visit(target);
      else if (basename(target).toLocaleLowerCase('en-US') === 'propr-desktop.exe') applicationCount += 1;
    }
  };

  await visit(root);
  if (applicationCount !== 1) throw new Error('Windows MVP package lacks one canonical application executable');
  const asarPath = join(root, 'resources', 'app.asar');
  const asarEntries = listPackage(asarPath);
  const packageEntry = canonicalArchiveEntry(asarEntries, 'package.json');
  const packageBytes = extractFile(asarPath, packageEntry);
  if (packageBytes.length > 65_536) throw new Error('Windows MVP application package metadata is too large');
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(packageBytes.toString('utf8'));
  } catch {
    throw new Error('Windows MVP application package metadata is invalid');
  }
  if (!packageMetadata || Array.isArray(packageMetadata) || packageMetadata.main !== PACKAGE_MAIN) {
    throw new Error(`Windows MVP application package main must be ${PACKAGE_MAIN}`);
  }
  const mainEntry = canonicalMainBundleEntry(asarEntries);
  if (asarEntries.some(entry => AUTHORITY_TOKEN.test(normalizeArchiveEntry(entry)))) {
    throw new Error('Windows MVP application archive contains a deferred update authority resource');
  }
  const mainBundle = extractFile(asarPath, mainEntry).toString('utf8');
  if (AUTHORITY_TOKEN.test(mainBundle)) {
    throw new Error('Windows MVP main process retains a reachable deferred update authority');
  }
  process.stdout.write('Windows MVP package contains one application and no update authority resources.\n');
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [directory] = process.argv.slice(2);
  await assertWindowsMvpPackage(directory);
}
