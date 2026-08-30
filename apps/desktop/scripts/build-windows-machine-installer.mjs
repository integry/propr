import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = resolve(desktopRoot, '..', '..');
// This dependency is only the pinned carrier for WiX v3 candle/light. Forge
// never invokes its per-user Squirrel packaging implementation.
const wixVendor = join(repositoryRoot, 'node_modules', 'electron-winstaller', 'vendor');
const MAX_FILES = 4096;
const MAX_PATH_BYTES = 32 * 1024;
const UPGRADE_CODE = '79D29087-5B38-4D77-93C8-5BC0F7856D59';

const fail = message => { throw new Error(`Windows machine installer build failed: ${message}`); };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

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
  <Product Id="${productCode}" Name="ProPR Desktop" Language="1033" Version="${xml(version)}"
      Manufacturer="Unchained Development OÜ" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="${platform}" />
    <Property Id="ALLUSERS" Value="1" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallInitialize"
      DowngradeErrorMessage="A newer ProPR Desktop is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="ProPR Desktop">
${tree.content}
          <Component Id="ApplicationRegistration" Guid="*" Win64="yes">
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Name="" Value="URL:ProPR Protocol" Type="string" KeyPath="yes" />
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Name="URL Protocol" Value="" Type="string" />
            <RegistryValue Root="HKLM" Key="Software\\Classes\\propr\\shell\\open\\command" Name=""
              Value="&quot;[INSTALLFOLDER]propr-desktop.exe&quot; &quot;%1&quot;" Type="string" />
            <RegistryValue Root="HKLM" Key="Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\propr-desktop.exe"
              Name="" Value="[INSTALLFOLDER]propr-desktop.exe" Type="string" />
            <Shortcut Id="ApplicationStartMenuShortcut" Directory="ApplicationProgramsFolder" Name="ProPR Desktop"
              Description="ProPR Desktop" Target="[INSTALLFOLDER]propr-desktop.exe" WorkingDirectory="INSTALLFOLDER">
              <ShortcutProperty Key="System.AppUserModel.ID" Value="dev.propr.desktop" />
            </Shortcut>
            <RemoveFolder Id="RemoveApplicationProgramsFolder" Directory="ApplicationProgramsFolder" On="uninstall" />
          </Component>
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="ProPR Desktop" />
      </Directory>
    </Directory>
    <Feature Id="MainApplication" Title="ProPR Desktop" Level="1">
${tree.components.map(id => `      <ComponentRef Id="${id}" />`).join('\n')}
      <ComponentRef Id="ApplicationRegistration" />
    </Feature>
  </Product>
</Wix>
`;
};

export const buildWindowsMachineInstaller = async ({ appDirectory, output, version, arch }) => {
  if (process.platform !== 'win32') return { skipped: true };
  if (!['x64', 'arm64'].includes(arch) || !/^\d+\.\d+\.\d+$/.test(version)) fail('arguments');
  const canonicalApp = resolve(appDirectory);
  const files = await collectTree(canonicalApp);
  const temporary = await mkdtemp(join(dirname(output), '.machine-installer-'));
  try {
    const source = join(temporary, 'propr-desktop.wxs');
    const object = join(temporary, 'propr-desktop.wixobj');
    await writeFile(source, windowsMachineInstallerSourceForTest(canonicalApp, version, arch, files), { encoding: 'utf8', flag: 'wx' });
    await execFileAsync(join(wixVendor, 'candle.exe'), ['-nologo', '-arch', arch, '-out', object, source], {
      cwd: temporary, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
    });
    await mkdir(dirname(output), { recursive: true });
    await execFileAsync(join(wixVendor, 'light.exe'), ['-nologo', '-out', output, object], {
      cwd: temporary, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
    });
    const bytes = await readFile(output);
    if (bytes.length < 4096 || bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') fail('invalid MSI output');
    return { skipped: false, path: output, files: files.length };
  } finally { await rm(temporary, { recursive: true, force: true }); }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , appDirectory, output, version, arch] = process.argv;
  await buildWindowsMachineInstaller({
    appDirectory,
    output,
    version,
    arch,
  });
}
