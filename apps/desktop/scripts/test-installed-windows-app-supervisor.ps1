param(
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)

$ErrorActionPreference = 'Stop'
$supervisorPath = Join-Path $PSScriptRoot 'run-installed-windows-app-harness.ps1'
$workflowCleanupPath = Join-Path $PSScriptRoot 'run-installed-windows-app-workflow-cleanup.ps1'
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
  [bool]$UseProductionWorker,
  [string]$WorkflowManifest = '',
  [string]$ExpectedRunId = ''
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
    '-BootstrapTimeoutMilliseconds', '10000',
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
  if ($WorkflowManifest) {
    $startInfo.ArgumentList.Add('-OwnershipManifest')
    $startInfo.ArgumentList.Add($WorkflowManifest)
    $startInfo.ArgumentList.Add('-ExpectedRunId')
    $startInfo.ArgumentList.Add($ExpectedRunId)
  }
  return $startInfo
}

function Read-FixtureProcessState([string]$StateDirectory) {
  $statePath = Join-Path $StateDirectory 'processes.json'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
    if ($stopwatch.ElapsedMilliseconds -ge 15000) {
      throw 'fixture did not publish process state'
    }
    Start-Sleep -Milliseconds 25
  }
  return Get-Content -LiteralPath $statePath -Raw -Encoding ASCII | ConvertFrom-Json
}

function Read-FixtureResourceState([string]$StateDirectory) {
  $statePath = Join-Path $StateDirectory 'resources.json'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
    if ($stopwatch.ElapsedMilliseconds -ge 45000) {
      throw 'fixture did not publish owned resource state'
    }
    Start-Sleep -Milliseconds 25
  }
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

function Assert-OwnedResourcesGone($Owned) {
  foreach ($ownedPath in @(
    $Owned.OwnedRoot, $Owned.InstallRoot, $Owned.ShortcutFolder,
    $Owned.Shortcut, $Owned.SmokeDirectory
  )) {
    Assert-True (!(Test-Path -LiteralPath $ownedPath)) `
      'external cleanup left a run-owned file-system resource behind'
  }
  Assert-True (!(Test-Path -LiteralPath $Owned.RegistryPath)) `
    'external cleanup left a run-owned registry resource behind'
  Assert-True (!(Test-Path -LiteralPath $Owned.RegistryRoot)) `
    'external cleanup left the run-owned registry root behind'
  Assert-True ($null -eq (Get-LocalUser -Name $Owned.UserName -ErrorAction SilentlyContinue)) `
    'external cleanup left the run-owned local user behind'
  $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -ceq $Owned.UserSid })
  Assert-True ($ownedProfiles.Count -eq 0) `
    'external cleanup left the run-owned profile behind'
}

function Restore-ReplacedFixtureAuthority($Owned) {
  [IO.File]::WriteAllText(
    (Join-Path $Owned.OwnedRoot '.propr-installed-app-owner'),
    [string]$Owned.Token,
    [Text.Encoding]::ASCII
  )
  if (Test-Path -LiteralPath $Owned.InstallRoot) {
    Remove-Item -LiteralPath $Owned.InstallRoot -Recurse -Force -ErrorAction Stop
  }
  [void](New-Item -ItemType Directory -Path $Owned.InstallRoot -ErrorAction Stop)
  [IO.File]::WriteAllText(
    (Join-Path $Owned.InstallRoot '.propr-installed-app-owner'),
    [string]$Owned.Token,
    [Text.Encoding]::ASCII
  )
  [IO.File]::WriteAllText(
    (Join-Path $Owned.ShortcutFolder '.propr-installed-app-owner'),
    [string]$Owned.Token,
    [Text.Encoding]::ASCII
  )
  [IO.File]::WriteAllText($Owned.Shortcut, 'owned-shortcut', [Text.Encoding]::ASCII)
  Set-ItemProperty -LiteralPath $Owned.RegistryPath `
    -Name 'ProPRInstalledAppOwner' -Value ([string]$Owned.Token)
}

function Assert-ReplacedFixtureResourcesSurvive($Owned) {
  Assert-True ((Get-Content -LiteralPath (Join-Path $Owned.InstallRoot 'foreign.txt') -Raw).Trim() `
      -ceq 'foreign-install-tree') `
    'replacement install tree was removed or changed'
  Assert-True ((Get-Content -LiteralPath $Owned.Shortcut -Raw).Trim() -ceq 'foreign-shortcut') `
    'replacement shortcut was removed or changed'
  Assert-True ((Get-ItemPropertyValue -LiteralPath $Owned.RegistryPath `
      -Name 'ProPRInstalledAppOwner') -ceq 'foreign-owner') `
    'replacement registry authority was removed or changed'
}

function Invoke-WorkflowCleanupController(
  [string]$ManifestPath,
  [string]$RunId,
  [string]$FixtureRoot,
  [int]$CleanupTimeoutMilliseconds = 30000
) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $workflowCleanupPath,
    '-OwnershipManifest', $ManifestPath,
    '-Installer', $dummyInstaller,
    '-ExpectedRunId', $RunId,
    '-CleanupTimeoutMilliseconds', [string]$CleanupTimeoutMilliseconds,
    '-TerminationTimeoutMilliseconds', '3000'
  )) {
    $startInfo.ArgumentList.Add($argument)
  }
  if ($FixtureRoot) {
    $startInfo.ArgumentList.Add('-FixtureRoot')
    $startInfo.ArgumentList.Add($FixtureRoot)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (!$process.Start()) { throw 'workflow cleanup fixture did not start' }
    Assert-True ($process.WaitForExit(40000)) 'workflow cleanup fixture exceeded its bound'
    $output = $process.StandardOutput.ReadToEnd()
    $errorOutput = $process.StandardError.ReadToEnd()
    Assert-True ($output.Length -le 512) 'workflow cleanup fixture output exceeded its fixed bound'
    Assert-True ($errorOutput.Length -eq 0) `
      'workflow cleanup fixture emitted non-fixed error output'
    $outputLines = @($output -split '\r?\n' | Where-Object { $_ })
    Assert-True ($outputLines.Count -eq 2) `
      'workflow cleanup fixture did not emit exactly two fixed result lines'
    Assert-True ($outputLines[0] -match
      '^PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:(COMPLETE|FAILED|TIMED_OUT)$') `
      'workflow cleanup fixture emitted an invalid fixed result'
    $resultName = $Matches[1]
    Assert-True ($outputLines[1] -match
      '^PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STATUS:([A-Z_]+):EXIT_CODE:([0-9]+)$') `
      'workflow cleanup fixture emitted an invalid fixed status'
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      Result = $resultName
      ControllerStatus = $Matches[1]
      ReportedExitCode = [int]$Matches[2]
      Output = $output
    }
  } finally {
    if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
    $process.Dispose()
  }
}

function Start-ExternallyInterruptibleSupervisor([string]$StateDirectory) {
  $scriptText = @'
param($SupervisorPath, $Installer, $Architecture, $FixtureWorker, $Scenario,
  $StateDirectory, $Secret, $OwnedUser, $OwnedPassword,
  $ConflictUser, $ConflictUserSid, $ConflictProfileSid, $ConflictProfilePath,
  $ConflictDirectories, $ConflictShortcut, $ConflictRegistry)
$env:PROPR_SUPERVISOR_FIXTURE_SCENARIO = $Scenario
$env:PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY = $StateDirectory
$env:PROPR_SUPERVISOR_FIXTURE_SECRET = $Secret
$env:PROPR_SUPERVISOR_FIXTURE_OWNED_USER = $OwnedUser
$env:PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD = $OwnedPassword
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER = $ConflictUser
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID = $ConflictUserSid
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID = $ConflictProfileSid
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_PATH = $ConflictProfilePath
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES = $ConflictDirectories
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT = $ConflictShortcut
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY = $ConflictRegistry
& $SupervisorPath -Installer $Installer -Architecture $Architecture `
  -WorkerPath $FixtureWorker -FixtureCleanupRoot $StateDirectory `
  -BootstrapTimeoutMilliseconds 10000 -WatchdogPollMilliseconds 25 `
  -WatchdogTerminationMilliseconds 3000 -PostTerminationCleanupMilliseconds 30000 `
  -MarkerReadTimeoutMilliseconds 200
'@
  $pipeline = [Management.Automation.PowerShell]::Create()
  [void]$pipeline.AddScript($scriptText)
  foreach ($argument in @(
    $supervisorPath,
    $dummyInstaller,
    $Architecture,
    $fixtureWorkerPath,
    'OWNED_RESOURCES_FOR_INTERRUPTION',
    $StateDirectory,
    $secretNeedle,
    $ownedFixtureUserName,
    $ownedFixturePassword,
    $conflictingFixtureUserName,
    $conflictingFixtureUserSid,
    $conflictingFixtureProfileSid,
    $conflictingFixtureProfilePath,
    $conflictingFixtureDirectories,
    $conflictingFixtureShortcut,
    $conflictingFixtureRegistryPath
  )) {
    [void]$pipeline.AddArgument($argument)
  }
  $asyncResult = $pipeline.BeginInvoke()
  return [PSCustomObject]@{ Pipeline = $pipeline; AsyncResult = $asyncResult }
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
    $completionBound = if ($Scenario -in @(
        'OWNED_RESOURCES_THEN_DEADLINE','OWNED_RESOURCES_REPLACED_THEN_DEADLINE'
      )) { 90000 } else { 20000 }
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
  Assert-True ($result.ElapsedMilliseconds -ge 9000) 'bootstrap timeout ignored the injected deadline'
  Assert-True ($result.ElapsedMilliseconds -lt 20000) 'missing-marker bootstrap completion was not bounded'
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
  Assert-True ($result.ElapsedMilliseconds -ge 2200) `
    'operation deadline did not retain the injected observable interval'
  Assert-True ($result.ElapsedMilliseconds -lt 10000) `
    'operation deadline completion was not bounded'
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

    $replacementStateDirectory = New-StateDirectory 'replacement-collision'
    $replacementResult = Invoke-FixtureScenario `
      'OWNED_RESOURCES_REPLACED_THEN_DEADLINE' $replacementStateDirectory
    Assert-True ($replacementResult.ExitCode -eq 125) `
      'replacement collision did not fail the standalone cleanup'
    Assert-Contains $replacementResult.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
      'replacement collision did not emit fixed cleanup failure evidence'
    $replacementOwned = Read-FixtureResourceState $replacementStateDirectory
    Assert-ReplacedFixtureResourcesSurvive $replacementOwned
    Assert-True (Test-Path -LiteralPath $replacementOwned.ManifestPath -PathType Leaf) `
      'false standalone cleanup result discarded authenticated recovery authority'
    Restore-ReplacedFixtureAuthority $replacementOwned
    $replacementRetry = Invoke-WorkflowCleanupController `
      $replacementOwned.ManifestPath $replacementOwned.RunId $replacementStateDirectory
    Assert-True ($replacementRetry.ExitCode -eq 0 -and
        $replacementRetry.Result -ceq 'COMPLETE') `
      'standalone cleanup did not retry to exact success after authority restoration'
    Assert-OwnedResourcesGone $replacementOwned
    Assert-True (!(Test-Path -LiteralPath $replacementOwned.ManifestPath)) `
      'successful standalone cleanup retry did not consume recovery authority'

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

    $gracefulStateDirectory = New-StateDirectory 'graceful-interruption'
    $graceful = Start-ExternallyInterruptibleSupervisor $gracefulStateDirectory
    try {
      $gracefulProcessState = Read-FixtureProcessState $gracefulStateDirectory
      $gracefulOwned = Read-FixtureResourceState $gracefulStateDirectory
      $graceful.Pipeline.Stop()
      try { [void]$graceful.Pipeline.EndInvoke($graceful.AsyncResult) } catch {}
      Assert-ProcessTreeGone $gracefulProcessState
      Assert-OwnedResourcesGone $gracefulOwned
    } finally {
      $graceful.Pipeline.Dispose()
    }

    $workflowStateDirectory = New-StateDirectory 'workflow-cleanup'
    $workflowRunId = [Guid]::NewGuid().ToString('N')
    $workflowManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$workflowRunId.json"
    $workflowSupervisor = [Diagnostics.Process]::new()
    $workflowSupervisor.StartInfo = New-SupervisorStartInfo `
      'OWNED_RESOURCES_FOR_INTERRUPTION' $workflowStateDirectory '' $false `
      $workflowManifest $workflowRunId
    try {
      if (!$workflowSupervisor.Start()) { throw 'workflow supervisor fixture did not start' }
      $workflowProcessState = Read-FixtureProcessState $workflowStateDirectory
      $workflowOwned = Read-FixtureResourceState $workflowStateDirectory
      $workflowSupervisor.Kill($false)
      Assert-True ($workflowSupervisor.WaitForExit(5000)) `
        'killed workflow supervisor did not exit within the bound'
      Assert-ProcessTreeGone $workflowProcessState
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'killed supervisor did not preserve the durable ownership manifest'
      $timedOutCleanup = Invoke-WorkflowCleanupController `
        $workflowManifest $workflowRunId $workflowStateDirectory 1
      Assert-True ($timedOutCleanup.ExitCode -eq 124 -and
          $timedOutCleanup.ReportedExitCode -eq 124 -and
          $timedOutCleanup.Result -ceq 'TIMED_OUT') `
        'workflow cleanup did not report its injected fixed timeout'
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'timed-out workflow cleanup discarded authenticated recovery authority'

      Set-ItemProperty -LiteralPath $workflowOwned.RegistryPath `
        -Name 'ProPRInstalledAppOwner' -Value 'foreign-owner'
      $failedWorkflowCleanup = Invoke-WorkflowCleanupController `
        $workflowManifest $workflowRunId $workflowStateDirectory
      Assert-True ($failedWorkflowCleanup.ExitCode -eq 21 -and
          $failedWorkflowCleanup.ReportedExitCode -eq 21 -and
          $failedWorkflowCleanup.Result -ceq 'FAILED' -and
          $failedWorkflowCleanup.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
        'workflow cleanup did not report a fixed replacement-collision failure'
      Assert-True ((Get-ItemPropertyValue -LiteralPath $workflowOwned.RegistryPath `
          -Name 'ProPRInstalledAppOwner') -ceq 'foreign-owner') `
        'workflow cleanup removed a replacement registry object'
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'failed workflow cleanup discarded authenticated recovery authority'

      Set-ItemProperty -LiteralPath $workflowOwned.RegistryPath `
        -Name 'ProPRInstalledAppOwner' -Value ([string]$workflowOwned.Token)
      $workflowCleanup = Invoke-WorkflowCleanupController `
        $workflowManifest $workflowRunId $workflowStateDirectory
      Assert-True ($workflowCleanup.ExitCode -eq 0 -and
          $workflowCleanup.ReportedExitCode -eq 0 -and
          $workflowCleanup.ControllerStatus -ceq 'EMPTY_OR_CLEANED') `
        'workflow cleanup controller did not retry to fixed cleanup success'
      Assert-Contains $workflowCleanup.Output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:COMPLETE' `
        'workflow cleanup controller did not emit fixed completion evidence'
      Assert-OwnedResourcesGone $workflowOwned
      Assert-True (!(Test-Path -LiteralPath $workflowManifest)) `
        'workflow cleanup did not consume the ownership manifest'
    } finally {
      if (!$workflowSupervisor.HasExited) { try { $workflowSupervisor.Kill($true) } catch {} }
      $workflowSupervisor.Dispose()
    }

    $normalStateDirectory = New-StateDirectory 'workflow-normal-already-cleaned'
    $normalRunId = [Guid]::NewGuid().ToString('N')
    $normalManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$normalRunId.json"
    $normalSupervisor = [Diagnostics.Process]::new()
    $normalSupervisor.StartInfo = New-SupervisorStartInfo `
      'OWNED_RESOURCES_NORMAL_SUCCESS' $normalStateDirectory '' $false `
      $normalManifest $normalRunId
    try {
      if (!$normalSupervisor.Start()) { throw 'normal workflow supervisor fixture did not start' }
      $normalOwned = Read-FixtureResourceState $normalStateDirectory
      Assert-True ($normalSupervisor.WaitForExit(40000)) `
        'normal workflow supervisor fixture exceeded its bound'
      Assert-True ($normalSupervisor.ExitCode -eq 0) `
        'normal workflow supervisor fixture did not complete successfully'
      Assert-OwnedResourcesGone $normalOwned
      Assert-True (Test-Path -LiteralPath $normalManifest -PathType Leaf) `
        'normal supervisor did not preserve its empty ownership receipt'
      $normalReceipt = Get-Content -LiteralPath $normalManifest -Raw -Encoding UTF8 |
        ConvertFrom-Json -ErrorAction Stop
      Assert-True ($normalReceipt.SchemaVersion -eq 2 -and
          $normalReceipt.ManifestType -ceq 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -and
          $normalReceipt.State -ceq 'EMPTY' -and
          @($normalReceipt.Directories).Count -eq 0 -and
          @($normalReceipt.Files).Count -eq 0 -and
          @($normalReceipt.RegistryKeys).Count -eq 0 -and
          @($normalReceipt.RegistryValues).Count -eq 0 -and
          @($normalReceipt.Users).Count -eq 0 -and
          @($normalReceipt.Profiles).Count -eq 0) `
        'normal supervisor did not produce a typed authenticated empty-state receipt'
      $normalCleanup = Invoke-WorkflowCleanupController `
        $normalManifest $normalRunId $normalStateDirectory
      Assert-True ($normalCleanup.ExitCode -eq 0 -and
          $normalCleanup.ReportedExitCode -eq 0 -and
          $normalCleanup.ControllerStatus -ceq 'EMPTY_OR_CLEANED') `
        'always cleanup did not accept the normal already-cleaned receipt'
      Assert-True (!(Test-Path -LiteralPath $normalManifest)) `
        'always cleanup did not consume the normal empty-state receipt'
    } finally {
      if (!$normalSupervisor.HasExited) { try { $normalSupervisor.Kill($true) } catch {} }
      $normalSupervisor.Dispose()
    }

    foreach ($manifestCase in @('MISSING','MALFORMED','STALE')) {
      $badRunId = [Guid]::NewGuid().ToString('N')
      $badManifest = Join-Path ([IO.Path]::GetTempPath()) `
        "propr-installed-app-ownership-$badRunId.json"
      if ($manifestCase -eq 'MALFORMED') {
        [IO.File]::WriteAllText($badManifest, '{not-json', [Text.Encoding]::UTF8)
      } elseif ($manifestCase -eq 'STALE') {
        $createdTicks = [DateTime]::UtcNow.AddHours(-4).Ticks
        $staleManifest = [ordered]@{
          SchemaVersion = 2
          ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'; State = 'ACTIVE'
          RunId = $badRunId
          CreatedUtcTicks = $createdTicks
          ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
          InstallerPath = $dummyInstaller; Fixture = $true
          FixtureRoot = $workflowStateDirectory; BaselineClean = $false
          InstallAttempted = $false; Directories = @(); Files = @()
          RegistryKeys = @(); RegistryValues = @(); Users = @(); Profiles = @()
        }
        [IO.File]::WriteAllText(
          $badManifest,
          ($staleManifest | ConvertTo-Json -Depth 6 -Compress),
          [Text.Encoding]::UTF8
        )
      }
      $failedCleanup = Invoke-WorkflowCleanupController `
        $badManifest $badRunId $workflowStateDirectory
      Assert-True ($failedCleanup.ExitCode -ne 0) `
        "$manifestCase workflow manifest did not fail closed"
      Assert-True ($failedCleanup.ExitCode -eq 20 -and
          $failedCleanup.ReportedExitCode -eq 20 -and
          $failedCleanup.ControllerStatus -ceq 'MANIFEST_VALIDATION_FAILURE') `
        "$manifestCase workflow manifest did not report fixed validation status"
      Assert-Contains $failedCleanup.Output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:FAILED' `
        "$manifestCase workflow manifest did not emit fixed failure evidence"
      if ($manifestCase -ne 'MISSING') {
        Assert-True (Test-Path -LiteralPath $badManifest -PathType Leaf) `
          "$manifestCase workflow failure discarded authenticated recovery authority"
        Remove-Item -LiteralPath $badManifest -Force -ErrorAction Stop
      }
    }

    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictInstallRoot 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing install tree'
    Assert-True ((Get-ItemPropertyValue -LiteralPath $conflictRegistryPath -Name 'PreExisting') -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing registry tree'
    Assert-True ((Get-Content -LiteralPath $conflictShortcut -Raw).Trim() -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing shortcut'
    Assert-True ((Get-LocalUser -Name $userName -ErrorAction Stop).SID.Equals($userSid)) `
      'external cleanup changed the pre-existing local user'
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

function Test-PreExistingAppPathsAuthority {
  $appPaths = `
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
  $protocol = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
  $sentinelApplication = 'C:\pre-existing\propr-desktop.exe'
  $sentinelProtocol = 'pre-existing-protocol'
  Assert-True (!(Test-Path -LiteralPath $appPaths)) `
    'pre-existing App Paths fixture baseline was not clean'
  Assert-True (!(Test-Path -LiteralPath $protocol)) `
    'pre-existing protocol fixture baseline was not clean'
  try {
    [void](New-Item -Path $appPaths -Force -ErrorAction Stop)
    Set-Item -LiteralPath $appPaths -Value $sentinelApplication
    Set-ItemProperty -LiteralPath $appPaths -Name 'Path' -Value 'C:\pre-existing'
    [void](New-Item -Path $protocol -Force -ErrorAction Stop)
    Set-Item -LiteralPath $protocol -Value $sentinelProtocol
    Set-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value 'do-not-remove'

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = New-SupervisorStartInfo `
      'PRE_EXISTING_APP_PATHS' $testRoot '' $true
    try {
      if (!$process.Start()) { throw 'pre-existing registry supervisor did not start' }
      Assert-True ($process.WaitForExit(20000)) `
        'pre-existing registry supervisor exceeded its bound'
      $output = $process.StandardOutput.ReadToEnd()
      $errorOutput = $process.StandardError.ReadToEnd()
      Assert-True ($process.ExitCode -ne 0) `
        'pre-existing App Paths authority was not rejected'
      Assert-Contains $output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
        'pre-existing App Paths rejection did not finish bounded cleanup'
      Assert-NotContains "$output`n$errorOutput" $sentinelApplication `
        'pre-existing App Paths evidence was not redacted'
    } finally {
      if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
      $process.Dispose()
    }
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) `
      'pre-existing App Paths executable was removed or changed'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('Path') -ceq 'C:\pre-existing') `
      'pre-existing App Paths values were removed or changed'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) `
      'pre-existing protocol key was removed or changed'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('URL Protocol') -ceq 'do-not-remove') `
      'pre-existing protocol values were removed or changed'

    $mismatchRunId = [Guid]::NewGuid().ToString('N')
    $mismatchManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$mismatchRunId.json"
    $createdTicks = [DateTime]::UtcNow.Ticks
    $mismatchState = [ordered]@{
      SchemaVersion = 2
      ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'; State = 'ACTIVE'
      RunId = $mismatchRunId
      CreatedUtcTicks = $createdTicks
      ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
      InstallerPath = $dummyInstaller; Fixture = $false; FixtureRoot = $null
      BaselineClean = $true; InstallAttempted = $true
      Directories = @(); Files = @(); Users = @(); Profiles = @()
      RegistryValues = @([ordered]@{
        Kind = 'HKCU_INSTALLED'
        Path = 'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop'
        Name = 'installed'; Owned = $false; Provisional = $false
        BaselineKeyExisted = $false; BaselineValueExisted = $false
        BaselineValueKind = $null; BaselineValueData = $null
        IdentityValueKind = $null; IdentityValueData = $null; KeyCreatedByRun = $false
      })
      RegistryKeys = @(
        [ordered]@{
          Kind = 'PROTOCOL'; Path = $protocol; Owned = $true; Token = $null
          Identity = ('0' * 64); Provisional = $false
        },
        [ordered]@{
          Kind = 'APP_PATH'; Path = $appPaths; Owned = $true; Token = $null
          Identity = ('0' * 64); Provisional = $false
        }
      )
    }
    [IO.File]::WriteAllText(
      $mismatchManifest,
      ($mismatchState | ConvertTo-Json -Depth 6 -Compress),
      [Text.Encoding]::UTF8
    )
    $mismatchCleanup = Invoke-WorkflowCleanupController `
      $mismatchManifest $mismatchRunId ''
    Assert-True ($mismatchCleanup.ExitCode -ne 0) `
      'mismatched App Paths ownership identity did not fail closed'
    Assert-True ($mismatchCleanup.ExitCode -eq 20 -and
        $mismatchCleanup.ReportedExitCode -eq 20 -and
        $mismatchCleanup.ControllerStatus -ceq 'MANIFEST_VALIDATION_FAILURE') `
      'mismatched App Paths ownership did not report fixed validation status'
    Assert-Contains $mismatchCleanup.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:FAILED' `
      'mismatched App Paths ownership did not emit fixed failure evidence'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) `
      'mismatched App Paths ownership removed the pre-existing executable value'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('Path') -ceq 'C:\pre-existing') `
      'mismatched App Paths ownership removed pre-existing values'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) `
      'mismatched protocol ownership removed the pre-existing key'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('URL Protocol') -ceq 'do-not-remove') `
      'mismatched protocol ownership removed pre-existing values'
  } finally {
    if ((Test-Path -LiteralPath $appPaths) -and
        (Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) {
      Remove-Item -LiteralPath $appPaths -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $protocol) -and
        (Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) {
      Remove-Item -LiteralPath $protocol -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:APP_PATHS_PRE_EXISTING:PRESERVED'
  [Console]::Out.Flush()
}

function Test-HkcuInstalledValueOwnership {
  $desktopKey = 'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop'
  $installedName = 'installed'
  $sentinelInstalled = 'pre-existing-installed'
  $sentinelUnrelated = 'preserve-unrelated'
  Assert-True (!(Test-Path -LiteralPath $desktopKey)) `
    'HKCU installed-value fixture baseline was not clean'

  function New-HkcuManifest(
    [bool]$BaselineKeyExisted,
    [bool]$BaselineValueExisted,
    [AllowNull()][string]$BaselineKind,
    [AllowNull()][string]$BaselineData,
    [bool]$KeyCreatedByRun,
    [bool]$Provisional = $false
  ) {
    $runId = [Guid]::NewGuid().ToString('N')
    $path = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$runId.json"
    $createdTicks = [DateTime]::UtcNow.Ticks
    $installedIdentityData = [Convert]::ToBase64String(
      [BitConverter]::GetBytes([int32]1))
    $manifest = [ordered]@{
      SchemaVersion = 2
      ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'
      State = 'ACTIVE'
      RunId = $runId
      CreatedUtcTicks = $createdTicks
      ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
      InstallerPath = $dummyInstaller
      Fixture = $false
      FixtureRoot = $null
      BaselineClean = $false
      InstallAttempted = $false
      Directories = @()
      Files = @()
      RegistryKeys = @()
      RegistryValues = @([ordered]@{
        Kind = 'HKCU_INSTALLED'; Path = $desktopKey; Name = $installedName
        Owned = $true; Provisional = $Provisional
        BaselineKeyExisted = $BaselineKeyExisted
        BaselineValueExisted = $BaselineValueExisted
        BaselineValueKind = $BaselineKind
        BaselineValueData = $BaselineData
        IdentityValueKind = if ($Provisional) { $null } else { 'DWord' }
        IdentityValueData = if ($Provisional) { $null } else { $installedIdentityData }
        KeyCreatedByRun = $KeyCreatedByRun
      })
      Users = @()
      Profiles = @()
    }
    [IO.File]::WriteAllText(
      $path,
      ($manifest | ConvertTo-Json -Depth 6 -Compress),
      [Text.Encoding]::UTF8
    )
    return [PSCustomObject]@{ RunId = $runId; Path = $path }
  }

  try {
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, $sentinelInstalled, [Microsoft.Win32.RegistryValueKind]::String)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      'Unrelated', $sentinelUnrelated, [Microsoft.Win32.RegistryValueKind]::String)
    $baselineData = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes($sentinelInstalled))
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $restoreManifest = New-HkcuManifest $true $true 'String' $baselineData $false
    $restore = Invoke-WorkflowCleanupController $restoreManifest.Path $restoreManifest.RunId ''
    Assert-True ($restore.ExitCode -eq 0 -and
        $restore.ControllerStatus -ceq 'EMPTY_OR_CLEANED') `
      'pre-existing HKCU installed value restoration did not complete'
    $restoredKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True ($restoredKey.GetValueKind($installedName).ToString() -ceq 'String' -and
        [string]$restoredKey.GetValue($installedName) -ceq $sentinelInstalled) `
      'pre-existing HKCU installed value was not restored exactly'
    Assert-True ([string]$restoredKey.GetValue('Unrelated') -ceq $sentinelUnrelated) `
      'unrelated HKCU value was changed during baseline restoration'

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      'Unrelated', $sentinelUnrelated, [Microsoft.Win32.RegistryValueKind]::String)
    $nonemptyManifest = New-HkcuManifest $false $false $null $null $true
    $nonempty = Invoke-WorkflowCleanupController $nonemptyManifest.Path $nonemptyManifest.RunId ''
    Assert-True ($nonempty.ExitCode -eq 0) `
      'run-owned HKCU value cleanup with unrelated values failed'
    $nonemptyKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True (@($nonemptyKey.GetValueNames()) -cnotcontains $installedName -and
        [string]$nonemptyKey.GetValue('Unrelated') -ceq $sentinelUnrelated) `
      'run-owned HKCU cleanup removed its nonempty key or unrelated value'

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $emptyManifest = New-HkcuManifest $false $false $null $null $true
    $empty = Invoke-WorkflowCleanupController $emptyManifest.Path $emptyManifest.RunId ''
    Assert-True ($empty.ExitCode -eq 0 -and !(Test-Path -LiteralPath $desktopKey)) `
      'run-created empty HKCU key was not removed'

    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, 'foreign-conflict', [Microsoft.Win32.RegistryValueKind]::String)
    $conflictManifest = New-HkcuManifest $false $false $null $null $true
    $conflict = Invoke-WorkflowCleanupController `
      $conflictManifest.Path $conflictManifest.RunId ''
    Assert-True ($conflict.ExitCode -eq 21 -and
        $conflict.ReportedExitCode -eq 21 -and
        $conflict.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'conflicting HKCU installed value did not fail with fixed resource-cleanup status'
    $conflictingKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True ([string]$conflictingKey.GetValue($installedName) -ceq 'foreign-conflict') `
      'conflicting HKCU installed value was removed or changed'
    Assert-True (Test-Path -LiteralPath $conflictManifest.Path -PathType Leaf) `
      'conflicting HKCU cleanup discarded authenticated recovery authority'
    Remove-Item -LiteralPath $conflictManifest.Path -Force -ErrorAction Stop

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $provisionalManifest = New-HkcuManifest $false $false $null $null $true $true
    $provisional = Invoke-WorkflowCleanupController `
      $provisionalManifest.Path $provisionalManifest.RunId ''
    Assert-True ($provisional.ExitCode -eq 21 -and
        $provisional.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'provisional HKCU evidence authorized manual registry deletion'
    Assert-True ((Get-Item -LiteralPath $desktopKey).GetValueKind($installedName).ToString() `
        -ceq 'DWord' -and
        [int](Get-ItemPropertyValue -LiteralPath $desktopKey -Name $installedName) -eq 1) `
      'provisional HKCU installed value was removed or changed'
    Assert-True (Test-Path -LiteralPath $provisionalManifest.Path -PathType Leaf) `
      'provisional HKCU failure discarded authenticated recovery authority'
    Remove-Item -LiteralPath $provisionalManifest.Path -Force -ErrorAction Stop
  } finally {
    if (Test-Path -LiteralPath $desktopKey) {
      Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:HKCU_INSTALLED_VALUE:PRESERVED'
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
  Test-PreExistingAppPathsAuthority
  Test-HkcuInstalledValueOwnership
  Write-Host "PROPR_WINDOWS_SUPERVISOR_TESTS:${Architecture}:PASSED"
  [Console]::Out.Flush()
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
