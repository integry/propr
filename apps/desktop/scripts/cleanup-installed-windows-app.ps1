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
$authorizedRunId = $null

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
  $provisional = $AllowProvisionalProductOwnership -and [bool]$Record.Provisional
  if (!$provisional) {
    if ($FixtureRoot) {
      $token = Get-ItemPropertyValue -LiteralPath $path -Name $ownerRegistryValue -ErrorAction Stop
      if ([string]$token -cne [string]$Record.Token) { throw 'owned registry token does not match' }
    } elseif ([string]$Record.Identity -notmatch '^[a-f0-9]{64}$' -or
        (Get-RegistryTreeIdentity $path) -cne [string]$Record.Identity) {
      throw 'owned registry identity does not match'
    }
  } elseif (!(Test-ProvisionalRegistryIdentity $kind $path $script:authorizedApplication)) {
    throw 'provisional registry identity does not match'
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
    'SchemaVersion','RunId','CreatedUtcTicks','ExpiresUtcTicks','InstallerPath','Fixture',
    'FixtureRoot','BaselineClean','InstallAttempted','Directories','Files','RegistryKeys',
    'Users','Profiles'
  )
  if ($manifestKeys.Count -ne $expectedManifestKeys.Count -or
      @($expectedManifestKeys | Where-Object { $manifestKeys -cnotcontains $_ }).Count -ne 0 -or
      $manifest.Fixture -isnot [bool] -or $manifest.BaselineClean -isnot [bool] -or
      $manifest.InstallAttempted -isnot [bool] -or
      $manifest.SchemaVersion -ne 1 -or
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
    if ($record.Owned -and [string]$record.Name -notmatch '^(?:propr-ci-|prpr)[a-f0-9]{8}$') {
      throw 'user manifest identity is invalid'
    }
    if ($record.Owned -and !$record.Provisional -and
        [string]$record.Sid -notmatch '^S-\d+(?:-\d+)+$') {
      throw 'user manifest SID is invalid'
    }
  }
  foreach ($record in @($manifest.Profiles)) {
    if ($record.Owned -and ([string]$record.Sid -notmatch '^S-\d+(?:-\d+)+$' -or
        ![IO.Path]::IsPathRooted([string]$record.LocalPath))) {
      throw 'profile manifest identity is invalid'
    }
  }

  $allowProvisionalProductOwnership = !$manifest.Fixture -and
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
      if ($allowProvisionalProductOwnership -and [bool]$record.Provisional) {
        if (!(Test-ProvisionalRegistryIdentity $kind $path $script:authorizedApplication)) {
          throw 'registry manifest provisional identity is invalid'
        }
      } elseif ([string]$record.Identity -notmatch '^[a-f0-9]{64}$' -or
          (Get-RegistryTreeIdentity $path) -cne [string]$record.Identity) {
        throw 'registry manifest ownership identity is invalid'
      }
    }
  }
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
