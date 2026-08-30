import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';

const [directory] = process.argv.slice(2);
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
    const folded = entry.name.toLocaleLowerCase('en-US');
    if (folded === 'windows-authority' || folded === 'windows-update-authority'
      || /^propr-windows-(?:authority|launcher|bootstrap)/.test(folded)) {
      throw new Error('Windows MVP package contains a deferred update authority resource');
    }
    if (stats.isDirectory()) await visit(target);
    else if (basename(target).toLocaleLowerCase('en-US') === 'propr-desktop.exe') applicationCount += 1;
  }
};

await visit(root);
if (applicationCount !== 1) throw new Error('Windows MVP package lacks one canonical application executable');
const asarPath = join(root, 'resources', 'app.asar');
const asarEntries = listPackage(asarPath).map(name => name.toLocaleLowerCase('en-US'));
if (asarEntries.some(name => /windows-(?:update-)?authority|propr-windows-(?:authority|launcher|bootstrap)/.test(name))) {
  throw new Error('Windows MVP application archive contains a deferred update authority resource');
}
const mainBundle = extractFile(asarPath, '.vite/build/main.cjs').toString('utf8');
if (/windows-update-authority|propr-windows-authority|--broker/.test(mainBundle)) {
  throw new Error('Windows MVP main process retains a reachable deferred update authority');
}
process.stdout.write('Windows MVP package contains one application and no update authority resources.\n');
