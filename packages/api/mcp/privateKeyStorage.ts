import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import { win32 } from 'node:path';

/**
 * How the persisted MCP encryption key is kept private on this platform.
 *
 * POSIX: an owner-only (0700) directory holding an owner-only (0600) file.
 * Windows: mode bits are synthesized from the read-only attribute and say
 * nothing about access, so privacy is the DACL: the key directory is cut off
 * from inheritance and grants only the current account, which new files in it
 * inherit. A key file is private when its owner and every effective Allow
 * entry is the current account, SYSTEM or Administrators (the Windows
 * equivalent of root still being able to read a 0600 file).
 */
export interface PrivateKeyStorage {
  isPrivateDirectory(directory: string, stat: Stats): boolean;
  isPrivateFile(filename: string, stat: Stats): boolean;
  /** Restrict a directory this process just created to the current account. */
  restrictDirectory(directory: string): void;
  /** Whether a directory handle can be flushed to make a new link durable. */
  readonly syncsDirectories: boolean;
}

const posixStorage: PrivateKeyStorage = {
  isPrivateDirectory: (_directory, stat) => (stat.mode & 0o777) === 0o700,
  isPrivateFile: (_filename, stat) => (stat.mode & 0o777) === 0o600,
  restrictDirectory: () => { /* mkdir already applied 0700. */ },
  syncsDirectories: true,
};

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

/** Owner and effective Allow entries of a Windows path, as SIDs. */
export interface WindowsAccess { user: string; owner: string; allow: string[] }

const INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [Security.Principal.SecurityIdentifier]',
  '$acl = Get-Acl -LiteralPath $env:PROPR_PRIVATE_KEY_PATH',
  '$allow = @($acl.GetAccessRules($true, $true, $sid) | Where-Object {',
  "  $_.AccessControlType -eq 'Allow' -and -not ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)",
  '} | ForEach-Object { $_.IdentityReference.Value })',
  '[pscustomobject]@{ user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; owner = $acl.GetOwner($sid).Value; allow = $allow } | ConvertTo-Json -Compress',
].join('\n');

function systemTool(...segments: string[]): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return win32.join(root, 'System32', ...segments);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 });
  if (result.error) throw result.error;
  // Never include the output: it is not needed to diagnose a setup error.
  if (result.status !== 0) throw new Error(`${win32.basename(command)} exited with status ${String(result.status)}`);
  return result.stdout;
}

function inspectWindowsAccess(path: string): WindowsAccess {
  const output = run(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INSPECT_SCRIPT],
    { ...process.env, PROPR_PRIVATE_KEY_PATH: path });
  const parsed = JSON.parse(output) as { user?: unknown; owner?: unknown; allow?: unknown };
  // ConvertTo-Json collapses a one-element array to a scalar.
  const allow = Array.isArray(parsed.allow) ? parsed.allow : parsed.allow === undefined || parsed.allow === null ? [] : [parsed.allow];
  if (typeof parsed.user !== 'string' || typeof parsed.owner !== 'string' || !allow.every(sid => typeof sid === 'string')) {
    throw new Error('Unexpected Windows access inspection result');
  }
  return { user: parsed.user, owner: parsed.owner, allow: allow as string[] };
}

export function isPrivateWindowsAccess(access: WindowsAccess): boolean {
  const trusted = new Set([access.user, SYSTEM_SID, ADMINISTRATORS_SID]);
  return trusted.has(access.owner) && access.allow.every(sid => trusted.has(sid));
}

export function windowsStorage(
  inspect: (path: string) => WindowsAccess = inspectWindowsAccess,
  restrict: (directory: string, userSid: string) => void = (directory, userSid) => {
    run(systemTool('icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, '/q']);
  },
): PrivateKeyStorage {
  return {
    isPrivateDirectory: directory => isPrivateWindowsAccess(inspect(directory)),
    isPrivateFile: filename => isPrivateWindowsAccess(inspect(filename)),
    restrictDirectory: directory => restrict(directory, inspect(directory).user),
    // FlushFileBuffers rejects directory handles; NTFS journals the link itself.
    syncsDirectories: false,
  };
}

let storage: PrivateKeyStorage = process.platform === 'win32' ? windowsStorage() : posixStorage;

export function privateKeyStorage(): PrivateKeyStorage { return storage; }

/** Tests only: substitute the platform storage. Returns a restore function. */
export function setPrivateKeyStorageForTests(next: PrivateKeyStorage): () => void {
  const previous = storage;
  storage = next;
  return () => { storage = previous; };
}
