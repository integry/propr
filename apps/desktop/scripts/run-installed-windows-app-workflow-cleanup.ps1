param(
  [Parameter(Mandatory=$true)][string]$OwnershipManifest,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedRunId,
  [ValidateRange(1000,600000)][int]$CleanupTimeoutMilliseconds = 4 * 60 * 1000,
  [ValidateRange(1,30000)][int]$TerminationTimeoutMilliseconds = 30 * 1000,
  [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$cleanupProcess = $null
$cleanupJob = $null
$cleanupReadyEvent = $null
$fixedResult = 'FAILED'
$validatedManifestPath = $null

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
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
'@

function Write-FixedResult([ValidateSet('COMPLETE','FAILED','TIMED_OUT')][string]$Result) {
  Write-Host "PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:$Result"
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
  try {
    $cleanupJob.AddProcess($cleanupProcess.Handle)
    [void]$cleanupReadyEvent.Set()
  } catch {
    try { $cleanupProcess.Kill($true) } catch {}
    throw 'workflow cleanup ownership failed'
  }
  if (!$cleanupProcess.WaitForExit($CleanupTimeoutMilliseconds)) {
    try { $cleanupJob.Terminate(125) } catch {}
    try { [void]$cleanupProcess.WaitForExit($TerminationTimeoutMilliseconds) } catch {}
    $fixedResult = 'TIMED_OUT'
  } elseif ($cleanupProcess.ExitCode -eq 0) {
    $fixedResult = 'COMPLETE'
  }
} catch {
  $fixedResult = 'FAILED'
} finally {
  Write-FixedResult $fixedResult
  if ($null -ne $cleanupJob) { $cleanupJob.Dispose() }
  if ($null -ne $cleanupProcess) { $cleanupProcess.Dispose() }
  if ($null -ne $cleanupReadyEvent) { $cleanupReadyEvent.Dispose() }
  if ($validatedManifestPath) {
    foreach ($path in @($validatedManifestPath, "$validatedManifestPath.new")) {
      try { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } } catch {}
    }
  }
}

if ($fixedResult -ne 'COMPLETE') { exit 1 }
exit 0
