param(
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)

$ErrorActionPreference = 'Stop'
$supervisorPath = Join-Path $PSScriptRoot 'run-installed-windows-app-harness.ps1'
$fixtureWorkerPath = Join-Path $PSScriptRoot 'test-installed-windows-app-supervisor-fixture.ps1'
$hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) `
  "propr-supervisor-tests-$([Guid]::NewGuid().ToString('N'))"
$dummyInstaller = Join-Path $testRoot 'fixture.msi'
$secretNeedle = 'C:\Users\fixture-user\token=fixture-credential'
$ownedFixtureUserName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$ownedFixturePassword = "P!$([Guid]::NewGuid().ToString('N'))x7"
$conflictingFixtureUserName = $null
$conflictingFixtureUserSid = $null
$conflictingFixtureProfileSid = $null
$conflictingFixtureProfilePath = $null
$conflictingFixtureDirectories = $null
$conflictingFixtureShortcut = $null
$conflictingFixtureRegistryPath = $null

function Assert-True([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}

function Assert-Contains([string]$Text, [string]$Expected, [string]$Message) {
  Assert-True ($Text.Contains($Expected, [StringComparison]::Ordinal)) $Message
}

function Assert-NotContains([string]$Text, [string]$Forbidden, [string]$Message) {
  Assert-True (!$Text.Contains($Forbidden, [StringComparison]::OrdinalIgnoreCase)) $Message
}

function New-StateDirectory([string]$Name) {
  $path = Join-Path $testRoot $Name
  [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
  return $path
}

function New-SupervisorStartInfo(
  [string]$Scenario,
  [string]$StateDirectory,
  [string]$CancellationEventName,
  [bool]$UseProductionWorker
) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File', $supervisorPath,
    '-Installer', $dummyInstaller,
    '-Architecture', $Architecture,
    '-BootstrapTimeoutMilliseconds', $(if ($UseProductionWorker) { '10000' } else { '2000' }),
    '-WatchdogPollMilliseconds', '25',
    '-WatchdogTerminationMilliseconds', '3000',
    '-PostTerminationCleanupMilliseconds', '30000',
    '-MarkerReadTimeoutMilliseconds', '200'
  )) {
    $startInfo.ArgumentList.Add([string]$argument)
  }
  if (!$UseProductionWorker) {
    $startInfo.ArgumentList.Add('-WorkerPath')
    $startInfo.ArgumentList.Add($fixtureWorkerPath)
    $startInfo.ArgumentList.Add('-FixtureCleanupRoot')
    $startInfo.ArgumentList.Add($StateDirectory)
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SCENARIO'] = $Scenario
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY'] = $StateDirectory
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SECRET'] = $secretNeedle
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_OWNED_USER'] = $ownedFixtureUserName
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD'] = $ownedFixturePassword
    if ($conflictingFixtureUserName) {
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER'] =
        $conflictingFixtureUserName
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID'] =
        $conflictingFixtureUserSid
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID'] =
        $conflictingFixtureProfileSid
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_PATH'] =
        $conflictingFixtureProfilePath
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES'] =
        $conflictingFixtureDirectories
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT'] =
        $conflictingFixtureShortcut
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY'] =
        $conflictingFixtureRegistryPath
    }
  }
  if ($CancellationEventName) {
    $startInfo.ArgumentList.Add('-CancellationEventName')
    $startInfo.ArgumentList.Add($CancellationEventName)
  }
  return $startInfo
}

function Read-FixtureProcessState([string]$StateDirectory) {
  $statePath = Join-Path $StateDirectory 'processes.json'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
    if ($stopwatch.ElapsedMilliseconds -ge 5000) {
      throw 'fixture did not publish process state'
    }
    Start-Sleep -Milliseconds 25
  }
  return Get-Content -LiteralPath $statePath -Raw -Encoding ASCII | ConvertFrom-Json
}

function Read-FixtureResourceState([string]$StateDirectory) {
  $statePath = Join-Path $StateDirectory 'resources.json'
  Assert-True (Test-Path -LiteralPath $statePath -PathType Leaf) `
    'fixture did not publish owned resource state'
  return Get-Content -LiteralPath $statePath -Raw -Encoding ASCII | ConvertFrom-Json
}

function Assert-ProcessTreeGone($State) {
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $worker = Get-Process -Id ([int]$State.WorkerPid) -ErrorAction SilentlyContinue
    $descendant = Get-Process -Id ([int]$State.DescendantPid) -ErrorAction SilentlyContinue
    if ($null -eq $worker -and $null -eq $descendant) { return }
    Start-Sleep -Milliseconds 25
  } while ($stopwatch.ElapsedMilliseconds -lt 3000)
  throw 'owned worker process tree survived supervisor completion'
}

function Invoke-FixtureScenario([string]$Scenario, [string]$ExistingStateDirectory = '') {
  $stateDirectory = if ($ExistingStateDirectory) {
    $ExistingStateDirectory
  } else {
    New-StateDirectory $Scenario.ToLowerInvariant()
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-SupervisorStartInfo $Scenario $stateDirectory '' $false
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  if (!$process.Start()) { throw 'supervisor test process did not start' }
  try {
    $completionBound = if ($Scenario -eq 'OWNED_RESOURCES_THEN_DEADLINE') { 90000 } else { 10000 }
    if (!$process.WaitForExit($completionBound)) {
      try { $process.Kill($true) } catch {}
      throw 'supervisor exceeded the executable test completion bound'
    }
    $stopwatch.Stop()
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    $state = Read-FixtureProcessState $stateDirectory
    Assert-ProcessTreeGone $state
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      ElapsedMilliseconds = $stopwatch.ElapsedMilliseconds
      Output = $standardOutput
      Error = $standardError
      StateDirectory = $stateDirectory
    }
  } finally {
    $process.Dispose()
  }
}

function Test-BootstrapTimeout {
  $result = Invoke-FixtureScenario 'NO_MARKER'
  Assert-True ($result.ExitCode -eq 124) 'missing-marker bootstrap did not fail with the watchdog code'
  Assert-True ($result.ElapsedMilliseconds -ge 1800) 'bootstrap timeout ignored the injected deadline'
  Assert-True ($result.ElapsedMilliseconds -lt 10000) 'missing-marker bootstrap completion was not bounded'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:TIMED_OUT' `
    'missing-marker bootstrap did not emit the fixed timeout line'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:NONE' `
    'missing-marker bootstrap did not emit the fixed empty last-stage line'
}

function Test-OperationDeadlineAndTreeTermination {
  $result = Invoke-FixtureScenario 'VALID_THEN_DEADLINE'
  Assert-True ($result.ExitCode -eq 124) 'operation deadline did not fail with the watchdog code'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:INSTALL:MSI_INSTALL:BEGIN' `
    'operation transition was not accepted and flushed by the supervisor'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:INSTALL:MSI_INSTALL:BEGIN:TIMED_OUT' `
    'operation deadline did not emit the fixed redacted timeout line'
}

function Test-FailClosedMarkers {
  foreach ($testCase in @(
    @{ Scenario = 'MALFORMED_MARKER'; Label = 'malformed' },
    @{ Scenario = 'TORN_MARKER'; Label = 'torn' },
    @{ Scenario = 'STALE_MARKER'; Label = 'stale' },
    @{ Scenario = 'INACCESSIBLE_MARKER'; Label = 'inaccessible' }
  )) {
    $result = Invoke-FixtureScenario $testCase.Scenario
    Assert-True ($result.ExitCode -eq 124) "$($testCase.Label) marker did not fail closed"
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:FAILED' `
      "$($testCase.Label) marker did not emit the fixed bootstrap failure line"
    Assert-NotContains $result.Output $secretNeedle `
      "$($testCase.Label) marker diagnostics exposed fixture-sensitive data"
  }
}

function Test-LiveCancellationAndRedaction {
  $stateDirectory = New-StateDirectory 'cancellation'
  $eventName = "Local\ProPRInstalledAppCancellation-$([Guid]::NewGuid().ToString('N'))"
  $cancellationEvent = [Threading.EventWaitHandle]::new(
    $false,
    [Threading.EventResetMode]::ManualReset,
    $eventName
  )
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-SupervisorStartInfo 'CANCELLATION' $stateDirectory $eventName $false
  $lines = [Collections.Generic.List[string]]::new()
  try {
    if (!$process.Start()) { throw 'cancellation supervisor did not start' }
    $liveAccepted = $false
    $readStopwatch = [Diagnostics.Stopwatch]::StartNew()
    while (!$liveAccepted -and $readStopwatch.ElapsedMilliseconds -lt 8000) {
      $lineTask = $process.StandardOutput.ReadLineAsync()
      if (!$lineTask.Wait(8000 - [int]$readStopwatch.ElapsedMilliseconds)) { break }
      $line = $lineTask.Result
      if ($null -eq $line) { break }
      $lines.Add($line)
      if ($line -ceq 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:INITIALIZATION:PATHS:BEGIN') {
        $liveAccepted = $true
      }
    }
    Assert-True $liveAccepted 'accepted transition was not observable live before cancellation'
    Assert-True (!$process.HasExited) 'supervisor exited before simulated cancellation'
    [void]$cancellationEvent.Set()
    Assert-True ($process.WaitForExit(8000)) 'cancelled supervisor did not complete within the bound'
    $remainingOutput = $process.StandardOutput.ReadToEnd()
    if ($remainingOutput) { $lines.Add($remainingOutput) }
    $standardError = $process.StandardError.ReadToEnd()
    $output = $lines -join "`n"
    Assert-True ($process.ExitCode -eq 125) 'simulated cancellation did not use the supervisor failure code'
    Assert-Contains $output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:SUPERVISOR:CANCELLED' `
      'simulated cancellation did not emit the fixed cancellation line'
    Assert-True ($output -match `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:(?:INITIALIZATION:PATHS|VALIDATION:INSTALL_TREE_SCAN):BEGIN') `
      'simulated cancellation did not emit a fixed last-valid-marker line'
    foreach ($forbidden in @($secretNeedle, $stateDirectory, $testRoot, 'fixture-user', 'credential')) {
      Assert-NotContains $output $forbidden 'live supervisor diagnostics were not redacted'
    }
    $state = Read-FixtureProcessState $stateDirectory
    Assert-ProcessTreeGone $state
    Assert-True ([string]::IsNullOrEmpty($standardError)) 'fixture cancellation wrote unexpected stderr'
  } finally {
    if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
    $process.Dispose()
    $cancellationEvent.Dispose()
  }
}

function Get-RunnerProfileSnapshot {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    Assert-True ($null -ne $identity -and $null -ne $identity.User) `
      'runner profile authority validation failed'
    $identitySid = $identity.User.Value
    Assert-True (![string]::IsNullOrWhiteSpace($identitySid)) `
      'runner profile authority validation failed'

    $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
      $_.SID -ceq $identitySid
    })
    Assert-True ($profiles.Count -eq 1) 'runner profile authority validation failed'
    $profile = $profiles[0]
    Assert-True (!$profile.Special -and $profile.Loaded) `
      'runner profile authority validation failed'
    Assert-True (![string]::IsNullOrWhiteSpace([string]$profile.LocalPath) -and
      [IO.Path]::IsPathRooted([string]$profile.LocalPath)) `
      'runner profile authority validation failed'

    $rawCimLocalPath = [string]$profile.LocalPath
    $cimLocalPath = $rawCimLocalPath.TrimEnd('\')
    Assert-True ($rawCimLocalPath -ceq $cimLocalPath) `
      'runner profile authority validation failed'
    $canonicalLocalPath = [IO.Path]::GetFullPath($cimLocalPath).TrimEnd('\')
    Assert-True ([string]::Equals(
      $cimLocalPath,
      $canonicalLocalPath,
      [StringComparison]::Ordinal
    )) 'runner profile authority validation failed'
    $resolvedProfilePath = Resolve-Path -LiteralPath $canonicalLocalPath -ErrorAction Stop
    $resolvedLocalPath = $resolvedProfilePath.ProviderPath.TrimEnd('\')
    Assert-True ([string]::Equals(
      $resolvedLocalPath,
      $canonicalLocalPath,
      [StringComparison]::Ordinal
    )) 'runner profile authority validation failed'

    $profileDirectory = Get-Item -LiteralPath $canonicalLocalPath -Force -ErrorAction Stop
    Assert-True ($profileDirectory.PSIsContainer) 'runner profile authority validation failed'
    $pathCursor = $profileDirectory
    while ($null -ne $pathCursor) {
      Assert-True (($pathCursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
        'runner profile authority validation failed'
      $parentPath = Split-Path -Parent $pathCursor.FullName
      if ([string]::IsNullOrEmpty($parentPath) -or
          [string]::Equals($parentPath, $pathCursor.FullName, [StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
    }

    $profileOwner = (Get-Acl -LiteralPath $canonicalLocalPath -ErrorAction Stop).Owner
    Assert-True (![string]::IsNullOrWhiteSpace($profileOwner)) `
      'runner profile authority validation failed'
    $profileOwnerSid = if ($profileOwner -match '^S-\d+(?:-\d+)+$') {
      [Security.Principal.SecurityIdentifier]::new($profileOwner).Value
    } else {
      $profileOwnerAccount = [Security.Principal.NTAccount]::new($profileOwner)
      $profileOwnerAccount.Translate([Security.Principal.SecurityIdentifier]).Value
    }

    return [PSCustomObject]@{
      ProfileExists = $true
      DirectoryExists = $true
      IdentitySid = $identitySid
      ProfileSid = [string]$profile.SID
      CimLocalPath = $cimLocalPath
      CanonicalLocalPath = $canonicalLocalPath
      DirectoryOwnerSid = $profileOwnerSid
      DirectoryAttributes = [int64]$profileDirectory.Attributes
      Loaded = [bool]$profile.Loaded
      Special = [bool]$profile.Special
      Status = [uint32]$profile.Status
      HealthStatus = [uint32]$profile.HealthStatus
      RoamingConfigured = [bool]$profile.RoamingConfigured
      RoamingPath = [string]$profile.RoamingPath
      RoamingPreference = [bool]$profile.RoamingPreference
    }
  } catch {
    throw 'runner profile authority validation failed'
  } finally {
    if ($null -ne $identity) { $identity.Dispose() }
  }
}

function Assert-RunnerProfileUnchanged($Before) {
  $after = Get-RunnerProfileSnapshot
  $unchanged = $after.ProfileExists -and $Before.ProfileExists -and
    $after.DirectoryExists -and $Before.DirectoryExists -and
    $after.IdentitySid -ceq $Before.IdentitySid -and
    $after.ProfileSid -ceq $Before.ProfileSid -and
    $after.CimLocalPath -ceq $Before.CimLocalPath -and
    $after.CanonicalLocalPath -ceq $Before.CanonicalLocalPath -and
    $after.DirectoryOwnerSid -ceq $Before.DirectoryOwnerSid -and
    $after.DirectoryAttributes -eq $Before.DirectoryAttributes -and
    $after.Loaded -eq $Before.Loaded -and
    $after.Special -eq $Before.Special -and
    $after.Status -eq $Before.Status -and
    $after.HealthStatus -eq $Before.HealthStatus -and
    $after.RoamingConfigured -eq $Before.RoamingConfigured -and
    $after.RoamingPath -ceq $Before.RoamingPath -and
    $after.RoamingPreference -eq $Before.RoamingPreference
  Assert-True $unchanged 'runner profile authority changed during ownership test'
}

function Test-PreExistingCleanupOwnership {
  $runnerProfileBefore = Get-RunnerProfileSnapshot
  $stateDirectory = New-StateDirectory 'ownership'
  $conflictRoot = Join-Path $stateDirectory 'pre-existing'
  $conflictInstallRoot = Join-Path $conflictRoot 'install-tree'
  $conflictShortcutFolder = Join-Path $conflictRoot 'shortcut-folder'
  $conflictShortcut = Join-Path $conflictShortcutFolder 'ProPR Desktop.lnk'
  $conflictSmokeDirectory = Join-Path $conflictRoot 'smoke-data'
  $conflictRegistryPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\conflict-$([Guid]::NewGuid().ToString('N'))"
  $userName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $password = ConvertTo-SecureString "P!$([Guid]::NewGuid().ToString('N'))z9" -AsPlainText -Force
  $userCreated = $false
  $registryCreated = $false
  $userSid = $null
  try {
    Assert-True ($null -eq (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) `
      'pre-existing local user fixture baseline was not clean'
    $createdUser = New-LocalUser -Name $userName -Password $password `
      -AccountNeverExpires -PasswordNeverExpires
    $userCreated = $true
    $userSid = $createdUser.SID
    Assert-True ($null -ne $userSid) 'pre-existing local user fixture ownership capture failed'
    $capturedUser = Get-LocalUser -Name $userName -ErrorAction Stop
    Assert-True ($capturedUser.SID.Equals($userSid)) `
      'pre-existing local user fixture ownership capture failed'
    $fixtureUserProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $userSid.Value })
    Assert-True ($fixtureUserProfiles.Count -eq 0) `
      'pre-existing local user fixture unexpectedly acquired a profile'

    foreach ($directory in @(
      $conflictInstallRoot, $conflictShortcutFolder, $conflictSmokeDirectory
    )) {
      [void](New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop)
      Set-Content -LiteralPath (Join-Path $directory 'pre-existing.txt') -Value 'owned-before-run'
    }
    Set-Content -LiteralPath $conflictShortcut -Value 'owned-before-run'
    [void](New-Item -Path $conflictRegistryPath -Force -ErrorAction Stop)
    $registryCreated = $true
    Set-ItemProperty -LiteralPath $conflictRegistryPath -Name 'PreExisting' -Value 'owned-before-run'

    $script:conflictingFixtureUserName = $userName
    $script:conflictingFixtureUserSid = $userSid.Value
    $script:conflictingFixtureProfileSid = $runnerProfileBefore.ProfileSid
    $script:conflictingFixtureProfilePath = $runnerProfileBefore.CanonicalLocalPath
    $script:conflictingFixtureDirectories = @(
      $conflictInstallRoot, $conflictShortcutFolder, $conflictSmokeDirectory
    ) -join '|'
    $script:conflictingFixtureShortcut = $conflictShortcut
    $script:conflictingFixtureRegistryPath = $conflictRegistryPath

    $result = Invoke-FixtureScenario 'OWNED_RESOURCES_THEN_DEADLINE' $stateDirectory
    Assert-True ($result.ExitCode -eq 124) 'owned-resource timeout did not preserve watchdog status'
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:CLEANUP:SMOKE_DATA_REMOVE:BEGIN:TIMED_OUT' `
      'owned-resource fixture did not reach the forced timeout boundary'
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
      'forced timeout did not execute bounded post-termination cleanup'
    $redactedEvidence = "$($result.Output)`n$($result.Error)"
    foreach ($forbidden in @(
      $runnerProfileBefore.IdentitySid,
      $runnerProfileBefore.CanonicalLocalPath,
      $userName,
      $userSid.Value,
      $ownedFixtureUserName,
      $ownedFixturePassword
    )) {
      Assert-NotContains $redactedEvidence $forbidden `
        'ownership cleanup evidence exposed an identity or credential'
    }

    $owned = Read-FixtureResourceState $stateDirectory
    foreach ($ownedPath in @(
      $owned.OwnedRoot, $owned.InstallRoot, $owned.ShortcutFolder,
      $owned.Shortcut, $owned.SmokeDirectory
    )) {
      Assert-True (!(Test-Path -LiteralPath $ownedPath)) `
        'post-termination cleanup left a run-owned file-system resource behind'
    }
    Assert-True (!(Test-Path -LiteralPath $owned.RegistryPath)) `
      'post-termination cleanup left a run-owned registry resource behind'
    Assert-True (!(Test-Path -LiteralPath $owned.RegistryRoot)) `
      'post-termination cleanup left the run-owned registry root behind'
    Assert-True ($null -eq (Get-LocalUser -Name $owned.UserName -ErrorAction SilentlyContinue)) `
      'post-termination cleanup left the run-owned local user behind'
    $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $owned.UserSid })
    Assert-True ($ownedProfiles.Count -eq 0) `
      'post-termination cleanup left the run-owned profile behind'

    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictInstallRoot 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing install tree was removed or changed'
    Assert-True ((Get-ItemPropertyValue -LiteralPath $conflictRegistryPath -Name 'PreExisting') -ceq `
      'owned-before-run') 'pre-existing registry tree was removed or changed'
    Assert-True ((Get-Content -LiteralPath $conflictShortcut -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing shortcut was removed or changed'
    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictSmokeDirectory 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing smoke data was removed or changed'
    $remainingUser = Get-LocalUser -Name $userName -ErrorAction Stop
    Assert-True ($remainingUser.SID.Equals($userSid)) 'pre-existing local user was removed or replaced'
    $fixtureUserProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $userSid.Value })
    Assert-True ($fixtureUserProfiles.Count -eq 0) `
      'pre-existing local user fixture unexpectedly acquired a profile'
  } finally {
    $script:conflictingFixtureUserName = $null
    $script:conflictingFixtureUserSid = $null
    $script:conflictingFixtureProfileSid = $null
    $script:conflictingFixtureProfilePath = $null
    $script:conflictingFixtureDirectories = $null
    $script:conflictingFixtureShortcut = $null
    $script:conflictingFixtureRegistryPath = $null
    if ($registryCreated -and (Test-Path -LiteralPath $conflictRegistryPath)) {
      Remove-Item -LiteralPath $conflictRegistryPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    $fixtureRegistryRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture'
    if ((Test-Path -LiteralPath $fixtureRegistryRoot) -and
        @(Get-ChildItem -LiteralPath $fixtureRegistryRoot -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item -LiteralPath $fixtureRegistryRoot -Force -ErrorAction SilentlyContinue
    }
    if ($userCreated) {
      $ownedUser = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
      if ($null -ne $ownedUser) {
        Assert-True ($null -ne $userSid -and $ownedUser.SID.Equals($userSid)) `
          'refusing to remove a local user not owned by the fixture'
        Remove-LocalUser -Name $userName -ErrorAction Stop
        Assert-True ($null -eq (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) `
          'ownership local-user fixture cleanup failed'
      }
    }
    $ownedUser = Get-LocalUser -Name $ownedFixtureUserName -ErrorAction SilentlyContinue
    if ($null -ne $ownedUser) {
      $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.SID -ceq $ownedUser.SID.Value })
      foreach ($profile in $ownedProfiles) {
        Remove-CimInstance -InputObject $profile -ErrorAction SilentlyContinue
      }
      Remove-LocalUser -Name $ownedFixtureUserName -ErrorAction SilentlyContinue
    }
    Assert-RunnerProfileUnchanged $runnerProfileBefore
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:PRE_EXISTING_AUTHORITIES:PRESERVED'
  [Console]::Out.Flush()
}

if (![OperatingSystem]::IsWindows()) { throw 'supervisor behavior tests require Windows' }
$actualArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
Assert-True ($actualArchitecture -ceq $Architecture) `
  "supervisor behavior tests expected $Architecture but are running on $actualArchitecture"

[void](New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop)
[IO.File]::WriteAllBytes($dummyInstaller, [byte[]](0))
try {
  Test-BootstrapTimeout
  Test-OperationDeadlineAndTreeTermination
  Test-FailClosedMarkers
  Test-LiveCancellationAndRedaction
  Test-PreExistingCleanupOwnership
  Write-Host "PROPR_WINDOWS_SUPERVISOR_TESTS:${Architecture}:PASSED"
  [Console]::Out.Flush()
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
