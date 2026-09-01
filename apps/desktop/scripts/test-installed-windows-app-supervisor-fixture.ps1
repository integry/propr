param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$WatchdogMarker,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent
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
    'CANCELLATION'
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
    Start-Sleep -Milliseconds 300
    Write-FixtureMarker ('{0}|INSTALL|MSI_INSTALL|BEGIN' -f [DateTime]::UtcNow.AddMilliseconds(350).Ticks)
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
}

$descendant.Dispose()
