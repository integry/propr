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
$msiCriticalTransactionGraceMilliseconds = 30 * 1000
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
$postTerminationCleanupAuthorized = $true
$fixtureNoMarkerDiagnostic = $false
$fixtureWindowsPowerShellCleanup = $false
$fixtureWorkerTreeTerminationOutcome = 'FAILED'
$fixtureCleanupChildExitCategory = 'OTHER'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
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

public static class ProPRInstallerEntryIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string path, uint access, uint share, IntPtr security, uint creation,
        uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

    public static string Read(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 0x7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "installer identity open failed");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "installer identity read failed");
            if ((information.FileAttributes & (0x10 | 0x400)) != 0)
                throw new InvalidOperationException("installer entry is not an ordinary file");
            return string.Format("{0:x8}{1:x8}{2:x8}", information.VolumeSerialNumber,
                information.FileIndexHigh, information.FileIndexLow);
        }
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

public sealed class ProPRCleanupDiagnosticDrainResult
{
    public long StandardOutputBytes;
    public long StandardOutputLines;
    public byte[] StandardOutput;
    public long StandardErrorBytes;
    public long StandardErrorLines;
}

public sealed class ProPRCleanupDiagnosticDrain : IDisposable
{
    public const int StandardOutputByteLimit = 96;
    public const int StandardOutputLineLimit = 1;
    public const int StandardErrorByteLimit = 0;
    public const int StandardErrorLineLimit = 0;

    private sealed class PumpResult
    {
        public long Bytes;
        public long Lines;
        public byte[] Captured;
    }

    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private Stream standardOutput;
    private Stream standardError;
    private Task<PumpResult> standardOutputTask;
    private Task<PumpResult> standardErrorTask;

    private static async Task<PumpResult> Pump(
        Stream stream,
        int byteLimit,
        int lineLimit,
        CancellationToken token)
    {
        var buffer = new byte[64];
        using (var captured = new MemoryStream(byteLimit + 1))
        {
            long bytes = 0;
            long lines = 0;
            while (true)
            {
                int count = await stream.ReadAsync(
                    buffer, 0, buffer.Length, token).ConfigureAwait(false);
                if (count == 0)
                {
                    return new PumpResult {
                        Bytes = bytes,
                        Lines = lines,
                        Captured = captured.ToArray()
                    };
                }
                bytes = Math.Min((long)byteLimit + 1, bytes + count);
                for (int index = 0; index < count; index++)
                    if (buffer[index] == (byte)'\n')
                        lines = Math.Min((long)lineLimit + 1, lines + 1);
                int remaining = byteLimit + 1 - checked((int)captured.Length);
                if (remaining > 0)
                    captured.Write(buffer, 0, Math.Min(remaining, count));
            }
        }
    }

    public void Start(Process process)
    {
        if (standardOutputTask != null || standardErrorTask != null)
            throw new InvalidOperationException("diagnostic drain was already started");
        standardOutput = process.StandardOutput.BaseStream;
        standardError = process.StandardError.BaseStream;
        standardOutputTask = Pump(
            standardOutput,
            StandardOutputByteLimit,
            StandardOutputLineLimit,
            cancellation.Token);
        standardErrorTask = Pump(
            standardError,
            StandardErrorByteLimit,
            StandardErrorLineLimit,
            cancellation.Token);
    }

    public ProPRCleanupDiagnosticDrainResult Finish(int timeoutMilliseconds)
    {
        if (standardOutputTask == null || standardErrorTask == null)
            throw new InvalidOperationException("diagnostic drain was not started");
        Task all = Task.WhenAll(standardOutputTask, standardErrorTask);
        if (!all.Wait(timeoutMilliseconds)) return null;
        if (standardOutputTask.IsFaulted || standardOutputTask.IsCanceled ||
            standardErrorTask.IsFaulted || standardErrorTask.IsCanceled)
            throw new InvalidOperationException("diagnostic drain failed");
        PumpResult output = standardOutputTask.Result;
        PumpResult error = standardErrorTask.Result;
        return new ProPRCleanupDiagnosticDrainResult {
            StandardOutputBytes = output.Bytes,
            StandardOutputLines = output.Lines,
            StandardOutput = output.Captured,
            StandardErrorBytes = error.Bytes,
            StandardErrorLines = error.Lines
        };
    }

    public bool CancelAndFinish(int timeoutMilliseconds)
    {
        cancellation.Cancel();
        try { if (standardOutput != null) standardOutput.Dispose(); } catch { }
        try { if (standardError != null) standardError.Dispose(); } catch { }
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

function Get-InstallerSha256([string]$Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-MsiProductCode([string]$Path) {
  $installerCom = $null
  $database = $null
  $view = $null
  $record = $null
  try {
    $installerCom = New-Object -ComObject WindowsInstaller.Installer
    $database = $installerCom.OpenDatabase($Path, 0)
    $view = $database.OpenView(
      "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductCode'")
    $view.Execute()
    $record = $view.Fetch()
    $productCode = if ($null -eq $record) { $null } else { [string]$record.StringData(1) }
    if ($productCode -notmatch '^\{[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\}$') {
      throw 'MSI product identity is invalid'
    }
    return $productCode.ToUpperInvariant()
  } finally {
    foreach ($resource in @($record, $view, $database, $installerCom)) {
      if ($null -ne $resource -and [Runtime.InteropServices.Marshal]::IsComObject($resource)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($resource)
      }
    }
  }
}

function Get-InstallerAuthority([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'installer artifact is not an ordinary file'
  }
  $canonicalPath = (Resolve-Path -LiteralPath $item.FullName -ErrorAction Stop).ProviderPath
  $entryIdentity = [ProPRInstallerEntryIdentity]::Read($canonicalPath)
  $sha256 = Get-InstallerSha256 $canonicalPath
  if ([ProPRInstallerEntryIdentity]::Read($canonicalPath) -cne $entryIdentity -or
      (Get-InstallerSha256 $canonicalPath) -cne $sha256) {
    throw 'installer artifact changed before product identity capture'
  }
  $productCode = Get-MsiProductCode $canonicalPath
  if ([ProPRInstallerEntryIdentity]::Read($canonicalPath) -cne $entryIdentity -or
      (Get-InstallerSha256 $canonicalPath) -cne $sha256) {
    throw 'installer artifact changed during authority capture'
  }
  return [PSCustomObject]@{
    Path = $canonicalPath
    EntryIdentity = $entryIdentity
    Sha256 = $sha256
    ProductCode = $productCode
  }
}

function Test-InstallerArtifactAuthority($Record) {
  try {
    return [string]$Record.InstallerEntryIdentity -match '^[a-f0-9]{24}$' -and
      [string]$Record.InstallerSha256 -match '^[a-f0-9]{64}$' -and
      [string]$Record.InstallerProductCode -match
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$' -and
      [ProPRInstallerEntryIdentity]::Read([string]$Record.InstallerPath) -ceq
        [string]$Record.InstallerEntryIdentity -and
      (Get-InstallerSha256 ([string]$Record.InstallerPath)) -ceq
        [string]$Record.InstallerSha256
  } catch {
    return $false
  }
}

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

function Get-CanonicalManifestIdentifiers([string]$RunId, $InstallerAuthority) {
  if ($RunId -cnotmatch '^[a-f0-9]{32}$') {
    throw 'manifest run identifier is not canonical'
  }

  $entryIdentity = [string]$InstallerAuthority.EntryIdentity
  if ($entryIdentity -notmatch '^[A-Fa-f0-9]{24}$') {
    throw 'installer entry identifier cannot be represented canonically'
  }
  $entryIdentity = $entryIdentity.ToLowerInvariant()

  $sha256 = [string]$InstallerAuthority.Sha256
  if ($sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'installer digest cannot be represented canonically'
  }
  $sha256 = $sha256.ToLowerInvariant()

  $productCodeText = [string]$InstallerAuthority.ProductCode
  $productCode = [Guid]::Empty
  if (![Guid]::TryParseExact($productCodeText, 'B', [ref]$productCode)) {
    throw 'installer product code cannot be represented canonically'
  }
  $productCodeText = $productCode.ToString('B').ToUpperInvariant()

  if ($entryIdentity -cnotmatch '^[a-f0-9]{24}$' -or
      $sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $productCodeText -cnotmatch
        '^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$') {
    throw 'canonical manifest identifier construction failed'
  }

  return [PSCustomObject]@{
    RunId = $RunId
    InstallerEntryIdentity = $entryIdentity
    InstallerSha256 = $sha256
    InstallerProductCode = $productCodeText
  }
}

function Write-InitialOwnershipManifest(
  [string]$Path,
  $InstallerAuthority,
  [bool]$Fixture,
  [string]$AuthorizedFixtureRoot
) {
  $runId = [IO.Path]::GetFileNameWithoutExtension($Path).Substring(
    'propr-installed-app-ownership-'.Length)
  $identifiers = Get-CanonicalManifestIdentifiers $runId $InstallerAuthority
  $createdUtcTicks = [DateTime]::UtcNow.Ticks
  $manifest = [ordered]@{
    SchemaVersion = 3
    ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'
    State = 'ACTIVE'
    RunId = $identifiers.RunId
    CreatedUtcTicks = $createdUtcTicks
    ExpiresUtcTicks = $createdUtcTicks + ([TimeSpan]::TicksPerHour * 3)
    InstallerPath = [string]$InstallerAuthority.Path
    InstallerEntryIdentity = $identifiers.InstallerEntryIdentity
    InstallerSha256 = $identifiers.InstallerSha256
    InstallerProductCode = $identifiers.InstallerProductCode
    Fixture = $Fixture
    FixtureRoot = if ($Fixture) { $AuthorizedFixtureRoot } else { $null }
    BaselineClean = $false
    InstallAttempted = $false
    MsiTransactionState = 'NONE'
    Directories = @()
    Files = @()
    RegistryKeys = @()
    RegistryValues = @()
    Users = @()
    Profiles = @()
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6 -Compress
  $roundTrip = ConvertFrom-Json -InputObject $manifestJson -ErrorAction Stop
  if ([string]$roundTrip.RunId -cne $identifiers.RunId -or
      [string]$roundTrip.InstallerEntryIdentity -cne
        $identifiers.InstallerEntryIdentity -or
      [string]$roundTrip.InstallerSha256 -cne $identifiers.InstallerSha256 -or
      [string]$roundTrip.InstallerProductCode -cne
        $identifiers.InstallerProductCode) {
    throw 'canonical manifest identifier round trip failed'
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($manifestJson)
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

function Test-MsiCriticalMarker($Marker) {
  return $null -ne $Marker -and [string]$Marker.Stage -ceq 'INSTALL' -and
    [string]$Marker.Substage -in @('MSI_INSTALL','OWNERSHIP_CAPTURE') -and
    !([string]$Marker.Substage -ceq 'OWNERSHIP_CAPTURE' -and
      [string]$Marker.Status -ceq 'COMPLETE')
}

function Get-DurableMsiTransactionReceipt {
  try {
    $item = Get-Item -LiteralPath $ownershipManifestPath -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -le 0 -or $item.Length -gt 65536) { return 'UNAVAILABLE' }
    $bytes = [byte[]]::new([int]$item.Length)
    $stream = [IO.FileStream]::new(
      $item.FullName,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]'ReadWrite, Delete',
      4096,
      [IO.FileOptions]::SequentialScan
    )
    try {
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -eq 0) { return 'UNAVAILABLE' }
        $offset += $read
      }
      if ($stream.ReadByte() -ne -1) { return 'UNAVAILABLE' }
    } finally {
      $stream.Dispose()
    }
    $manifest = ConvertFrom-Json `
      -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($bytes)) `
      -ErrorAction Stop
    $manifestKeys = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
    $expectedManifestKeys = @(
      'SchemaVersion','ManifestType','State','RunId','CreatedUtcTicks','ExpiresUtcTicks',
      'InstallerPath','InstallerEntryIdentity','InstallerSha256','InstallerProductCode',
      'Fixture','FixtureRoot','BaselineClean','InstallAttempted','MsiTransactionState',
      'Directories','Files','RegistryKeys','RegistryValues','Users','Profiles'
    )
    if ($manifestKeys.Count -ne $expectedManifestKeys.Count -or
        @($expectedManifestKeys | Where-Object {
          $manifestKeys -cnotcontains $_
        }).Count -ne 0 -or
        $manifest.SchemaVersion -ne 3 -or
        [string]$manifest.RunId -cne $ownershipRunId -or
        !(Test-InstallerArtifactAuthority $manifest) -or
        [string]$manifest.State -notin @('ACTIVE','EMPTY')) { return 'UNAVAILABLE' }
    if ([string]$manifest.State -ceq 'EMPTY' -and
        [string]$manifest.MsiTransactionState -ceq 'NONE' -and
        !$manifest.InstallAttempted) { return 'ROLLED_BACK_CLEAN' }
    if ([string]$manifest.MsiTransactionState -ceq 'ROLLED_BACK_CLEAN' -and
        @($manifest.Directories).Count -eq 0 -and @($manifest.Files).Count -eq 0 -and
        @($manifest.RegistryKeys).Count -eq 0 -and
        (($manifest.Fixture -and @($manifest.RegistryValues).Count -eq 0) -or
          (!$manifest.Fixture -and @($manifest.RegistryValues).Count -eq 1 -and
            !$manifest.RegistryValues[0].Owned))) {
      return 'ROLLED_BACK_CLEAN'
    }
    if ([string]$manifest.MsiTransactionState -cne 'COMMITTED') { return 'UNAVAILABLE' }
    $ownedDirectories = @($manifest.Directories | Where-Object {
      $_.Owned -and [string]$_.Kind -in @('INSTALL_ROOT','SHORTCUT_FOLDER') -and
      !$_.Provisional -and
      [string]$_.Identity -match '^[a-f0-9]{24}$' -and
      [string]$_.TreeIdentity -match '^[a-f0-9]{64}$'
    })
    $ownedFiles = @($manifest.Files | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'SHORTCUT_FILE' -and !$_.Provisional -and
      [string]$_.Identity -match '^[a-f0-9]{64}$' -and
      [string]$_.EntryIdentity -match '^[a-f0-9]{24}$'
    })
    $ownedRegistryKeys = @($manifest.RegistryKeys | Where-Object {
      $_.Owned -and [string]$_.Kind -in @('PROTOCOL','APP_PATH') -and
      !$_.Provisional -and [string]$_.Identity -match '^[a-f0-9]{64}$'
    })
    $ownedRegistryValues = @($manifest.RegistryValues | Where-Object {
      $_.Owned -and [string]$_.Kind -ceq 'HKCU_INSTALLED' -and !$_.Provisional -and
      [string]$_.IdentityValueKind -and [string]$_.IdentityValueData
    })
    if ($ownedDirectories.Count -ne 2 -or $ownedFiles.Count -ne 1 -or
        (!$manifest.Fixture -and
          ($ownedRegistryKeys.Count -ne 2 -or $ownedRegistryValues.Count -ne 1))) {
      return 'UNAVAILABLE'
    }
    return 'COMMITTED'
  } catch {
    return 'UNAVAILABLE'
  }
}

function Wait-MsiCriticalTransactionReceipt {
  Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:GRACE'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $receipt = Get-DurableMsiTransactionReceipt
    if ($receipt -in @('COMMITTED','ROLLED_BACK_CLEAN')) {
      Write-WatchdogLine `
        "PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:$receipt"
      return $true
    }
    Start-Sleep -Milliseconds 25
  } while ($stopwatch.ElapsedMilliseconds -lt $msiCriticalTransactionGraceMilliseconds)
  Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:UNPROVEN'
  return $false
}

function Invoke-PostTerminationCleanup([string]$InstallerPath, [string]$AuthorizedFixtureRoot) {
  $cleanupJob = $null
  $cleanupProcess = $null
  $cleanupReadyEvent = $null
  $cleanupDiagnosticDrain = $null
  try {
    $cleanupReadyEventName = "Local\ProPRInstalledAppCleanup-$([Guid]::NewGuid().ToString('N'))"
    $cleanupReadyEvent = [Threading.EventWaitHandle]::new(
      $false,
      [Threading.EventResetMode]::ManualReset,
      $cleanupReadyEventName
    )
    $cleanupStartInfo = [Diagnostics.ProcessStartInfo]::new()
    # Production and the principal fixture use the exact host that launched the
    # supervisor. A separate fixture retains Windows PowerShell 5.1 coverage
    # without attributing native pwsh 7 evidence to that compatibility host.
    $cleanupHostPath = $hostPath
    if ($fixtureWindowsPowerShellCleanup) {
      $cleanupHostPath = Join-Path $env:SystemRoot `
        'System32\WindowsPowerShell\v1.0\powershell.exe'
      if (!(Test-Path -LiteralPath $cleanupHostPath -PathType Leaf)) {
        throw 'Windows PowerShell 5.1 fixture host is unavailable'
      }
    }
    $cleanupStartInfo.FileName = $cleanupHostPath
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
    if ($fixtureNoMarkerDiagnostic) {
      $cleanupStartInfo.ArgumentList.Add('-FixtureValidationDiagnostic')
      $cleanupStartInfo.RedirectStandardOutput = $true
      $cleanupStartInfo.RedirectStandardError = $true
    }

    $cleanupJob = [ProPRKillOnCloseJob]::new()
    if ($fixtureNoMarkerDiagnostic) {
      $cleanupDiagnosticDrain = [ProPRCleanupDiagnosticDrain]::new()
    }
    $cleanupProcess = [Diagnostics.Process]::new()
    $cleanupProcess.StartInfo = $cleanupStartInfo
    if (!$cleanupProcess.Start()) { throw 'post-termination cleanup did not start' }
    try {
      $cleanupJob.AddProcess($cleanupProcess.Handle)
      [void]$cleanupReadyEvent.Set()
      if ($fixtureNoMarkerDiagnostic) {
        $cleanupDiagnosticDrain.Start($cleanupProcess)
      }
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
    $script:fixtureCleanupChildExitCategory = if ($cleanupProcess.ExitCode -in @(0,20,21)) {
      ([int]$cleanupProcess.ExitCode).ToString(
        [Globalization.CultureInfo]::InvariantCulture)
    } else { 'OTHER' }
    if ($fixtureNoMarkerDiagnostic) {
      # The fixture protocol permits exactly one bounded phase line for
      # validation exit 20 or post-validation exit 21. Exit 0 is the explicitly
      # defined zero-byte success protocol. Any other child output leaves
      # recovery authority in place and fails closed.
      $diagnosticDrainResult = $cleanupDiagnosticDrain.Finish(
        $WatchdogTerminationMilliseconds)
      if ($null -eq $diagnosticDrainResult -or
          $diagnosticDrainResult.StandardErrorBytes -ne 0 -or
          $diagnosticDrainResult.StandardErrorLines -ne 0 -or
          $diagnosticDrainResult.StandardOutputBytes -gt
            [ProPRCleanupDiagnosticDrain]::StandardOutputByteLimit -or
          $diagnosticDrainResult.StandardOutputLines -gt
            [ProPRCleanupDiagnosticDrain]::StandardOutputLineLimit) {
        Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
        return $false
      }
      if ($cleanupProcess.ExitCode -eq 0) {
        if ($diagnosticDrainResult.StandardOutputBytes -ne 0 -or
            $diagnosticDrainResult.StandardOutputLines -ne 0) {
          Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
          return $false
        }
      } elseif ($cleanupProcess.ExitCode -in @(20,21)) {
        $diagnosticBytes = [byte[]]$diagnosticDrainResult.StandardOutput
        if ($diagnosticDrainResult.StandardOutputLines -ne 1 -or
            @($diagnosticBytes | Where-Object { $_ -gt 0x7f }).Count -ne 0) {
          Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
          return $false
        }
        $diagnosticMatch = [regex]::Match(
          [Text.Encoding]::ASCII.GetString($diagnosticBytes),
          ('\ACLEANUP_VALIDATION_PHASE:' +
            '(HANDSHAKE|FILE_AUTHORITY|UTF8_DECODE|JSON_PARSE|EXACT_KEY_SET|' +
            'BOOLEAN_TYPES|TRANSACTION_ENUM|SCHEMA_TYPE_STATE|' +
            'RUN_ID_FORMAT|INSTALLER_ENTRY_ID_FORMAT|INSTALLER_SHA256_FORMAT|' +
            'INSTALLER_PRODUCT_CODE_FORMAT|LIFETIME|RUN_ID|INSTALLER_PATH|FIXTURE_SCOPE|' +
            'INITIAL_ACTIVE_MATCH|INITIAL_INSTALLER_AUTHORITY_RECHECK|' +
            'EMPTY_RECEIPT_WRITE)\r?\n\z'),
          [Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
        if (!$diagnosticMatch.Success) {
          Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
          return $false
        }
        Write-WatchdogLine (
          'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:CLEANUP_VALIDATION_PHASE:' +
          $diagnosticMatch.Groups[1].Value
        )
      } elseif ($diagnosticDrainResult.StandardOutputBytes -ne 0 -or
          $diagnosticDrainResult.StandardOutputLines -ne 0) {
        Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
        return $false
      }
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
    foreach ($resource in @(
      $cleanupDiagnosticDrain, $cleanupJob, $cleanupProcess, $cleanupReadyEvent
    )) {
      if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
    }
  }
}

try {
  $installerAuthority = Get-InstallerAuthority $Installer
  $installerPath = [string]$installerAuthority.Path
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
    $fixtureScenario = [string]$env:PROPR_SUPERVISOR_FIXTURE_SCENARIO
    $fixtureNoMarkerDiagnostic = $fixtureScenario -in @(
      'NO_MARKER','NO_MARKER_WINDOWS_POWERSHELL'
    )
    $fixtureWindowsPowerShellCleanup =
      $fixtureScenario -ceq 'NO_MARKER_WINDOWS_POWERSHELL'
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
    $ownershipManifestPath $installerAuthority (!$usingProductionWorker) $FixtureCleanupRoot

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
      try {
        $cancellationMarker = Read-WatchdogMarker $markerPath $MarkerReadTimeoutMilliseconds
        if ($cancellationMarker.State -eq 'Valid' -and
            (Test-WatchdogMarkerSchema $cancellationMarker)) {
          $lastValidMarker = $cancellationMarker
        }
      } catch {}
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:SUPERVISOR:CANCELLED'
      if (Test-MsiCriticalMarker $lastValidMarker) {
        $postTerminationCleanupAuthorized = Wait-MsiCriticalTransactionReceipt
      }
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
        if (Test-MsiCriticalMarker $marker) {
          $postTerminationCleanupAuthorized = Wait-MsiCriticalTransactionReceipt
        }
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
    # Process.ExitCode is signed and can be negative after a native crash. The
    # Job Object API requires a valid uint32, so finalization always uses this
    # fixed supervisor-owned termination code instead of casting worker status.
    $workerTreeTerminated = Stop-OwnedWorker 125
    if ($fixtureNoMarkerDiagnostic) {
      $fixtureWorkerTreeTerminationOutcome = if ($workerTreeTerminated) {
        'COMPLETE'
      } else { 'FAILED' }
    }
    if ($workerTreeTerminated -and $postTerminationCleanupAuthorized) {
      $fixedCleanupResult = Invoke-PostTerminationCleanup $installerPath $FixtureCleanupRoot
    } else {
      Write-WatchdogLine 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED'
      $fixedCleanupResult = $false
    }
    if ($fixedCleanupResult -ne $true) { $exitCode = 125 }
  }

  if ($fixtureNoMarkerDiagnostic) {
    Write-WatchdogLine ((
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'WORKER_TREE_TERMINATION:{0}') -f $fixtureWorkerTreeTerminationOutcome)
    if ($fixtureWorkerTreeTerminationOutcome -ceq 'COMPLETE') {
      Write-WatchdogLine ((
        'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
        'CLEANUP_CHILD_EXIT:{0}') -f $fixtureCleanupChildExitCategory)
    }
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
