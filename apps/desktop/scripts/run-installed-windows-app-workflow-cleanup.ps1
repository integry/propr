[CmdletBinding(PositionalBinding=$false)]
param(
  [object]$OwnershipManifest,
  [object]$Installer,
  [object]$ExpectedRunId,
  [object]$CleanupTimeoutMilliseconds = 4 * 60 * 1000,
  [object]$TerminationTimeoutMilliseconds = 30 * 1000,
  [object]$FixtureRoot,
  [switch]$FixtureEarlyInitializationChild,
  [switch]$FixtureResultEmissionFailure,
  [object]$StartupFailureClass,
  [object]$ProtocolFixture
)

$ErrorActionPreference = 'Stop'
$bodyPath = Join-Path $PSScriptRoot 'run-installed-windows-app-workflow-cleanup-body.ps1'

function Get-StartupFailureClass($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [Management.Automation.ParseException]) { return 'PARSER' }
    if ($exception -is [Management.Automation.ParameterBindingException]) {
      return 'PARAMETER_BINDING'
    }
    if ($exception -is [TypeLoadException] -or
        $exception -is [TypeInitializationException] -or
        $exception -is [IO.FileLoadException]) {
      return 'TYPE_LOAD'
    }
    $exception = $exception.InnerException
  }
  return 'OTHER'
}

function Write-StartupFailure($ErrorRecord) {
  $failureClass = Get-StartupFailureClass $ErrorRecord
  $line = 0
  try {
    $candidateLine = [int64]$ErrorRecord.InvocationInfo.ScriptLineNumber
    if ($candidateLine -ge 0 -and $candidateLine -le 999999) { $line = $candidateLine }
  } catch {}
  [Console]::Out.WriteLine((
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STARTUP:FAILED:' +
      'CLASS:{0}:PROCESS_EXIT:125:LINE:{1}') -f `
      $failureClass, $line
  ))
  [Console]::Out.Flush()
  [Console]::Out.WriteLine(
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
      'RESULT:FAILED:STATUS:STARTUP_FAILURE:EXIT_CODE:125'))
  [Console]::Out.Flush()
}

function Invoke-ProtocolFixture([string]$Name) {
  $startup = 'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STARTUP:READY'
  $terminal = ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
    'RESULT:FAILED:STATUS:CONTROLLER_FAILURE:EXIT_CODE:125')
  switch ($Name) {
    'ONE_LINE_STARTUP' {
      [Console]::Out.Write("$startup`r`n"); [Console]::Out.Flush(); exit 125
    }
    'MISSING_TERMINAL' {
      [Console]::Out.Write("$startup`r`n"); [Console]::Out.Flush(); exit 125
    }
    'DUPLICATE_STARTUP' {
      [Console]::Out.Write("$startup`r`n$startup`r`n$terminal`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'EXTRA_RECORD' {
      [Console]::Out.Write("$startup`r`n$terminal`r`nEXTRA`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'REORDERED_RECORDS' {
      [Console]::Out.Write("$terminal`r`n$startup`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'OVERSIZED_RECORD' {
      [Console]::Out.Write(('A' * 385) + "`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'MALFORMED_RECORD' {
      [Console]::Out.Write("MALFORMED`r`n$terminal`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'PARTIAL_RECORD' {
      [Console]::Out.Write($startup); [Console]::Out.Flush(); exit 125
    }
    'STDERR_RECORD' {
      [Console]::Out.Write("$startup`r`n$terminal`r`n"); [Console]::Out.Flush()
      [Console]::Error.Write('E'); [Console]::Error.Flush(); exit 125
    }
    'TIMEOUT_BEFORE_STARTUP' { [Threading.Thread]::Sleep(60000); exit 125 }
    'TIMEOUT_AFTER_STARTUP' {
      [Console]::Out.Write("$startup`r`n"); [Console]::Out.Flush()
      [Threading.Thread]::Sleep(60000); exit 125
    }
    'MISMATCHED_MANIFEST_EXIT_125' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:MANIFEST_VALIDATION_FAILURE:EXIT_CODE:125`r`n"))
      [Console]::Out.Flush(); exit 125
    }
    'MISMATCHED_CHILD_STDOUT_EXIT_21' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:CHILD_STDOUT:EXIT_CODE:21`r`n"))
      [Console]::Out.Flush(); exit 21
    }
    'EXACT_MANIFEST_20' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:MANIFEST_VALIDATION_FAILURE:EXIT_CODE:20`r`n"))
      [Console]::Out.Flush(); exit 20
    }
    'EXACT_OWNED_RESOURCE_21' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:OWNED_RESOURCE_CLEANUP_FAILURE:EXIT_CODE:21`r`n"))
      [Console]::Out.Flush(); exit 21
    }
    'EXACT_CHILD_STDOUT_122' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:CHILD_STDOUT:EXIT_CODE:122`r`n"))
      [Console]::Out.Flush(); exit 122
    }
    'EXACT_CHILD_STDERR_123' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:CHILD_STDERR:EXIT_CODE:123`r`n"))
      [Console]::Out.Flush(); exit 123
    }
    'EXACT_TIMEOUT_124' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:TIMED_OUT:STATUS:TIMEOUT:EXIT_CODE:124`r`n"))
      [Console]::Out.Flush(); exit 124
    }
    'EXACT_CONTROLLER_FAILURE_125' {
      [Console]::Out.Write("$startup`r`n$terminal`r`n")
      [Console]::Out.Flush(); exit 125
    }
    'EXACT_FINALIZATION_FAILURE_125' {
      [Console]::Out.Write(
        "$startup`r`n" +
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
          "RESULT:FAILED:STATUS:PROCESS_FINALIZATION_FAILURE:EXIT_CODE:125`r`n"))
      [Console]::Out.Flush(); exit 125
    }
    'STREAM_DRAIN_RACE' {
      [Console]::Out.Write("$startup`r`n$terminal`r`n"); [Console]::Out.Flush()
      $child = [Diagnostics.ProcessStartInfo]::new()
      $child.FileName = (Get-Process -Id $PID -ErrorAction Stop).Path
      $child.UseShellExecute = $false
      $child.ArgumentList.Add('-NoLogo')
      $child.ArgumentList.Add('-NoProfile')
      $child.ArgumentList.Add('-NonInteractive')
      $child.ArgumentList.Add('-Command')
      $child.ArgumentList.Add('[Threading.Thread]::Sleep(60000)')
      [void][Diagnostics.Process]::Start($child)
      exit 125
    }
    'INVALID_STARTUP_METADATA' {
      [Console]::Out.Write(
        ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STARTUP:FAILED:' +
          "CLASS:INVALID:PROCESS_EXIT:125:LINE:0`r`n$terminal`r`n"))
      [Console]::Out.Flush(); exit 125
    }
    default { throw [InvalidOperationException]::new('protocol fixture is invalid') }
  }
}

try {
  if ($null -ne $ProtocolFixture) {
    Invoke-ProtocolFixture ([string]$ProtocolFixture)
  }
  if ($null -ne $StartupFailureClass) {
    switch ([string]$StartupFailureClass) {
      'PARSER' { [void][scriptblock]::Create('{') }
      'PARAMETER_BINDING' {
        function Invoke-StartupBindingProbe {
          param([Parameter(Mandatory=$true)][int]$Value)
        }
        Invoke-StartupBindingProbe -Value ([object]::new())
      }
      'TYPE_LOAD' { throw [TypeLoadException]::new('startup type-load fixture') }
      'OTHER' { throw [InvalidOperationException]::new('startup other fixture') }
      default { throw [InvalidOperationException]::new('startup fixture class is invalid') }
    }
  }
  $bodyParameters = @{
    OwnershipManifest = $OwnershipManifest
    Installer = $Installer
    ExpectedRunId = $ExpectedRunId
    CleanupTimeoutMilliseconds = $CleanupTimeoutMilliseconds
    TerminationTimeoutMilliseconds = $TerminationTimeoutMilliseconds
    FixtureRoot = $FixtureRoot
  }
  if ([bool]$FixtureEarlyInitializationChild) {
    $bodyParameters.FixtureEarlyInitializationChild = $true
  }
  if ([bool]$FixtureResultEmissionFailure) {
    $bodyParameters.FixtureResultEmissionFailure = $true
  }
  $LASTEXITCODE = $null
  & $bodyPath @bodyParameters
  $bodyExitCode = 0
  if ($null -eq $LASTEXITCODE -or
      ![int]::TryParse(
        [string]$LASTEXITCODE,
        [Globalization.NumberStyles]::AllowLeadingSign,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$bodyExitCode
      ) -or $bodyExitCode -notin @(0,20,21,122,123,124,125)) {
    throw [InvalidOperationException]::new('workflow cleanup body returned without a fixed exit')
  }
  exit $bodyExitCode
} catch {
  Write-StartupFailure $_
  exit 125
}
