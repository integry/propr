import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  windowsMachineInstallerSourceForTest,
  windowsWixDirectoryForTest,
  wixProbeSourceForTest,
} from './build-windows-machine-installer.mjs';

const installerScript = readFileSync(new URL('./build-windows-machine-installer.mjs', import.meta.url), 'utf8');

const assertExplicitCodepages = source => {
  assert.match(source, /<Product\b[^>]*\bCodepage="1252"[^>]*>/);
  assert.match(source, /<Package\b[^>]*\bSummaryCodepage="1252"[^>]*\/>/);
  assert.match(source, /Manufacturer="Unchained Development OÜ"/);
  assert.equal(source.match(/\bCodepage="1252"/g)?.length, 1);
  assert.equal(source.match(/\bSummaryCodepage="1252"/g)?.length, 1);
};

test('sets explicit Windows-1252 MSI and summary code pages in probe and production WXS', () => {
  const files = [{
    path: 'C:\\fixture\\propr-desktop.exe',
    name: 'propr-desktop.exe',
    size: 1n,
  }];

  assertExplicitCodepages(wixProbeSourceForTest('x64'));
  assertExplicitCodepages(wixProbeSourceForTest('arm64'));
  assertExplicitCodepages(windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', 'x64', files));
  assertExplicitCodepages(windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', 'arm64', files));
});

test('uses per-machine scope without explicitly authoring the derived ALLUSERS property', () => {
  const files = [{
    path: 'C:\\fixture\\propr-desktop.exe',
    name: 'propr-desktop.exe',
    size: 1n,
  }];

  for (const arch of ['x64', 'arm64']) {
    const source = windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', arch, files);
    assert.match(source, /<Package\b[^>]*\bInstallScope="perMachine"[^>]*\/>/);
    assert.doesNotMatch(source, /<Property\b[^>]*\bId="ALLUSERS"(?:\s|\/|>)/);
  }
});

test('authors machine registration and the common Start Menu component for x64 and ARM64', () => {
  const files = [{
    path: 'C:\\fixture\\propr-desktop.exe',
    name: 'propr-desktop.exe',
    size: 1n,
  }];

  for (const arch of ['x64', 'arm64']) {
    const source = windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', arch, files);
    const registration = source.match(/<Component Id="ApplicationRegistration"[\s\S]*?<\/Component>/)?.[0];
    const shortcut = source.match(/<Component Id="ApplicationStartMenuShortcutComponent"[\s\S]*?<\/Component>/)?.[0];
    assert.ok(registration);
    assert.ok(shortcut);
    assert.equal(registration.match(/Root="HKLM"/g)?.length, 4);
    assert.equal(registration.match(/KeyPath="yes"/g)?.length, 1);
    assert.doesNotMatch(registration, /Root="HKCU"|<Shortcut|<RemoveFolder/);
    assert.match(shortcut, /<Component Id="ApplicationStartMenuShortcutComponent" Guid="\*" Win64="yes">/);
    assert.match(shortcut, /<Shortcut Id="ApplicationStartMenuShortcut"[\s\S]*?<\/Shortcut>/);
    assert.match(shortcut, /<RemoveFolder Id="RemoveApplicationProgramsFolder"[^>]*On="uninstall" \/>/);
    assert.match(
      shortcut,
      /<RegistryValue Root="HKLM" Key="Software\\ProPR\\Desktop" Name="installed"\s+Value="1" Type="integer" KeyPath="yes" \/>/,
    );
    assert.equal(shortcut.match(/KeyPath="yes"/g)?.length, 1);
    assert.equal(shortcut.match(/Root="HKLM"/g)?.length, 1);
    assert.match(source, /<Directory Id="CommonProgramMenuFolder">\s*<Directory Id="ApplicationProgramsFolder" Name="ProPR Desktop">/);
    assert.match(
      source,
      /<Directory Id="INSTALLFOLDER" Name="ProPR Desktop">[\s\S]*<Component Id="ApplicationRegistration"[\s\S]*?<\/Component>\s*<\/Directory>\s*<\/Directory>\s*<Directory Id="CommonProgramMenuFolder">/,
    );
    assert.doesNotMatch(source, /<Directory Id="ProgramMenuFolder">/);
    assert.doesNotMatch(source, /<RegistryValue\b[^>]*\bRoot="HKCU"/);
    assert.match(source, /<ComponentRef Id="ApplicationRegistration" \/>/);
    assert.match(source, /<ComponentRef Id="ApplicationStartMenuShortcutComponent" \/>/);
  }
});

test('selects only the installed x64 WiX directory or an explicit ARM64 build directory', () => {
  const installed = String.raw`C:\Program Files (x86)\WiX Toolset v3.14\bin`;
  const provisioned = String.raw`D:\runner-temp\propr-wix3141-arm64`;
  assert.equal(windowsWixDirectoryForTest('x64'), installed);
  assert.equal(windowsWixDirectoryForTest('x64', installed), installed);
  assert.equal(windowsWixDirectoryForTest('arm64', provisioned), provisioned);
  assert.throws(() => windowsWixDirectoryForTest('x64', provisioned), /official WiX Toolset 3\.14\.1 build directory/);
  assert.throws(() => windowsWixDirectoryForTest('arm64'), /official WiX Toolset 3\.14\.1 build directory/);
  assert.throws(() => windowsWixDirectoryForTest('arm64', 'relative'), /official WiX Toolset 3\.14\.1 build directory/);
  assert.match(installerScript, /const INSTALLED_WIX_DIRECTORY = String\.raw`C:\\Program Files \(x86\)\\WiX Toolset v3\.14\\bin`;/);
  assert.match(installerScript, /if \(arch === 'x64'\)/);
  assert.match(installerScript, /wixDirectory && windowsPathIdentity\(wixDirectory\) !== windowsPathIdentity\(INSTALLED_WIX_DIRECTORY\)/);
  assert.match(installerScript, /arch !== 'arm64'.*!win32\.isAbsolute\(wixDirectory\)/s);
  assert.match(installerScript, /canonicalWixTool\(join\(directory, 'candle\.exe'\)\)/);
  assert.match(installerScript, /canonicalWixTool\(join\(directory, 'light\.exe'\)\)/);
  assert.doesNotMatch(installerScript, /process\.env\.PATH|choco|electron-winstaller|wixVendor/);
});

test('uses a ten-minute timeout only for production Light', () => {
  assert.match(installerScript, /TOOL_VERSION: 120_000,/);
  assert.match(installerScript, /CANDLE: 120_000,/);
  assert.match(installerScript, /PROBE_LIGHT: 120_000,/);
  assert.match(installerScript, /PRODUCTION_LIGHT: 10 \* 60_000,/);
  assert.match(installerScript, /runWix\('CANDLE', candle, \['-\?'\], cwd, WIX_TIMEOUT_POLICY_MS\.TOOL_VERSION\)/);
  assert.match(installerScript, /runWix\('LIGHT', light, \['-\?'\], cwd, WIX_TIMEOUT_POLICY_MS\.TOOL_VERSION\)/);
  assert.match(installerScript, /WIX_TIMEOUT_POLICY_MS\.CANDLE,\s+redactions,/);
  assert.match(installerScript, /lightTimeout: WIX_TIMEOUT_POLICY_MS\.PROBE_LIGHT,/);
  assert.match(installerScript, /lightTimeout: WIX_TIMEOUT_POLICY_MS\.PRODUCTION_LIGHT,/);
});

test('keeps WiX processes and their emitted diagnostics bounded', () => {
  assert.match(installerScript, /shell: false,/);
  assert.match(installerScript, /timeout,/);
  assert.match(installerScript, /const WIX_MAX_BUFFER_BYTES = 64 \* 1024;/);
  assert.match(installerScript, /const WIX_DIAGNOSTIC_BYTES = 4 \* 1024;/);
  assert.match(installerScript, /maxBuffer: WIX_MAX_BUFFER_BYTES/);
  assert.match(installerScript, /\.slice\(0, WIX_DIAGNOSTIC_BYTES\)/);
  assert.ok(installerScript.includes('${stage} exit=${exit} signal=${signal}: ${diagnostic}'));
});

test('emits WiX v3 default registry values without empty Name attributes', () => {
  const source = windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', 'x64', [{
    path: 'C:\\fixture\\propr-desktop.exe',
    name: 'propr-desktop.exe',
    size: 1n,
  }]);

  assert.match(
    source,
    /<RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Value="URL:ProPR Protocol" Type="string" KeyPath="yes" \/>/,
  );
  assert.match(
    source,
    /<RegistryValue Root="HKLM" Key="Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\propr-desktop\.exe"\s+Value="\[INSTALLFOLDER\]propr-desktop\.exe" Type="string" \/>/,
  );
  assert.match(
    source,
    /<RegistryValue Root="HKLM" Key="Software\\Classes\\propr\\shell\\open\\command"\s+Value="&quot;\[INSTALLFOLDER\]propr-desktop\.exe&quot; &quot;%1&quot;" Type="string" \/>/,
  );
  assert.match(
    source,
    /<RegistryValue Root="HKLM" Key="Software\\Classes\\propr" Name="URL Protocol" Value="" Type="string" \/>/,
  );
  assert.doesNotMatch(source, /\bName=""/);
});
