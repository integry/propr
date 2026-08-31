import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  windowsMachineInstallerSourceForTest,
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

test('uses the machine-wide Start Menu folder for x64 and ARM64 production WXS', () => {
  const files = [{
    path: 'C:\\fixture\\propr-desktop.exe',
    name: 'propr-desktop.exe',
    size: 1n,
  }];

  for (const arch of ['x64', 'arm64']) {
    const source = windowsMachineInstallerSourceForTest('C:\\fixture', '1.2.3', arch, files);
    assert.match(source, /<Directory Id="CommonProgramMenuFolder">/);
    assert.doesNotMatch(source, /<Directory Id="ProgramMenuFolder">/);
  }
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
