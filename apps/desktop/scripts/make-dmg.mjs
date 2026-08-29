import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('DMG artifacts must be built on a native macOS host');

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = process.env.PROPR_DESKTOP_VERSION?.trim() || packageJson.version;
const archArgument = process.argv.find(argument => argument.startsWith('--arch='));
const arch = archArgument?.slice('--arch='.length) || process.arch;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error(`Invalid desktop release version: ${version}`);
}
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported macOS architecture: ${arch}`);

const appPath = resolve('out', `propr-desktop-darwin-${arch}`, 'propr-desktop.app');
const outputDirectory = resolve('out', 'make', 'dmg', arch);
const outputPath = resolve(outputDirectory, `ProPR-Desktop-${version}-macos-${arch}.dmg`);
await access(appPath);
await mkdir(outputDirectory, { recursive: true });
const stagingDirectory = await mkdtemp(join(tmpdir(), 'propr-dmg-layout-'));
try {
  await cp(appPath, join(stagingDirectory, basename(appPath)), { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', join(stagingDirectory, 'Applications'));
  await execFileAsync('hdiutil', [
    'create',
    '-volname', 'ProPR Desktop',
    '-srcfolder', stagingDirectory,
    '-ov',
    '-format', 'UDZO',
    outputPath,
  ]);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
console.log(outputPath);
