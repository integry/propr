param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)

$ErrorActionPreference = 'Stop'
$watchdogPollMilliseconds = 250
$watchdogTerminationMilliseconds = 30 * 1000
$markerName = "propr-installed-app-watchdog-$([Guid]::NewGuid().ToString('N')).marker"
$markerPath = Join-Path ([IO.Path]::GetTempPath()) $markerName
$ownershipReadyEventName = "Local\ProPRInstalledApp-$([Guid]::NewGuid().ToString('N'))"
$workerPath = Join-Path $PSScriptRoot 'test-installed-windows-app.ps1'
$worker = $null
$job = $null
$ownershipReadyEvent = $null

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class ProPRKillOnCloseJob : IDisposable
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
        SafeFileHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    public ProPRKillOnCloseJob()
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
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void AddProcess(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(handle, processHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "worker ownership failed");
    }

    public void Terminate(uint exitCode)
    {
        if (!handle.IsInvalid && !TerminateJobObject(handle, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "job termination failed");
    }

    public void Dispose()
    {
        if (handle != null) handle.Dispose();
    }
}
'@

function Read-WatchdogMarker([string]$Path) {
  try {
    if (![IO.File]::Exists($Path)) { return $null }
    $record = [IO.File]::ReadAllText($Path, [Text.Encoding]::ASCII)
    if ($record -notmatch
        '^(?<Deadline>[0-9]+)\|(?<Stage>[A-Z_]+)\|(?<Substage>[A-Z_]+)\|(?<Status>BEGIN|COMPLETE|FAILED)$') {
      return $null
    }
    return [PSCustomObject]@{
      Deadline = [int64]$Matches.Deadline
      Stage = $Matches.Stage
      Substage = $Matches.Substage
      Status = $Matches.Status
    }
  } catch {
    return $null
  }
}

try {
  $installerPath = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
  $workerPath = (Resolve-Path -LiteralPath $workerPath -ErrorAction Stop).Path
  $hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  if ([IO.Path]::GetFileName($hostPath) -notin @('pwsh.exe', 'powershell.exe')) {
    throw 'PowerShell host resolution failed'
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  $ownershipReadyEvent = [Threading.EventWaitHandle]::new(
    $false,
    [Threading.EventResetMode]::ManualReset,
    $ownershipReadyEventName
  )
  foreach ($argument in @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File', $workerPath,
    '-Installer', $installerPath,
    '-Architecture', $Architecture,
    '-WatchdogMarker', $markerPath,
    '-OwnershipReadyEvent', $ownershipReadyEventName
  )) {
    $startInfo.ArgumentList.Add($argument)
  }

  $job = [ProPRKillOnCloseJob]::new()
  $worker = [Diagnostics.Process]::new()
  $worker.StartInfo = $startInfo
  if (!$worker.Start()) { throw 'installed-app worker did not start' }
  try {
    $job.AddProcess($worker.Handle)
    [void]$ownershipReadyEvent.Set()
  } catch {
    try { $worker.Kill($true) } catch {}
    throw 'installed-app worker ownership failed'
  }

  while (!$worker.WaitForExit($watchdogPollMilliseconds)) {
    $marker = Read-WatchdogMarker $markerPath
    if ($null -ne $marker -and [DateTime]::UtcNow.Ticks -gt $marker.Deadline) {
      Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:{0}:{1}:{2}:TIMED_OUT' -f `
        $marker.Stage, $marker.Substage, $marker.Status)
      [Console]::Out.Flush()
      $job.Terminate(124)
      if (!$worker.WaitForExit($watchdogTerminationMilliseconds)) {
        throw 'installed-app worker termination timed out'
      }
      exit 124
    }
  }

  exit $worker.ExitCode
} catch {
  $lastMarker = Read-WatchdogMarker $markerPath
  if ($null -ne $lastMarker) {
    Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:{0}:{1}:{2}:ABORTED' -f `
      $lastMarker.Stage, $lastMarker.Substage, $lastMarker.Status)
    [Console]::Out.Flush()
  }
  Write-Host 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:SUPERVISOR:FAILED'
  [Console]::Out.Flush()
  if ($null -ne $job) {
    try { $job.Terminate(125) } catch {}
  }
  throw 'installed-app harness supervision failed'
} finally {
  if ($null -ne $worker) { $worker.Dispose() }
  if ($null -ne $job) { $job.Dispose() }
  if ($null -ne $ownershipReadyEvent) { $ownershipReadyEvent.Dispose() }
  try {
    if ([IO.File]::Exists($markerPath)) { [IO.File]::Delete($markerPath) }
  } catch {}
}
