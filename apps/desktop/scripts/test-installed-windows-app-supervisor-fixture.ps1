param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$WatchdogMarker,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [Parameter(Mandatory=$true)][string]$OwnershipManifest
)

$ErrorActionPreference = 'Stop'
$scenario = $env:PROPR_SUPERVISOR_FIXTURE_SCENARIO
$stateDirectory = $env:PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY
if ($scenario -notin @(
    'NO_MARKER',
    'VALID_THEN_DEADLINE',
    'MALFORMED_MARKER',
    'TORN_MARKER',
    'STALE_MARKER',
    'INACCESSIBLE_MARKER',
    'CANCELLATION',
    'OWNED_RESOURCES_NORMAL_SUCCESS',
    'OWNED_RESOURCES_FOR_INTERRUPTION',
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

function New-OwnedFixtureResources {
  $manifest = [IO.File]::ReadAllText($OwnershipManifest, [Text.Encoding]::UTF8) |
    ConvertFrom-Json -ErrorAction Stop
  if (!$manifest.Fixture -or $manifest.SchemaVersion -ne 2 -or
      $manifest.ManifestType -cne 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -or
      $manifest.State -cne 'ACTIVE') {
    throw 'fixture ownership manifest was not initialized'
  }
  $token = [Guid]::NewGuid().ToString('N')
  $ownedRoot = Join-Path $stateDirectory 'owned'
  $installRoot = Join-Path $ownedRoot 'install-tree'
  $shortcutFolder = Join-Path $ownedRoot 'shortcut-folder'
  $shortcut = Join-Path $shortcutFolder 'ProPR Desktop.lnk'
  $smokeDirectory = Join-Path $ownedRoot 'smoke-data'
  [void](New-Item -ItemType Directory -Path $ownedRoot -Force -ErrorAction Stop)
  Write-FixtureOwnershipToken (Join-Path $ownedRoot '.propr-installed-app-owner') $token
  foreach ($directory in @($installRoot, $shortcutFolder, $smokeDirectory)) {
    [void](New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop)
    Write-FixtureOwnershipToken (Join-Path $directory '.propr-installed-app-owner') $token
  }
  [IO.File]::WriteAllText((Join-Path $installRoot 'installed.txt'), 'owned', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($shortcut, 'owned-shortcut', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $smokeDirectory 'smoke.txt'), 'owned', [Text.Encoding]::ASCII)

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
  New-LocalUser -Name $userName -Password $password `
    -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $userSid = (Get-LocalUser -Name $userName -ErrorAction Stop).SID.Value

  $ownedDirectories = @(
    [ordered]@{ Kind = 'FIXTURE_ROOT'; Path = $ownedRoot; Owned = $true; Token = $token },
    [ordered]@{ Kind = 'INSTALL_ROOT'; Path = $installRoot; Owned = $true; Token = $token },
    [ordered]@{ Kind = 'SHORTCUT_FOLDER'; Path = $shortcutFolder; Owned = $true; Token = $token },
    [ordered]@{ Kind = 'SMOKE_DATA'; Path = $smokeDirectory; Owned = $true; Token = $token }
  )
  $conflictingDirectories = @(
    $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES -split '\|' | Where-Object { $_ }
  ) | ForEach-Object {
    [ordered]@{ Kind = 'CONFLICT'; Path = $_; Owned = $false; Token = $null }
  }
  $manifest.Directories = @($ownedDirectories) + @($conflictingDirectories)
  $manifest.Files = @(
    [ordered]@{ Kind = 'SHORTCUT_FILE'; Path = $shortcut; Owned = $true; Token = $token }
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
  $manifest.Users = @(
    [ordered]@{ Name = $userName; Sid = $userSid; Owned = $true }
  )
  if ($env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER) {
    $manifest.Users += [ordered]@{
      Name = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER
      Sid = $env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID
      Owned = $false
    }
  }
  $manifest.Profiles = @()
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
  $resourceState = [ordered]@{
    OwnedRoot = $ownedRoot
    InstallRoot = $installRoot
    ShortcutFolder = $shortcutFolder
    Shortcut = $shortcut
    SmokeDirectory = $smokeDirectory
    RegistryPath = $registryPath
    RegistryRoot = Split-Path -Parent $registryPath
    UserName = $userName
    UserSid = $userSid
    ProfilePath = [string]$profiles[0].LocalPath
  }
  $resourceState | ConvertTo-Json -Compress | Set-Content -LiteralPath `
    (Join-Path $stateDirectory 'resources.json') -Encoding ASCII
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
$state | ConvertTo-Json -Compress | Set-Content -LiteralPath `
  (Join-Path $stateDirectory 'processes.json') -Encoding ASCII

switch ($scenario) {
  'NO_MARKER' {
    Start-Sleep -Seconds 300
  }
  'VALID_THEN_DEADLINE' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(10).Ticks)
    Start-Sleep -Milliseconds 500
    Write-FixtureMarker ('{0}|INSTALL|MSI_INSTALL|BEGIN' -f [DateTime]::UtcNow.AddMilliseconds(2500).Ticks)
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
  'OWNED_RESOURCES_NORMAL_SUCCESS' {
    Write-FixtureMarker ('{0}|INITIALIZATION|PATHS|BEGIN' -f [DateTime]::UtcNow.AddSeconds(60).Ticks)
    New-OwnedFixtureResources
    Write-FixtureMarker ('{0}|CLEANUP|SMOKE_DATA_REMOVE|COMPLETE' -f `
      [DateTime]::UtcNow.AddSeconds(60).Ticks)
  }
}

$descendant.Dispose()
