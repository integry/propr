param(
  [Parameter(Mandatory=$true)][string]$OwnershipManifest,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedRunId,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [string]$FixtureRoot,
  [switch]$FixtureValidationDiagnostic,
  [switch]$FixtureEarlyInitializationChild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ownerFileName = '.propr-installed-app-owner'
$ownerRegistryValue = 'ProPRInstalledAppOwner'
$cleanupFailed = $false
$manifestValidated = $false
$authorizedRunId = $null
$cleanupValidationPhase = 'HANDSHAKE'
$cleanupValidationPhases = @(
  'HANDSHAKE','FILE_AUTHORITY','UTF8_DECODE','JSON_PARSE','EXACT_KEY_SET',
  'BOOLEAN_TYPES','TRANSACTION_ENUM','SCHEMA_TYPE_STATE','IDENTIFIER_FORMATS',
  'LIFETIME','RUN_ID','INSTALLER_PATH','FIXTURE_SCOPE','INITIAL_ACTIVE_MATCH'
)

function Write-FixtureCleanupValidationPhase([string]$Phase) {
  if (!$FixtureValidationDiagnostic -or !$FixtureRoot -or
      $cleanupValidationPhases -cnotcontains $Phase) {
    return
  }
  # Diagnostic success is deliberately silent; only validation exit 20 emits
  # this single bounded child-protocol line for supervisor parsing.
  [Console]::Out.WriteLine(
    'CLEANUP_VALIDATION_PHASE:' + $Phase
  )
  [Console]::Out.Flush()
}

function Exit-CleanupHandshakeFailure {
  Write-FixtureCleanupValidationPhase 'HANDSHAKE'
  if ($FixtureValidationDiagnostic -and $FixtureRoot) { exit 20 }
  exit 1
}

try {
  if ($ExpectedRunId -notmatch '^[a-f0-9]{32}$') { Exit-CleanupHandshakeFailure }
  if ($OwnershipReadyEvent -notmatch '^Local\\ProPRInstalledAppCleanup-[a-f0-9]{32}$') {
    Exit-CleanupHandshakeFailure
  }
  $ownershipReady = [Threading.EventWaitHandle]::OpenExisting($OwnershipReadyEvent)
  try {
    if (!$ownershipReady.WaitOne(5000)) { Exit-CleanupHandshakeFailure }
  } finally {
    $ownershipReady.Dispose()
  }
} catch {
  Exit-CleanupHandshakeFailure
}

# This fixture runs after the ownership release but before cold type loading so
# the controller test covers descendants created at the earliest worker phase.
if ($FixtureEarlyInitializationChild) {
  try {
    if (!$FixtureRoot) { exit 1 }
    $fixtureEarlyRoot = (Resolve-Path -LiteralPath $FixtureRoot -ErrorAction Stop).Path
    $fixtureHostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
    if ([IO.Path]::GetFileName($fixtureHostPath) -notin @('pwsh.exe', 'powershell.exe')) {
      exit 1
    }
    $fixtureChildStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $fixtureChildStartInfo.FileName = $fixtureHostPath
    $fixtureChildStartInfo.UseShellExecute = $false
    foreach ($argument in @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 300'
    )) {
      $fixtureChildStartInfo.ArgumentList.Add($argument)
    }
    $fixtureChild = [Diagnostics.Process]::new()
    $fixtureChild.StartInfo = $fixtureChildStartInfo
    if (!$fixtureChild.Start()) { exit 1 }
    $fixtureStatePath = Join-Path $fixtureEarlyRoot 'workflow-cleanup-early-processes.json'
    $fixtureStateTemporaryPath = "$fixtureStatePath.$PID.new"
    $fixtureStateBytes = [Text.Encoding]::ASCII.GetBytes((
      [ordered]@{ WorkerPid = $PID; DescendantPid = $fixtureChild.Id } |
        ConvertTo-Json -Compress
    ))
    $fixtureStateStream = [IO.FileStream]::new(
      $fixtureStateTemporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::Read,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $fixtureStateStream.Write($fixtureStateBytes, 0, $fixtureStateBytes.Length)
      $fixtureStateStream.Flush($true)
    } finally {
      $fixtureStateStream.Dispose()
    }
    [IO.File]::Move($fixtureStateTemporaryPath, $fixtureStatePath)
    Start-Sleep -Seconds 300
  } catch {
    exit 1
  }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProPRDirectoryIdentity
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

    public static string ReadHandle(SafeFileHandle handle, bool expectDirectory)
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("file-system identity handle is invalid");
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "directory identity read failed");
        bool isDirectory = (information.FileAttributes & 0x10) != 0;
        if ((information.FileAttributes & 0x400) != 0 || isDirectory != expectDirectory)
            throw new InvalidOperationException("file-system object identity changed");
        return string.Format("{0:x8}{1:x8}{2:x8}", information.VolumeSerialNumber,
            information.FileIndexHigh, information.FileIndexLow);
    }

    public static string ReadEntry(string path, bool expectDirectory)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 0x7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "directory identity open failed");
            return ReadHandle(handle, expectDirectory);
        }
    }

    public static string Read(string path) { return ReadEntry(path, true); }
}
'@

function Test-SamePath([string]$Left, [string]$Right) {
  return [string]::Equals(
    [IO.Path]::GetFullPath($Left).TrimEnd('\'),
    [IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Resolve-CanonicalNonReparseDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or ![IO.Path]::IsPathRooted($Path)) {
    throw "$Label path is invalid"
  }
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $pathRoot = [IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($pathRoot)) { throw "$Label path root is invalid" }
  $rootItem = Get-Item -LiteralPath $pathRoot -Force -ErrorAction Stop
  if (!$rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label path root is invalid"
  }
  $currentPath = $pathRoot
  $components = @($fullPath.Substring($pathRoot.Length) -split '\\' |
    Where-Object { $_.Length -ne 0 })
  foreach ($component in $components) {
    $currentPath = Join-Path $currentPath $component
    $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (!$item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path has invalid ancestry"
    }
  }
  $resolved = (Resolve-Path -LiteralPath $fullPath -ErrorAction Stop).ProviderPath.TrimEnd('\')
  if (![string]::Equals(
      [IO.Path]::GetFullPath($resolved).TrimEnd('\'),
      $fullPath,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "$Label path is not canonical"
  }
  return $fullPath
}

function Resolve-SystemProfilesDirectory {
  $profileListPath = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  $configured = [string](Get-ItemPropertyValue -LiteralPath $profileListPath `
    -Name 'ProfilesDirectory' -ErrorAction Stop)
  $expanded = [Environment]::ExpandEnvironmentVariables($configured)
  return Resolve-CanonicalNonReparseDirectory $expanded 'system profiles directory'
}

function Resolve-ValidatedOwnedProfilePath([string]$LocalPath, [string]$UserName) {
  if ($UserName -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
    throw 'owned profile username is invalid'
  }
  $profilesDirectory = Resolve-SystemProfilesDirectory
  $canonicalLocalPath = Resolve-CanonicalNonReparseDirectory $LocalPath 'profile local'
  $parent = Split-Path -Parent $canonicalLocalPath
  $leaf = Split-Path -Leaf $canonicalLocalPath
  if (!(Test-SamePath $parent $profilesDirectory) -or $leaf -cne $UserName) {
    throw 'profile local path is not the exact owned direct child of ProfilesDirectory'
  }
  return $canonicalLocalPath
}

function Test-PathWithin([string]$Path, [string]$Root) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $fullPath.StartsWith("$fullRoot\", [StringComparison]::OrdinalIgnoreCase)
}

function Test-OwnerFile([string]$Directory, [string]$Token) {
  if (!$Token -or !(Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
  $marker = Join-Path $Directory $ownerFileName
  if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $marker -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 128) {
    return $false
  }
  return ([IO.File]::ReadAllText($marker, [Text.Encoding]::ASCII) -ceq $Token)
}

function Get-FileIdentity([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -gt 65536) {
    return $null
  }
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-DirectoryIdentity([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Container)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
  return [ProPRDirectoryIdentity]::Read($item.FullName)
}

function Get-FileSystemEntryIdentity([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'file-system object identity is invalid'
  }
  return [ProPRDirectoryIdentity]::ReadEntry($item.FullName, $Directory)
}

function Get-FileSystemTreeIdentity([string]$Path) {
  $root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (!$root.PSIsContainer -or
      ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'file-system tree root identity is invalid'
  }
  $rootPath = $root.FullName.TrimEnd('\')
  $records = [Collections.Generic.List[string]]::new()
  $records.Add(('D||{0}' -f (Get-FileSystemEntryIdentity $rootPath $true)))
  foreach ($entry in @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force -ErrorAction Stop)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'file-system tree contains a reparse point'
    }
    $relativePath = $entry.FullName.Substring($rootPath.Length).TrimStart('\')
    if (!$relativePath -or [IO.Path]::IsPathRooted($relativePath)) {
      throw 'file-system tree relative path is invalid'
    }
    $kind = if ($entry.PSIsContainer) { 'D' } else { 'F' }
    $relative = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relativePath))
    $identity = Get-FileSystemEntryIdentity $entry.FullName ([bool]$entry.PSIsContainer)
    $records.Add(('{0}|{1}|{2}' -f $kind, $relative, $identity))
  }
  $recordArray = $records.ToArray()
  [Array]::Sort($recordArray, [StringComparer]::Ordinal)
  $payload = [Text.Encoding]::UTF8.GetBytes(($recordArray -join "`n"))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($payload)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Assert-MsiManagedFileSystemAuthority($Manifest) {
  $installRootPath = if ($FixtureRoot) { $null } else {
    Join-Path $env:ProgramFiles 'ProPR Desktop'
  }
  $installRoot = if ($FixtureRoot) {
    @($Manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'INSTALL_ROOT'
    })
  } else {
    @($Manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'INSTALL_ROOT' -and
        (Test-SamePath ([string]$_.Path) $installRootPath)
    })
  }
  $shortcutFolderPath = if ($FixtureRoot) { $null } else {
    Join-Path ([Environment]::GetFolderPath(
      [Environment+SpecialFolder]::CommonPrograms)) 'ProPR Desktop'
  }
  $shortcutFolder = if ($FixtureRoot) {
    @($Manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FOLDER'
    })
  } else {
    @($Manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FOLDER' -and
        (Test-SamePath ([string]$_.Path) $shortcutFolderPath)
    })
  }
  $shortcutPath = if ($FixtureRoot) { $null } else {
    Join-Path $shortcutFolderPath 'ProPR Desktop.lnk'
  }
  $shortcut = if ($FixtureRoot) {
    @($Manifest.Files | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FILE'
    })
  } else {
    @($Manifest.Files | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FILE' -and
        (Test-SamePath ([string]$_.Path) $shortcutPath)
    })
  }

  foreach ($candidate in @(
      [PSCustomObject]@{
        Records = $installRoot; Path = $installRootPath; Directory = $true; Tree = $true
      },
      [PSCustomObject]@{
        Records = $shortcutFolder; Path = $shortcutFolderPath; Directory = $true; Tree = $true
      },
      [PSCustomObject]@{
        Records = $shortcut; Path = $shortcutPath; Directory = $false; Tree = $false
      }
    )) {
    $candidatePath = if ($FixtureRoot -and $candidate.Records.Count -eq 1) {
      [string]$candidate.Records[0].Path
    } else { [string]$candidate.Path }
    if ($candidate.Records.Count -ne 1) {
      throw 'MSI-managed file-system authority is missing or ambiguous'
    }
    if (!$candidatePath -or !(Test-Path -LiteralPath $candidatePath)) { continue }
    $record = $candidate.Records[0]
    $entryIdentity = if ($candidate.Directory) {
      [string]$record.Identity
    } else { [string]$record.EntryIdentity }
    if ([bool]$record.Provisional -or
        $entryIdentity -notmatch '^[a-f0-9]{24}$' -or
        (Get-FileSystemEntryIdentity $candidatePath $candidate.Directory) -cne
          $entryIdentity) {
      throw 'MSI-managed file-system object identity does not match'
    }
    if ($candidate.Tree) {
      if ([string]$record.TreeIdentity -notmatch '^[a-f0-9]{64}$' -or
          (Get-FileSystemTreeIdentity $candidatePath) -cne
            [string]$record.TreeIdentity) {
        throw 'MSI-managed file-system tree identity does not match'
      }
    } elseif ([string]$record.Identity -notmatch '^[a-f0-9]{64}$' -or
        (Get-FileIdentity $candidatePath) -cne [string]$record.Identity) {
      throw 'MSI-managed shortcut content identity does not match'
    }
  }
}

function Get-RegistryTreeIdentity([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  $root = Get-Item -LiteralPath $Path -ErrorAction Stop
  $records = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Queue[object]]::new()
  $pending.Enqueue([PSCustomObject]@{ Key = $root; Relative = '' })
  while ($pending.Count -ne 0) {
    $entry = $pending.Dequeue()
    $records.Add(('K|{0}' -f [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes([string]$entry.Relative))))
    foreach ($valueName in @($entry.Key.GetValueNames() | Sort-Object -CaseSensitive)) {
      $value = $entry.Key.GetValue(
        $valueName,
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      $valueBytes = if ($value -is [byte[]]) {
        $value
      } elseif ($value -is [string[]]) {
        [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
      } else {
        [Text.Encoding]::UTF8.GetBytes([Convert]::ToString(
          $value,
          [Globalization.CultureInfo]::InvariantCulture
        ))
      }
      $records.Add(('V|{0}|{1}|{2}' -f
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$valueName)),
        $entry.Key.GetValueKind($valueName).ToString(),
        [Convert]::ToBase64String($valueBytes)))
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $entry.Key.PSPath -ErrorAction Stop |
        Sort-Object -Property PSChildName -CaseSensitive)) {
      $relative = if ($entry.Relative) {
        '{0}\{1}' -f $entry.Relative, $child.PSChildName
      } else { [string]$child.PSChildName }
      $pending.Enqueue([PSCustomObject]@{ Key = $child; Relative = $relative })
    }
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($payload)).Replace('-', '').ToLowerInvariant()
  }
  finally { $sha256.Dispose() }
}

function Get-InstallerSha256([string]$Path) {
  $stream = [IO.File]::Open(
    $Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Assert-InstallerArtifactAuthority($Manifest) {
  $path = [string]$Manifest.InstallerPath
  if ([string]$Manifest.InstallerEntryIdentity -notmatch '^[a-f0-9]{24}$' -or
      [string]$Manifest.InstallerSha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]$Manifest.InstallerProductCode -notmatch
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$' -or
      (Get-FileSystemEntryIdentity $path $false) -cne
        [string]$Manifest.InstallerEntryIdentity -or
      (Get-InstallerSha256 $path) -cne [string]$Manifest.InstallerSha256) {
    throw 'installer artifact no longer matches durable authority'
  }
}

function Assert-MsiProductIsUnregistered([string]$ProductCode) {
  $installerCom = $null
  try {
    if ($ProductCode -notmatch '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$') {
      throw 'MSI product identity is invalid'
    }
    $installerCom = New-Object -ComObject WindowsInstaller.Installer
    if ([int]$installerCom.ProductState($ProductCode) -ne -1) {
      throw 'Windows Installer product registration is not at the clean baseline'
    }
  } finally {
    if ($null -ne $installerCom -and
        [Runtime.InteropServices.Marshal]::IsComObject($installerCom)) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installerCom)
    }
  }
}

function Assert-MsiRolledBackCleanBaseline($Manifest) {
  if ($FixtureRoot -or [string]$Manifest.MsiTransactionState -cne 'ROLLED_BACK_CLEAN') {
    return
  }
  foreach ($path in @(
      (Join-Path $env:ProgramFiles 'ProPR Desktop'),
      (Join-Path ([Environment]::GetFolderPath(
        [Environment+SpecialFolder]::CommonPrograms)) 'ProPR Desktop'),
      'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr',
      'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
    )) {
    if (Test-Path -LiteralPath $path) {
      throw 'MSI rollback did not restore the exact clean baseline'
    }
  }
  if (@($Manifest.Directories).Count -ne 0 -or @($Manifest.Files).Count -ne 0 -or
      @($Manifest.RegistryKeys).Count -ne 0) {
    throw 'MSI rollback receipt contains file-system or machine-registry authority'
  }
  $installedRecords = @($Manifest.RegistryValues)
  if ($installedRecords.Count -ne 1) {
    throw 'MSI rollback current-user baseline receipt is missing or ambiguous'
  }
  $record = $installedRecords[0]
  $current = Get-RegistryValueSnapshot ([string]$record.Path) ([string]$record.Name)
  $matchesBaseline = if ([bool]$record.BaselineValueExisted) {
    $current.Exists -and $current.Kind -ceq [string]$record.BaselineValueKind -and
      $current.Data -ceq [string]$record.BaselineValueData
  } else { !$current.Exists }
  $keyMatchesBaseline = (Test-Path -LiteralPath ([string]$record.Path)) -eq
    [bool]$record.BaselineKeyExisted
  if (!$matchesBaseline -or !$keyMatchesBaseline) {
    throw 'MSI rollback did not restore the exact current-user baseline'
  }
  Assert-InstallerArtifactAuthority $Manifest
  Assert-MsiProductIsUnregistered ([string]$Manifest.InstallerProductCode)
}

function Convert-RegistryValueToBytes(
  [Microsoft.Win32.RegistryValueKind]$Kind,
  $Value
) {
  switch ($Kind) {
    'DWord' { return [BitConverter]::GetBytes([int32]$Value) }
    'QWord' { return [BitConverter]::GetBytes([int64]$Value) }
    'String' { return [Text.Encoding]::UTF8.GetBytes([string]$Value) }
    'ExpandString' { return [Text.Encoding]::UTF8.GetBytes([string]$Value) }
    'MultiString' {
      return [Text.Encoding]::UTF8.GetBytes(
        (ConvertTo-Json -InputObject @([string[]]$Value) -Compress))
    }
    'Binary' { return [byte[]]$Value }
    'None' { return [byte[]]$Value }
    default { throw 'registry value kind is unsupported' }
  }
}

function Get-RegistryValueSnapshot([string]$Path, [string]$Name) {
  if (!(Test-Path -LiteralPath $Path)) {
    return [PSCustomObject]@{ Exists = $false; Kind = $null; Data = $null }
  }
  $key = Get-Item -LiteralPath $Path -ErrorAction Stop
  if (@($key.GetValueNames()) -cnotcontains $Name) {
    return [PSCustomObject]@{ Exists = $false; Kind = $null; Data = $null }
  }
  $kind = $key.GetValueKind($Name)
  $value = $key.GetValue(
    $Name,
    $null,
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  )
  return [PSCustomObject]@{
    Exists = $true
    Kind = $kind.ToString()
    Data = [Convert]::ToBase64String((Convert-RegistryValueToBytes $kind $value))
  }
}

function Test-MsiInstalledValue([string]$Path, [string]$Name) {
  $snapshot = Get-RegistryValueSnapshot $Path $Name
  return $snapshot.Exists -and $snapshot.Kind -ceq 'DWord' -and
    $snapshot.Data -ceq [Convert]::ToBase64String([BitConverter]::GetBytes([int32]1))
}

function Test-RegistryValueIdentity($Record, $Snapshot) {
  return $Snapshot.Exists -and
    [string]$Record.IdentityValueKind -in @(
      'DWord','QWord','String','ExpandString','MultiString','Binary','None'
    ) -and
    [string]$Record.IdentityValueData -match '^[A-Za-z0-9+/]*={0,2}$' -and
    $Snapshot.Kind -ceq [string]$Record.IdentityValueKind -and
    $Snapshot.Data -ceq [string]$Record.IdentityValueData
}

function Test-AllowedFileSystemPath([string]$Kind, [string]$Path) {
  if ($FixtureRoot) { return Test-PathWithin $Path $FixtureRoot }
  $installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
  $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
  $shortcutFolder = Join-Path $commonPrograms 'ProPR Desktop'
  $shortcut = Join-Path $shortcutFolder 'ProPR Desktop.lnk'
  if ($Kind -eq 'INSTALL_ROOT') { return Test-SamePath $Path $installRoot }
  if ($Kind -eq 'SHORTCUT_FOLDER') { return Test-SamePath $Path $shortcutFolder }
  if ($Kind -eq 'SHORTCUT_FILE') { return Test-SamePath $Path $shortcut }
  if ($Kind -eq 'SMOKE_DATA') {
    $machineTempValue = [Environment]::GetEnvironmentVariable(
      'TEMP', [EnvironmentVariableTarget]::Machine)
    if (!$machineTempValue) { return $false }
    $machineTemp = [Environment]::ExpandEnvironmentVariables($machineTempValue)
    return (Split-Path -Leaf $Path) -match '^propr-desktop-smoke-[a-f0-9]{32}$' -and
      (Test-SamePath (Split-Path -Parent $Path) $machineTemp)
  }
  return $false
}

function Assert-SmokeAccessControl($Item, $Record, [bool]$Root) {
  $userSid = [string]$Record.UserSid
  $creatorSid = [string]$Record.CreatorSid
  $rootOwnerSid = [string]$Record.RootOwnerSid
  if ($userSid -notmatch '^S-\d+(?:-\d+)+$' -or
      $creatorSid -notmatch '^S-\d+(?:-\d+)+$' -or
      $rootOwnerSid -cne 'S-1-5-32-544') {
    throw 'smoke user-data manifest security authority is invalid'
  }
  $systemSid = 'S-1-5-18'
  $expectedAccessSids = @($userSid, $systemSid, $rootOwnerSid) | Sort-Object -Unique
  if ($expectedAccessSids.Count -ne 3) {
    throw 'smoke user-data manifest security authority is invalid'
  }
  $acl = Get-Acl -LiteralPath $Item.FullName -ErrorAction Stop
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowedOwnerSids = @($userSid, $creatorSid, $rootOwnerSid) | Sort-Object -Unique
  if ($allowedOwnerSids -cnotcontains $ownerSid) {
    throw 'smoke user-data object owner is not authorized'
  }
  $rules = @($acl.Access)
  $actualAccessSids = @($rules | ForEach-Object {
    ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
  }) | Sort-Object -Unique
  $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $invalidRules = if ($Root) {
    @($rules | Where-Object {
      $_.IsInherited -or
      $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      ($_.FileSystemRights -band $fullControl) -ne $fullControl -or
      $_.InheritanceFlags -ne $expectedInheritance -or
      $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None
    })
  } else {
    $inheritedFlags = if ($Item.PSIsContainer) {
      $expectedInheritance
    } else { [Security.AccessControl.InheritanceFlags]::None }
    @($rules | Where-Object {
      !$_.IsInherited -or
      $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      ($_.FileSystemRights -band $fullControl) -ne $fullControl -or
      $_.InheritanceFlags -ne $inheritedFlags -or
      $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None
    })
  }
  if (($Root -and (!$acl.AreAccessRulesProtected -or $ownerSid -cne $rootOwnerSid)) -or
      (!$Root -and $acl.AreAccessRulesProtected) -or
      $rules.Count -ne 3 -or $invalidRules.Count -ne 0 -or
      @(Compare-Object $expectedAccessSids $actualAccessSids).Count -ne 0) {
    throw 'smoke user-data object ACL is not authorized'
  }
}

function Assert-OwnedSmokeRoot($Record) {
  $path = [IO.Path]::GetFullPath([string]$Record.Path)
  if (!(Test-AllowedFileSystemPath 'SMOKE_DATA' $path) -or
      [string]$Record.Token -notmatch '^[a-f0-9]{32}$') {
    throw 'smoke user-data cleanup scope is invalid'
  }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (!$item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'smoke user-data root identity is invalid'
  }
  $markerPath = Join-Path $path $ownerFileName
  $marker = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
  if (!($marker -is [IO.FileInfo]) -or
      ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'smoke user-data ownership token does not match'
  }
  $markerIdentity = Get-FileSystemEntryIdentity $marker.FullName $false
  $markerStream = [IO.File]::Open(
    $markerPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
    if ($markerStream.Length -le 0 -or $markerStream.Length -gt 128) {
      throw 'smoke user-data ownership token does not match'
    }
    $markerBytes = [byte[]]::new([int]$markerStream.Length)
    $markerOffset = 0
    while ($markerOffset -lt $markerBytes.Length) {
      $markerRead = $markerStream.Read(
        $markerBytes, $markerOffset, $markerBytes.Length - $markerOffset)
      if ($markerRead -eq 0) { throw 'smoke user-data ownership token does not match' }
      $markerOffset += $markerRead
    }
    if ($markerStream.ReadByte() -ne -1 -or
        [Text.Encoding]::ASCII.GetString($markerBytes) -cne [string]$Record.Token) {
      throw 'smoke user-data ownership token does not match'
    }
  } finally {
    $markerStream.Dispose()
  }
  Assert-SmokeAccessControl $item $Record $true
  Assert-SmokeAccessControl $marker $Record $false
  if ((Get-FileSystemEntryIdentity $marker.FullName $false) -cne $markerIdentity) {
    throw 'smoke user-data ownership token identity changed'
  }
  return $item
}

function Resolve-SmokeDirectoryAuthority($Record, $Manifest, [string]$ManifestPath) {
  if (!$Record.Owned -or [string]$Record.Kind -cne 'SMOKE_DATA') { return $false }
  $recordKeys = @($Record.PSObject.Properties | ForEach-Object { $_.Name })
  $expectedKeys = @(
    'Kind','Path','Owned','Token','Identity','Provisional',
    'UserSid','CreatorSid','RootOwnerSid'
  )
  if ($recordKeys.Count -ne $expectedKeys.Count -or
      @($expectedKeys | Where-Object { $recordKeys -cnotcontains $_ }).Count -ne 0 -or
      $Record.Owned -isnot [bool] -or $Record.Provisional -isnot [bool] -or
      [string]$Record.Token -notmatch '^[a-f0-9]{32}$' -or
      [string]$Record.UserSid -notmatch '^S-\d+(?:-\d+)+$' -or
      [string]$Record.CreatorSid -notmatch '^S-\d+(?:-\d+)+$' -or
      [string]$Record.RootOwnerSid -cne 'S-1-5-32-544' -or
      (![bool]$Record.Provisional -and [string]$Record.Identity -notmatch '^[a-f0-9]{24}$') -or
      ([bool]$Record.Provisional -and $null -ne $Record.Identity)) {
    throw 'smoke user-data manifest authority is invalid'
  }
  $ownedUsers = @($Manifest.Users | Where-Object { $_.Owned })
  if ($ownedUsers.Count -ne 1 -or [bool]$ownedUsers[0].Provisional -or
      [string]$ownedUsers[0].Sid -cne [string]$Record.UserSid) {
    throw 'smoke user-data SID is not the exact run-owned user SID'
  }
  if (!(Test-Path -LiteralPath ([string]$Record.Path))) { return $false }
  $root = Assert-OwnedSmokeRoot $Record
  $identity = Get-FileSystemEntryIdentity $root.FullName $true
  if ([bool]$Record.Provisional) {
    $Record.Identity = $identity
    $Record.Provisional = $false
    Write-DurableOwnershipManifest $ManifestPath $Manifest
    return $true
  }
  if ([string]$Record.Identity -cne $identity) {
    throw 'smoke user-data root identity does not match'
  }
  return $false
}

function Remove-OwnedSmokeDirectory($Record) {
  if (!$Record.Owned -or !(Test-Path -LiteralPath ([string]$Record.Path))) { return }
  if ([bool]$Record.Provisional) {
    throw 'provisional smoke user-data authority was not durably promoted'
  }
  $root = Assert-OwnedSmokeRoot $Record
  if ((Get-FileSystemEntryIdentity $root.FullName $true) -cne [string]$Record.Identity) {
    throw 'smoke user-data root identity does not match'
  }
  $rootPath = $root.FullName.TrimEnd('\')
  $pending = [Collections.Generic.Queue[object]]::new()
  $pending.Enqueue([PSCustomObject]@{
    Path = $root.FullName
    Identity = [string]$Record.Identity
    Root = $true
  })
  $entries = [Collections.Generic.List[object]]::new()
  while ($pending.Count -ne 0) {
    $queuedDirectory = $pending.Dequeue()
    $directory = Get-Item -LiteralPath $queuedDirectory.Path -Force -ErrorAction Stop
    Assert-SmokeAccessControl $directory $Record ([bool]$queuedDirectory.Root)
    if ((Get-FileSystemEntryIdentity $directory.FullName $true) -cne
        [string]$queuedDirectory.Identity) {
      throw 'smoke user-data directory identity changed during traversal'
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      if ($entries.Count -ge 50000) { throw 'smoke user-data cleanup entry bound was exceeded' }
      $childPath = [IO.Path]::GetFullPath($child.FullName)
      if (!$childPath.StartsWith("$rootPath\", [StringComparison]::OrdinalIgnoreCase) -or
          ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'smoke user-data descendant scope is invalid'
      }
      Assert-SmokeAccessControl $child $Record $false
      $identity = Get-FileSystemEntryIdentity $childPath ([bool]$child.PSIsContainer)
      $entries.Add([PSCustomObject]@{
        Path = $childPath
        Directory = [bool]$child.PSIsContainer
        Identity = $identity
      })
      if ($child.PSIsContainer) {
        $pending.Enqueue([PSCustomObject]@{
          Path = $childPath
          Identity = $identity
          Root = $false
        })
      }
    }
  }

  foreach ($entry in @($entries | Where-Object { !$_.Directory })) {
    $item = Get-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
    Assert-SmokeAccessControl $item $Record $false
    if ((Get-FileSystemEntryIdentity $entry.Path $false) -cne [string]$entry.Identity) {
      throw 'smoke user-data file identity changed during cleanup'
    }
    Remove-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
  }
  foreach ($entry in @($entries | Where-Object { $_.Directory } |
      Sort-Object { ([string]$_.Path).Length } -Descending)) {
    $item = Get-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
    Assert-SmokeAccessControl $item $Record $false
    if ((Get-FileSystemEntryIdentity $entry.Path $true) -cne [string]$entry.Identity -or
        @(Get-ChildItem -LiteralPath $entry.Path -Force -ErrorAction Stop).Count -ne 0) {
      throw 'smoke user-data directory identity changed or is not empty'
    }
    Remove-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
  }
  $root = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
  if (!$root.PSIsContainer -or
      ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'smoke user-data root identity changed during cleanup'
  }
  Assert-SmokeAccessControl $root $Record $true
  if ((Get-FileSystemEntryIdentity $root.FullName $true) -cne [string]$Record.Identity -or
      @(Get-ChildItem -LiteralPath $root.FullName -Force -ErrorAction Stop).Count -ne 0) {
    throw 'smoke user-data root changed or is not empty'
  }
  Remove-Item -LiteralPath $root.FullName -Force -ErrorAction Stop
}

function Remove-OwnedDirectory($Record) {
  if (!$Record.Owned) { return }
  if ([string]$Record.Kind -ceq 'SMOKE_DATA') {
    Remove-OwnedSmokeDirectory $Record
    return
  }
  $path = [string]$Record.Path
  $kind = [string]$Record.Kind
  if (!(Test-AllowedFileSystemPath $kind $path)) { throw 'directory cleanup scope is invalid' }
  if (!(Test-Path -LiteralPath $path)) { return }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (!$item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'owned directory identity is invalid'
  }
  if ([bool]$Record.Provisional) {
    throw 'provisional directory evidence cannot authorize manual cleanup'
  }
  $tokenMatches = Test-OwnerFile $path ([string]$Record.Token)
  $identityMatches = [string]$Record.Identity -match '^[a-f0-9]{24}$' -and
    (Get-DirectoryIdentity $path) -ceq [string]$Record.Identity
  if (!$tokenMatches -and !$identityMatches) {
    throw 'owned directory identity does not match'
  }
  $markerPath = Join-Path $path $ownerFileName
  $children = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)
  $unexpectedChildren = @($children | Where-Object {
    ![string]::Equals($_.FullName, $markerPath, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($unexpectedChildren.Count -ne 0) {
    throw 'owned directory contains an unexpected descendant'
  }
  if ($children.Count -ne 0) {
    if (!$tokenMatches -or $children.Count -ne 1) {
      throw 'owned directory marker identity does not match'
    }
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction Stop
  }
  if (@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count -ne 0) {
    throw 'owned directory is not empty'
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) { throw 'owned directory cleanup did not complete' }
}

function Remove-OwnedFile($Record) {
  if (!$Record.Owned) { return }
  $path = [string]$Record.Path
  $kind = [string]$Record.Kind
  if (!(Test-AllowedFileSystemPath $kind $path)) { throw 'file cleanup scope is invalid' }
  if (!(Test-Path -LiteralPath $path)) { return }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (!($item -is [IO.FileInfo]) -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'owned file identity is invalid'
  }
  if ([bool]$Record.Provisional) {
    throw 'provisional file evidence cannot authorize manual cleanup'
  }
  if ([string]$Record.Identity -notmatch '^[a-f0-9]{64}$' -or
      (Get-FileIdentity $path) -cne [string]$Record.Identity) {
    throw 'owned file content identity does not match'
  }
  if ([string]$Record.EntryIdentity -notmatch '^[a-f0-9]{24}$' -or
      (Get-FileSystemEntryIdentity $path $false) -cne [string]$Record.EntryIdentity) {
    throw 'owned file entry identity does not match'
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) { throw 'owned file cleanup did not complete' }
}

function Remove-OwnedRegistryKey($Record) {
  if (!$Record.Owned) { return }
  $path = [string]$Record.Path
  $kind = [string]$Record.Kind
  $productionPaths = @{
    PROTOCOL = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
    APP_PATH = 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
  }
  if ($FixtureRoot) {
    $expectedPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$authorizedRunId\owned"
    if (![string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'registry cleanup scope is invalid'
    }
  } elseif (!$productionPaths.ContainsKey($kind) -or
      ![string]::Equals($path, $productionPaths[$kind], [StringComparison]::OrdinalIgnoreCase)) {
    throw 'registry cleanup scope is invalid'
  }
  if (!(Test-Path -LiteralPath $path)) { return }
  if ([bool]$Record.Provisional) {
    throw 'provisional registry evidence cannot authorize manual cleanup'
  }
  if ($FixtureRoot) {
    $token = Get-ItemPropertyValue -LiteralPath $path -Name $ownerRegistryValue -ErrorAction Stop
    if ([string]$token -cne [string]$Record.Token) { throw 'owned registry token does not match' }
  } elseif ([string]$Record.Identity -notmatch '^[a-f0-9]{64}$' -or
      (Get-RegistryTreeIdentity $path) -cne [string]$Record.Identity) {
    throw 'owned registry identity does not match'
  }
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) { throw 'owned registry cleanup did not complete' }
  if ($FixtureRoot) {
    $runRoot = Split-Path -Parent $path
    if ((Test-Path -LiteralPath $runRoot) -and
        @(Get-ChildItem -LiteralPath $runRoot -Force -ErrorAction Stop).Count -eq 0) {
      Remove-Item -LiteralPath $runRoot -Force -ErrorAction Stop
    }
  }
}

function Restore-OwnedRegistryValue($Record) {
  if (!$Record.Owned) { return }
  $path = [string]$Record.Path
  $name = [string]$Record.Name
  if ([string]$Record.Kind -cne 'HKCU_INSTALLED' -or
      ![string]::Equals(
        $path,
        'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop',
        [StringComparison]::OrdinalIgnoreCase
      ) -or $name -cne 'installed') {
    throw 'registry value cleanup scope is invalid'
  }

  $current = Get-RegistryValueSnapshot $path $name
  $baselineValueExists = [bool]$Record.BaselineValueExisted
  $baselineKind = [string]$Record.BaselineValueKind
  $baselineData = [string]$Record.BaselineValueData
  $matchesBaseline = $baselineValueExists -and $current.Exists -and
    $current.Kind -ceq $baselineKind -and $current.Data -ceq $baselineData
  if ([bool]$Record.Provisional -and $current.Exists -and !$matchesBaseline) {
    throw 'provisional registry evidence cannot authorize manual cleanup'
  }
  if ($current.Exists -and !$matchesBaseline -and
      !(Test-RegistryValueIdentity $Record $current)) {
    throw 'registry value ownership changed'
  }

  if ($baselineValueExists) {
    if (!(Test-Path -LiteralPath $path)) {
      [void](New-Item -Path $path -Force -ErrorAction Stop)
    }
    if (!$matchesBaseline) {
      $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $baselineKind, $false)
      $bytes = [Convert]::FromBase64String($baselineData)
      $value = switch ($kind) {
        'DWord' { [BitConverter]::ToInt32($bytes, 0); break }
        'QWord' { [BitConverter]::ToInt64($bytes, 0); break }
        'String' { [Text.Encoding]::UTF8.GetString($bytes); break }
        'ExpandString' { [Text.Encoding]::UTF8.GetString($bytes); break }
        'MultiString' {
          @([string[]](ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($bytes))))
          break
        }
        'Binary' { $bytes; break }
        'None' { $bytes; break }
        default { throw 'registry baseline kind is unsupported' }
      }
      (Get-Item -LiteralPath $path -ErrorAction Stop).SetValue($name, $value, $kind)
    }
  } elseif ($current.Exists) {
    Remove-ItemProperty -LiteralPath $path -Name $name -Force -ErrorAction Stop
  }

  if ([bool]$Record.KeyCreatedByRun -and (Test-Path -LiteralPath $path)) {
    $key = Get-Item -LiteralPath $path -ErrorAction Stop
    if (@($key.GetValueNames()).Count -eq 0 -and @($key.GetSubKeyNames()).Count -eq 0) {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
  }

  $after = Get-RegistryValueSnapshot $path $name
  if ($baselineValueExists) {
    if (!$after.Exists -or $after.Kind -cne $baselineKind -or $after.Data -cne $baselineData) {
      throw 'registry baseline restoration did not complete'
    }
  } elseif ($after.Exists) {
    throw 'owned registry value cleanup did not complete'
  }
}

function Write-DurableOwnershipManifest([string]$Path, $Manifest) {
  $temporaryPath = "$Path.new"
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Manifest | ConvertTo-Json -Depth 6 -Compress))
  $stream = [IO.FileStream]::new(
    $temporaryPath,
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
  # File.Move(source, destination, overwrite) is not available on the .NET
  # Framework used by Windows PowerShell 5.1. The canonical manifest exists,
  # so File.Replace retains the same atomic same-volume replacement contract.
  [IO.File]::Replace($temporaryPath, $Path, $null, $true)
}

function Write-EmptyOwnershipReceipt([string]$Path, $Manifest) {
  $Manifest.State = 'EMPTY'
  $Manifest.BaselineClean = $false
  $Manifest.InstallAttempted = $false
  $Manifest.MsiTransactionState = 'NONE'
  $Manifest.Directories = @()
  $Manifest.Files = @()
  $Manifest.RegistryKeys = @()
  $Manifest.RegistryValues = @()
  $Manifest.Users = @()
  $Manifest.Profiles = @()
  Write-DurableOwnershipManifest $Path $Manifest
}

function Resolve-ProvisionalOwnedUser($Record) {
  if (!$Record.Owned -or [string]$Record.Sid -match '^S-\d+(?:-\d+)+$') {
    return $false
  }
  if (!$Record.Provisional) { throw 'owned user SID is invalid' }
  $name = [string]$Record.Name
  $ownershipMarker = [string]$Record.OwnershipMarker
  $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $user) { return $false }
  if ($ownershipMarker -notmatch '^prpr-own-[a-f0-9]{32}$' -or
      [string]$user.Description -cne $ownershipMarker -or
      [string]$user.SID.Value -notmatch '^S-\d+(?:-\d+)+$') {
    throw 'provisional local-user ownership marker does not match'
  }
  $Record.Sid = [string]$user.SID.Value
  $Record.Provisional = $false
  return $true
}

function Promote-UncapturedOwnedProfiles($UserRecord, $Manifest) {
  if (!$UserRecord.Owned) { return $false }
  $name = [string]$UserRecord.Name
  $sid = [string]$UserRecord.Sid
  $ownershipMarker = [string]$UserRecord.OwnershipMarker
  if ($sid -notmatch '^S-\d+(?:-\d+)+$' -and $UserRecord.Provisional) {
    return $false
  }
  if ($name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$' -or
      $sid -notmatch '^S-\d+(?:-\d+)+$' -or
      $ownershipMarker -notmatch '^prpr-own-[a-f0-9]{32}$') {
    throw 'profile promotion identity is invalid'
  }
  $durableProfiles = @($Manifest.Profiles | Where-Object {
    $_.Owned -and [string]$_.Sid -ceq $sid
  })
  if ($durableProfiles.Count -ne 0) { return $false }

  $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -ceq $sid })
  if ($profiles.Count -eq 0) { return $false }

  # An absent profile record can be promoted only while the exact run-created
  # account still authenticates both the marker and SID. A durable path record
  # is published by the caller before any profile deletion is attempted.
  $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $user -or [string]$user.Description -cne $ownershipMarker -or
      [string]$user.SID.Value -cne $sid) {
    throw 'uncaptured profile lacks authenticated marker and SID authority'
  }
  $promoted = @()
  foreach ($profile in $profiles) {
    if ([string]$profile.SID -cne $sid) {
      throw 'profile SID changed during ownership promotion'
    }
    $canonicalLocalPath = Resolve-ValidatedOwnedProfilePath `
      ([string]$profile.LocalPath) $name
    if (@($promoted | Where-Object {
        Test-SamePath ([string]$_.LocalPath) $canonicalLocalPath
      }).Count -ne 0) {
      throw 'profile ownership promotion is ambiguous'
    }
    $promoted += [ordered]@{
      Sid = $sid
      LocalPath = $canonicalLocalPath
      Owned = $true
    }
  }
  $Manifest.Profiles = @($Manifest.Profiles) + @($promoted)
  return $true
}

function Remove-OwnedProfiles($UserRecord, $ProfileRecords) {
  if (!$UserRecord.Owned) { return }
  $name = [string]$UserRecord.Name
  if ($name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
    throw 'owned local-user identity is invalid'
  }
  $sid = [string]$UserRecord.Sid
  if ($sid -notmatch '^S-\d+(?:-\d+)+$') {
    if ($UserRecord.Provisional -and
        $null -eq (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) { return }
    throw 'owned user SID was not durably resolved'
  }
  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
      $_.SID -ceq $sid
    })
    if ($profiles.Count -eq 0) { return }
    try {
      foreach ($profile in $profiles) {
        if ([string]$profile.SID -cne $sid) {
          throw 'profile lacks exact durable SID and path ownership'
        }
        $canonicalLocalPath = Resolve-ValidatedOwnedProfilePath `
          ([string]$profile.LocalPath) $name
        $matchingRecords = @()
        foreach ($record in @($ProfileRecords | Where-Object {
            $_.Owned -and [string]$_.Sid -ceq $sid
          })) {
          $canonicalRecordPath = Resolve-ValidatedOwnedProfilePath `
            ([string]$record.LocalPath) $name
          if (Test-SamePath $canonicalRecordPath $canonicalLocalPath) {
            $matchingRecords += $record
          }
        }
        if ($matchingRecords.Count -ne 1) {
          throw 'profile lacks exact durable SID and path ownership'
        }
        # Re-resolve the live path and its one durable record at the deletion
        # boundary so a changed root, ancestor, depth, leaf, SID, or path fails closed.
        $canonicalLocalPath = Resolve-ValidatedOwnedProfilePath `
          ([string]$profile.LocalPath) $name
        $canonicalRecordPath = Resolve-ValidatedOwnedProfilePath `
          ([string]$matchingRecords[0].LocalPath) $name
        if ([string]$profile.SID -cne $sid -or
            !(Test-SamePath $canonicalRecordPath $canonicalLocalPath)) {
          throw 'profile ownership changed immediately before deletion'
        }
        Remove-CimInstance -InputObject $profile -ErrorAction Stop
      }
    } catch {
      if ($attempt -eq 9) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
  throw 'owned profile cleanup did not complete'
}

function Remove-ExplicitOwnedProfile($Record, $UserRecord) {
  if (!$Record.Owned) { return }
  $sid = [string]$Record.Sid
  $localPath = [string]$Record.LocalPath
  $name = [string]$UserRecord.Name
  if (!$UserRecord.Owned -or [string]$UserRecord.Sid -cne $sid -or
      $sid -notmatch '^S-\d+(?:-\d+)+$' -or ![IO.Path]::IsPathRooted($localPath)) {
    throw 'profile cleanup identity is invalid'
  }
  $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
    $_.SID -ceq $sid
  })
  foreach ($profile in $profiles) {
    $canonicalRecordPath = Resolve-ValidatedOwnedProfilePath $localPath $name
    $canonicalCurrentPath = Resolve-ValidatedOwnedProfilePath `
      ([string]$profile.LocalPath) $name
    if ($profile.SID -cne $sid -or
        !(Test-SamePath $canonicalCurrentPath $canonicalRecordPath)) {
      throw 'profile path ownership changed'
    }
    $canonicalRecordPath = Resolve-ValidatedOwnedProfilePath $localPath $name
    $canonicalCurrentPath = Resolve-ValidatedOwnedProfilePath `
      ([string]$profile.LocalPath) $name
    if ($profile.SID -cne $sid -or
        !(Test-SamePath $canonicalCurrentPath $canonicalRecordPath)) {
      throw 'profile ownership changed immediately before deletion'
    }
    Remove-CimInstance -InputObject $profile -ErrorAction Stop
  }
}

function Remove-OwnedUser($Record) {
  if (!$Record.Owned) { return }
  $name = [string]$Record.Name
  $sid = [string]$Record.Sid
  if ($name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
    throw 'owned local-user identity is invalid'
  }
  $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $user) { return }
  $ownershipMarker = [string]$Record.OwnershipMarker
  if ($ownershipMarker -notmatch '^prpr-own-[a-f0-9]{32}$' -or
      [string]$user.Description -cne $ownershipMarker) {
    throw 'local-user ownership marker does not match'
  }
  if ($sid -notmatch '^S-\d+(?:-\d+)+$') {
    throw 'owned local-user SID was not durably resolved'
  }
  if ($user.SID.Value -cne $sid) { throw 'local-user SID ownership changed' }
  Remove-LocalUser -Name $name -ErrorAction Stop
  if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) {
    throw 'owned local-user cleanup did not complete'
  }
}

try {
  $cleanupValidationPhase = 'FILE_AUTHORITY'
  $manifestPath = [IO.Path]::GetFullPath($OwnershipManifest)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ((Split-Path -Leaf $manifestPath) -notmatch
        '^propr-installed-app-ownership-[a-f0-9]{32}\.json$' -or
      !(Test-SamePath (Split-Path -Parent $manifestPath) $tempRoot)) {
    throw 'ownership manifest path is invalid'
  }
  # Durable manifests are replaced atomically. Read from one authenticated
  # ordinary-file handle while permitting that protocol's delete sharing, then
  # prove the pathname still names the same entry before trusting the bytes.
  $manifestStream = [IO.FileStream]::new(
    $manifestPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]'ReadWrite, Delete',
    4096,
    [IO.FileOptions]::SequentialScan
  )
  try {
    if ($manifestStream.Length -le 0 -or $manifestStream.Length -gt 65536) {
      throw 'ownership manifest metadata is invalid'
    }
    $manifestEntryIdentity = [ProPRDirectoryIdentity]::ReadHandle(
      $manifestStream.SafeFileHandle,
      $false
    )
    $manifestBytes = [byte[]]::new([int]$manifestStream.Length)
    $manifestOffset = 0
    while ($manifestOffset -lt $manifestBytes.Length) {
      $read = $manifestStream.Read(
        $manifestBytes,
        $manifestOffset,
        $manifestBytes.Length - $manifestOffset
      )
      if ($read -eq 0) { throw 'ownership manifest read was incomplete' }
      $manifestOffset += $read
    }
    if ($manifestStream.ReadByte() -ne -1) { throw 'ownership manifest changed during read' }
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $manifestItem.Length -ne $manifestBytes.Length -or
        [ProPRDirectoryIdentity]::ReadEntry($manifestPath, $false) -cne
          $manifestEntryIdentity) {
      throw 'ownership manifest entry changed during read'
    }
  } finally {
    $manifestStream.Dispose()
  }
  $cleanupValidationPhase = 'UTF8_DECODE'
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $manifestJson = $strictUtf8.GetString($manifestBytes)

  $cleanupValidationPhase = 'JSON_PARSE'
  $manifest = ConvertFrom-Json -InputObject $manifestJson -ErrorAction Stop

  $cleanupValidationPhase = 'EXACT_KEY_SET'
  $manifestKeys = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
  $expectedManifestKeys = @(
    'SchemaVersion','ManifestType','State','RunId','CreatedUtcTicks','ExpiresUtcTicks',
    'InstallerPath','InstallerEntryIdentity','InstallerSha256','InstallerProductCode','Fixture',
    'FixtureRoot','BaselineClean','InstallAttempted','MsiTransactionState',
    'Directories','Files','RegistryKeys',
    'RegistryValues','Users','Profiles'
  )
  if ($manifestKeys.Count -ne $expectedManifestKeys.Count -or
      @($expectedManifestKeys | Where-Object {
        $manifestKeys -cnotcontains $_
      }).Count -ne 0) {
    throw 'ownership manifest key set is invalid'
  }

  $cleanupValidationPhase = 'BOOLEAN_TYPES'
  # Windows PowerShell 5.1 can retain an incidental PSObject wrapper around a
  # JSON primitive. Inspect the explicit base object while still rejecting
  # strings, numbers, and every other truthy value.
  if ($null -eq $manifest.Fixture -or
      $manifest.Fixture.PSObject.BaseObject.GetType() -ne [bool] -or
      $null -eq $manifest.BaselineClean -or
      $manifest.BaselineClean.PSObject.BaseObject.GetType() -ne [bool] -or
      $null -eq $manifest.InstallAttempted -or
      $manifest.InstallAttempted.PSObject.BaseObject.GetType() -ne [bool]) {
    throw 'ownership manifest Boolean types are invalid'
  }

  $cleanupValidationPhase = 'TRANSACTION_ENUM'
  if ([string]$manifest.MsiTransactionState -cnotin @(
      'NONE','PENDING','COMMITTED','ROLLED_BACK_CLEAN'
    )) {
    throw 'ownership manifest transaction enum is invalid'
  }

  $cleanupValidationPhase = 'SCHEMA_TYPE_STATE'
  if (
      $manifest.SchemaVersion -ne 3 -or
      [string]$manifest.ManifestType -cne 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -or
      [string]$manifest.State -cnotin @('ACTIVE','EMPTY')) {
    throw 'ownership manifest schema version, type, or state is invalid'
  }

  $cleanupValidationPhase = 'IDENTIFIER_FORMATS'
  if ([string]$manifest.RunId -cnotmatch '^[a-f0-9]{32}$' -or
      [string]$manifest.InstallerEntryIdentity -cnotmatch '^[a-f0-9]{24}$' -or
      [string]$manifest.InstallerSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      [string]$manifest.InstallerProductCode -cnotmatch
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$') {
    throw 'ownership manifest durable identifier formats are invalid'
  }
  if (!$manifest.Fixture -and (
      ([string]$manifest.MsiTransactionState -ceq 'NONE' -and
        [bool]$manifest.InstallAttempted) -or
      ([string]$manifest.MsiTransactionState -in @(
          'PENDING','COMMITTED','ROLLED_BACK_CLEAN'
        ) -and (!([bool]$manifest.BaselineClean) -or
          !([bool]$manifest.InstallAttempted))))) {
    throw 'MSI transaction receipt state is inconsistent'
  }
  $cleanupValidationPhase = 'RUN_ID'
  $authorizedRunId = [string]$manifest.RunId
  $pathRunId = [IO.Path]::GetFileNameWithoutExtension($manifestPath).Substring(
    'propr-installed-app-ownership-'.Length)
  if ($authorizedRunId -cne $pathRunId -or $authorizedRunId -cne $ExpectedRunId) {
    throw 'ownership manifest run identity is invalid'
  }
  $cleanupValidationPhase = 'LIFETIME'
  $createdUtcTicks = [int64]$manifest.CreatedUtcTicks
  $expiresUtcTicks = [int64]$manifest.ExpiresUtcTicks
  $nowUtcTicks = [DateTime]::UtcNow.Ticks
  if ($createdUtcTicks -le 0 -or $expiresUtcTicks -le $createdUtcTicks -or
      $expiresUtcTicks - $createdUtcTicks -gt ([TimeSpan]::TicksPerHour * 3) -or
      $createdUtcTicks -gt $nowUtcTicks + ([TimeSpan]::TicksPerMinute * 5) -or
      $expiresUtcTicks -lt $nowUtcTicks) {
    throw 'ownership manifest lifetime is invalid'
  }
  $cleanupValidationPhase = 'INSTALLER_PATH'
  $resolvedInstaller = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
  if (!(Test-SamePath ([string]$manifest.InstallerPath) $resolvedInstaller)) {
    throw 'ownership manifest installer identity is invalid'
  }
  $cleanupValidationPhase = 'FIXTURE_SCOPE'
  if ($FixtureRoot) {
    $FixtureRoot = (Resolve-Path -LiteralPath $FixtureRoot -ErrorAction Stop).Path
    if (!$manifest.Fixture -or !(Test-SamePath ([string]$manifest.FixtureRoot) $FixtureRoot)) {
      throw 'ownership manifest fixture scope is invalid'
    }
  } elseif ($manifest.Fixture) {
    throw 'fixture ownership manifest was not authorized'
  }

  # A worker that is terminated before its first marker cannot promote any
  # resource authority. Accept only the exact supervisor-created fixture state:
  # authenticated schema-v3 ACTIVE authority, no baseline or install attempt,
  # transaction NONE, and no resource records. Revalidate the durable installer
  # authority before atomically converting it to the ordinary EMPTY receipt.
  $cleanupValidationPhase = 'INITIAL_ACTIVE_MATCH'
  $initialActiveFixtureManifest = $manifest.Fixture -and
    [string]$manifest.State -ceq 'ACTIVE' -and
    !$manifest.BaselineClean -and !$manifest.InstallAttempted -and
    [string]$manifest.MsiTransactionState -ceq 'NONE' -and
    @($manifest.Directories).Count -eq 0 -and @($manifest.Files).Count -eq 0 -and
    @($manifest.RegistryKeys).Count -eq 0 -and
    @($manifest.RegistryValues).Count -eq 0 -and @($manifest.Users).Count -eq 0 -and
    @($manifest.Profiles).Count -eq 0
  if ($FixtureValidationDiagnostic -and !$initialActiveFixtureManifest) {
    throw 'initial fixture ownership authority does not match'
  }
  if ($initialActiveFixtureManifest) {
    $manifestValidated = $true
    Assert-InstallerArtifactAuthority $manifest
    Write-EmptyOwnershipReceipt $manifestPath $manifest
    exit 0
  }

  if ([string]$manifest.State -ceq 'EMPTY') {
    if ($manifest.BaselineClean -or $manifest.InstallAttempted -or
        [string]$manifest.MsiTransactionState -cne 'NONE' -or
        @($manifest.Directories).Count -ne 0 -or @($manifest.Files).Count -ne 0 -or
        @($manifest.RegistryKeys).Count -ne 0 -or @($manifest.RegistryValues).Count -ne 0 -or
        @($manifest.Users).Count -ne 0 -or @($manifest.Profiles).Count -ne 0) {
      throw 'empty ownership receipt is invalid'
    }
    $manifestValidated = $true
    exit 0
  }

  foreach ($record in @($manifest.Directories)) {
    if ($record.Owned -and
        !(Test-AllowedFileSystemPath ([string]$record.Kind) ([string]$record.Path))) {
      throw 'directory manifest scope is invalid'
    }
    if ($record.Owned -and [string]$record.Kind -ceq 'SMOKE_DATA') {
      [void](Resolve-SmokeDirectoryAuthority $record $manifest $manifestPath)
    }
  }
  foreach ($record in @($manifest.Files)) {
    if ($record.Owned -and
        !(Test-AllowedFileSystemPath ([string]$record.Kind) ([string]$record.Path))) {
      throw 'file manifest scope is invalid'
    }
    if ($record.Owned -and !$record.Provisional -and
        ([string]$record.Identity -notmatch '^[a-f0-9]{64}$' -or
          [string]$record.EntryIdentity -notmatch '^[a-f0-9]{24}$')) {
      throw 'file manifest durable identity is invalid'
    }
  }
  foreach ($record in @($manifest.Users)) {
    if ($record.Owned -and ($record.Owned -isnot [bool] -or
        $record.Provisional -isnot [bool])) {
      throw 'user manifest ownership state is invalid'
    }
    if ($record.Owned -and [string]$record.Name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
      throw 'user manifest identity is invalid'
    }
    if ($record.Owned -and !$record.Provisional -and
        [string]$record.Sid -notmatch '^S-\d+(?:-\d+)+$') {
      throw 'user manifest SID is invalid'
    }
    if ($record.Owned -and
        [string]$record.OwnershipMarker -notmatch
          '^prpr-own-[a-f0-9]{32}$') {
      throw 'user manifest ownership marker is invalid'
    }
  }
  foreach ($record in @($manifest.Profiles)) {
    if ($record.Owned -and ([string]$record.Sid -notmatch '^S-\d+(?:-\d+)+$' -or
        ![IO.Path]::IsPathRooted([string]$record.LocalPath))) {
      throw 'profile manifest identity is invalid'
    }
  }

  $allowAuthenticatedMsiUninstall = !$manifest.Fixture -and
    [bool]$manifest.BaselineClean -and [bool]$manifest.InstallAttempted -and
    [string]$manifest.MsiTransactionState -ceq 'COMMITTED'
  foreach ($record in @($manifest.RegistryKeys)) {
    if (!$record.Owned) { continue }
    $path = [string]$record.Path
    $kind = [string]$record.Kind
    if ($FixtureRoot) {
      $expectedPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$authorizedRunId\owned"
      if (![string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'registry manifest scope is invalid'
      }
      if (!(Test-Path -LiteralPath $path)) { continue }
      if ([string](Get-ItemPropertyValue -LiteralPath $path -Name $ownerRegistryValue `
          -ErrorAction Stop) -cne [string]$record.Token) {
        throw 'registry manifest token is invalid'
      }
    } else {
      $expectedPath = if ($kind -eq 'PROTOCOL') {
        'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
      } elseif ($kind -eq 'APP_PATH') {
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
      } else { $null }
      if (!$expectedPath -or
          ![string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'registry manifest scope is invalid'
      }
      if (!(Test-Path -LiteralPath $path)) { continue }
      if ([bool]$record.Provisional -or
          [string]$record.Identity -notmatch '^[a-f0-9]{64}$' -or
          (Get-RegistryTreeIdentity $path) -cne [string]$record.Identity) {
        throw 'registry manifest ownership identity is invalid'
      }
    }
  }
  foreach ($record in @($manifest.RegistryValues)) {
    $recordKeys = @($record.PSObject.Properties | ForEach-Object { $_.Name })
    $expectedRecordKeys = @(
      'Kind','Path','Name','Owned','Provisional','BaselineKeyExisted',
      'BaselineValueExisted','BaselineValueKind','BaselineValueData',
      'IdentityValueKind','IdentityValueData','KeyCreatedByRun'
    )
    if ($recordKeys.Count -ne $expectedRecordKeys.Count -or
        @($expectedRecordKeys | Where-Object { $recordKeys -cnotcontains $_ }).Count -ne 0 -or
        $record.Owned -isnot [bool] -or $record.Provisional -isnot [bool] -or
        $record.BaselineKeyExisted -isnot [bool] -or
        $record.BaselineValueExisted -isnot [bool] -or
        $record.KeyCreatedByRun -isnot [bool] -or
        [string]$record.Kind -cne 'HKCU_INSTALLED' -or
        ![string]::Equals(
          [string]$record.Path,
          'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop',
          [StringComparison]::OrdinalIgnoreCase
        ) -or [string]$record.Name -cne 'installed' -or
        ([bool]$record.KeyCreatedByRun -and [bool]$record.BaselineKeyExisted)) {
      throw 'registry value manifest scope is invalid'
    }
    if ([bool]$record.BaselineValueExisted) {
      if (![bool]$record.BaselineKeyExisted -or
          [string]$record.BaselineValueKind -notin @(
            'DWord','QWord','String','ExpandString','MultiString','Binary','None'
          ) -or [string]$record.BaselineValueData -notmatch '^[A-Za-z0-9+/]*={0,2}$') {
        throw 'registry value baseline is invalid'
      }
      try {
        $baselineBytes = [Convert]::FromBase64String([string]$record.BaselineValueData)
        if (([string]$record.BaselineValueKind -ceq 'DWord' -and
              $baselineBytes.Length -ne 4) -or
            ([string]$record.BaselineValueKind -ceq 'QWord' -and
              $baselineBytes.Length -ne 8)) {
          throw 'invalid baseline width'
        }
        if ([string]$record.BaselineValueKind -in @('String','ExpandString')) {
          [void]([Text.UTF8Encoding]::new($false, $true).GetString($baselineBytes))
        } elseif ([string]$record.BaselineValueKind -ceq 'MultiString') {
          $multiStringJson = [Text.UTF8Encoding]::new($false, $true).GetString($baselineBytes)
          $multiStringValue = ConvertFrom-Json -InputObject $multiStringJson `
            -NoEnumerate -ErrorAction Stop
          if ($multiStringValue -isnot [array] -or
              @($multiStringValue | Where-Object { $_ -isnot [string] }).Count -ne 0) {
            throw 'invalid multi-string baseline'
          }
        }
      } catch {
        throw 'registry value baseline is invalid'
      }
    } elseif ($null -ne $record.BaselineValueKind -or
        $null -ne $record.BaselineValueData) {
      throw 'registry value empty baseline is invalid'
    }
    if ($record.Owned -and !$record.Provisional) {
      if ([string]$record.IdentityValueKind -notin @(
          'DWord','QWord','String','ExpandString','MultiString','Binary','None'
        ) -or [string]$record.IdentityValueData -notmatch '^[A-Za-z0-9+/]*={0,2}$') {
        throw 'registry value ownership identity is invalid'
      }
    } elseif ($null -ne $record.IdentityValueKind -or $null -ne $record.IdentityValueData) {
      throw 'provisional registry value identity is invalid'
    }
  }
  if (@($manifest.RegistryValues).Count -gt 1 -or
      (!$manifest.Fixture -and $manifest.InstallAttempted -and
        @($manifest.RegistryValues).Count -ne 1) -or
      ($manifest.Fixture -and @($manifest.RegistryValues).Count -ne 0)) {
    throw 'registry value manifest cardinality is invalid'
  }
  if (!$manifest.Fixture -and
      [string]$manifest.MsiTransactionState -ceq 'COMMITTED') {
    $ownedDirectoryKinds = @($manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -in @('INSTALL_ROOT','SHORTCUT_FOLDER')
    } | ForEach-Object { [string]$_.Kind })
    $ownedFileKinds = @($manifest.Files | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FILE'
    } | ForEach-Object { [string]$_.Kind })
    $ownedRegistryKinds = @($manifest.RegistryKeys | Where-Object {
      $_.Owned -and [string]$_.Kind -in @('PROTOCOL','APP_PATH')
    } | ForEach-Object { [string]$_.Kind })
    if ($ownedDirectoryKinds.Count -ne 2 -or
        @($ownedDirectoryKinds | Where-Object {
          $_ -notin @('INSTALL_ROOT','SHORTCUT_FOLDER')
        }).Count -ne 0 -or
        @($ownedDirectoryKinds | Select-Object -Unique).Count -ne 2 -or
        $ownedFileKinds.Count -ne 1 -or $ownedFileKinds[0] -cne 'SHORTCUT_FILE' -or
        $ownedRegistryKinds.Count -ne 2 -or
        @($ownedRegistryKinds | Where-Object {
          $_ -notin @('PROTOCOL','APP_PATH')
        }).Count -ne 0 -or
        @($ownedRegistryKinds | Select-Object -Unique).Count -ne 2 -or
        @($manifest.Directories | Where-Object { $_.Owned -and $_.Provisional }).Count -ne 0 -or
        @($manifest.Files | Where-Object { $_.Owned -and $_.Provisional }).Count -ne 0 -or
        @($manifest.RegistryKeys | Where-Object { $_.Owned -and $_.Provisional }).Count -ne 0 -or
        @($manifest.RegistryValues | Where-Object {
          !$_.Owned -or $_.Provisional
        }).Count -ne 0) {
      throw 'committed MSI transaction receipt is incomplete or provisional'
    }
  }
  $manifestValidated = $true
  # ACTIVE authority is inseparable from the exact installer entry captured by
  # the supervisor. A same-path replacement blocks every cleanup mutation,
  # including fixture/manual fallbacks that do not otherwise need Windows Installer.
  Assert-InstallerArtifactAuthority $manifest
  if (!$manifest.Fixture) {
    if ([string]$manifest.MsiTransactionState -ceq 'PENDING') {
      throw 'MSI transaction has no durable cleanup authority receipt'
    }
    if ([string]$manifest.MsiTransactionState -ceq 'NONE' -and
        [bool]$manifest.InstallAttempted) {
      throw 'MSI install attempt has no transaction receipt'
    }
    if ([string]$manifest.MsiTransactionState -ceq 'ROLLED_BACK_CLEAN') {
      Assert-MsiRolledBackCleanBaseline $manifest
    }
  }
  $ownershipPromoted = $false
  foreach ($record in @($manifest.Users)) {
    if (Resolve-ProvisionalOwnedUser $record) { $ownershipPromoted = $true }
    if (Promote-UncapturedOwnedProfiles $record $manifest) {
      $ownershipPromoted = $true
    }
  }
  if ($ownershipPromoted) {
    Write-DurableOwnershipManifest $manifestPath $manifest
  }
  foreach ($record in @($manifest.RegistryValues)) {
    if (!$record.Owned) { continue }
    $current = Get-RegistryValueSnapshot ([string]$record.Path) ([string]$record.Name)
    $matchesBaseline = [bool]$record.BaselineValueExisted -and $current.Exists -and
      $current.Kind -ceq [string]$record.BaselineValueKind -and
      $current.Data -ceq [string]$record.BaselineValueData
    if (!$matchesBaseline -and $current.Exists -and
        (([bool]$record.Provisional -and
            !(Test-MsiInstalledValue ([string]$record.Path) ([string]$record.Name))) -or
          (![bool]$record.Provisional -and !(Test-RegistryValueIdentity $record $current)))) {
      $cleanupFailed = $true
    }
  }
  if ([string]$manifest.MsiTransactionState -ceq 'COMMITTED') {
    Assert-MsiManagedFileSystemAuthority $manifest
  }
  if ($allowAuthenticatedMsiUninstall -and !$cleanupFailed) {
    $msiExitCode = 1618
    for ($attempt = 0; $attempt -lt 12 -and $msiExitCode -eq 1618; $attempt += 1) {
      if ($attempt -ne 0) { Start-Sleep -Seconds 2 }
      Assert-MsiManagedFileSystemAuthority $manifest
      Assert-InstallerArtifactAuthority $manifest
      $msi = Start-Process msiexec.exe -ArgumentList @(
        '/x', [string]$manifest.InstallerProductCode, '/qn', '/norestart'
      ) -PassThru -WindowStyle Hidden -ErrorAction Stop
      try {
        [void]$msi.WaitForExit()
        $msiExitCode = $msi.ExitCode
      } finally {
        $msi.Dispose()
      }
    }
    if ($msiExitCode -notin @(0, 1605, 1614, 1641, 3010)) { $cleanupFailed = $true }
  }

  foreach ($record in @($manifest.Files)) {
    try { Remove-OwnedFile $record } catch { $cleanupFailed = $true }
  }
  foreach ($record in @($manifest.RegistryKeys)) {
    try { Remove-OwnedRegistryKey $record } catch { $cleanupFailed = $true }
  }
  foreach ($record in @($manifest.RegistryValues)) {
    try { Restore-OwnedRegistryValue $record } catch { $cleanupFailed = $true }
  }
  $profileCleanupFailed = $false
  foreach ($record in @($manifest.Profiles)) {
    try {
      $profileOwners = @($manifest.Users | Where-Object {
        $_.Owned -and [string]$_.Sid -ceq [string]$record.Sid
      })
      if ($record.Owned -and $profileOwners.Count -ne 1) {
        throw 'profile durable owner identity is ambiguous'
      }
      if ($record.Owned) { Remove-ExplicitOwnedProfile $record $profileOwners[0] }
    } catch {
      $profileCleanupFailed = $true
      $cleanupFailed = $true
    }
  }
  foreach ($record in @($manifest.Users)) {
    try { Remove-OwnedProfiles $record $manifest.Profiles } catch {
      $profileCleanupFailed = $true
      $cleanupFailed = $true
    }
  }
  if (!$profileCleanupFailed) {
    foreach ($record in @($manifest.Users)) {
      try { Remove-OwnedUser $record } catch { $cleanupFailed = $true }
    }
  }
  $directories = @($manifest.Directories) | Sort-Object {
    ([string]$_.Path).Length
  } -Descending
  foreach ($record in $directories) {
    try { Remove-OwnedDirectory $record } catch {
      $cleanupFailed = $true
    }
  }
  if (!$cleanupFailed) { Write-EmptyOwnershipReceipt $manifestPath $manifest }
} catch {
  $cleanupFailed = $true
}

if ($cleanupFailed) {
  if ($manifestValidated) { exit 21 }
  Write-FixtureCleanupValidationPhase $cleanupValidationPhase
  exit 20
}
exit 0
