import { execFile } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

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
await execFileAsync('hdiutil', [
  'create',
  '-volname', 'ProPR Desktop',
  '-srcfolder', appPath,
  '-ov',
  '-format', 'UDZO',
  outputPath,
]);
console.log(outputPath);
