param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [string]$WorkerPath,
  [ValidateRange(1,60000)][int]$BootstrapTimeoutMilliseconds = 60 * 1000,
  [ValidateRange(1,10000)][int]$WatchdogPollMilliseconds = 250,
  [ValidateRange(1,30000)][int]$WatchdogTerminationMilliseconds = 30 * 1000,
  [ValidateRange(1000,600000)][int]$PostTerminationCleanupMilliseconds = 4 * 60 * 1000,
  [ValidateRange(1,5000)][int]$MarkerReadTimeoutMilliseconds = 250,
  [string]$CancellationEventName,
  [string]$FixtureCleanupRoot,
  [string]$OwnershipManifest,
  [string]$ExpectedRunId,
  [switch]$InjectTerminationFailure
)

$ErrorActionPreference = 'Stop'
$maximumMarkerDeadlineMilliseconds = 11 * 60 * 1000
$watchdogStages = @(
  'INITIALIZATION','INSTALL','VALIDATION','USER_SETUP','APP_LAUNCH','APP_EXIT','UNINSTALL','CLEANUP'
)
$watchdogSubstages = @(
  'PATHS',
  'BASELINE',
  'MSI_INSTALL',
  'OWNERSHIP_CAPTURE',
  'INSTALL_TREE_SCAN',
  'APPLICATION_IMAGE',
  'PROTOCOL_ASSERTION',
  'APP_PATH_ASSERTION',
  'HKCU_INSTALLED_ASSERTION',
  'SHORTCUT_ASSERTION',
  'USER_CREATE',
  'USER_SID',
  'SMOKE_DATA_CREATE',
  'SHORTCUT_PRESENT_PROBE',
  'ALTERNATE_USER_START',
  'APPLICATION_WAIT',
  'STREAM_DRAIN',
  'EVIDENCE_INSPECTION',
  'MSI_UNINSTALL',
  'INSTALL_TREE_ASSERTION',
  'PROTOCOL_ABSENCE_ASSERTION',
  'APP_PATH_ABSENCE_ASSERTION',
  'HKCU_INSTALLED_ABSENCE_ASSERTION',
  'SHORTCUT_FILE_ASSERTION',
  'SHORTCUT_FOLDER_ASSERTION',
  'SHORTCUT_ABSENCE_PROBE',
  'SMOKE_DATA_REMOVE',
  'PROFILE_LOOKUP',
  'PROFILE_REMOVE',
  'USER_LOOKUP',
  'USER_REMOVE',
  'INSTALL_ROOT_FALLBACK',
  'PROTOCOL_FALLBACK',
  'APP_PATH_FALLBACK',
  'HKCU_INSTALLED_FALLBACK',
  'SHORTCUT_FALLBACK'
)
$markerName = "propr-installed-app-watchdog-$([Guid]::NewGuid().ToString('N')).marker"
$markerPath = Join-Path ([IO.Path]::GetTempPath()) $markerName
$generatedRunId = [Guid]::NewGuid().ToString('N')
$ownershipManifestName = "propr-installed-app-ownership-$generatedRunId.json"
$ownershipManifestPath = Join-Path ([IO.Path]::GetTempPath()) $ownershipManifestName
$workflowManagedManifest = $false
$ownershipReadyEventName = "Local\ProPRInstalledApp-$([Guid]::NewGuid().ToString('N'))"
$productionWorkerPath = Join-Path $PSScriptRoot 'test-installed-windows-app.ps1'
$cleanupWorkerPath = Join-Path $PSScriptRoot 'cleanup-installed-windows-app.ps1'
$worker = $null
$job = $null
$ownershipReadyEvent = $null
$cancellationEvent = $null
$lastValidMarker = $null
$exitCode = 125
$terminateOwnedTree = $false
$workerStarted = $false
$supervisorOutcomeComplete = $false

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
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
        SafeFileHandle job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

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

    private uint ReadActiveProcessCount()
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(handle, 1, out information, size, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "job accounting failed");
        return information.ActiveProcesses;
    }

    public bool TerminateAndWait(uint exitCode, int timeoutMilliseconds)
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("job handle is unavailable");
        if (!TerminateJobObject(handle, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "job termination failed");
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        do
        {
            if (ReadActiveProcessCount() == 0) return true;
            System.Threading.Thread.Sleep(25);
        }
        while (stopwatch.ElapsedMilliseconds < timeoutMilliseconds);
        return ReadActiveProcessCount() == 0;
    }

    public void Dispose()
    {
        if (handle != null) handle.Dispose();
    }
}

public enum ProPRMarkerReadState
{
    Missing,
    Valid,
    Invalid,
    Inaccessible
}

public sealed class ProPRMarkerReadResult
{
    public ProPRMarkerReadState State;
    public long Deadline;
    public string Stage;
    public string Substage;
    public string Status;
}

public static class ProPRBoundedMarkerReader
{
    private const int MaximumMarkerBytes = 256;
    private static readonly Regex MarkerPattern = new Regex(
        "^(?<Deadline>[0-9]+)\\|(?<Stage>[A-Z_]+)\\|(?<Substage>[A-Z_]+)\\|(?<Status>BEGIN|COMPLETE|FAILED)$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static Task<ProPRMarkerReadResult> ReadAsync(string path)
    {
        return Task.Run(() => Read(path));
    }

    private static ProPRMarkerReadResult Result(ProPRMarkerReadState state)
    {
        return new ProPRMarkerReadResult { State = state };
    }

    private static ProPRMarkerReadResult Read(string path)
    {
        try
        {
            var item = new FileInfo(path);
            item.Refresh();
            if (!item.Exists) return Result(ProPRMarkerReadState.Missing);
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0 || item.Length <= 0 ||
                item.Length > MaximumMarkerBytes)
                return Result(ProPRMarkerReadState.Invalid);

            int length = checked((int)item.Length);
            var bytes = new byte[length];
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 256, FileOptions.SequentialScan))
            {
                int offset = 0;
                while (offset < length)
                {
                    int read = stream.Read(bytes, offset, length - offset);
                    if (read == 0) return Result(ProPRMarkerReadState.Invalid);
                    offset += read;
                }
                if (stream.ReadByte() != -1) return Result(ProPRMarkerReadState.Invalid);
            }

            for (int index = 0; index < bytes.Length; index++)
                if (bytes[index] > 0x7f) return Result(ProPRMarkerReadState.Invalid);
            string text = Encoding.ASCII.GetString(bytes);
            Match match = MarkerPattern.Match(text);
            long deadline;
            if (!match.Success || !long.TryParse(match.Groups["Deadline"].Value,
                NumberStyles.None, CultureInfo.InvariantCulture, out deadline))
                return Result(ProPRMarkerReadState.Invalid);
            return new ProPRMarkerReadResult {
                State = ProPRMarkerReadState.Valid,
                Deadline = deadline,
                Stage = match.Groups["Stage"].Value,
                Substage = match.Groups["Substage"].Value,
                Status = match.Groups["Status"].Value
            };
        }
        catch (FileNotFoundException) { return Result(ProPRMarkerReadState.Missing); }
        catch (DirectoryNotFoundException) { return Result(ProPRMarkerReadState.Missing); }
        catch (UnauthorizedAccessException) { return Result(ProPRMarkerReadState.Inaccessible); }
        catch (IOException) { return Result(ProPRMarkerReadState.Inaccessible); }
        catch { return Result(ProPRMarkerReadState.Invalid); }
    }
}
'@

function Write-WatchdogLine([string]$Line) {
  Write-Host $Line
  [Console]::Out.Flush()
}

function Read-WatchdogMarker([string]$Path, [int]$TimeoutMilliseconds) {
  $readTask = [ProPRBoundedMarkerReader]::ReadAsync($Path)
  if (!$readTask.Wait($TimeoutMilliseconds)) {
    return [PSCustomObject]@{ State = 'TimedOut' }
  }
  $result = $readTask.Result
  if ($result.State -ne [ProPRMarkerReadState]::Valid) {
    return [PSCustomObject]@{ State = $result.State.ToString() }
  }
  return [PSCustomObject]@{
    State = 'Valid'
    Deadline = $result.Deadline
    Stage = $result.Stage
    Substage = $result.Substage
    Status = $result.Status
  }
}

function Test-FreshMarker($Marker) {
  $now = [DateTime]::UtcNow.Ticks
  if ($Marker.Deadline -le $now) { return $false }
  return ($Marker.Deadline - $now) -le
    ([int64]$maximumMarkerDeadlineMilliseconds * [TimeSpan]::TicksPerMillisecond)
}

function Test-WatchdogMarkerSchema($Marker) {
  return $watchdogStages -ccontains $Marker.Stage -and
    $watchdogSubstages -ccontains $Marker.Substage
}

function Accept-WatchdogMarker($Marker) {
  $identity = '{0}:{1}:{2}:{3}' -f $Marker.Deadline, $Marker.Stage, $Marker.Substage, $Marker.Status
  $previousIdentity = if ($null -eq $script:lastValidMarker) { $null } else {
    '{0}:{1}:{2}:{3}' -f $script:lastValidMarker.Deadline, $script:lastValidMarker.Stage,
      $script:lastValidMarker.Substage, $script:lastValidMarker.Status
  }
  $script:lastValidMarker = $Marker
  if ($identity -cne $previousIdentity) {
    Write-WatchdogLine ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:{0}:{1}:{2}' -f `
      $Marker.Stage, $Marker.Substage, $Marker.Status)
  }
}

function Stop-OwnedWorker([uint32]$TerminationExitCode) {
  if ($null -eq $job) { return $false }
  if ($InjectTerminationFailure) {
    try {
      $job.Dispose()
      $script:job = $null
      if ($null -ne $worker) {
        [void]$worker.WaitForExit($WatchdogTerminationMilliseconds)
      }
    } catch {}
    return $false
  }
  try {
    if (!$job.TerminateAndWait($TerminationExitCode, $WatchdogTerminationMilliseconds)) {
      return $false
    }
    $job.Dispose()
    $script:job = $null
    if ($null -eq $worker) { return !$workerStarted }
    if (!$worker.WaitForExit($WatchdogTerminationMilliseconds) -or !$worker.HasExited) {
      return $false
    }
    return $true
  } catch {
    try {
      if ($null -ne $job) {
        $job.Dispose()
        $script:job = $null
      }
      if ($null -ne $worker) {
        [void]$worker.WaitForExit($WatchdogTerminationMilliseconds)
      }
    } catch {}
    return $false
  }
}

function Write-InitialOwnershipManifest(
  [string]$Path,
  [string]$InstallerPath,
  [bool]$Fixture,
  [string]$AuthorizedFixtureRoot
) {
  $runId = [IO.Path]::GetFileNameWithoutExtension($Path).Substring(
    'propr-installed-app-ownership-'.Length)
  $createdUtcTicks = [DateTime]::UtcNow.Ticks
  $manifest = [ordered]@{
    SchemaVersion = 2
    ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'
    State = 'ACTIVE'
    RunId = $runId
    CreatedUtcTicks = $createdUtcTicks
    ExpiresUtcTicks = $createdUtcTicks + ([TimeSpan]::TicksPerHour * 3)
    InstallerPath = $InstallerPath
    Fixture = $Fixture
    FixtureRoot = if ($Fixture) { $AuthorizedFixtureRoot } else { $null }
    BaselineClean = $false
    InstallAttempted = $false
    Directories = @()
    Files = @()
    RegistryKeys = @()
    RegistryValues = @()
    Users = @()
    Profiles = @()
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 6 -Compress))
  $stream = [IO.FileStream]::new(
    $Path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::Read,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Invoke-PostTerminationCleanup([string]$InstallerPath, [string]$AuthorizedFixtureRoot) {
  $cleanupJob = $null
  $cleanupProcess = $null
  $cleanupReadyEvent = $null
  try {
    $cleanupReadyEventName = "Local\ProPRInstalledAppCleanup-$([Guid]::NewGuid().ToString('N'))"
    $cleanupReadyEvent = [Threading.EventWaitHandle]::new(
      $false,
      [Threading.EventResetMode]::ManualReset,
      $cleanupReadyEventName
    )
    $cleanupStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $cleanupStartInfo.FileName = $hostPath
    $cleanupStartInfo.UseShellExecute = $false
    $cleanupStartInfo.CreateNoWindow = $true
    foreach ($argument in @(
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File', $cleanupWorkerPath,
      '-OwnershipManifest', $ownershipManifestPath,
      '-Installer', $InstallerPath,
      '-ExpectedRunId', $ownershipRunId,
      '-OwnershipReadyEvent', $cleanupReadyEventName
    )) {
      $cleanupStartInfo.ArgumentList.Add($argument)
    }
    if ($AuthorizedFixtureRoot) {
      $cleanupStartInfo.ArgumentList.Add('-FixtureRoot')
      $cleanupStartInfo.ArgumentList.Add($AuthorizedFixtureRoot)
    }

    $cleanupJob = [ProPRKillOnCloseJob]::new()
    $cleanupProcess = [Diagnostics.Process]::new()
    $cleanupProcess.StartInfo = $cleanupStartInfo
    if (!$cleanupProcess.Start()) { throw 'post-termination cleanup did not start' }
    try {
      $cleanupJob.AddProcess($cleanupProcess.Handle)
      [void]$cleanupReadyEvent.Set()
    } catch {
      try { $cleanupProcess.Kill($true) } catch {}
      throw 'post-termination cleanup ownership failed'
    }
    if (!$cleanupProcess.WaitForExit($PostTerminationCleanupMilliseconds)) {
      $cleanupTreeGone = $false
      try {
        $cleanupTreeGone = $cleanupJob.TerminateAndWait(
          125,
          $WatchdogTerminationMilliseconds
        ) -and $cleanupProcess.WaitForExit($WatchdogTerminationMilliseconds) -and
          $cleanupProcess.HasExited
      } catch {}
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:TIMED_OUT'
      return $false
    }
    if ($cleanupProcess.ExitCode -ne 0) {
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
      return $false
    }
    Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE'
    return $true
  } catch {
    Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
    return $false
  } finally {
    if ($null -ne $cleanupJob) { $cleanupJob.Dispose() }
    if ($null -ne $cleanupProcess) { $cleanupProcess.Dispose() }
    if ($null -ne $cleanupReadyEvent) { $cleanupReadyEvent.Dispose() }
  }
}

try {
  $installerPath = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
  if ($OwnershipManifest -or $ExpectedRunId) {
    if (!$OwnershipManifest -or $ExpectedRunId -notmatch '^[a-f0-9]{32}$') {
      throw 'workflow ownership authority is invalid'
    }
    $candidateManifestPath = [IO.Path]::GetFullPath($OwnershipManifest)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Leaf $candidateManifestPath) -cne
          "propr-installed-app-ownership-$ExpectedRunId.json" -or
        ![string]::Equals(
          (Split-Path -Parent $candidateManifestPath).TrimEnd('\'),
          $tempRoot,
          [StringComparison]::OrdinalIgnoreCase
        )) {
      throw 'workflow ownership manifest path is invalid'
    }
    $ownershipManifestPath = $candidateManifestPath
    $ownershipRunId = $ExpectedRunId
    $workflowManagedManifest = $true
  } else {
    $ownershipRunId = $generatedRunId
  }
  $selectedWorkerPath = if ($WorkerPath) { $WorkerPath } else { $productionWorkerPath }
  $selectedWorkerPath = (Resolve-Path -LiteralPath $selectedWorkerPath -ErrorAction Stop).Path
  $cleanupWorkerPath = (Resolve-Path -LiteralPath $cleanupWorkerPath -ErrorAction Stop).Path
  $usingProductionWorker = [string]::Equals(
    $selectedWorkerPath, $productionWorkerPath, [StringComparison]::OrdinalIgnoreCase)
  if ($FixtureCleanupRoot) {
    if ($usingProductionWorker) { throw 'production worker cannot use a fixture cleanup scope' }
    $FixtureCleanupRoot = (Resolve-Path -LiteralPath $FixtureCleanupRoot -ErrorAction Stop).Path
  } elseif (!$usingProductionWorker) {
    throw 'injected workers require a fixture cleanup scope'
  }
  if ($InjectTerminationFailure -and $usingProductionWorker) {
    throw 'termination failure injection requires an authorized fixture worker'
  }
  $hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  if ([IO.Path]::GetFileName($hostPath) -notin @('pwsh.exe', 'powershell.exe')) {
    throw 'PowerShell host resolution failed'
  }
  if ($CancellationEventName) {
    if ($CancellationEventName -notmatch '^Local\\ProPRInstalledAppCancellation-[a-f0-9]{32}$') {
      throw 'supervisor cancellation event name is invalid'
    }
    $cancellationEvent = [Threading.EventWaitHandle]::OpenExisting($CancellationEventName)
  }
  Write-InitialOwnershipManifest `
    $ownershipManifestPath $installerPath (!$usingProductionWorker) $FixtureCleanupRoot

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
    '-File', $selectedWorkerPath,
    '-Installer', $installerPath,
    '-Architecture', $Architecture,
    '-WatchdogMarker', $markerPath,
    '-OwnershipReadyEvent', $ownershipReadyEventName,
    '-OwnershipManifest', $ownershipManifestPath
  )) {
    $startInfo.ArgumentList.Add($argument)
  }

  $job = [ProPRKillOnCloseJob]::new()
  $worker = [Diagnostics.Process]::new()
  $worker.StartInfo = $startInfo
  if (!$worker.Start()) { throw 'installed-app worker did not start' }
  $workerStarted = $true
  $bootstrapStopwatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $job.AddProcess($worker.Handle)
    [void]$ownershipReadyEvent.Set()
  } catch {
    try { $worker.Kill($true) } catch {}
    throw 'installed-app worker ownership failed'
  }

  $firstMarkerAccepted = $false
  while ($true) {
    if ($null -ne $cancellationEvent -and $cancellationEvent.WaitOne(0)) {
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:SUPERVISOR:CANCELLED'
      $exitCode = 125
      $terminateOwnedTree = $true
      break
    }

    $waitMilliseconds = $WatchdogPollMilliseconds
    if (!$firstMarkerAccepted) {
      $remainingBootstrapMilliseconds = $BootstrapTimeoutMilliseconds -
        [int]$bootstrapStopwatch.ElapsedMilliseconds
      if ($remainingBootstrapMilliseconds -le 0) { $waitMilliseconds = 1 }
      else { $waitMilliseconds = [Math]::Min($waitMilliseconds, $remainingBootstrapMilliseconds) }
    }
    $workerExited = $worker.WaitForExit($waitMilliseconds)

    $readTimeout = $MarkerReadTimeoutMilliseconds
    if (!$firstMarkerAccepted) {
      $remainingBootstrapMilliseconds = $BootstrapTimeoutMilliseconds -
        [int]$bootstrapStopwatch.ElapsedMilliseconds
      if ($remainingBootstrapMilliseconds -gt 0) {
        $readTimeout = [Math]::Min($readTimeout, $remainingBootstrapMilliseconds)
      } else {
        $readTimeout = 1
      }
    }
    $marker = Read-WatchdogMarker $markerPath ([Math]::Max(1, $readTimeout))
    if ($marker.State -eq 'Valid' -and !(Test-WatchdogMarkerSchema $marker)) {
      $marker = [PSCustomObject]@{ State = 'Invalid' }
    }

    if ($marker.State -eq 'Valid') {
      if (!$firstMarkerAccepted) {
        if ($bootstrapStopwatch.ElapsedMilliseconds -gt $BootstrapTimeoutMilliseconds -or
            !(Test-FreshMarker $marker)) {
          Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:FAILED'
          $exitCode = 124
          $terminateOwnedTree = $true
          break
        }
        $firstMarkerAccepted = $true
      } elseif (!(Test-FreshMarker $marker)) {
        Write-WatchdogLine ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:{0}:{1}:{2}:TIMED_OUT' -f `
          $marker.Stage, $marker.Substage, $marker.Status)
        $exitCode = 124
        $terminateOwnedTree = $true
        break
      }
      Accept-WatchdogMarker $marker
    } elseif (!$firstMarkerAccepted) {
      if ($marker.State -in @('Invalid','Inaccessible','TimedOut')) {
        Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:FAILED'
        $exitCode = 124
        $terminateOwnedTree = $true
        break
      }
      if ($workerExited) {
        Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:FAILED'
        $exitCode = 124
        $terminateOwnedTree = $true
        break
      }
      if ($bootstrapStopwatch.ElapsedMilliseconds -ge $BootstrapTimeoutMilliseconds) {
        Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:TIMED_OUT'
        $exitCode = 124
        $terminateOwnedTree = $true
        break
      }
    } else {
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MARKER:FAILED'
      $exitCode = 124
      $terminateOwnedTree = $true
      break
    }

    if ($workerExited) {
      $exitCode = $worker.ExitCode
      $supervisorOutcomeComplete = $exitCode -eq 0
      break
    }
  }
} catch {
  Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:SUPERVISOR:FAILED'
  $exitCode = 125
  $terminateOwnedTree = $true
} finally {
  $workerLive = $false
  if ($workerStarted -and $null -ne $worker) {
    try { $workerLive = !$worker.HasExited } catch { $workerLive = $true }
  }
  $cleanupRequired = $terminateOwnedTree -or $workerStarted -or $workerLive -or
    !$supervisorOutcomeComplete
  $fixedCleanupResult = $null
  if ($cleanupRequired -and $installerPath -and $ownershipRunId) {
    $workerTreeTerminated = Stop-OwnedWorker ([uint32]$exitCode)
    if ($workerTreeTerminated) {
      $fixedCleanupResult = Invoke-PostTerminationCleanup $installerPath $FixtureCleanupRoot
    } else {
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
      $fixedCleanupResult = $false
    }
    if ($fixedCleanupResult -ne $true) { $exitCode = 125 }
  }

  try {
    $finalMarker = Read-WatchdogMarker $markerPath $MarkerReadTimeoutMilliseconds
    if ($finalMarker.State -eq 'Valid' -and (Test-WatchdogMarkerSchema $finalMarker) -and
        (Test-FreshMarker $finalMarker)) {
      $lastValidMarker = $finalMarker
    }
  } catch {}
  if ($null -ne $lastValidMarker) {
    Write-WatchdogLine ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:{0}:{1}:{2}' -f `
      $lastValidMarker.Stage, $lastValidMarker.Substage, $lastValidMarker.Status)
  } else {
    Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:NONE'
  }

  foreach ($resource in @($job, $worker, $ownershipReadyEvent, $cancellationEvent)) {
    if ($null -eq $resource) { continue }
    try { $resource.Dispose() } catch {
      $fixedCleanupResult = $false
      $exitCode = 125
    }
  }
  try {
    if ([IO.File]::Exists($markerPath)) { [IO.File]::Delete($markerPath) }
  } catch {}
  if ($fixedCleanupResult -eq $true -and !$workflowManagedManifest) {
    foreach ($path in @($ownershipManifestPath, "$ownershipManifestPath.new")) {
      try { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } } catch {}
    }
  }
}

exit $exitCode
