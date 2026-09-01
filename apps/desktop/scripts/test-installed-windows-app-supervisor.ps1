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
    '-MarkerReadTimeoutMilliseconds', '200'
  )) {
    $startInfo.ArgumentList.Add([string]$argument)
  }
  if (!$UseProductionWorker) {
    $startInfo.ArgumentList.Add('-WorkerPath')
    $startInfo.ArgumentList.Add($fixtureWorkerPath)
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SCENARIO'] = $Scenario
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY'] = $StateDirectory
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SECRET'] = $secretNeedle
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

function Invoke-FixtureScenario([string]$Scenario) {
  $stateDirectory = New-StateDirectory $Scenario.ToLowerInvariant()
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-SupervisorStartInfo $Scenario $stateDirectory '' $false
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  if (!$process.Start()) { throw 'supervisor test process did not start' }
  try {
    if (!$process.WaitForExit(10000)) {
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
  $installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
  $protocolRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
  $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
  $shortcutFolder = Join-Path $commonPrograms 'ProPR Desktop'
  $shortcut = Join-Path $shortcutFolder 'ProPR Desktop.lnk'
  foreach ($path in @($installRoot, $protocolRoot, $shortcutFolder)) {
    Assert-True (!(Test-Path -LiteralPath $path)) `
      'ownership behavior test requires the same clean baseline as the installed-app harness'
  }

  $userName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $password = ConvertTo-SecureString "P!$([Guid]::NewGuid().ToString('N'))z9" -AsPlainText -Force
  $userCreated = $false
  $installCreated = $false
  $protocolCreated = $false
  $shortcutCreated = $false
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

    [void](New-Item -ItemType Directory -Path $installRoot -ErrorAction Stop)
    $installCreated = $true
    Set-Content -LiteralPath (Join-Path $installRoot 'pre-existing.txt') -Value 'owned-before-run'
    [void](New-Item -Path $protocolRoot -Force -ErrorAction Stop)
    $protocolCreated = $true
    Set-ItemProperty -LiteralPath $protocolRoot -Name 'PreExisting' -Value 'owned-before-run'
    [void](New-Item -ItemType Directory -Path $shortcutFolder -ErrorAction Stop)
    $shortcutCreated = $true
    Set-Content -LiteralPath $shortcut -Value 'owned-before-run'

    $stateDirectory = New-StateDirectory 'ownership'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = New-SupervisorStartInfo '' $stateDirectory '' $true
    if (!$process.Start()) { throw 'production ownership probe did not start' }
    try {
      Assert-True ($process.WaitForExit(20000)) 'production ownership probe did not complete within the bound'
      $output = $process.StandardOutput.ReadToEnd()
      $standardError = $process.StandardError.ReadToEnd()
      Assert-True ($process.ExitCode -ne 0) 'production worker accepted a pre-existing resource baseline'
      Assert-Contains $output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:INITIALIZATION:BASELINE:FAILED' `
        'production worker did not execute its pre-existing-resource rejection path'
      Assert-NotContains $output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:CLEANUP:PROFILE_LOOKUP:BEGIN' `
        'production worker selected a pre-existing profile for lookup'
      Assert-NotContains $output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:CLEANUP:PROFILE_REMOVE:BEGIN' `
        'production worker selected a pre-existing profile for deletion'
      $redactedEvidence = "$output`n$standardError"
      Assert-NotContains $redactedEvidence $runnerProfileBefore.IdentitySid `
        'ownership evidence exposed the runner identity SID'
      Assert-NotContains $redactedEvidence $runnerProfileBefore.CanonicalLocalPath `
        'ownership evidence exposed the runner profile path'
      Assert-NotContains $redactedEvidence $userName `
        'ownership evidence exposed the fixture local-user name'
      Assert-NotContains $redactedEvidence $userSid.Value `
        'ownership evidence exposed the fixture local-user SID'
    } finally {
      if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
      $process.Dispose()
    }

    Assert-True ((Get-Content -LiteralPath (Join-Path $installRoot 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing install tree was removed or changed'
    Assert-True ((Get-ItemPropertyValue -LiteralPath $protocolRoot -Name 'PreExisting') -ceq `
      'owned-before-run') 'pre-existing registry tree was removed or changed'
    Assert-True ((Get-Content -LiteralPath $shortcut -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing shortcut was removed or changed'
    $remainingUser = Get-LocalUser -Name $userName -ErrorAction Stop
    Assert-True ($remainingUser.SID.Equals($userSid)) 'pre-existing local user was removed or replaced'
    $fixtureUserProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $userSid.Value })
    Assert-True ($fixtureUserProfiles.Count -eq 0) `
      'pre-existing local user fixture unexpectedly acquired a profile'
  } finally {
    if ($shortcutCreated -and (Test-Path -LiteralPath $shortcutFolder)) {
      Remove-Item -LiteralPath $shortcutFolder -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($protocolCreated -and (Test-Path -LiteralPath $protocolRoot)) {
      Remove-Item -LiteralPath $protocolRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($installCreated -and (Test-Path -LiteralPath $installRoot)) {
      Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
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
