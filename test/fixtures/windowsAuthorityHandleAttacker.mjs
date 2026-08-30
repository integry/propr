import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [resultPath, supervisorPid] = process.argv.slice(2);
if (!resultPath || !/^[1-9][0-9]{0,9}$/.test(supervisorPid ?? '')) process.exit(2);

let inheritedControlHandle = false;
try {
  // The supervisor receives its staged image at fd 3. An unrelated child must
  // receive only its explicitly configured stdio and therefore cannot acquire
  // either endpoint (or the image handle) through wildcard inheritance.
  fstatSync(3);
  inheritedControlHandle = true;
  closeSync(3);
} catch {
  inheritedControlHandle = false;
}

const advertisedCapability = Object.keys(process.env).some((key) => (
  key.startsWith('PROPR_CAPABILITY_')
  || key === 'PROPR_BOOTSTRAP_PATH'
  || key === 'PROPR_BOOTSTRAP_SHA256'
));

const rightsProbe = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  public static bool CanOpen(uint access,uint pid) { IntPtr value=OpenProcess(access,false,pid); if(value==IntPtr.Zero)return false; CloseHandle(value); return true; }
}
'@
$pidValue=[uint32]$env:PROPR_TEST_SUPERVISOR_PID
[Console]::Out.Write((@{
  duplicate=[Probe]::CanOpen(0x40,$pidValue)
  vmRead=[Probe]::CanOpen(0x10,$pidValue)
  query=[Probe]::CanOpen(0x400,$pidValue)
}|ConvertTo-Json -Compress))
`,
], {
  shell: false,
  windowsHide: true,
  encoding: 'utf8',
  timeout: 5_000,
  env: { SystemRoot: process.env.SystemRoot, PROPR_TEST_SUPERVISOR_PID: supervisorPid },
});
const deniedRights = rightsProbe.status === 0
  ? JSON.parse(rightsProbe.stdout)
  : { duplicate: true, vmRead: true, query: true };

writeFileSync(resultPath, JSON.stringify({ inheritedControlHandle, advertisedCapability, deniedRights }), 'utf8');
