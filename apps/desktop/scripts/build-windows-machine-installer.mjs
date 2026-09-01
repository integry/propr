import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertWindowsInstallerProductVersion } from './windows-installer-version.mjs';

const execFileAsync = promisify(execFile);
const INSTALLED_WIX_DIRECTORY = String.raw`C:\Program Files (x86)\WiX Toolset v3.14\bin`;
const WIX_VERSION = /\bversion\s+3\.14\.1(?:\.\d+)?\b/i;
const WIX_TIMEOUT_POLICY_MS = Object.freeze({
  TOOL_VERSION: 120_000,
  CANDLE: 120_000,
  PROBE_LIGHT: 120_000,
  PRODUCTION_LIGHT: 10 * 60_000,
});
const WIX_MAX_BUFFER_BYTES = 64 * 1024;
const WIX_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_FILES = 4096;
const MAX_PATH_BYTES = 32 * 1024;
const UPGRADE_CODE = '79D29087-5B38-4D77-93C8-5BC0F7856D59';

const fail = message => { throw new Error(`Windows machine installer build failed: ${message}`); };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const failWixPrerequisite = () => fail('provide the official WiX Toolset 3.14.1 build directory');

const windowsPathIdentity = value => win32.normalize(value).replace(/^\\\\\?\\/, '').toLowerCase();

const selectedWixDirectory = (arch, wixDirectory) => {
  if (arch === 'x64') {
    if (wixDirectory && windowsPathIdentity(wixDirectory) !== windowsPathIdentity(INSTALLED_WIX_DIRECTORY)) {
      failWixPrerequisite();
    }
    return INSTALLED_WIX_DIRECTORY;
  }
  if (arch !== 'arm64' || typeof wixDirectory !== 'string' || !win32.isAbsolute(wixDirectory)
    || Buffer.byteLength(wixDirectory, 'utf8') > MAX_PATH_BYTES) {
    failWixPrerequisite();
  }
  return wixDirectory;
};

export const windowsWixDirectoryForTest = selectedWixDirectory;

const canonicalWixTool = async expected => {
  try {
    const stats = await lstat(expected);
    if (!stats.isFile() || stats.isSymbolicLink()) failWixPrerequisite();
    const canonical = await realpath(expected);
    if (windowsPathIdentity(canonical) !== windowsPathIdentity(expected)) failWixPrerequisite();
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Windows machine installer build failed:')) throw error;
    failWixPrerequisite();
  }
};

const redactLiteral = (value, literal) => {
  if (!literal) return value;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'gi'), '<path>');
};

const normalizedWixDiagnostic = (error, redactions) => {
  const stderr = typeof error?.stderr === 'string' || Buffer.isBuffer(error?.stderr)
    ? String(error.stderr)
    : '';
  const stdout = typeof error?.stdout === 'string' || Buffer.isBuffer(error?.stdout)
    ? String(error.stdout)
    : '';
  const message = error instanceof Error ? error.message : '';
  let diagnostic = stderr.trim() || stdout.trim() || message.trim() || 'no diagnostic output';
  diagnostic = diagnostic.replace(/\r\n?/g, '\n').replace(/\u001b\[[0-9;]*m/g, '');
  for (const path of [...redactions].sort((left, right) => right.length - left.length)) {
    diagnostic = redactLiteral(diagnostic, path);
  }
  diagnostic = diagnostic
    .split('\n')
    .map(line => line.replace(/^.*?(?=\(\d+(?:,\d+)?\)\s*:\s*(?:error|warning)\b)/i, '<path>'))
    .join('\n')
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '<path>')
    .replace(/\\\\[^\r\n]*/g, '<path>')
    .replace(/[^\t\n\x20-\x7e]/g, '?')
    .trim();
  return (diagnostic || 'no diagnostic output').slice(0, WIX_DIAGNOSTIC_BYTES);
};

const numericWixSignal = signal => {
  if (Number.isInteger(signal)) return signal;
  if (typeof signal === 'string' && Number.isInteger(osConstants.signals[signal])) {
    return osConstants.signals[signal];
  }
  return 0;
};

const runWix = async (stage, executable, args, cwd, timeout, redactions = []) => {
  try {
    return await execFileAsync(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      timeout,
      maxBuffer: WIX_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const exit = Number.isInteger(error?.code) ? error.code : -1;
    const signal = numericWixSignal(error?.signal);
    const sensitivePaths = [executable, cwd, ...args, ...redactions]
      .filter(value => typeof value === 'string' && win32.isAbsolute(value));
    const diagnostic = normalizedWixDiagnostic(error, sensitivePaths);
    const wrapped = new Error(
      `Windows machine installer build failed: ${stage} exit=${exit} signal=${signal}: ${diagnostic}`,
    );
    wrapped.stack = wrapped.message;
    throw wrapped;
  }
};

const resolveWixToolset = async (cwd, arch, wixDirectory) => {
  const directory = selectedWixDirectory(arch, wixDirectory);
  const candle = await canonicalWixTool(join(directory, 'candle.exe'));
  const light = await canonicalWixTool(join(directory, 'light.exe'));
  const [candleVersion, lightVersion] = await Promise.all([
    runWix('CANDLE', candle, ['-?'], cwd, WIX_TIMEOUT_POLICY_MS.TOOL_VERSION),
    runWix('LIGHT', light, ['-?'], cwd, WIX_TIMEOUT_POLICY_MS.TOOL_VERSION),
  ]);
  for (const result of [candleVersion, lightVersion]) {
    if (!WIX_VERSION.test(`${result.stdout}\n${result.stderr}`)) failWixPrerequisite();
  }
  return { candle, light };
};

const removeTemporary = async (temporary, failed) => {
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    if (!failed) fail('temporary cleanup failed');
  }
};

const collectTree = async root => {
  const files = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path, { bigint: true });
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) fail('special packaged entry');
      if (stats.isDirectory()) await visit(path);
      else {
        const name = relative(root, path);
        if (!name || Buffer.byteLength(name, 'utf8') > MAX_PATH_BYTES || stats.size < 0n) fail('invalid packaged entry');
        files.push({ path, name, size: stats.size });
        if (files.length > MAX_FILES) fail('packaged entry bound');
      }
    }
  };
  await visit(root);
  if (!files.some(entry => entry.name.toLowerCase() === 'propr-desktop.exe')) fail('canonical executable missing');
  const forbiddenAuthority = files.find(entry => /(?:^|\\)(?:windows-update-authority|windows-authority)(?:\\|$)/i.test(entry.name)
    || /propr-windows-(?:authority|launcher|bootstrap)/i.test(entry.name));
  if (forbiddenAuthority) {
    fail('deferred Windows update authority resource present');
  }
  return files;
};

const directoryXml = files => {
  const root = { children: new Map(), files: [] };
  for (const file of files) {
    const parts = file.name.split('\\');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      if (!cursor.children.has(part)) cursor.children.set(part, { children: new Map(), files: [] });
      cursor = cursor.children.get(part);
    }
    cursor.files.push(file);
  }
  let next = 0;
  const components = [];
  const render = (node, indent) => {
    const lines = [];
    for (const [name, child] of node.children) {
      const directoryId = `D${next++}`;
      lines.push(`${indent}<Directory Id="${directoryId}" Name="${xml(name)}">`);
      lines.push(render(child, `${indent}  `));
      lines.push(`${indent}</Directory>`);
    }
    for (const file of node.files) {
      const componentId = `C${next++}`;
      const fileId = `F${next++}`;
      components.push(componentId);
      lines.push(`${indent}<Component Id="${componentId}" Guid="*" Win64="yes">`);
      lines.push(`${indent}  <File Id="${fileId}" Source="${xml(file.path)}" KeyPath="yes" Checksum="yes" />`);
      lines.push(`${indent}</Component>`);
    }
    return lines.join('\n');
  };
  return { content: render(root, '          '), components };
};

export const windowsMachineInstallerSourceForTest = (appDirectory, version, arch, files) => {
  const tree = directoryXml(files);
  const platform = arch === 'arm64' ? 'arm64' : 'x64';
  const productCode = '*';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="${productCode}" Name="ProPR Desktop" Language="1033" Codepage="1252" Version="${xml(version)}"
      Manufacturer="Unchained Development OÜ" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="${platform}"
      SummaryCodepage="1252" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallInitialize"
      DowngradeErrorMessage="A newer ProPR Desktop is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="ProPR Desktop">
${tree.content}
          <Component Id="ApplicationRegistration" Guid="*" Win64="yes">
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Value="URL:ProPR Protocol" Type="string" KeyPath="yes" />
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Name="URL Protocol" Value="" Type="string" />
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr\\shell\\open\\command"
              Value="&quot;[INSTALLFOLDER]propr-desktop.exe&quot; &quot;%1&quot;" Type="string" />
            <RegistryValue Root="HKLM" Key="Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\propr-desktop.exe"
              Value="[INSTALLFOLDER]propr-desktop.exe" Type="string" />
          </Component>
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="ProPR Desktop">
          <Component Id="ApplicationStartMenuShortcutComponent" Guid="*">
            <Shortcut Id="ApplicationStartMenuShortcut" Directory="ApplicationProgramsFolder" Name="ProPR Desktop"
              Description="ProPR Desktop" Target="[INSTALLFOLDER]propr-desktop.exe" WorkingDirectory="INSTALLFOLDER">
              <ShortcutProperty Key="System.AppUserModel.ID" Value="dev.propr.desktop" />
            </Shortcut>
            <RemoveFolder Id="RemoveApplicationProgramsFolder" Directory="ApplicationProgramsFolder" On="uninstall" />
            <RegistryValue Root="HKCU" Key="Software\\ProPR\\Desktop" Name="installed"
              Value="1" Type="integer" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="MainApplication" Title="ProPR Desktop" Level="1">
${tree.components.map(id => `      <ComponentRef Id="${id}" />`).join('\n')}
      <ComponentRef Id="ApplicationRegistration" />
      <ComponentRef Id="ApplicationStartMenuShortcutComponent" />
    </Feature>
  </Product>
</Wix>
`;
};

export const wixProbeSourceForTest = arch => `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="ProPR WiX Probe" Language="1033" Codepage="1252" Version="1.0.0"
      Manufacturer="Unchained Development OÜ" UpgradeCode="1C7701EF-12DE-4C22-9894-D22E1954407D">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="${arch}"
      SummaryCodepage="1252" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Component Id="ProbeRegistryComponent" Guid="72D401FB-1E08-4A23-A45E-2551207206D5" Win64="yes">
        <RegistryValue Root="HKLM" Key="Software\\ProPR\\WixProbe" Value="probe" Type="string" KeyPath="yes" />
      </Component>
    </Directory>
    <Feature Id="ProbeFeature" Title="ProPR WiX Probe" Level="1">
      <ComponentRef Id="ProbeRegistryComponent" />
    </Feature>
  </Product>
</Wix>
`;

const compileWixSource = async ({
  source,
  object,
  output,
  arch,
  wix,
  cwd,
  lightTimeout = WIX_TIMEOUT_POLICY_MS.PROBE_LIGHT,
  redactions = [],
}) => {
  await runWix(
    'CANDLE',
    wix.candle,
    ['-nologo', '-arch', arch, '-out', object, source],
    cwd,
    WIX_TIMEOUT_POLICY_MS.CANDLE,
    redactions,
  );
  await runWix('LIGHT', wix.light, ['-nologo', '-out', output, object], cwd, lightTimeout, redactions);
};

const requireMsi = async path => {
  try {
    const bytes = await readFile(path);
    if (bytes.length < 4096 || bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') fail('invalid MSI output');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Windows machine installer build failed:')) throw error;
    fail('invalid MSI output');
  }
};

export const probeWindowsWixToolset = async ({ arch, wixDirectory }) => {
  if (process.platform !== 'win32') fail('WiX Toolset 3.14.1 probe requires a Windows builder');
  if (!['x64', 'arm64'].includes(arch)) fail('arguments');
  const temporary = await mkdtemp(join(tmpdir(), 'propr-wix-probe-'));
  let failed = false;
  try {
    const source = join(temporary, 'probe.wxs');
    const object = join(temporary, 'probe.wixobj');
    const output = join(temporary, 'probe.msi');
    const wix = await resolveWixToolset(temporary, arch, wixDirectory);
    await writeFile(source, wixProbeSourceForTest(arch), { encoding: 'utf8', flag: 'wx' });
    await compileWixSource({
      source,
      object,
      output,
      arch,
      wix,
      cwd: temporary,
      lightTimeout: WIX_TIMEOUT_POLICY_MS.PROBE_LIGHT,
    });
    await requireMsi(output);
    return { arch, version: '3.14.1' };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await removeTemporary(temporary, failed);
  }
};

export const buildWindowsMachineInstaller = async ({ appDirectory, output, version, arch, wixDirectory }) => {
  assertWindowsInstallerProductVersion(version);
  if (process.platform !== 'win32') return { skipped: true };
  if (!['x64', 'arm64'].includes(arch)) fail('arguments');
  const canonicalApp = resolve(appDirectory);
  const files = await collectTree(canonicalApp);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), '.machine-installer-'));
  let failed = false;
  try {
    const source = join(temporary, 'propr-desktop.wxs');
    const object = join(temporary, 'propr-desktop.wixobj');
    const wix = await resolveWixToolset(temporary, arch, wixDirectory);
    await writeFile(source, windowsMachineInstallerSourceForTest(canonicalApp, version, arch, files), { encoding: 'utf8', flag: 'wx' });
    await compileWixSource({
      source,
      object,
      output,
      arch,
      wix,
      cwd: temporary,
      lightTimeout: WIX_TIMEOUT_POLICY_MS.PRODUCTION_LIGHT,
      redactions: files.map(file => file.path),
    });
    await requireMsi(output);
    return { skipped: false, path: output, files: files.length };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await removeTemporary(temporary, failed);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'probe') {
    await probeWindowsWixToolset({ arch: process.argv[3], wixDirectory: process.argv[4] });
    process.exit(0);
  }
  const [, , appDirectory, output, version, arch, wixDirectory] = process.argv;
  await buildWindowsMachineInstaller({
    appDirectory,
    output,
    version,
    arch,
    wixDirectory,
  });
}
