param(
  [Parameter(Mandatory=$true)][string]$OwnershipManifest,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedRunId,
  [ValidateRange(1,600000)][int]$CleanupTimeoutMilliseconds = 4 * 60 * 1000,
  [ValidateRange(1,30000)][int]$TerminationTimeoutMilliseconds = 30 * 1000,
  [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$cleanupProcess = $null
$cleanupJob = $null
$cleanupReadyEvent = $null
$outputDrain = $null
$fixedResult = 'FAILED'
$fixedStatus = 'CONTROLLER_FAILURE'
$fixedExitCode = 125
$validatedManifestPath = $null

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

    public void Terminate(uint exitCode)
    {
        if (!handle.IsInvalid && !TerminateJobObject(handle, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "cleanup termination failed");
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
        standardOutputTask = Pump(process.StandardOutput, cancellation.Token);
        standardErrorTask = Pump(process.StandardError, cancellation.Token);
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

    public void Dispose()
    {
        cancellation.Cancel();
        cancellation.Dispose();
    }
}
'@

function Write-FixedResult([ValidateSet('COMPLETE','FAILED','TIMED_OUT')][string]$Result) {
  Write-Host "PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:$Result"
  Write-Host (
    'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:STATUS:{0}:EXIT_CODE:{1}' -f `
      $script:fixedStatus, $script:fixedExitCode)
  [Console]::Out.Flush()
}

try {
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
  $cleanupJob = [ProPRWorkflowCleanupJob]::new()
  $cleanupProcess = [Diagnostics.Process]::new()
  $cleanupProcess.StartInfo = $startInfo
  if (!$cleanupProcess.Start()) { throw 'workflow cleanup did not start' }
  $outputDrain = [ProPRWorkflowCleanupOutputDrain]::new()
  $outputDrain.Start($cleanupProcess)
  try {
    $cleanupJob.AddProcess($cleanupProcess.Handle)
    [void]$cleanupReadyEvent.Set()
  } catch {
    try { $cleanupProcess.Kill($true) } catch {}
    throw 'workflow cleanup ownership failed'
  }
  if (!$cleanupProcess.WaitForExit($CleanupTimeoutMilliseconds)) {
    $terminationVerified = $false
    try {
      $cleanupJob.Terminate(125)
      $terminationVerified = $cleanupProcess.WaitForExit($TerminationTimeoutMilliseconds) -and
        $cleanupProcess.HasExited
    } catch {}
    if ($terminationVerified) {
      $fixedResult = 'TIMED_OUT'
      $fixedStatus = 'TIMEOUT'
      $fixedExitCode = 124
    } else {
      $fixedResult = 'FAILED'
      $fixedStatus = 'TERMINATION_FAILURE'
      $fixedExitCode = 125
    }
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
} catch {
  $fixedResult = 'FAILED'
  $fixedStatus = 'CONTROLLER_FAILURE'
  $fixedExitCode = 125
}

try {
  if ($null -ne $cleanupProcess -and !$cleanupProcess.HasExited) {
    if ($null -ne $cleanupJob) {
      $cleanupJob.Dispose()
      $cleanupJob = $null
    }
    if (!$cleanupProcess.WaitForExit($TerminationTimeoutMilliseconds) -or
        !$cleanupProcess.HasExited) {
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
  if ($null -ne $outputDrain) {
    $drainResult = $outputDrain.Finish($TerminationTimeoutMilliseconds)
    if ($null -eq $drainResult) {
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

foreach ($resource in @($outputDrain, $cleanupJob, $cleanupProcess, $cleanupReadyEvent)) {
  if ($null -eq $resource) { continue }
  try { $resource.Dispose() } catch {
    $fixedResult = 'FAILED'
    $fixedStatus = 'RESOURCE_FINALIZATION_FAILURE'
    $fixedExitCode = 125
  }
}

if ($fixedResult -ceq 'COMPLETE' -and $validatedManifestPath) {
  try {
    foreach ($path in @("$validatedManifestPath.new", $validatedManifestPath)) {
      if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
    }
  } catch {
    $fixedResult = 'FAILED'
    $fixedStatus = 'AUTHORITY_FINALIZATION_FAILURE'
    $fixedExitCode = 125
  }
}

Write-FixedResult $fixedResult

exit $fixedExitCode
