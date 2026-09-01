param(
  [object]$OwnershipManifest,
  [object]$Installer,
  [object]$ExpectedRunId,
  [object]$CleanupTimeoutMilliseconds = 4 * 60 * 1000,
  [object]$TerminationTimeoutMilliseconds = 30 * 1000,
  [object]$FixtureRoot,
  [object]$FixtureEarlyInitializationChild,
  [object]$StartupFailureClass
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
  [Console]::Out.WriteLine('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:FAILED')
  [Console]::Out.WriteLine((
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STATUS:STARTUP_FAILURE:' +
      'EXIT_CODE:125:STARTUP_CLASS:{0}:PROCESS_EXIT:125:LINE:{1}') -f `
      $failureClass, $line
  ))
  [Console]::Out.Flush()
}

try {
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
