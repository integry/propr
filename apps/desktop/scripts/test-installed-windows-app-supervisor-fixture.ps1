param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$WatchdogMarker,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [Parameter(Mandatory=$true)][string]$OwnershipManifest
)

$ErrorActionPreference = 'Stop'

function Initialize-FixtureDirectoryIdentity {
  if ('ProPRFixtureDirectoryIdentity' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProPRFixtureDirectoryIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string path, uint access, uint share, IntPtr security, uint creation,
        uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
    public static string ReadEntry(string path, bool expectDirectory)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 0x7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            bool isDirectory = (information.FileAttributes & 0x10) != 0;
            if ((information.FileAttributes & 0x400) != 0 ||
                isDirectory != expectDirectory)
                throw new InvalidOperationException("fixture entry identity changed");
            return string.Format("{0:x8}{1:x8}{2:x8}", information.VolumeSerialNumber,
                information.FileIndexHigh, information.FileIndexLow);
        }
    }
    public static string Read(string path) { return ReadEntry(path, true); }
}
'@
}
$scenario = $env:PROPR_SUPERVISOR_FIXTURE_SCENARIO
$stateDirectory = $env:PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY
if ($scenario -notin @(
    'NO_MARKER',
    'NO_MARKER_WINDOWS_POWERSHELL',
    'VALID_THEN_DEADLINE',
    'MALFORMED_MARKER',
    'TORN_MARKER',
    'STALE_MARKER',
    'INACCESSIBLE_MARKER',
    'NEGATIVE_EXIT',
    'CANCELLATION',
    'DURING_MSI',
    'DURING_OWNERSHIP_CAPTURE',
    'OWNED_RESOURCES_NORMAL_SUCCESS',
    'OWNED_RESOURCES_FOR_INTERRUPTION',
    'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE',
    'SMOKE_AFTER_PROMOTION_THEN_DEADLINE',
    'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE',
    'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE',
    'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE',
    'PRIMARY_FALLBACK_FOREIGN_DESCENDANTS',
    'OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE',
    'OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE',
    'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE',
    'OWNED_SHORTCUT_REPLACED_THEN_DEADLINE',
    'OWNED_PROFILE_PATH_MISMATCH_THEN_DEADLINE',
    'OWNED_RESOURCES_REPLACED_THEN_DEADLINE',
    'OWNED_RESOURCES_THEN_DEADLINE'
  )) {
  throw 'fixture scenario is invalid'
}
if (!$stateDirectory -or !(Test-Path -LiteralPath $stateDirectory -PathType Container)) {
  throw 'fixture state directory is invalid'
}

function Write-FixtureMarker([string]$Record) {
  $temporaryMarker = "$WatchdogMarker.$PID.new"
  $bytes = [Text.Encoding]::ASCII.GetBytes($Record)
  $stream = [IO.FileStream]::new(
    $temporaryMarker,
    [IO.FileMode]::Create,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  [IO.File]::Move($temporaryMarker, $WatchdogMarker, $true)
}

function Write-FixtureOwnershipManifest($Manifest) {
  $temporaryManifest = "$OwnershipManifest.new"
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Manifest | ConvertTo-Json -Depth 6 -Compress))
  $stream = [IO.FileStream]::new(
    $temporaryManifest,
    [IO.FileMode]::Create,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  [IO.File]::Move($temporaryManifest, $OwnershipManifest, $true)
}

function Write-FixtureCriticalGate([string]$Name) {
  [IO.File]::WriteAllText(
    (Join-Path $stateDirectory 'critical-gate.txt'),
    $Name,
    [Text.Encoding]::ASCII
  )
}

function Write-FixtureOwnershipToken([string]$Path, [string]$Token) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($Token)
  $stream = [IO.FileStream]::new(
    $Path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::Read,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Get-FixtureFileIdentity([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-FixtureEntryIdentity([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'fixture file-system object identity is invalid'
  }
  return [ProPRFixtureDirectoryIdentity]::ReadEntry($item.FullName, $Directory)
}

function Get-FixtureTreeIdentity([string]$Path) {
  $root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (!$root.PSIsContainer -or
      ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'fixture tree root identity is invalid'
  }
  $rootPath = $root.FullName.TrimEnd('\')
  $records = [Collections.Generic.List[string]]::new()
  $records.Add(('D||{0}' -f (Get-FixtureEntryIdentity $rootPath $true)))
  foreach ($entry in @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force -ErrorAction Stop)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'fixture tree contains a reparse point'
    }
    $relativePath = $entry.FullName.Substring($rootPath.Length).TrimStart('\')
    $kind = if ($entry.PSIsContainer) { 'D' } else { 'F' }
    $relative = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relativePath))
    $identity = Get-FixtureEntryIdentity $entry.FullName ([bool]$entry.PSIsContainer)
    $records.Add(('{0}|{1}|{2}' -f $kind, $relative, $identity))
  }
  $recordArray = $records.ToArray()
  [Array]::Sort($recordArray, [StringComparer]::Ordinal)
  $payload = [Text.Encoding]::UTF8.GetBytes(($recordArray -join "`n"))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($payload)).Replace('-', '').ToLowerInvariant()
  } finally { $sha256.Dispose() }
}

function Set-FixtureSmokeAcl([string]$Path, [string]$UserSid) {
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($administratorsSid)
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @(
      [Security.Principal.SecurityIdentifier]::new($UserSid),
      $systemSid,
      $administratorsSid
    )) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function New-FixtureSmokeArtifacts([string]$Path) {
  $electronData = Join-Path $Path 'profile\AppData\Local\ProPR'
  [void](New-Item -ItemType Directory -Path $electronData -Force -ErrorAction Stop)
  [IO.File]::WriteAllText(
    (Join-Path $Path 'application.stdout.log'), 'owned-log', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText(
    (Join-Path $Path 'application.smoke-evidence.jsonl'),
    '{"event":"desktop.smoke.authorized"}', [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText(
    (Join-Path $electronData 'electron-data.json'), 'owned-electron-data', [Text.Encoding]::ASCII)
}

function New-OwnedFixtureResources(
  [ValidateSet('BEFORE_PROMOTION','AFTER_PROMOTION','AFTER_ARTIFACTS')]
    [string]$SmokeCheckpoint = 'AFTER_ARTIFACTS',
  [bool]$PublishCommittedReceipt = $true
) {
  Initialize-FixtureDirectoryIdentity
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  if (!$manifest.Fixture -or $manifest.SchemaVersion -ne 3 -or
      [string]$manifest.InstallerEntryIdentity -notmatch '^[a-f0-9]{24}$' -or
      [string]$manifest.InstallerSha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]$manifest.InstallerProductCode -notmatch
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$' -or
      $manifest.ManifestType -cne 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -or
      $manifest.State -cne 'ACTIVE') {
    throw 'fixture ownership manifest was not initialized'
  }
  $token = [Guid]::NewGuid().ToString('N')
  $ownedRoot = Join-Path $stateDirectory 'owned'
  $installRoot = Join-Path $ownedRoot 'install-tree'
  $executable = Join-Path $installRoot 'propr-desktop.exe'
  $shortcutFolder = Join-Path $ownedRoot 'shortcut-folder'
  $shortcut = Join-Path $shortcutFolder 'ProPR Desktop.lnk'
  $smokeDirectory = Join-Path $ownedRoot 'smoke-data'
  [void](New-Item -ItemType Directory -Path $ownedRoot -Force -ErrorAction Stop)
  Write-FixtureOwnershipToken (Join-Path $ownedRoot '.propr-installed-app-owner') $token
  foreach ($directory in @($installRoot, $shortcutFolder)) {
    [void](New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop)
    Write-FixtureOwnershipToken (Join-Path $directory '.propr-installed-app-owner') $token
  }
  [IO.File]::WriteAllText($executable, 'owned-executable', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($shortcut, 'owned-shortcut', [Text.Encoding]::ASCII)

  $registryPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$($manifest.RunId)\owned"
  [void](New-Item -Path $registryPath -Force -ErrorAction Stop)
  Set-ItemProperty -LiteralPath $registryPath -Name 'ProPRInstalledAppOwner' -Value $token
  Set-ItemProperty -LiteralPath $registryPath -Name 'Payload' -Value 'owned'

  $userName = $env:PROPR_SUPERVISOR_FIXTURE_OWNED_USER
  $passwordText = $env:PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD
  if ($userName -notmatch '^prpr[a-f0-9]{8}$' -or !$passwordText) {
    throw 'fixture owned-user identity is invalid'
  }
  $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
  if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) {
    throw 'fixture owned-user baseline was not clean'
  }
  $userOwnershipMarker =
    "prpr-own-$([Guid]::NewGuid().ToString('N'))"
  $provisionalUserRecord = [ordered]@{
    Name = $userName
    Sid = $null
    Owned = $true
    Provisional = $true
    OwnershipMarker = $userOwnershipMarker
  }
  $manifest.Users = @($provisionalUserRecord)
  Write-FixtureOwnershipManifest $manifest
  New-LocalUser -Name $userName -Password $password `
    -Description $userOwnershipMarker `
    -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $userSid = (Get-LocalUser -Name $userName -ErrorAction Stop).SID.Value
  $provisionalUserRecord.Sid = $userSid
  $provisionalUserRecord.Provisional = $false

  $smokeRecord = [ordered]@{
    Kind = 'SMOKE_DATA'
    Path = $smokeDirectory
    Owned = $true
    Token = $token
    Identity = $null
    Provisional = $true
    UserSid = $userSid
    CreatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    RootOwnerSid = 'S-1-5-32-544'
  }
  $manifest.Directories = @($smokeRecord)
  $manifest.Users = @($provisionalUserRecord)
  Write-FixtureOwnershipManifest $manifest
  [void](New-Item -ItemType Directory -Path $smokeDirectory -ErrorAction Stop)
  Set-FixtureSmokeAcl $smokeDirectory $userSid
  Write-FixtureOwnershipToken (Join-Path $smokeDirectory '.propr-installed-app-owner') $token
  if ($SmokeCheckpoint -ne 'BEFORE_PROMOTION') {
    $smokeRecord.Identity = [ProPRFixtureDirectoryIdentity]::Read($smokeDirectory)
    $smokeRecord.Provisional = $false
    Write-FixtureOwnershipManifest $manifest
    if ($SmokeCheckpoint -eq 'AFTER_ARTIFACTS') {
      New-FixtureSmokeArtifacts $smokeDirectory
    }
  }

  $ownedDirectories = @(
    [ordered]@{ Kind = 'FIXTURE_ROOT'; Path = $ownedRoot; Owned = $true; Token = $token },
    [ordered]@{
      Kind = 'INSTALL_ROOT'; Path = $installRoot; Owned = $true; Token = $token
      Identity = (Get-FixtureEntryIdentity $installRoot $true)
      TreeIdentity = (Get-FixtureTreeIdentity $installRoot); Provisional = $false
    },
    [ordered]@{
      Kind = 'SHORTCUT_FOLDER'; Path = $shortcutFolder; Owned = $true; Token = $token
      Identity = (Get-FixtureEntryIdentity $shortcutFolder $true)
      TreeIdentity = (Get-FixtureTreeIdentity $shortcutFolder); Provisional = $false
    },
    $smokeRecord
  )
  $conflictingDirectories = @(
    $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES -split '\|' | Where-Object { $_ }
  ) | ForEach-Object {
    [ordered]@{ Kind = 'CONFLICT'; Path = $_; Owned = $false; Token = $null }
  }
  $manifest.Directories = @($ownedDirectories) + @($conflictingDirectories)
  $manifest.Files = @(
    [ordered]@{
      Kind = 'FIXTURE_FILE'; Path = $executable
      Owned = $true; Token = $null
      Identity = (Get-FixtureFileIdentity $executable)
      EntryIdentity = (Get-FixtureEntryIdentity $executable $false)
      Provisional = $false
    },
    [ordered]@{
      Kind = 'SHORTCUT_FILE'; Path = $shortcut; Owned = $true; Token = $token
      Identity = (Get-FixtureFileIdentity $shortcut)
      EntryIdentity = (Get-FixtureEntryIdentity $shortcut $false)
      Provisional = $false
    }
  )
  if ($env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT) {
    $manifest.Files += [ordered]@{
      Kind = 'CONFLICT'; Path = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT
      Owned = $false; Token = $null
    }
  }
  $manifest.RegistryKeys = @(
    [ordered]@{ Kind = 'PROTOCOL'; Path = $registryPath; Owned = $true; Token = $token }
  )
  $manifest.RegistryValues = @()
  if ($env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY) {
    $manifest.RegistryKeys += [ordered]@{
      Kind = 'CONFLICT'; Path = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY
      Owned = $false; Token = $null
    }
  }
  $manifest.Users = @($provisionalUserRecord)
  if ($env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER) {
    $manifest.Users += [ordered]@{
      Name = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER
      Sid = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID
      Owned = $false
    }
  }
  $manifest.Profiles = @()
  $manifest.InstallAttempted = $true
  if ($PublishCommittedReceipt) { $manifest.MsiTransactionState = 'COMMITTED' }
  if ($env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID) {
    $manifest.Profiles += [ordered]@{
      Sid = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID
      LocalPath = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_PATH
      Owned = $false
    }
  }
  Write-FixtureOwnershipManifest $manifest

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Process -Id $PID -ErrorAction Stop).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.UserName = $userName
  $startInfo.Domain = $env:COMPUTERNAME
  $startInfo.Password = $password
  $startInfo.LoadUserProfile = $true
  $startInfo.WorkingDirectory = $env:SystemRoot
  foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-Command','exit 0')) {
    $startInfo.ArgumentList.Add($argument)
  }
  $profileProcess = [Diagnostics.Process]::new()
  $profileProcess.StartInfo = $startInfo
  $profileProcessStarted = $false
  try {
    $profileProcessStarted = $profileProcess.Start()
    if (!$profileProcessStarted -or !$profileProcess.WaitForExit(30000) -or
        $profileProcess.ExitCode -ne 0) {
      throw 'fixture owned profile creation failed'
    }
  } finally {
    if ($profileProcessStarted -and !$profileProcess.HasExited) {
      try { $profileProcess.Kill($true) } catch {}
    }
    $profileProcess.Dispose()
  }
  $profiles = @()
  $profileLookupStopwatch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
      $_.SID -ceq $userSid
    })
    if ($profiles.Count -eq 1) { break }
    Start-Sleep -Milliseconds 250
  } while ($profileLookupStopwatch.ElapsedMilliseconds -lt 10000)
  if ($profiles.Count -ne 1) { throw 'fixture owned profile was not created' }
  $canonicalProfilePath = (Resolve-Path -LiteralPath ([string]$profiles[0].LocalPath) `
    -ErrorAction Stop).ProviderPath.TrimEnd('\')
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  $manifest.Profiles = @($manifest.Profiles) + @([ordered]@{
    Sid = $userSid
    LocalPath = $canonicalProfilePath
    Owned = $true
  })
  Write-FixtureOwnershipManifest $manifest
  $resourceState = [ordered]@{
    OwnedRoot = $ownedRoot
    InstallRoot = $installRoot
    Executable = $executable
    ShortcutFolder = $shortcutFolder
    Shortcut = $shortcut
    SmokeDirectory = $smokeDirectory
    RegistryPath = $registryPath
    RegistryRoot = Split-Path -Parent $registryPath
    UserName = $userName
    UserSid = $userSid
    ProfilePath = $canonicalProfilePath
    ManifestPath = $OwnershipManifest
    RunId = [string]$manifest.RunId
    Token = $token
  }
  $resourceState | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function New-ByteIdenticalOwnedFileFixture {
  Initialize-FixtureDirectoryIdentity
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  $root = Join-Path $stateDirectory 'byte-identical-file-root'
  $executable = Join-Path $root 'owned-file.exe'
  [void](New-Item -ItemType Directory -Path $root -ErrorAction Stop)
  [IO.File]::WriteAllText($executable, 'owned-executable', [Text.Encoding]::ASCII)
  $manifest.BaselineClean = $false
  $manifest.InstallAttempted = $false
  $manifest.MsiTransactionState = 'NONE'
  $manifest.Directories = @()
  $manifest.Files = @([ordered]@{
    Kind = 'FIXTURE_FILE'; Path = $executable; Owned = $true; Token = $null
    Identity = (Get-FixtureFileIdentity $executable)
    EntryIdentity = (Get-FixtureEntryIdentity $executable $false)
    Provisional = $false
  })
  $manifest.RegistryKeys = @()
  $manifest.RegistryValues = @()
  $manifest.Users = @()
  $manifest.Profiles = @()
  Write-FixtureOwnershipManifest $manifest
  [ordered]@{
    Executable = $executable
    ManifestPath = $OwnershipManifest
    RunId = [string]$manifest.RunId
    ByteIdenticalReplacement = $true
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function New-SmokeCheckpointFixtureResources(
  [ValidateSet('BEFORE_PROMOTION','AFTER_PROMOTION','AFTER_ARTIFACTS')]
    [string]$Checkpoint
) {
  Initialize-FixtureDirectoryIdentity
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  if (!$manifest.Fixture -or $manifest.SchemaVersion -ne 3 -or
      [string]$manifest.InstallerEntryIdentity -notmatch '^[a-f0-9]{24}$' -or
      [string]$manifest.InstallerSha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]$manifest.InstallerProductCode -notmatch
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$' -or
      $manifest.State -cne 'ACTIVE') {
    throw 'smoke checkpoint manifest was not initialized'
  }
  $token = [Guid]::NewGuid().ToString('N')
  $userName = $env:PROPR_SUPERVISOR_FIXTURE_OWNED_USER
  $passwordText = $env:PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD
  if ($userName -notmatch '^prpr[a-f0-9]{8}$' -or !$passwordText -or
      (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) {
    throw 'smoke checkpoint user baseline is invalid'
  }
  $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
  $userMarker = "prpr-own-$([Guid]::NewGuid().ToString('N'))"
  $userRecord = [ordered]@{
    Name = $userName
    Sid = $null
    Owned = $true
    Provisional = $true
    OwnershipMarker = $userMarker
  }
  $manifest.Users = @($userRecord)
  Write-FixtureOwnershipManifest $manifest
  New-LocalUser -Name $userName -Password $password -Description $userMarker `
    -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $userSid = (Get-LocalUser -Name $userName -ErrorAction Stop).SID.Value
  $userRecord.Sid = $userSid
  $userRecord.Provisional = $false

  $smokeDirectory = Join-Path $stateDirectory 'smoke-data'
  $smokeRecord = [ordered]@{
    Kind = 'SMOKE_DATA'
    Path = $smokeDirectory
    Owned = $true
    Token = $token
    Identity = $null
    Provisional = $true
    UserSid = $userSid
    CreatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    RootOwnerSid = 'S-1-5-32-544'
  }
  $manifest.Directories = @($smokeRecord)
  $manifest.Files = @()
  $manifest.RegistryKeys = @()
  $manifest.RegistryValues = @()
  $manifest.Users = @($userRecord)
  $manifest.Profiles = @()
  Write-FixtureOwnershipManifest $manifest

  $resourceState = [ordered]@{
    OwnedRoot = $smokeDirectory
    InstallRoot = Join-Path $stateDirectory 'absent-install-root'
    ShortcutFolder = Join-Path $stateDirectory 'absent-shortcut-folder'
    Shortcut = Join-Path $stateDirectory 'absent-shortcut.lnk'
    SmokeDirectory = $smokeDirectory
    RegistryPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$($manifest.RunId)\absent"
    RegistryRoot = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$($manifest.RunId)"
    UserName = $userName
    UserSid = $userSid
    ProfilePath = ''
    ManifestPath = $OwnershipManifest
    RunId = [string]$manifest.RunId
    Token = $token
  }
  $resourceState | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII

  [void](New-Item -ItemType Directory -Path $smokeDirectory -ErrorAction Stop)
  Set-FixtureSmokeAcl $smokeDirectory $userSid
  Write-FixtureOwnershipToken (Join-Path $smokeDirectory '.propr-installed-app-owner') $token
  if ($Checkpoint -eq 'BEFORE_PROMOTION') { return }

  $smokeRecord.Identity = [ProPRFixtureDirectoryIdentity]::Read($smokeDirectory)
  $smokeRecord.Provisional = $false
  Write-FixtureOwnershipManifest $manifest
  if ($Checkpoint -eq 'AFTER_PROMOTION') { return }

  New-FixtureSmokeArtifacts $smokeDirectory
}

function Replace-FixtureOwnedResources {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  foreach ($directory in @($state.OwnedRoot, $state.ShortcutFolder)) {
    [IO.File]::WriteAllText(
      (Join-Path $directory '.propr-installed-app-owner'),
      'foreign-owner',
      [Text.Encoding]::ASCII
    )
  }
  $installRootBackup = Join-Path $stateDirectory 'original-install-tree'
  $shortcutBackup = Join-Path $stateDirectory 'original-shortcut.lnk'
  Move-Item -LiteralPath $state.InstallRoot -Destination $installRootBackup -ErrorAction Stop
  [void](New-Item -ItemType Directory -Path $state.InstallRoot -ErrorAction Stop)
  [IO.File]::WriteAllText(
    (Join-Path $state.InstallRoot 'foreign.txt'),
    'foreign-install-tree',
    [Text.Encoding]::ASCII
  )
  Move-Item -LiteralPath $state.Shortcut -Destination $shortcutBackup -ErrorAction Stop
  [IO.File]::WriteAllText($state.Shortcut, 'foreign-shortcut', [Text.Encoding]::ASCII)
  Set-ItemProperty -LiteralPath $state.RegistryPath `
    -Name 'ProPRInstalledAppOwner' -Value 'foreign-owner'
  $state | Add-Member -NotePropertyName InstallRootBackup -NotePropertyValue $installRootBackup
  $state | Add-Member -NotePropertyName ShortcutBackup -NotePropertyValue $shortcutBackup
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Replace-FixtureExecutable {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  $backup = Join-Path $stateDirectory 'original-executable.exe'
  Move-Item -LiteralPath $state.Executable -Destination $backup -ErrorAction Stop
  [IO.File]::WriteAllText($state.Executable, 'foreign-executable', [Text.Encoding]::ASCII)
  $state | Add-Member -NotePropertyName ExecutableBackup -NotePropertyValue $backup
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Replace-FixtureExecutableByteIdenticallyViaMove {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  $backup = Join-Path $stateDirectory 'original-byte-identical-executable.exe'
  $replacement = Join-Path $stateDirectory 'foreign-byte-identical-executable.exe'
  [IO.File]::Copy($state.Executable, $replacement, $false)
  Move-Item -LiteralPath $state.Executable -Destination $backup -ErrorAction Stop
  Move-Item -LiteralPath $replacement -Destination $state.Executable -ErrorAction Stop
  $state | Add-Member -NotePropertyName ExecutableBackup -NotePropertyValue $backup
  $state | Add-Member -NotePropertyName ByteIdenticalReplacement `
    -NotePropertyValue $true
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Replace-FixtureShortcut {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  $backup = Join-Path $stateDirectory 'original-shortcut.lnk'
  Move-Item -LiteralPath $state.Shortcut -Destination $backup -ErrorAction Stop
  [IO.File]::WriteAllText($state.Shortcut, 'foreign-shortcut', [Text.Encoding]::ASCII)
  $state | Add-Member -NotePropertyName ShortcutBackup -NotePropertyValue $backup
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Replace-FixtureProfilePath {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  $mismatchedPath = Join-Path $stateDirectory 'mismatched-profile-path'
  [void](New-Item -ItemType Directory -Path $mismatchedPath -ErrorAction Stop)
  $canonicalMismatch = (Resolve-Path -LiteralPath $mismatchedPath -ErrorAction Stop).ProviderPath
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  $ownedProfile = @($manifest.Profiles | Where-Object {
    $_.Owned -and [string]$_.Sid -ceq [string]$state.UserSid
  })
  if ($ownedProfile.Count -ne 1) {
    throw 'fixture durable profile ownership record is missing'
  }
  $ownedProfile[0].LocalPath = $canonicalMismatch
  Write-FixtureOwnershipManifest $manifest
  $state | Add-Member -NotePropertyName MismatchedProfilePath `
    -NotePropertyValue $canonicalMismatch
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Add-FixtureForeignChild {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  [IO.File]::WriteAllText(
    (Join-Path $state.InstallRoot 'foreign-in-place.txt'),
    'foreign-in-place',
    [Text.Encoding]::ASCII
  )
}

function Add-FixtureForeignSmokeDescendant {
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  $foreignPath = Join-Path $state.SmokeDirectory 'foreign-in-place.txt'
  [IO.File]::WriteAllText($foreignPath, 'foreign-smoke-in-place', [Text.Encoding]::ASCII)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($currentSid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $foreignPath -AclObject $acl -ErrorAction Stop
  $state | Add-Member -NotePropertyName ForeignSmokePath -NotePropertyValue $foreignPath
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
}

function Test-PrimaryFallbackForeignDescendants {
  $installRoot = Join-Path $stateDirectory 'primary-install-root'
  $shortcutFolder = Join-Path $stateDirectory 'primary-shortcut-folder'
  [void](New-Item -ItemType Directory -Path $installRoot -ErrorAction Stop)
  [void](New-Item -ItemType Directory -Path $shortcutFolder -ErrorAction Stop)
  $installForeign = Join-Path $installRoot 'foreign-in-place.txt'
  $shortcutForeign = Join-Path $shortcutFolder 'foreign-in-place.txt'
  [IO.File]::WriteAllText($installForeign, 'foreign-install', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($shortcutForeign, 'foreign-shortcut', [Text.Encoding]::ASCII)
  foreach ($directory in @($installRoot, $shortcutFolder)) {
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (!$item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'primary fallback fixture directory is invalid'
    }
    if (@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop).Count -eq 0) {
      Remove-Item -LiteralPath $directory -Force -ErrorAction Stop
      throw 'primary fallback fixture did not contain a foreign descendant'
    }
    if (!(Test-Path -LiteralPath $directory -PathType Container)) {
      throw 'primary fallback removed a nonempty owned directory'
    }
  }
  [ordered]@{
    InstallForeign = $installForeign
    ShortcutForeign = $shortcutForeign
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'primary-fallback.json') -Encoding ASCII
}

function Start-FixtureDescendant {
  $hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  foreach ($argument in @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Start-Sleep -Seconds 300'
  )) {
    $startInfo.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (!$process.Start()) { throw 'fixture descendant did not start' }
  return $process
}

$ownershipReady = [Threading.EventWaitHandle]::OpenExisting($OwnershipReadyEvent)
try {
  if (!$ownershipReady.WaitOne(5000)) { throw 'fixture ownership was not established' }
} finally {
  $ownershipReady.Dispose()
}

$descendant = Start-FixtureDescendant
$state = [ordered]@{ WorkerPid = $PID; DescendantPid = $descendant.Id }
$processStatePath = Join-Path $stateDirectory 'processes.json'
$processStateTemporaryPath = "$processStatePath.$PID.new"
$processStateBytes = [Text.Encoding]::ASCII.GetBytes(($state | ConvertTo-Json -Compress))
$processStateStream = [IO.FileStream]::new(
  $processStateTemporaryPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::Write,
  [IO.FileShare]::Read,
  4096,
  [IO.FileOptions]::WriteThrough
)
try {
  $processStateStream.Write($processStateBytes, 0, $processStateBytes.Length)
  $processStateStream.Flush($true)
} finally {
  $processStateStream.Dispose()
}
[IO.File]::Move($processStateTemporaryPath, $processStatePath)

switch ($scenario) {
  'NO_MARKER' {
    Start-Sleep -Seconds 300
  }
  'NO_MARKER_WINDOWS_POWERSHELL' {
    Start-Sleep -Seconds 300
  }
  'VALID_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Milliseconds 500
    Write-FixtureMarker ('{0}|VALIDATION|INSTALL_TREE_SCAN|BEGIN' -f [DateTime]::UtcNow.AddMilliseconds(2500).Ticks)
    Start-Sleep -Seconds 300
  }
  'MALFORMED_MARKER' {
    Write-FixtureMarker 'not-a-watchdog-record'
    Start-Sleep -Seconds 300
  }
  'TORN_MARKER' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS' -f [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Seconds 300
  }
  'STALE_MARKER' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(-1).Ticks)
    Start-Sleep -Seconds 300
  }
  'INACCESSIBLE_MARKER' {
    $record = '{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(10).Ticks
    $bytes = [Text.Encoding]::ASCII.GetBytes($record)
    $stream = [IO.FileStream]::new(
      $WatchdogMarker,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
      Start-Sleep -Seconds 300
    } finally {
      $stream.Dispose()
    }
  }
  'CANCELLATION' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Milliseconds 300
    Write-FixtureMarker ('{0}|VALIDATION|INSTALL_TREE_SCAN|BEGIN' -f `
      [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Seconds 300
  }
  'DURING_MSI' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
      ConvertFrom-Json -ErrorAction Stop
    $manifest.BaselineClean = $true
    $manifest.InstallAttempted = $true
    $manifest.MsiTransactionState = 'PENDING'
    Write-FixtureOwnershipManifest $manifest
    Write-FixtureMarker ('{0}|INSTALL|MSI_INSTALL|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Write-FixtureCriticalGate 'DURING_MSI'
    Start-Sleep -Milliseconds 750
    $manifest.Directories = @()
    $manifest.Files = @()
    $manifest.RegistryKeys = @()
    $manifest.RegistryValues = @()
    $manifest.MsiTransactionState = 'ROLLED_BACK_CLEAN'
    Write-FixtureOwnershipManifest $manifest
    Write-FixtureMarker ('{0}|INSTALL|OWNERSHIP_CAPTURE|COMPLETE' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Start-Sleep -Seconds 300
  }
  'DURING_OWNERSHIP_CAPTURE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Initialize-FixtureDirectoryIdentity
    $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
      ConvertFrom-Json -ErrorAction Stop
    $manifest.BaselineClean = $true
    $manifest.InstallAttempted = $true
    $manifest.MsiTransactionState = 'PENDING'
    Write-FixtureOwnershipManifest $manifest
    Write-FixtureMarker ('{0}|INSTALL|OWNERSHIP_CAPTURE|BEGIN' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Write-FixtureCriticalGate 'DURING_OWNERSHIP_CAPTURE'
    Start-Sleep -Milliseconds 750
    New-OwnedFixtureResources -PublishCommittedReceipt $false
    $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
      ConvertFrom-Json -ErrorAction Stop
    $manifest.MsiTransactionState = 'COMMITTED'
    Write-FixtureOwnershipManifest $manifest
    Write-FixtureMarker ('{0}|INSTALL|OWNERSHIP_CAPTURE|COMPLETE' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Start-Sleep -Seconds 300
  }
  'NEGATIVE_EXIT' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Milliseconds 500
    exit -1
  }
  'OWNED_RESOURCES_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_RESOURCES_FOR_INTERRUPTION' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Start-Sleep -Seconds 300
  }
  'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-SmokeCheckpointFixtureResources 'BEFORE_PROMOTION'
    Write-FixtureMarker ('{0}|USER_SETUP|SMOKE_DATA_CREATE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'SMOKE_AFTER_PROMOTION_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-SmokeCheckpointFixtureResources 'AFTER_PROMOTION'
    Write-FixtureMarker ('{0}|USER_SETUP|SMOKE_DATA_CREATE|COMPLETE' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-SmokeCheckpointFixtureResources 'AFTER_ARTIFACTS'
    Write-FixtureMarker ('{0}|APP_EXIT|EVIDENCE_INSPECTION|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-SmokeCheckpointFixtureResources 'AFTER_ARTIFACTS'
    Add-FixtureForeignSmokeDescendant
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-SmokeCheckpointFixtureResources 'BEFORE_PROMOTION'
    $owned = Get-Content -LiteralPath (Join-Path $stateDirectory 'resources.json') `
      -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
    [IO.File]::WriteAllText(
      (Join-Path $owned.SmokeDirectory '.propr-installed-app-owner'),
      'foreign-owner',
      [Text.Encoding]::ASCII
    )
    Write-FixtureMarker ('{0}|USER_SETUP|SMOKE_DATA_CREATE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'PRIMARY_FALLBACK_FOREIGN_DESCENDANTS' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    Test-PrimaryFallbackForeignDescendants
    Write-FixtureMarker ('{0}|CLEANUP|SHORTCUT_FALLBACK|COMPLETE' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
  }
  'OWNED_RESOURCES_REPLACED_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Replace-FixtureOwnedResources
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Replace-FixtureExecutable
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-ByteIdenticalOwnedFileFixture
    Replace-FixtureExecutableByteIdenticallyViaMove
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_SHORTCUT_REPLACED_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Replace-FixtureShortcut
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_PROFILE_PATH_MISMATCH_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Replace-FixtureProfilePath
    Write-FixtureMarker ('{0}|CLEANUP|PROFILE_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Add-FixtureForeignChild
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|BEGIN' -f `
      [DateTime]::UtcNow.AddMilliseconds(500).Ticks)
    Start-Sleep -Seconds 300
  }
  'OWNED_RESOURCES_NORMAL_SUCCESS' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|COMPLETE' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
  }
}

$descendant.Dispose()
