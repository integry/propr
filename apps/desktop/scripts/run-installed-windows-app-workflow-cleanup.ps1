param(
  [object]$OwnershipManifest,
  [object]$Installer,
  [object]$ExpectedRunId,
  [object]$CleanupTimeoutMilliseconds = 4 * 60 * 1000,
  [object]$TerminationTimeoutMilliseconds = 30 * 1000,
  [object]$FixtureRoot,
  [switch]$FixtureEarlyInitializationChild
)

enum WorkflowCleanupControllerPhase {
  INITIALIZATION
  PARAMETER_VALIDATION
  PATH_VALIDATION
  PROCESS_START
  PROCESS_WAIT
  PROCESS_FINALIZATION
  STREAM_FINALIZATION
  RESOURCE_FINALIZATION
  AUTHORITY_FINALIZATION
  RESULT_EMISSION
}

enum WorkflowCleanupControllerLine {
  TYPE_LOAD
  PARAMETERS
  PATHS
  START
  WAIT
  TERMINATE
  DRAIN
  DISPOSE
  AUTHORITY
  EMIT
}

$ErrorActionPreference = 'Stop'
$cleanupProcess = $null
$cleanupJob = $null
$cleanupReadyEvent = $null
$outputDrain = $null
$fixedResult = 'FAILED'
$fixedStatus = 'CONTROLLER_FAILURE'
$fixedExitCode = 125
$validatedManifestPath = $null
[WorkflowCleanupControllerPhase]$controllerPhase = 'INITIALIZATION'
[WorkflowCleanupControllerLine]$controllerLine = 'TYPE_LOAD'
$cleanupTreeZeroVerified = $false

function Write-FixedResult([ValidateSet('COMPLETE','FAILED','TIMED_OUT')][string]$Result) {
  [Console]::Out.WriteLine("PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:$Result")
  [Console]::Out.WriteLine(
    'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STATUS:{0}:EXIT_CODE:{1}' -f `
      $script:fixedStatus, $script:fixedExitCode)
  [Console]::Out.Flush()
}

function Set-CaughtControllerFailure($ErrorRecord) {
  $phases = @(
    'INITIALIZATION','PARAMETER_VALIDATION','PATH_VALIDATION','PROCESS_START',
    'PROCESS_WAIT','PROCESS_FINALIZATION','STREAM_FINALIZATION',
    'RESOURCE_FINALIZATION','AUTHORITY_FINALIZATION','RESULT_EMISSION'
  )
  $lines = @(
    'TYPE_LOAD','PARAMETERS','PATHS','START','WAIT','TERMINATE','DRAIN',
    'DISPOSE','AUTHORITY','EMIT'
  )
  $categories = @{
    AuthenticationError = 'AUTHENTICATION'
    CloseError = 'CLOSE'
    InvalidArgument = 'INVALID_ARGUMENT'
    InvalidData = 'INVALID_DATA'
    InvalidOperation = 'INVALID_OPERATION'
    LimitsExceeded = 'LIMIT'
    NotEnabled = 'NOT_ENABLED'
    ObjectNotFound = 'NOT_FOUND'
    OpenError = 'OPEN'
    OperationStopped = 'STOPPED'
    PermissionDenied = 'PERMISSION'
    ReadError = 'READ'
    ResourceBusy = 'BUSY'
    ResourceUnavailable = 'UNAVAILABLE'
    SecurityError = 'SECURITY'
    WriteError = 'WRITE'
  }
  $phase = if ($phases -ccontains [string]$script:controllerPhase) {
    [string]$script:controllerPhase
  } else { 'INITIALIZATION' }
  $line = if ($lines -ccontains [string]$script:controllerLine) {
    [string]$script:controllerLine
  } else { 'TYPE_LOAD' }
  $categoryName = [string]$ErrorRecord.CategoryInfo.Category
  $category = if ($categories.ContainsKey($categoryName)) {
    $categories[$categoryName]
  } else { 'UNCLASSIFIED' }
  $script:fixedResult = 'FAILED'
  $script:fixedStatus = 'CONTROLLER_{0}_{1}_{2}' -f $phase, $line, $category
  $script:fixedExitCode = 125
}

$invokeController = {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class ProPRWorkflowCleanupJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private SafeFileHandle handle;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        SafeFileHandle job, int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength, IntPtr returnLength);

    public ProPRWorkflowCleanupJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == null || handle.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "job creation failed");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "job configuration failed");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void AddProcess(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(handle, processHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "cleanup ownership failed");
    }

    private uint ReadActiveProcessCount()
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("job handle is unavailable");
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(handle, 1, out information, size, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "cleanup accounting failed");
        return information.ActiveProcesses;
    }

    public bool WaitForNoActiveProcesses(int timeoutMilliseconds)
    {
        var stopwatch = Stopwatch.StartNew();
        do
        {
            if (ReadActiveProcessCount() == 0) return true;
            Thread.Sleep(25);
        }
        while (stopwatch.ElapsedMilliseconds < timeoutMilliseconds);
        return ReadActiveProcessCount() == 0;
    }

    public bool HasNoActiveProcesses()
    {
        return ReadActiveProcessCount() == 0;
    }

    public bool TerminateAndWait(uint exitCode, int timeoutMilliseconds)
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("job handle is unavailable");
        if (!TerminateJobObject(handle, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "cleanup termination failed");
        return WaitForNoActiveProcesses(timeoutMilliseconds);
    }

    public void Dispose() { if (handle != null) handle.Dispose(); }
}

public sealed class ProPRWorkflowCleanupDrainResult
{
    public long StandardOutputCharacters;
    public long StandardErrorCharacters;
}

public sealed class ProPRWorkflowCleanupOutputDrain : IDisposable
{
    private const long CharacterLimit = 4096;
    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private StreamReader standardOutputReader;
    private StreamReader standardErrorReader;
    private Task<long> standardOutputTask;
    private Task<long> standardErrorTask;

    private static async Task<long> Pump(StreamReader reader, CancellationToken token)
    {
        var buffer = new char[1024];
        long characters = 0;
        while (true)
        {
            int count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
            if (count == 0) return characters;
            token.ThrowIfCancellationRequested();
            characters = Math.Min(CharacterLimit + 1, characters + count);
        }
    }

    public void Start(Process process)
    {
        if (standardOutputTask != null || standardErrorTask != null)
            throw new InvalidOperationException("stream drain was already started");
        standardOutputReader = process.StandardOutput;
        standardErrorReader = process.StandardError;
        standardOutputTask = Pump(standardOutputReader, cancellation.Token);
        standardErrorTask = Pump(standardErrorReader, cancellation.Token);
    }

    public ProPRWorkflowCleanupDrainResult Finish(int timeoutMilliseconds)
    {
        if (standardOutputTask == null || standardErrorTask == null)
            throw new InvalidOperationException("stream drain was not started");
        Task all = Task.WhenAll(standardOutputTask, standardErrorTask);
        if (!all.Wait(timeoutMilliseconds)) return null;
        if (standardOutputTask.IsFaulted || standardOutputTask.IsCanceled ||
            standardErrorTask.IsFaulted || standardErrorTask.IsCanceled)
            throw new InvalidOperationException("stream drain failed");
        return new ProPRWorkflowCleanupDrainResult {
            StandardOutputCharacters = standardOutputTask.Result,
            StandardErrorCharacters = standardErrorTask.Result
        };
    }

    public bool CancelAndFinish(int timeoutMilliseconds)
    {
        cancellation.Cancel();
        try { if (standardOutputReader != null) standardOutputReader.Dispose(); } catch { }
        try { if (standardErrorReader != null) standardErrorReader.Dispose(); } catch { }
        if (standardOutputTask == null || standardErrorTask == null) return true;
        try { Task.WhenAll(standardOutputTask, standardErrorTask).Wait(timeoutMilliseconds); }
        catch { }
        return standardOutputTask.IsCompleted && standardErrorTask.IsCompleted;
    }

    public void Dispose()
    {
        CancelAndFinish(1000);
        cancellation.Dispose();
    }
}
'@

$controllerPhase = 'PARAMETER_VALIDATION'
$controllerLine = 'PARAMETERS'
$cleanupTimeout = 0
$terminationTimeout = 0
if ([string]::IsNullOrWhiteSpace([string]$OwnershipManifest) -or
    [string]::IsNullOrWhiteSpace([string]$Installer) -or
    [string]::IsNullOrWhiteSpace([string]$ExpectedRunId) -or
    ![int]::TryParse(
      [string]$CleanupTimeoutMilliseconds,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$cleanupTimeout
    ) -or $cleanupTimeout -lt 1 -or $cleanupTimeout -gt 600000 -or
    ![int]::TryParse(
      [string]$TerminationTimeoutMilliseconds,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$terminationTimeout
    ) -or $terminationTimeout -lt 1 -or $terminationTimeout -gt 30000) {
  throw 'workflow cleanup controller parameters are invalid'
}
$OwnershipManifest = [string]$OwnershipManifest
$Installer = [string]$Installer
$ExpectedRunId = [string]$ExpectedRunId
$FixtureRoot = if ($null -eq $FixtureRoot) { $null } else { [string]$FixtureRoot }
$CleanupTimeoutMilliseconds = $cleanupTimeout
$TerminationTimeoutMilliseconds = $terminationTimeout

  $controllerPhase = 'PATH_VALIDATION'
  $controllerLine = 'PATHS'
  if ($ExpectedRunId -notmatch '^[a-f0-9]{32}$') { throw 'cleanup run identity is invalid' }
  $manifestPath = [IO.Path]::GetFullPath($OwnershipManifest)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ((Split-Path -Leaf $manifestPath) -cne
        "propr-installed-app-ownership-$ExpectedRunId.json" -or
      ![string]::Equals(
        (Split-Path -Parent $manifestPath).TrimEnd('\'),
        $tempRoot,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw 'cleanup manifest path is invalid'
  }
  $validatedManifestPath = $manifestPath
  $installerPath = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
  $cleanupWorkerPath = (Resolve-Path -LiteralPath
    (Join-Path $PSScriptRoot 'cleanup-installed-windows-app.ps1') -ErrorAction Stop).Path
  $hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  if ([IO.Path]::GetFileName($hostPath) -notin @('pwsh.exe', 'powershell.exe')) {
    throw 'PowerShell host resolution failed'
  }
  $cleanupReadyEventName = "Local\ProPRInstalledAppCleanup-$([Guid]::NewGuid().ToString('N'))"
  $cleanupReadyEvent = [Threading.EventWaitHandle]::new(
    $false,
    [Threading.EventResetMode]::ManualReset,
    $cleanupReadyEventName
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $cleanupWorkerPath,
    '-OwnershipManifest', $manifestPath,
    '-Installer', $installerPath,
    '-ExpectedRunId', $ExpectedRunId,
    '-OwnershipReadyEvent', $cleanupReadyEventName
  )) {
    $startInfo.ArgumentList.Add($argument)
  }
  if ($FixtureRoot) {
    $startInfo.ArgumentList.Add('-FixtureRoot')
    $startInfo.ArgumentList.Add((Resolve-Path -LiteralPath $FixtureRoot -ErrorAction Stop).Path)
  }
  if ($FixtureEarlyInitializationChild) {
    if (!$FixtureRoot) { throw 'early initialization fixture requires a fixture scope' }
    $startInfo.ArgumentList.Add('-FixtureEarlyInitializationChild')
  }
  $cleanupJob = [ProPRWorkflowCleanupJob]::new()
  $controllerPhase = 'PROCESS_START'
  $controllerLine = 'START'
  $cleanupProcess = [Diagnostics.Process]::new()
  $cleanupProcess.StartInfo = $startInfo
  if (!$cleanupProcess.Start()) { throw 'workflow cleanup did not start' }
  try {
    $cleanupJob.AddProcess($cleanupProcess.Handle)
    $outputDrain = [ProPRWorkflowCleanupOutputDrain]::new()
    $outputDrain.Start($cleanupProcess)
    [void]$cleanupReadyEvent.Set()
  } catch {
    try {
      $cleanupTreeZeroVerified = $cleanupJob.TerminateAndWait(
        125, $TerminationTimeoutMilliseconds)
    } catch {}
    try {
      if (!$cleanupProcess.HasExited) {
        $cleanupProcess.Kill($true)
        [void]$cleanupProcess.WaitForExit($TerminationTimeoutMilliseconds)
      }
    } catch {}
    throw 'workflow cleanup ownership failed'
  }
  $controllerPhase = 'PROCESS_WAIT'
  $controllerLine = 'WAIT'
  if (!$cleanupProcess.WaitForExit($CleanupTimeoutMilliseconds)) {
    $controllerLine = 'TERMINATE'
    $terminationVerified = $false
    try {
      $terminationVerified = $cleanupJob.TerminateAndWait(
        125, $TerminationTimeoutMilliseconds)
    } catch {}
    if ($terminationVerified) {
      $cleanupTreeZeroVerified = $true
      $fixedResult = 'TIMED_OUT'
      $fixedStatus = 'TIMEOUT'
      $fixedExitCode = 124
    } else {
      $fixedResult = 'FAILED'
      $fixedStatus = 'TERMINATION_FAILURE'
      $fixedExitCode = 125
    }
  } else {
    $cleanupTreeZeroVerified = $cleanupJob.HasNoActiveProcesses()
    if (!$cleanupTreeZeroVerified) {
      try {
        $cleanupTreeZeroVerified = $cleanupJob.TerminateAndWait(
          125, $TerminationTimeoutMilliseconds)
      } catch {}
      $fixedResult = 'FAILED'
      $fixedStatus = 'ACTIVE_PROCESS_AFTER_ROOT_EXIT'
      $fixedExitCode = 125
    } elseif ($cleanupProcess.ExitCode -eq 0) {
      $fixedResult = 'COMPLETE'
      $fixedStatus = 'EMPTY_OR_CLEANED'
      $fixedExitCode = 0
    } elseif ($cleanupProcess.ExitCode -eq 20) {
      $fixedStatus = 'MANIFEST_VALIDATION_FAILURE'
      $fixedExitCode = 20
    } elseif ($cleanupProcess.ExitCode -eq 21) {
      $fixedStatus = 'OWNED_RESOURCE_CLEANUP_FAILURE'
      $fixedExitCode = 21
    }
  }
}

# Keep the top-level launcher syntactically small and stable. Dot-sourcing the
# body preserves script scope while the catch consumes type-load and body errors
# without allowing the host to render raw diagnostics.
try {
  . $invokeController
} catch {
  Set-CaughtControllerFailure $_
}

try {
  $controllerPhase = 'PROCESS_FINALIZATION'
  $controllerLine = 'TERMINATE'
  if ($null -ne $cleanupJob -and !$cleanupTreeZeroVerified) {
    $cleanupTreeZeroVerified = $cleanupJob.TerminateAndWait(
      125, $TerminationTimeoutMilliseconds)
    if (!$cleanupTreeZeroVerified) {
      $fixedResult = 'FAILED'
      $fixedStatus = 'PROCESS_FINALIZATION_TIMEOUT'
      $fixedExitCode = 125
    }
  }
} catch {
  $fixedResult = 'FAILED'
  $fixedStatus = 'PROCESS_FINALIZATION_FAILURE'
  $fixedExitCode = 125
}

try {
  $controllerPhase = 'STREAM_FINALIZATION'
  $controllerLine = 'DRAIN'
  if ($null -ne $outputDrain) {
    $drainResult = $outputDrain.Finish($TerminationTimeoutMilliseconds)
    if ($null -eq $drainResult) {
      [void]$outputDrain.CancelAndFinish($TerminationTimeoutMilliseconds)
      $fixedResult = 'FAILED'
      $fixedStatus = 'STREAM_DRAIN_TIMEOUT'
      $fixedExitCode = 125
    } elseif ($drainResult.StandardErrorCharacters -ne 0) {
      $fixedResult = 'FAILED'
      $fixedStatus = if ($drainResult.StandardErrorCharacters -gt 4096) {
        'CHILD_STDERR_LIMIT'
      } else { 'CHILD_STDERR' }
      $fixedExitCode = 123
    } elseif ($drainResult.StandardOutputCharacters -ne 0) {
      $fixedResult = 'FAILED'
      $fixedStatus = if ($drainResult.StandardOutputCharacters -gt 4096) {
        'CHILD_STDOUT_LIMIT'
      } else { 'CHILD_STDOUT' }
      $fixedExitCode = 122
    }
  }
} catch {
  $fixedResult = 'FAILED'
  $fixedStatus = 'STREAM_DRAIN_FAILURE'
  $fixedExitCode = 125
}

$controllerPhase = 'RESOURCE_FINALIZATION'
$controllerLine = 'DISPOSE'
foreach ($resource in @($outputDrain, $cleanupJob, $cleanupProcess, $cleanupReadyEvent)) {
  if ($null -eq $resource) { continue }
  try { $resource.Dispose() } catch {
    $fixedResult = 'FAILED'
    $fixedStatus = 'RESOURCE_FINALIZATION_FAILURE'
    $fixedExitCode = 125
  }
}

if ($fixedResult -ceq 'COMPLETE' -and $cleanupTreeZeroVerified -and
    $validatedManifestPath) {
  try {
    $controllerPhase = 'AUTHORITY_FINALIZATION'
    $controllerLine = 'AUTHORITY'
    foreach ($path in @("$validatedManifestPath.new", $validatedManifestPath)) {
      if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
    }
  } catch {
    $fixedResult = 'FAILED'
    $fixedStatus = 'AUTHORITY_FINALIZATION_FAILURE'
    $fixedExitCode = 125
  }
}

try {
  $controllerPhase = 'RESULT_EMISSION'
  $controllerLine = 'EMIT'
  Write-FixedResult $fixedResult
} catch {
  Set-CaughtControllerFailure $_
  exit 125
}

exit $fixedExitCode
