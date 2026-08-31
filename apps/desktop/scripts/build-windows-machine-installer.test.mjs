import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsMachineInstallerSourceForTest } from './build-windows-machine-installer.mjs';

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
