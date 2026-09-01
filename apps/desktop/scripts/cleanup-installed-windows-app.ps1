param(
  [Parameter(Mandatory=$true)][string]$OwnershipManifest,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedRunId,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ownerFileName = '.propr-installed-app-owner'
$ownerRegistryValue = 'ProPRInstalledAppOwner'
$cleanupFailed = $false
$manifestValidated = $false
$authorizedRunId = $null

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

    public static string Read(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 0x7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "directory identity open failed");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "directory identity read failed");
            return string.Format("{0:x8}{1:x8}{2:x8}", information.VolumeSerialNumber,
                information.FileIndexHigh, information.FileIndexLow);
        }
    }
}
'@

try {
  if ($ExpectedRunId -notmatch '^[a-f0-9]{32}$') { exit 1 }
  if ($OwnershipReadyEvent -notmatch '^Local\\ProPRInstalledAppCleanup-[a-f0-9]{32}$') {
    exit 1
  }
  $ownershipReady = [Threading.EventWaitHandle]::OpenExisting($OwnershipReadyEvent)
  try {
    if (!$ownershipReady.WaitOne(5000)) { exit 1 }
  } finally {
    $ownershipReady.Dispose()
  }
} catch {
  exit 1
}

function Test-SamePath([string]$Left, [string]$Right) {
  return [string]::Equals(
    [IO.Path]::GetFullPath($Left).TrimEnd('\'),
    [IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )
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

function Test-ProvisionalRegistryIdentity([string]$Kind, [string]$Path, [string]$Application) {
  if ($Kind -eq 'APP_PATH') {
    $key = Get-Item -LiteralPath $Path -ErrorAction Stop
    return @($key.GetSubKeyNames()).Count -eq 0 -and
      @($key.GetValueNames()).Count -eq 1 -and
      @($key.GetValueNames())[0] -ceq '' -and
      [string]$key.GetValue('') -ceq $Application
  }
  if ($Kind -ne 'PROTOCOL') { return $false }
  $root = Get-Item -LiteralPath $Path -ErrorAction Stop
  $shell = Get-Item -LiteralPath "$Path\shell" -ErrorAction Stop
  $open = Get-Item -LiteralPath "$Path\shell\open" -ErrorAction Stop
  $command = Get-Item -LiteralPath "$Path\shell\open\command" -ErrorAction Stop
  return @($root.GetSubKeyNames()).Count -eq 1 -and $root.GetSubKeyNames()[0] -ceq 'shell' -and
    (@($root.GetValueNames() | Sort-Object -CaseSensitive) -join '|') -ceq '|URL Protocol' -and
    [string]$root.GetValue('') -ceq 'URL:ProPR Protocol' -and
    [string]$root.GetValue('URL Protocol') -ceq '' -and
    @($shell.GetSubKeyNames()).Count -eq 1 -and $shell.GetSubKeyNames()[0] -ceq 'open' -and
    @($shell.GetValueNames()).Count -eq 0 -and
    @($open.GetSubKeyNames()).Count -eq 1 -and $open.GetSubKeyNames()[0] -ceq 'command' -and
    @($open.GetValueNames()).Count -eq 0 -and @($command.GetSubKeyNames()).Count -eq 0 -and
    @($command.GetValueNames()).Count -eq 1 -and $command.GetValueNames()[0] -ceq '' -and
    [string]$command.GetValue('') -ceq "`"$Application`" `"%1`""
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

function Remove-OwnedDirectory($Record) {
  if (!$Record.Owned) { return }
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
    throw 'owned file identity does not match'
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
  [IO.File]::Move($temporaryPath, $Path, $true)
}

function Write-EmptyOwnershipReceipt([string]$Path, $Manifest) {
  $Manifest.State = 'EMPTY'
  $Manifest.BaselineClean = $false
  $Manifest.InstallAttempted = $false
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

function Remove-OwnedProfiles($UserRecord) {
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
        if ($profile.SID -cne $sid) { throw 'profile SID ownership changed' }
        Remove-CimInstance -InputObject $profile -ErrorAction Stop
      }
    } catch {
      if ($attempt -eq 9) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
  throw 'owned profile cleanup did not complete'
}

function Remove-ExplicitOwnedProfile($Record) {
  if (!$Record.Owned) { return }
  $sid = [string]$Record.Sid
  $localPath = [string]$Record.LocalPath
  if ($sid -notmatch '^S-\d+(?:-\d+)+$' -or ![IO.Path]::IsPathRooted($localPath)) {
    throw 'profile cleanup identity is invalid'
  }
  $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
    $_.SID -ceq $sid
  })
  foreach ($profile in $profiles) {
    if ($profile.SID -cne $sid -or !(Test-SamePath ([string]$profile.LocalPath) $localPath)) {
      throw 'profile path ownership changed'
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
  $manifestPath = [IO.Path]::GetFullPath($OwnershipManifest)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ((Split-Path -Leaf $manifestPath) -notmatch
        '^propr-installed-app-ownership-[a-f0-9]{32}\.json$' -or
      !(Test-SamePath (Split-Path -Parent $manifestPath) $tempRoot)) {
    throw 'ownership manifest path is invalid'
  }
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
  if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $manifestItem.Length -le 0 -or $manifestItem.Length -gt 65536) {
    throw 'ownership manifest metadata is invalid'
  }
  $manifestBytes = [byte[]]::new([int]$manifestItem.Length)
  $manifestStream = [IO.File]::Open(
    $manifestPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
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
  } finally {
    $manifestStream.Dispose()
  }
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $manifest = ConvertFrom-Json -InputObject $strictUtf8.GetString($manifestBytes) -ErrorAction Stop
  $manifestKeys = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
  $expectedManifestKeys = @(
    'SchemaVersion','ManifestType','State','RunId','CreatedUtcTicks','ExpiresUtcTicks',
    'InstallerPath','Fixture',
    'FixtureRoot','BaselineClean','InstallAttempted','Directories','Files','RegistryKeys',
    'RegistryValues','Users','Profiles'
  )
  if ($manifestKeys.Count -ne $expectedManifestKeys.Count -or
      @($expectedManifestKeys | Where-Object { $manifestKeys -cnotcontains $_ }).Count -ne 0 -or
      $manifest.Fixture -isnot [bool] -or $manifest.BaselineClean -isnot [bool] -or
      $manifest.InstallAttempted -isnot [bool] -or
      $manifest.SchemaVersion -ne 2 -or
      [string]$manifest.ManifestType -cne 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -or
      [string]$manifest.State -notin @('ACTIVE','EMPTY') -or
      [string]$manifest.RunId -notmatch '^[a-f0-9]{32}$') {
    throw 'ownership manifest schema is invalid'
  }
  $authorizedRunId = [string]$manifest.RunId
  $pathRunId = [IO.Path]::GetFileNameWithoutExtension($manifestPath).Substring(
    'propr-installed-app-ownership-'.Length)
  if ($authorizedRunId -cne $pathRunId -or $authorizedRunId -cne $ExpectedRunId) {
    throw 'ownership manifest run identity is invalid'
  }
  $createdUtcTicks = [int64]$manifest.CreatedUtcTicks
  $expiresUtcTicks = [int64]$manifest.ExpiresUtcTicks
  $nowUtcTicks = [DateTime]::UtcNow.Ticks
  if ($createdUtcTicks -le 0 -or $expiresUtcTicks -le $createdUtcTicks -or
      $expiresUtcTicks - $createdUtcTicks -gt ([TimeSpan]::TicksPerHour * 3) -or
      $createdUtcTicks -gt $nowUtcTicks + ([TimeSpan]::TicksPerMinute * 5) -or
      $expiresUtcTicks -lt $nowUtcTicks) {
    throw 'ownership manifest lifetime is invalid'
  }
  $resolvedInstaller = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
  if (!(Test-SamePath ([string]$manifest.InstallerPath) $resolvedInstaller)) {
    throw 'ownership manifest installer identity is invalid'
  }
  if ($FixtureRoot) {
    $FixtureRoot = (Resolve-Path -LiteralPath $FixtureRoot -ErrorAction Stop).Path
    if (!$manifest.Fixture -or !(Test-SamePath ([string]$manifest.FixtureRoot) $FixtureRoot)) {
      throw 'ownership manifest fixture scope is invalid'
    }
  } elseif ($manifest.Fixture) {
    throw 'fixture ownership manifest was not authorized'
  }

  if ([string]$manifest.State -ceq 'EMPTY') {
    if ($manifest.BaselineClean -or $manifest.InstallAttempted -or
        @($manifest.Directories).Count -ne 0 -or @($manifest.Files).Count -ne 0 -or
        @($manifest.RegistryKeys).Count -ne 0 -or @($manifest.RegistryValues).Count -ne 0 -or
        @($manifest.Users).Count -ne 0 -or @($manifest.Profiles).Count -ne 0) {
      throw 'empty ownership receipt is invalid'
    }
    $manifestValidated = $true
    exit 0
  }

  $script:authorizedApplication = Join-Path $env:ProgramFiles 'ProPR Desktop\propr-desktop.exe'
  foreach ($record in @($manifest.Directories)) {
    if ($record.Owned -and
        !(Test-AllowedFileSystemPath ([string]$record.Kind) ([string]$record.Path))) {
      throw 'directory manifest scope is invalid'
    }
  }
  foreach ($record in @($manifest.Files)) {
    if ($record.Owned -and
        !(Test-AllowedFileSystemPath ([string]$record.Kind) ([string]$record.Path))) {
      throw 'file manifest scope is invalid'
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

  $allowProvisionalMsiUninstall = !$manifest.Fixture -and
    [bool]$manifest.BaselineClean -and [bool]$manifest.InstallAttempted
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
      if ($allowProvisionalMsiUninstall -and [bool]$record.Provisional) {
        if (!(Test-ProvisionalRegistryIdentity $kind $path $script:authorizedApplication)) {
          throw 'registry manifest provisional identity is invalid'
        }
      } elseif ([string]$record.Identity -notmatch '^[a-f0-9]{64}$' -or
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
  $manifestValidated = $true
  $adoptedProvisionalUser = $false
  foreach ($record in @($manifest.Users)) {
    if (Resolve-ProvisionalOwnedUser $record) { $adoptedProvisionalUser = $true }
  }
  if ($adoptedProvisionalUser) {
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
  if ($allowProvisionalMsiUninstall -and !$cleanupFailed) {
    $msiExitCode = 1618
    for ($attempt = 0; $attempt -lt 12 -and $msiExitCode -eq 1618; $attempt += 1) {
      if ($attempt -ne 0) { Start-Sleep -Seconds 2 }
      $msi = Start-Process msiexec.exe -ArgumentList @(
        '/x', "`"$resolvedInstaller`"", '/qn', '/norestart'
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
  foreach ($record in @($manifest.Profiles)) {
    try { Remove-ExplicitOwnedProfile $record } catch { $cleanupFailed = $true }
  }
  foreach ($record in @($manifest.Users)) {
    try { Remove-OwnedProfiles $record } catch { $cleanupFailed = $true }
  }
  foreach ($record in @($manifest.Users)) {
    try { Remove-OwnedUser $record } catch { $cleanupFailed = $true }
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
  exit 20
}
exit 0
