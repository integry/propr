param(
  [Parameter(Mandatory=$true)][string]$OwnershipManifest,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ownerFileName = '.propr-installed-app-owner'
$ownerRegistryValue = 'ProPRInstalledAppOwner'
$cleanupFailed = $false
$authorizedRunId = $null

try {
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

function Remove-OwnedDirectory($Record, [bool]$AllowProvisionalProductOwnership) {
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
  $provisional = [bool]$Record.Provisional -or
    ($AllowProvisionalProductOwnership -and $kind -in @('INSTALL_ROOT','SHORTCUT_FOLDER'))
  if (!$provisional -and !(Test-OwnerFile $path ([string]$Record.Token))) {
    throw 'owned directory token does not match'
  }
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) { throw 'owned directory cleanup did not complete' }
}

function Remove-OwnedFile($Record, [bool]$AllowProvisionalProductOwnership) {
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
  $provisional = $AllowProvisionalProductOwnership -and $kind -eq 'SHORTCUT_FILE'
  if (!$provisional -and !(Test-OwnerFile (Split-Path -Parent $path) ([string]$Record.Token))) {
    throw 'owned file token does not match'
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) { throw 'owned file cleanup did not complete' }
}

function Remove-OwnedRegistryKey($Record, [bool]$AllowProvisionalProductOwnership) {
  if (!$Record.Owned) { return }
  $path = [string]$Record.Path
  $productionPath = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
  if ($FixtureRoot) {
    $expectedPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$authorizedRunId\owned"
    if (![string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'registry cleanup scope is invalid'
    }
  } elseif (![string]::Equals($path, $productionPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'registry cleanup scope is invalid'
  }
  if (!(Test-Path -LiteralPath $path)) { return }
  $provisional = $AllowProvisionalProductOwnership -and
    [string]::Equals($path, $productionPath, [StringComparison]::OrdinalIgnoreCase)
  if (!$provisional) {
    $token = Get-ItemPropertyValue -LiteralPath $path -Name $ownerRegistryValue -ErrorAction Stop
    if ([string]$token -cne [string]$Record.Token) { throw 'owned registry token does not match' }
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

function Remove-OwnedProfiles($UserRecord) {
  if (!$UserRecord.Owned) { return }
  $name = [string]$UserRecord.Name
  if ($name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
    throw 'owned local-user identity is invalid'
  }
  $sid = [string]$UserRecord.Sid
  if ($sid -notmatch '^S-\d+(?:-\d+)+$') {
    if (!$UserRecord.Provisional) { throw 'owned user SID is invalid' }
    $provisionalUser = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $provisionalUser) { return }
    $sid = $provisionalUser.SID.Value
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
  if ($sid -notmatch '^S-\d+(?:-\d+)+$') {
    if (!$Record.Provisional) { throw 'owned local-user identity is invalid' }
    $sid = $user.SID.Value
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
  $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  if ($manifest.SchemaVersion -ne 1 -or
      [string]$manifest.RunId -notmatch '^[a-f0-9]{32}$') {
    throw 'ownership manifest schema is invalid'
  }
  $authorizedRunId = [string]$manifest.RunId
  $pathRunId = [IO.Path]::GetFileNameWithoutExtension($manifestPath).Substring(
    'propr-installed-app-ownership-'.Length)
  if ($authorizedRunId -cne $pathRunId) { throw 'ownership manifest run identity is invalid' }
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

  $allowProvisionalProductOwnership = !$manifest.Fixture -and
    [bool]$manifest.BaselineClean -and [bool]$manifest.InstallAttempted
  if ($allowProvisionalProductOwnership) {
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
    try { Remove-OwnedFile $record $allowProvisionalProductOwnership } catch { $cleanupFailed = $true }
  }
  foreach ($record in @($manifest.RegistryKeys)) {
    try { Remove-OwnedRegistryKey $record $allowProvisionalProductOwnership } catch { $cleanupFailed = $true }
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
    try { Remove-OwnedDirectory $record $allowProvisionalProductOwnership } catch {
      $cleanupFailed = $true
    }
  }
} catch {
  $cleanupFailed = $true
}

if ($cleanupFailed) { exit 1 }
exit 0
