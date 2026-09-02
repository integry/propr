param(
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)

$ErrorActionPreference = 'Stop'
$supervisorPath = Join-Path $PSScriptRoot 'run-installed-windows-app-harness.ps1'
$workflowCleanupPath = Join-Path $PSScriptRoot 'run-installed-windows-app-workflow-cleanup.ps1'
$fixtureWorkerPath = Join-Path $PSScriptRoot 'test-installed-windows-app-supervisor-fixture.ps1'
$hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) `
  "propr-supervisor-tests-$([Guid]::NewGuid().ToString('N'))"
$dummyInstaller = Join-Path $testRoot 'fixture.msi'
$secretNeedle = 'C:\Users\fixture-user\token=fixture-credential'
$ownedFixtureUserName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$ownedFixturePassword = "P!$([Guid]::NewGuid().ToString('N'))x7"
$conflictingFixtureUserName = $null
$conflictingFixtureUserSid = $null
$conflictingFixtureProfileSid = $null
$conflictingFixtureProfilePath = $null
$conflictingFixtureDirectories = $null
$conflictingFixtureShortcut = $null
$conflictingFixtureRegistryPath = $null
$dummyInstallerProductCode = ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}')
$dummyInstallerEntryIdentity = $null
$dummyInstallerSha256 = $null
$script:currentSupervisorInvocationTest = 'UNATTRIBUTED'
$script:currentSupervisorInvocationScenario = 'UNATTRIBUTED'
$script:currentSupervisorInvocationPhase = 'UNATTRIBUTED'
$script:currentSupervisorInvocationCallsite = 'GENERAL'
$script:currentSupervisorInvocationField = 'NONE'

function Assert-True([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}

function Assert-Contains([string]$Text, [string]$Expected, [string]$Message) {
  Assert-True ($Text.Contains($Expected, [StringComparison]::Ordinal)) $Message
}

function Assert-NotContains([string]$Text, [string]$Forbidden, [string]$Message) {
  Assert-True (!$Text.Contains($Forbidden, [StringComparison]::OrdinalIgnoreCase)) $Message
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class ProPRWorkflowCleanupInvocationJob : IDisposable
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

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private SafeFileHandle handle;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        SafeFileHandle job, int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint length, IntPtr returnLength);

    public ProPRWorkflowCleanupInvocationJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == null || handle.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "invocation job creation failed");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                    buffer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "invocation job configuration failed");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void AddProcess(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(handle, processHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "invocation process ownership failed");
    }

    private uint ReadActiveProcessCount()
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(handle, 1, out information, size, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "invocation accounting failed");
        return information.ActiveProcesses;
    }

    public bool WaitForNoActiveProcesses(int timeoutMilliseconds)
    {
        var watch = Stopwatch.StartNew();
        do
        {
            if (ReadActiveProcessCount() == 0) return true;
            Thread.Sleep(25);
        }
        while (watch.ElapsedMilliseconds < timeoutMilliseconds);
        return ReadActiveProcessCount() == 0;
    }

    public bool TerminateAndWait(uint exitCode, int timeoutMilliseconds)
    {
        if (!TerminateJobObject(handle, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "invocation termination failed");
        return WaitForNoActiveProcesses(timeoutMilliseconds);
    }

    public void Dispose() { if (handle != null) handle.Dispose(); }
}

public sealed class ProPRWorkflowCleanupProtocolCapture : IDisposable
{
    private const int LineCharacterLimit = 384;
    private const int CountLimit = 4096;
    private const string Prefix = "PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:";
    private static readonly Regex ReadyStartup = new Regex(
        "^" + Prefix + "STARTUP:READY$", RegexOptions.CultureInvariant);
    private static readonly Regex FailedStartup = new Regex(
        "^" + Prefix + "STARTUP:FAILED:CLASS:(PARSER|PARAMETER_BINDING|TYPE_LOAD|OTHER):" +
        "PROCESS_EXIT:(0|-?[1-9][0-9]*):LINE:(0|[1-9][0-9]{0,5})$",
        RegexOptions.CultureInvariant);
    private static readonly Regex Terminal = new Regex(
        "^" + Prefix + "TERMINAL:RESULT:(COMPLETE|FAILED|TIMED_OUT):" +
        "STATUS:([A-Z_]+):EXIT_CODE:(0|20|21|122|123|124|125)$",
        RegexOptions.CultureInvariant);
    private static readonly Regex ControllerFailure = new Regex(
        "^CONTROLLER_(INITIALIZATION|PARAMETER_VALIDATION|PATH_VALIDATION|PROCESS_START|" +
        "PROCESS_WAIT|PROCESS_FINALIZATION|STREAM_FINALIZATION|RESOURCE_FINALIZATION|" +
        "AUTHORITY_FINALIZATION|RESULT_EMISSION)_(TYPE_LOAD|PARAMETERS|PATHS|START|WAIT|" +
        "TERMINATE|DRAIN|DISPOSE|AUTHORITY|EMIT)_(AUTHENTICATION|CLOSE|INVALID_ARGUMENT|" +
        "INVALID_DATA|INVALID_OPERATION|LIMIT|NOT_ENABLED|NOT_FOUND|OPEN|STOPPED|" +
        "PERMISSION|READ|BUSY|UNAVAILABLE|SECURITY|WRITE|UNCLASSIFIED)$",
        RegexOptions.CultureInvariant);
    private static readonly string[] FixedStatuses = new string[] {
        "CONTROLLER_FAILURE", "TIMEOUT", "TERMINATION_FAILURE",
        "ACTIVE_PROCESS_AFTER_ROOT_EXIT", "EMPTY_OR_CLEANED",
        "MANIFEST_VALIDATION_FAILURE", "OWNED_RESOURCE_CLEANUP_FAILURE",
        "PROCESS_FINALIZATION_TIMEOUT", "PROCESS_FINALIZATION_FAILURE",
        "STREAM_DRAIN_TIMEOUT", "CHILD_STDERR_LIMIT", "CHILD_STDERR",
        "CHILD_STDOUT_LIMIT", "CHILD_STDOUT", "STREAM_DRAIN_FAILURE",
        "RESOURCE_FINALIZATION_FAILURE", "AUTHORITY_FINALIZATION_FAILURE",
        "STARTUP_FAILURE"
    };

    private StreamReader outputReader;
    private StreamReader errorReader;
    private Task outputTask;
    private Task errorTask;
    private readonly ManualResetEventSlim startupObserved = new ManualResetEventSlim(false);
    private bool startupSeen;
    private bool terminalSeen;
    private bool defect;

    public int LineCount { get; private set; }
    public int StandardErrorCount { get; private set; }
    public string ObservedLineCategory { get; private set; }
    public int ObservedLineNumber { get; private set; }
    public int StartupRecordLineNumber { get; private set; }
    public int TerminalRecordLineNumber { get; private set; }
    public string StartupClass { get; private set; }
    public int StartupProcessExit { get; private set; }
    public int StartupLine { get; private set; }
    public string Result { get; private set; }
    public string ControllerStatus { get; private set; }
    public int ReportedExitCode { get; private set; }
    public bool DrainFailed { get; private set; }

    public ProPRWorkflowCleanupProtocolCapture()
    {
        ObservedLineCategory = "NONE";
        StartupClass = "NONE";
        Result = "INVALID";
        ControllerStatus = "INVALID";
        ReportedExitCode = -1;
    }

    private static bool IsFixedStatus(string value)
    {
        for (int i = 0; i < FixedStatuses.Length; i++)
            if (String.Equals(FixedStatuses[i], value, StringComparison.Ordinal)) return true;
        return ControllerFailure.IsMatch(value);
    }

    private static bool IsStatusExitPairValid(string status, int exitCode)
    {
        switch (status)
        {
            case "EMPTY_OR_CLEANED": return exitCode == 0;
            case "MANIFEST_VALIDATION_FAILURE": return exitCode == 20;
            case "OWNED_RESOURCE_CLEANUP_FAILURE": return exitCode == 21;
            case "CHILD_STDOUT":
            case "CHILD_STDOUT_LIMIT": return exitCode == 122;
            case "CHILD_STDERR":
            case "CHILD_STDERR_LIMIT": return exitCode == 123;
            case "TIMEOUT": return exitCode == 124;
            default:
                return exitCode == 125 && IsFixedStatus(status);
        }
    }

    private void SetDefect(string category)
    {
        if (!defect)
        {
            defect = true;
            ObservedLineCategory = category;
            ObservedLineNumber = Math.Min(3, Math.Max(1, LineCount));
        }
    }

    private void CompleteLine(string line, bool oversized)
    {
        LineCount = Math.Min(3, LineCount + 1);
        if (defect) return;
        if (oversized) { SetDefect("OVERSIZED"); return; }

        Match ready = ReadyStartup.Match(line);
        Match failed = FailedStartup.Match(line);
        Match terminal = Terminal.Match(line);
        if (!startupSeen)
        {
            if (terminal.Success) { SetDefect("REORDERED"); return; }
            if (!ready.Success && !failed.Success) { SetDefect("MALFORMED"); return; }
            startupSeen = true;
            ObservedLineCategory = "STARTUP";
            ObservedLineNumber = LineCount;
            StartupRecordLineNumber = LineCount;
            if (ready.Success) StartupClass = "READY";
            else
            {
                StartupClass = failed.Groups[1].Value;
                int processExit;
                int startupLine;
                if (!Int32.TryParse(failed.Groups[2].Value, out processExit) ||
                    !Int32.TryParse(failed.Groups[3].Value, out startupLine))
                { SetDefect("MALFORMED"); return; }
                StartupProcessExit = processExit;
                StartupLine = startupLine;
            }
            startupObserved.Set();
            return;
        }

        if (!terminalSeen)
        {
            if (ready.Success || failed.Success) { SetDefect("DUPLICATE"); return; }
            if (!terminal.Success || !IsFixedStatus(terminal.Groups[2].Value))
            { SetDefect("MALFORMED"); return; }
            terminalSeen = true;
            ObservedLineCategory = "TERMINAL";
            ObservedLineNumber = LineCount;
            TerminalRecordLineNumber = LineCount;
            Result = terminal.Groups[1].Value;
            ControllerStatus = terminal.Groups[2].Value;
            ReportedExitCode = Int32.Parse(terminal.Groups[3].Value);
            bool startupFailure = !String.Equals(StartupClass, "READY", StringComparison.Ordinal);
            if ((startupFailure && (!String.Equals(Result, "FAILED", StringComparison.Ordinal) ||
                    !String.Equals(ControllerStatus, "STARTUP_FAILURE", StringComparison.Ordinal) ||
                    ReportedExitCode != 125)) ||
                (!startupFailure && String.Equals(ControllerStatus, "STARTUP_FAILURE",
                    StringComparison.Ordinal)) ||
                (String.Equals(Result, "COMPLETE", StringComparison.Ordinal) &&
                    (!String.Equals(ControllerStatus, "EMPTY_OR_CLEANED", StringComparison.Ordinal) ||
                    ReportedExitCode != 0)) ||
                (String.Equals(Result, "TIMED_OUT", StringComparison.Ordinal) &&
                    (!String.Equals(ControllerStatus, "TIMEOUT", StringComparison.Ordinal) ||
                    ReportedExitCode != 124)) ||
                (String.Equals(Result, "FAILED", StringComparison.Ordinal) &&
                    (String.Equals(ControllerStatus, "EMPTY_OR_CLEANED", StringComparison.Ordinal) ||
                    String.Equals(ControllerStatus, "TIMEOUT", StringComparison.Ordinal) ||
                    ReportedExitCode == 0)) ||
                !IsStatusExitPairValid(ControllerStatus, ReportedExitCode))
                SetDefect("MALFORMED");
            return;
        }

        SetDefect((ready.Success || failed.Success || terminal.Success) ? "DUPLICATE" : "EXTRA");
    }

    private void PumpOutput()
    {
        var line = new StringBuilder();
        var buffer = new char[256];
        bool oversized = false;
        while (true)
        {
            int count = outputReader.Read(buffer, 0, buffer.Length);
            if (count == 0) break;
            for (int i = 0; i < count; i++)
            {
                char value = buffer[i];
                if (value == '\n')
                {
                    if (line.Length > 0 && line[line.Length - 1] == '\r')
                        line.Length = line.Length - 1;
                    CompleteLine(line.ToString(), oversized);
                    line.Clear();
                    oversized = false;
                }
                else if (value > 0x7f) oversized = true;
                else if (line.Length < LineCharacterLimit) line.Append(value);
                else oversized = true;
            }
        }
        if (line.Length != 0 || oversized)
        {
            LineCount = Math.Min(3, LineCount + 1);
            SetDefect(oversized ? "OVERSIZED" : "PARTIAL");
        }
    }

    private void PumpError()
    {
        var buffer = new char[256];
        while (true)
        {
            int count = errorReader.Read(buffer, 0, buffer.Length);
            if (count == 0) return;
            StandardErrorCount = Math.Min(CountLimit + 1, StandardErrorCount + count);
        }
    }

    public void Start(Process process)
    {
        outputReader = process.StandardOutput;
        errorReader = process.StandardError;
        outputTask = Task.Factory.StartNew(PumpOutput, CancellationToken.None,
            TaskCreationOptions.LongRunning, TaskScheduler.Default);
        errorTask = Task.Factory.StartNew(PumpError, CancellationToken.None,
            TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public bool Finish(int timeoutMilliseconds)
    {
        if (outputTask == null || errorTask == null) return false;
        try
        {
            if (!Task.WaitAll(new Task[] { outputTask, errorTask }, timeoutMilliseconds))
                return false;
        }
        catch { DrainFailed = true; return false; }
        return true;
    }

    public Task<bool> SignalCancellationAfterStartup(
        EventWaitHandle cancellation, int timeoutMilliseconds)
    {
        if (cancellation == null) throw new ArgumentNullException("cancellation");
        return Task.Factory.StartNew(() =>
        {
            if (!startupObserved.Wait(timeoutMilliseconds)) return false;
            return cancellation.Set();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public bool WaitForStartup(int timeoutMilliseconds)
    {
        return startupObserved.Wait(timeoutMilliseconds);
    }

    public bool IsProtocolValid(int processExitCode)
    {
        return !defect && startupSeen && terminalSeen && LineCount == 2 &&
            StandardErrorCount == 0 && processExitCode == ReportedExitCode &&
            IsStatusExitPairValid(ControllerStatus, ReportedExitCode) &&
            (String.Equals(StartupClass, "READY", StringComparison.Ordinal) ||
                StartupProcessExit == processExitCode);
    }

    public void Dispose()
    {
        try { if (outputReader != null) outputReader.Dispose(); } catch { }
        try { if (errorReader != null) errorReader.Dispose(); } catch { }
        startupObserved.Dispose();
    }
}
'@

function Test-WorkflowCleanupBodyParserRegression {
  $cleanupBodyPath = Join-Path $PSScriptRoot `
    'run-installed-windows-app-workflow-cleanup-body.ps1'
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $cleanupBodyPath,
    [ref]$tokens,
    [ref]$parseErrors
  )
  Assert-True ($parseErrors.Count -eq 0) `
    'workflow cleanup production body failed whole-file parser regression'
}

function New-StateDirectory([string]$Name) {
  $path = Join-Path $testRoot $Name
  [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
  return $path
}

function Write-TestOwnershipManifest([string]$Path, $Manifest) {
  $temporaryPath = "$Path.test.new"
  $bytes = [Text.Encoding]::UTF8.GetBytes(
    ($Manifest | ConvertTo-Json -Depth 6 -Compress))
  $stream = [IO.FileStream]::new(
    $temporaryPath,
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
  [IO.File]::Move($temporaryPath, $Path, $true)
}

function Initialize-TestInstaller {
  $installerCom = $null
  $database = $null
  $view = $null
  try {
    $installerCom = New-Object -ComObject WindowsInstaller.Installer
    $database = $installerCom.OpenDatabase($dummyInstaller, 3)
    $view = $database.OpenView(
      'CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, ' +
      '`Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)')
    $view.Execute()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    $view = $null
    $view = $database.OpenView(
      "INSERT INTO ``Property`` (``Property``, ``Value``) VALUES ('ProductCode', '$dummyInstallerProductCode')")
    $view.Execute()
    $database.Commit()
  } finally {
    foreach ($resource in @($view, $database, $installerCom)) {
      if ($null -ne $resource -and [Runtime.InteropServices.Marshal]::IsComObject($resource)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($resource)
      }
    }
  }

  if (-not ('ProPRSupervisorInstallerIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProPRSupervisorInstallerIdentity
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
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
    public static string Read(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 0x7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return string.Format("{0:x8}{1:x8}{2:x8}", information.VolumeSerialNumber,
                information.FileIndexHigh, information.FileIndexLow);
        }
    }
}
'@
  }
  $script:dummyInstallerEntryIdentity =
    [ProPRSupervisorInstallerIdentity]::Read($dummyInstaller)
  $script:dummyInstallerSha256 =
    (Get-FileHash -LiteralPath $dummyInstaller -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function New-SupervisorStartInfo(
  [string]$Scenario,
  [string]$StateDirectory,
  [string]$CancellationEventName,
  [bool]$UseProductionWorker,
  [string]$WorkflowManifest = '',
  [string]$ExpectedRunId = '',
  [bool]$InjectTerminationFailure = $false
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
    '-BootstrapTimeoutMilliseconds', '10000',
    '-WatchdogPollMilliseconds', '25',
    '-WatchdogTerminationMilliseconds', '3000',
    '-PostTerminationCleanupMilliseconds', '30000',
    '-MarkerReadTimeoutMilliseconds', '200'
  )) {
    $startInfo.ArgumentList.Add([string]$argument)
  }
  if (!$UseProductionWorker) {
    $startInfo.ArgumentList.Add('-WorkerPath')
    $startInfo.ArgumentList.Add($fixtureWorkerPath)
    $startInfo.ArgumentList.Add('-FixtureCleanupRoot')
    $startInfo.ArgumentList.Add($StateDirectory)
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SCENARIO'] = $Scenario
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY'] = $StateDirectory
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_SECRET'] = $secretNeedle
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_OWNED_USER'] = $ownedFixtureUserName
    $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD'] = $ownedFixturePassword
    if ($conflictingFixtureUserName) {
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER'] =
        $conflictingFixtureUserName
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID'] =
        $conflictingFixtureUserSid
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID'] =
        $conflictingFixtureProfileSid
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_PATH'] =
        $conflictingFixtureProfilePath
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES'] =
        $conflictingFixtureDirectories
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT'] =
        $conflictingFixtureShortcut
      $startInfo.Environment['PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY'] =
        $conflictingFixtureRegistryPath
    }
  }
  if ($InjectTerminationFailure) {
    $startInfo.ArgumentList.Add('-InjectTerminationFailure')
  }
  if ($CancellationEventName) {
    $startInfo.ArgumentList.Add('-CancellationEventName')
    $startInfo.ArgumentList.Add($CancellationEventName)
  }
  if ($WorkflowManifest) {
    $startInfo.ArgumentList.Add('-OwnershipManifest')
    $startInfo.ArgumentList.Add($WorkflowManifest)
    $startInfo.ArgumentList.Add('-ExpectedRunId')
    $startInfo.ArgumentList.Add($ExpectedRunId)
  }
  return $startInfo
}

function Read-FixtureProcessState([string]$StateDirectory) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'PROCESS_STATE' `
    'PROCESS_STATE_PATH' `
    'STATE_DIRECTORY'
  Assert-True (![string]::IsNullOrWhiteSpace($StateDirectory)) `
    (Get-SanitizedSupervisorInvocationDiagnostic `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'PROCESS_STATE' `
      'PROCESS_STATE_PATH' `
      'STATE_DIRECTORY')
  $statePath = Join-Path $StateDirectory 'processes.json'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
    if ($stopwatch.ElapsedMilliseconds -ge 15000) {
      throw 'fixture did not publish process state'
    }
    Start-Sleep -Milliseconds 25
  }
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'PROCESS_STATE' `
    'PROCESS_STATE_READ' `
    'PROCESS_STATE_PATH'
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding ASCII |
    ConvertFrom-Json -ErrorAction Stop
  foreach ($field in @('WorkerPid','DescendantPid')) {
    $property = $state.PSObject.Properties[$field]
    $pidValue = 0
    Assert-True ($null -ne $property -and [int]::TryParse(
        [string]$property.Value,
        [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$pidValue
      ) -and $pidValue -gt 0) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        $script:currentSupervisorInvocationTest `
        $script:currentSupervisorInvocationScenario `
        'PROCESS_STATE' `
        'PROCESS_STATE_READ' `
        (($field -creplace '([a-z])([A-Z])', '$1_$2').ToUpperInvariant()))
  }
  return $state
}

function Read-FixtureResourceState([string]$StateDirectory) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_STATE'
  $statePath = Join-Path $StateDirectory 'resources.json'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $statePath -PathType Leaf)) {
    if ($stopwatch.ElapsedMilliseconds -ge 45000) {
      throw 'fixture did not publish owned resource state'
    }
    Start-Sleep -Milliseconds 25
  }
  return Get-Content -LiteralPath $statePath -Raw -Encoding ASCII | ConvertFrom-Json
}

function Assert-ProcessTreeGone($State) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    $script:currentSupervisorInvocationPhase `
    'PROCESS_TREE_ASSERTION' `
    'PROCESS_TREE'
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $worker = Get-Process -Id ([int]$State.WorkerPid) -ErrorAction SilentlyContinue
    $descendant = Get-Process -Id ([int]$State.DescendantPid) -ErrorAction SilentlyContinue
    if ($null -eq $worker -and $null -eq $descendant) { return }
    Start-Sleep -Milliseconds 25
  } while ($stopwatch.ElapsedMilliseconds -lt 3000)
  throw 'owned worker process tree survived supervisor completion'
}

function Read-EarlyWorkflowCleanupProcessState(
  [string]$Scenario,
  [string]$StateDirectory
) {
  $statePath = Invoke-SupervisorAttributedOperation `
    -Scenario $Scenario `
    -Phase 'PROCESS_STATE' `
    -Callsite 'EARLY_PROCESS_STATE_PATH' `
    -Field 'STATE_DIRECTORY' `
    -Action {
      Assert-True (![string]::IsNullOrWhiteSpace($StateDirectory)) `
        (Get-SanitizedSupervisorInvocationDiagnostic `
          $script:currentSupervisorInvocationTest `
          $Scenario `
          'PROCESS_STATE' `
          'EARLY_PROCESS_STATE_PATH' `
          'STATE_DIRECTORY')
      Join-Path $StateDirectory 'workflow-cleanup-early-processes.json'
    }
  Invoke-SupervisorAttributedOperation `
    -Scenario $Scenario `
    -Phase 'PROCESS_STATE' `
    -Callsite 'EARLY_PROCESS_STATE_PATH' `
    -Field 'PROCESS_STATE_PATH' `
    -Action {
      Assert-True (![string]::IsNullOrWhiteSpace([string]$statePath)) `
        (Get-SanitizedSupervisorInvocationDiagnostic `
          $script:currentSupervisorInvocationTest `
          $Scenario `
          'PROCESS_STATE' `
          'EARLY_PROCESS_STATE_PATH' `
          'PROCESS_STATE_PATH')
      Assert-True (Test-Path -LiteralPath $statePath -PathType Leaf) `
        (Get-SanitizedSupervisorInvocationDiagnostic `
          $script:currentSupervisorInvocationTest `
          $Scenario `
          'PROCESS_STATE' `
          'EARLY_PROCESS_STATE_PATH' `
          'PROCESS_STATE_PATH')
    }
  $state = Invoke-SupervisorAttributedOperation `
    -Scenario $Scenario `
    -Phase 'PROCESS_STATE' `
    -Callsite 'EARLY_PROCESS_STATE_READ' `
    -Field 'PROCESS_STATE_PATH' `
    -Action {
      Get-Content -LiteralPath $statePath -Raw -Encoding ASCII |
        ConvertFrom-Json -ErrorAction Stop
    }
  foreach ($earlyStatePropertyName in @('WorkerPid','DescendantPid')) {
    $earlyStateFieldToken = Convert-FixtureAuthorityFieldToken $earlyStatePropertyName
    Invoke-SupervisorAttributedOperation `
      -Scenario $Scenario `
      -Phase 'PROCESS_STATE' `
      -Callsite 'EARLY_PROCESS_STATE_READ' `
      -Field $earlyStateFieldToken `
      -Action {
        $property = $state.PSObject.Properties[$earlyStatePropertyName]
        $pidValue = 0
        Assert-True ($null -ne $property -and [int]::TryParse(
            [string]$property.Value,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$pidValue
          ) -and $pidValue -gt 0) `
          (Get-SanitizedSupervisorInvocationDiagnostic `
            $script:currentSupervisorInvocationTest `
            $Scenario `
            'PROCESS_STATE' `
            'EARLY_PROCESS_STATE_READ' `
            $earlyStateFieldToken)
      }
  }
  return $state
}

function Get-SanitizedSupervisorMarkerDiagnostic($Result) {
  $bootstrapTimedOutPresent = [regex]::IsMatch(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:TIMED_OUT\r?$'
  )
  $lastValidNonePresent = [regex]::IsMatch(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:NONE\r?$'
  )
  $postTerminationMatch = [regex]::Match(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:' +
      'POST_TERMINATION_CLEANUP:(COMPLETE|FAILED|TIMED_OUT)\r?$'
  )
  $postTerminationOutcome = if ($postTerminationMatch.Success) {
    $postTerminationMatch.Groups[1].Value
  } else { 'NONE' }
  $workerTreeMatch = [regex]::Match(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'WORKER_TREE_TERMINATION:(COMPLETE|FAILED)\r?$'
  )
  $cleanupChildMatch = [regex]::Match(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'CLEANUP_CHILD_EXIT:(0|20|21|OTHER)\r?$'
  )
  $subphase = if ($workerTreeMatch.Success -and
      $workerTreeMatch.Groups[1].Value -ceq 'FAILED') {
    'WORKER_TREE_TERMINATION'
  } elseif ($cleanupChildMatch.Success) {
    'CLEANUP_CHILD_EXIT'
  } else { 'NONE' }
  $cleanupChildExit = if ($cleanupChildMatch.Success) {
    $cleanupChildMatch.Groups[1].Value
  } else { 'OTHER' }
  $cleanupValidationPhaseMatch = [regex]::Match(
    [string]$Result.Output,
    '(?m)^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:CLEANUP_VALIDATION_PHASE:' +
      '(HANDSHAKE|FILE_AUTHORITY|UTF8_DECODE|JSON_PARSE|EXACT_KEY_SET|' +
      'BOOLEAN_TYPES|TRANSACTION_ENUM|SCHEMA_TYPE_STATE|RUN_ID_FORMAT|' +
      'INSTALLER_ENTRY_ID_FORMAT|INSTALLER_SHA256_FORMAT|INSTALLER_PRODUCT_CODE_FORMAT|' +
      'LIFETIME|RUN_ID|INSTALLER_PATH|FIXTURE_SCOPE|INITIAL_ACTIVE_MATCH|' +
      'INITIAL_INSTALLER_AUTHORITY_RECHECK|EMPTY_RECEIPT_WRITE)\r?$'
  )
  $cleanupValidationPhase = if ($cleanupValidationPhaseMatch.Success) {
    $cleanupValidationPhaseMatch.Groups[1].Value
  } else { 'NONE' }
  $signedExit = ([int]$Result.ExitCode).ToString(
    [Globalization.CultureInfo]::InvariantCulture)
  return ('SUPERVISOR_EXIT:{0}:BOOTSTRAP_TIMED_OUT:{1}:LAST_VALID_NONE:{2}:' +
    'POST_TERMINATION_CLEANUP:{3}:SUBPHASE:{4}:CLEANUP_CHILD_EXIT:{5}:' +
    'CLEANUP_VALIDATION_PHASE:{6}') -f `
    $signedExit, ([int]$bootstrapTimedOutPresent), ([int]$lastValidNonePresent),
    $postTerminationOutcome, $subphase, $cleanupChildExit, $cleanupValidationPhase
}

function Get-SanitizedCriticalCancellationDiagnostic($Result) {
  $processExit = 0
  if (![int]::TryParse(
      [string]$Result.ExitCode,
      [Globalization.NumberStyles]::AllowLeadingSign,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$processExit
    )) {
    $processExit = [int]::MinValue
  }

  $msiTransaction = 'INVALID'
  $postTerminationCleanup = 'INVALID'
  $authorityState = 'INVALID'
  $output = [string]$Result.Output
  $outputByteLimit = 4096
  $outputLineLimit = 32
  $outputLineByteLimit = 192
  $protocolValid = [Text.Encoding]::UTF8.GetByteCount($output) -le $outputByteLimit
  $lines = [Collections.Generic.List[string]]::new()
  if ($protocolValid) {
    $rawLines = @([regex]::Split($output, '\r?\n'))
    $lineCount = $rawLines.Count
    if ($lineCount -gt 0 -and $rawLines[$lineCount - 1] -ceq '') {
      $lineCount--
    }
    if ($lineCount -gt $outputLineLimit) {
      $protocolValid = $false
    } else {
      for ($index = 0; $index -lt $lineCount; $index++) {
        $line = [string]$rawLines[$index]
        if ([string]::IsNullOrEmpty($line) -or
            $line.IndexOf("`r", [StringComparison]::Ordinal) -ge 0 -or
            [Text.Encoding]::ASCII.GetByteCount($line) -gt $outputLineByteLimit -or
            [regex]::IsMatch($line, '[^\x20-\x7e]')) {
          $protocolValid = $false
          break
        }
        $lines.Add($line)
      }
    }
  }

  if ($protocolValid) {
    $msiEvents = [Collections.Generic.List[string]]::new()
    $cleanupEvents = [Collections.Generic.List[string]]::new()
    $authorityEvents = [Collections.Generic.List[string]]::new()
    $msiPrefix = 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:'
    $cleanupPrefix =
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:'
    $lastValidPrefix = 'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:'
    $lastValidPattern =
      '^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:' +
      '(INITIALIZATION|INSTALL|VALIDATION|USER_SETUP|APP_LAUNCH|APP_EXIT|UNINSTALL|CLEANUP):' +
      '(PATHS|BASELINE|MSI_INSTALL|OWNERSHIP_CAPTURE|INSTALL_TREE_SCAN|' +
      'APPLICATION_IMAGE|PROTOCOL_ASSERTION|APP_PATH_ASSERTION|' +
      'HKCU_INSTALLED_ASSERTION|SHORTCUT_ASSERTION|USER_CREATE|USER_SID|' +
      'SMOKE_DATA_CREATE|SHORTCUT_PRESENT_PROBE|ALTERNATE_USER_START|' +
      'APPLICATION_WAIT|STREAM_DRAIN|EVIDENCE_INSPECTION|MSI_UNINSTALL|' +
      'INSTALL_TREE_ASSERTION|PROTOCOL_ABSENCE_ASSERTION|' +
      'APP_PATH_ABSENCE_ASSERTION|HKCU_INSTALLED_ABSENCE_ASSERTION|' +
      'SHORTCUT_FILE_ASSERTION|SHORTCUT_FOLDER_ASSERTION|' +
      'SHORTCUT_ABSENCE_PROBE|SMOKE_DATA_REMOVE|PROFILE_LOOKUP|' +
      'PROFILE_REMOVE|USER_LOOKUP|USER_REMOVE|INSTALL_ROOT_FALLBACK|' +
      'PROTOCOL_FALLBACK|APP_PATH_FALLBACK|HKCU_INSTALLED_FALLBACK|' +
      'SHORTCUT_FALLBACK):(BEGIN|COMPLETE|FAILED)$'

    foreach ($line in $lines) {
      if ($line.StartsWith($msiPrefix, [StringComparison]::Ordinal)) {
        $match = [regex]::Match(
          $line,
          '^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:' +
            '(GRACE|COMMITTED|ROLLED_BACK_CLEAN|UNPROVEN)$'
        )
        if (!$match.Success) { $protocolValid = $false; break }
        $msiEvents.Add($match.Groups[1].Value)
      } elseif ($line.StartsWith($cleanupPrefix, [StringComparison]::Ordinal)) {
        $match = [regex]::Match(
          $line,
          '^PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:' +
            'POST_TERMINATION_CLEANUP:(COMPLETE|FAILED|TIMED_OUT)$'
        )
        if (!$match.Success) { $protocolValid = $false; break }
        $cleanupEvents.Add($match.Groups[1].Value)
      } elseif ($line.StartsWith($lastValidPrefix, [StringComparison]::Ordinal)) {
        if ($line -ceq ($lastValidPrefix + 'NONE')) {
          $authorityEvents.Add('NONE')
          continue
        }
        $match = [regex]::Match($line, $lastValidPattern)
        if (!$match.Success) { $protocolValid = $false; break }
        if ($match.Groups[1].Value -ceq 'INSTALL' -and
            $match.Groups[2].Value -ceq 'OWNERSHIP_CAPTURE') {
          $authorityEvent = @(switch ($match.Groups[3].Value) {
            'BEGIN' { 'PROVISIONAL' }
            'COMPLETE' { 'NONPROVISIONAL' }
            'FAILED' { 'FAILED' }
          })
          if ($authorityEvent.Count -ne 1 -or
              $authorityEvent[0] -cnotin @('PROVISIONAL','NONPROVISIONAL','FAILED')) {
            $protocolValid = $false
            break
          }
          $authorityEvents.Add([string]$authorityEvent[0])
        } else {
          $authorityEvents.Add('OTHER')
        }
      }
    }

    if ($protocolValid) {
      if ($msiEvents.Count -eq 0) {
        $msiTransaction = 'NONE'
      } elseif ($msiEvents.Count -eq 1 -and $msiEvents[0] -ceq 'GRACE') {
        $msiTransaction = 'GRACE'
      } elseif ($msiEvents.Count -eq 2 -and $msiEvents[0] -ceq 'GRACE' -and
          $msiEvents[1] -cin @('COMMITTED','ROLLED_BACK_CLEAN','UNPROVEN')) {
        $msiTransaction = $msiEvents[1]
      }
      if ($cleanupEvents.Count -eq 0) {
        $postTerminationCleanup = 'NONE'
      } elseif ($cleanupEvents.Count -eq 1) {
        $postTerminationCleanup = $cleanupEvents[0]
      }
      if ($authorityEvents.Count -eq 0) {
        $authorityState = 'ABSENT'
      } elseif ($authorityEvents.Count -eq 1) {
        $authorityState = $authorityEvents[0]
      }
    }
  }

  $diagnostic = ('PROCESS_EXIT:{0}:MSI_TRANSACTION:{1}:' +
    'POST_TERMINATION_CLEANUP:{2}:AUTHORITY_STATE:{3}') -f `
    $processExit.ToString([Globalization.CultureInfo]::InvariantCulture),
    $msiTransaction, $postTerminationCleanup, $authorityState
  if ($diagnostic.IndexOf("`r", [StringComparison]::Ordinal) -ge 0 -or
      $diagnostic.IndexOf("`n", [StringComparison]::Ordinal) -ge 0 -or
      [Text.Encoding]::ASCII.GetByteCount($diagnostic) -gt 192) {
    return ('PROCESS_EXIT:{0}:MSI_TRANSACTION:INVALID:' +
      'POST_TERMINATION_CLEANUP:INVALID:AUTHORITY_STATE:INVALID') -f `
      $processExit.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
  return $diagnostic
}

function Get-SanitizedWorkflowCleanupResultDiagnostic($Result) {
  $processExit = 0
  if (![int]::TryParse(
      [string]$Result.ExitCode,
      [Globalization.NumberStyles]::AllowLeadingSign,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$processExit
    )) {
    $processExit = [int]::MinValue
  }
  $reportedExitCode = 0
  if (![int]::TryParse(
      [string]$Result.ReportedExitCode,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$reportedExitCode
    ) -or $reportedExitCode -notin @(0,20,21,122,123,124,125)) {
    $reportedExitCode = -1
  }
  $resultName = if ([string]$Result.Result -cin @('COMPLETE','FAILED','TIMED_OUT')) {
    [string]$Result.Result
  } else { 'INVALID' }
  $fixedStatuses = @(
    'CONTROLLER_FAILURE','TIMEOUT','TERMINATION_FAILURE',
    'ACTIVE_PROCESS_AFTER_ROOT_EXIT','EMPTY_OR_CLEANED',
    'MANIFEST_VALIDATION_FAILURE','OWNED_RESOURCE_CLEANUP_FAILURE',
    'PROCESS_FINALIZATION_TIMEOUT','PROCESS_FINALIZATION_FAILURE',
    'STREAM_DRAIN_TIMEOUT','CHILD_STDERR_LIMIT','CHILD_STDERR',
    'CHILD_STDOUT_LIMIT','CHILD_STDOUT','STREAM_DRAIN_FAILURE',
    'RESOURCE_FINALIZATION_FAILURE','AUTHORITY_FINALIZATION_FAILURE',
    'STARTUP_FAILURE'
  )
  $controllerStatus = [string]$Result.ControllerStatus
  if ($controllerStatus -cnotin $fixedStatuses -and
      $controllerStatus -cnotmatch (
        '^CONTROLLER_(INITIALIZATION|PARAMETER_VALIDATION|PATH_VALIDATION|' +
        'PROCESS_START|PROCESS_WAIT|PROCESS_FINALIZATION|STREAM_FINALIZATION|' +
        'RESOURCE_FINALIZATION|AUTHORITY_FINALIZATION|RESULT_EMISSION)_' +
        '(TYPE_LOAD|PARAMETERS|PATHS|START|WAIT|TERMINATE|DRAIN|DISPOSE|' +
        'AUTHORITY|EMIT)_(AUTHENTICATION|CLOSE|INVALID_ARGUMENT|INVALID_DATA|' +
        'INVALID_OPERATION|LIMIT|NOT_ENABLED|NOT_FOUND|OPEN|STOPPED|' +
        'PERMISSION|READ|BUSY|UNAVAILABLE|SECURITY|WRITE|UNCLASSIFIED)$')) {
    $controllerStatus = 'INVALID'
  }
  $startupDiagnostic = ''
  if ($controllerStatus -ceq 'STARTUP_FAILURE') {
    $startupClass = [string]$Result.StartupClass
    if ($startupClass -cnotin @('PARSER','PARAMETER_BINDING','TYPE_LOAD','OTHER')) {
      $startupClass = 'INVALID'
    }

    $startupProcessExit = 'INVALID'
    $startupProcessExitCandidate = [string]$Result.StartupProcessExit
    $parsedStartupProcessExit = 0
    if ($startupProcessExitCandidate -cmatch '^(?:0|-?[1-9][0-9]*)$' -and
        [int]::TryParse(
          $startupProcessExitCandidate,
          [Globalization.NumberStyles]::AllowLeadingSign,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$parsedStartupProcessExit
        )) {
      $startupProcessExit =
        $parsedStartupProcessExit.ToString([Globalization.CultureInfo]::InvariantCulture)
    }

    $startupLine = 'INVALID'
    $startupLineCandidate = [string]$Result.StartupLine
    $parsedStartupLine = 0
    if ($startupLineCandidate -cmatch '^[1-9][0-9]{0,5}$' -and
        [int]::TryParse(
          $startupLineCandidate,
          [Globalization.NumberStyles]::None,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$parsedStartupLine
        ) -and $parsedStartupLine -le 999999) {
      $startupLine =
        $parsedStartupLine.ToString([Globalization.CultureInfo]::InvariantCulture)
    }

    $startupDiagnostic = (':STARTUP_CLASS:{0}:STARTUP_PROCESS_EXIT:{1}:' +
      'STARTUP_LINE:{2}') -f $startupClass, $startupProcessExit, $startupLine
  }
  $diagnostic = ('EXIT_CODE:{0}:RESULT:{1}:CONTROLLER_STATUS:{2}:' +
    'REPORTED_EXIT_CODE:{3}{4}') -f `
    $processExit.ToString([Globalization.CultureInfo]::InvariantCulture),
    $resultName, $controllerStatus,
    $reportedExitCode.ToString([Globalization.CultureInfo]::InvariantCulture),
    $startupDiagnostic
  if ($diagnostic.IndexOf("`r", [StringComparison]::Ordinal) -ge 0 -or
      $diagnostic.IndexOf("`n", [StringComparison]::Ordinal) -ge 0 -or
      [Text.Encoding]::ASCII.GetByteCount($diagnostic) -gt 256) {
    return ('EXIT_CODE:{0}:RESULT:INVALID:CONTROLLER_STATUS:INVALID:' +
      'REPORTED_EXIT_CODE:-1') -f `
      $processExit.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
  return $diagnostic
}

function Get-WorkflowCleanupControllerStatusMatch([string]$TerminalLine) {
  return [regex]::Match(
    $TerminalLine,
    ('^PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:' +
      'RESULT:(COMPLETE|FAILED|TIMED_OUT):STATUS:([A-Z_]+):' +
      'EXIT_CODE:(0|20|21|122|123|124|125)$')
  )
}

function Assert-OwnedResourcesGone($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_ASSERTION'
  foreach ($ownedPath in @(
    $Owned.OwnedRoot, $Owned.InstallRoot, $Owned.ShortcutFolder,
    $Owned.Shortcut, $Owned.SmokeDirectory
  )) {
    Assert-True (!(Test-Path -LiteralPath $ownedPath)) `
      'external cleanup left a run-owned file-system resource behind'
  }
  Assert-True (!(Test-Path -LiteralPath $Owned.RegistryPath)) `
    'external cleanup left a run-owned registry resource behind'
  Assert-True (!(Test-Path -LiteralPath $Owned.RegistryRoot)) `
    'external cleanup left the run-owned registry root behind'
  Assert-True ($null -eq (Get-LocalUser -Name $Owned.UserName -ErrorAction SilentlyContinue)) `
    'external cleanup left the run-owned local user behind'
  $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -ceq $Owned.UserSid })
  Assert-True ($ownedProfiles.Count -eq 0) `
    'external cleanup left the run-owned profile behind'
}

function Convert-FixtureAuthorityFieldToken([string]$Field) {
  $token = ($Field -creplace '([a-z])([A-Z])', '$1_$2').ToUpperInvariant()
  return Get-SanitizedSupervisorFieldToken $token
}

function Assert-FixtureStateFieldsComplete(
  $State,
  [string]$Scenario,
  [string]$Callsite,
  [string[]]$Fields
) {
  foreach ($field in $Fields) {
    $fieldToken = Convert-FixtureAuthorityFieldToken $field
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      $script:currentSupervisorInvocationPhase `
      $Callsite `
      $fieldToken
    $property = $State.PSObject.Properties[$field]
    Assert-True ($null -ne $property -and
        ![string]::IsNullOrWhiteSpace([string]$property.Value)) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        $script:currentSupervisorInvocationTest `
        $Scenario `
        $script:currentSupervisorInvocationPhase `
        $Callsite `
        $fieldToken)
  }
}

function Restore-ReplacedFixtureAuthority($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE' `
    'AUTHORITY_RESTORE_WRITE' `
    'TOKEN'
  Assert-FixtureStateFieldsComplete `
    $Owned $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE_WRITE' @('OwnedRoot','Token')
  [IO.File]::WriteAllText(
    (Join-Path $Owned.OwnedRoot '.propr-installed-app-owner'),
    [string]$Owned.Token,
    [Text.Encoding]::ASCII
  )
  if ($Owned.PSObject.Properties['InstallRootBackup']) {
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_REMOVE' @('InstallRoot')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_REMOVE' `
      'INSTALL_ROOT'
    Remove-Item -LiteralPath $Owned.InstallRoot -Recurse -Force -ErrorAction Stop
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_MOVE' @('InstallRootBackup','InstallRoot')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_MOVE' `
      'INSTALL_ROOT_BACKUP'
    Move-Item -LiteralPath $Owned.InstallRootBackup -Destination $Owned.InstallRoot `
      -ErrorAction Stop
  } elseif ($Owned.PSObject.Properties['ExecutableBackup']) {
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_REMOVE' @('Executable')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_REMOVE' `
      'EXECUTABLE'
    Remove-Item -LiteralPath $Owned.Executable -Force -ErrorAction Stop
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_MOVE' @('ExecutableBackup','Executable')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_MOVE' `
      'EXECUTABLE_BACKUP'
    Move-Item -LiteralPath $Owned.ExecutableBackup -Destination $Owned.Executable `
      -ErrorAction Stop
  }
  Assert-FixtureStateFieldsComplete `
    $Owned $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE_WRITE' @('ShortcutFolder','Token')
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE' `
    'AUTHORITY_RESTORE_WRITE' `
    'SHORTCUT_FOLDER'
  [IO.File]::WriteAllText(
    (Join-Path $Owned.ShortcutFolder '.propr-installed-app-owner'),
    [string]$Owned.Token,
    [Text.Encoding]::ASCII
  )
  if ($Owned.PSObject.Properties['ShortcutBackup']) {
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_REMOVE' @('Shortcut')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_REMOVE' `
      'SHORTCUT'
    Remove-Item -LiteralPath $Owned.Shortcut -Force -ErrorAction Stop
    Assert-FixtureStateFieldsComplete `
      $Owned $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE_MOVE' @('ShortcutBackup','Shortcut')
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      'AUTHORITY_RESTORE' `
      'AUTHORITY_RESTORE_MOVE' `
      'SHORTCUT_BACKUP'
    Move-Item -LiteralPath $Owned.ShortcutBackup -Destination $Owned.Shortcut `
      -ErrorAction Stop
  }
  Assert-FixtureStateFieldsComplete `
    $Owned $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE_WRITE' @('RegistryPath','Token')
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'AUTHORITY_RESTORE' `
    'AUTHORITY_RESTORE_WRITE' `
    'REGISTRY_PATH'
  Set-ItemProperty -LiteralPath $Owned.RegistryPath `
    -Name 'ProPRInstalledAppOwner' -Value ([string]$Owned.Token)
}

function Assert-ReplacedFixtureResourcesSurvive($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_ASSERTION'
  Assert-True ((Get-Content -LiteralPath (Join-Path $Owned.InstallRoot 'foreign.txt') -Raw).Trim() `
      -ceq 'foreign-install-tree') `
    'replacement install tree was removed or changed'
  Assert-True ((Get-Content -LiteralPath $Owned.Shortcut -Raw).Trim() -ceq 'foreign-shortcut') `
    'replacement shortcut was removed or changed'
  Assert-True ((Get-ItemPropertyValue -LiteralPath $Owned.RegistryPath `
      -Name 'ProPRInstalledAppOwner') -ceq 'foreign-owner') `
    'replacement registry authority was removed or changed'
}

function Assert-ReplacedExecutableSurvives($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_ASSERTION' `
    'REPLACEMENT_SURVIVAL_READ' `
    'EXECUTABLE'
  Assert-FixtureStateFieldsComplete `
    $Owned $script:currentSupervisorInvocationScenario `
    'REPLACEMENT_SURVIVAL_READ' @('Executable')
  $expected = if ($Owned.PSObject.Properties['ByteIdenticalReplacement']) {
    'owned-executable'
  } else { 'foreign-executable' }
  Assert-True ((Get-Content -LiteralPath $Owned.Executable -Raw).Trim() -ceq
      $expected) 'replacement executable was removed or changed'
}

function Assert-ReplacedShortcutSurvives($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_ASSERTION'
  Assert-True ((Get-Content -LiteralPath $Owned.Shortcut -Raw).Trim() -ceq
      'foreign-shortcut') 'replacement shortcut was removed or changed'
}

function Assert-MsiPreflightPreservedResources($Owned) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $script:currentSupervisorInvocationScenario `
    'RESOURCE_ASSERTION'
  foreach ($path in @(
      $Owned.OwnedRoot, $Owned.InstallRoot, $Owned.ShortcutFolder,
      $Owned.Shortcut, $Owned.SmokeDirectory, $Owned.RegistryPath
    )) {
    Assert-True (Test-Path -LiteralPath $path) `
      'MSI file-system preflight failure mutated a run resource'
  }
  Assert-True ($null -ne (Get-LocalUser -Name $Owned.UserName -ErrorAction SilentlyContinue)) `
    'MSI file-system preflight failure removed the run-owned user'
}

function Get-SanitizedFixtureAuthorityDiagnostic($Scenario, $Field) {
  $scenarioName = if ([string]$Scenario -cmatch '^[A-Z_]{1,64}$') {
    [string]$Scenario
  } else { 'INVALID' }
  $fieldName = if ([string]$Field -cmatch '^[A-Za-z][A-Za-z0-9]{0,31}$') {
    [string]$Field
  } else { 'InvalidField' }
  return ('PROPR_SUPERVISOR_FIXTURE_AUTHORITY:SCENARIO:{0}:' +
    'PHASE:RESOURCE_STATE:FIELD:{1}:INVALID') -f $scenarioName, $fieldName
}

function Assert-OwnedFixtureAuthorityComplete($Owned, [string]$Scenario) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $Scenario `
    'AUTHORITY_ASSERTION'
  foreach ($field in @(
      'OwnedRoot','InstallRoot','ShortcutFolder','Shortcut','SmokeDirectory',
      'RegistryPath','RegistryRoot','UserName','UserSid','ProfilePath',
      'ManifestPath','RunId','Token'
    )) {
    $property = $Owned.PSObject.Properties[$field]
    Assert-True ($null -ne $property -and
        ![string]::IsNullOrWhiteSpace([string]$property.Value)) `
      (Get-SanitizedFixtureAuthorityDiagnostic $Scenario $field)
  }
  $expectedRegistryRoot =
    "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\$($Owned.RunId)"
  Assert-True ([string]::Equals(
      [string]$Owned.RegistryRoot,
      $expectedRegistryRoot,
      [StringComparison]::OrdinalIgnoreCase
    )) (Get-SanitizedFixtureAuthorityDiagnostic $Scenario 'RegistryRoot')
}

function Get-SupervisorInvocationTests {
  return @(
    'UNATTRIBUTED',
    'BOOTSTRAP_TIMEOUT',
    'WINDOWS_POWERSHELL_CLEANUP_COMPATIBILITY',
    'OPERATION_DEADLINE_AND_TREE_TERMINATION',
    'NEGATIVE_WORKER_EXIT_FINALIZATION',
    'FAIL_CLOSED_MARKERS',
    'LIVE_CANCELLATION_AND_REDACTION',
    'MSI_TRANSACTION_INTERRUPTION_GATES',
    'PRIMARY_WORKER_FALLBACK_FOREIGN_DESCENDANTS',
    'PRE_EXISTING_CLEANUP_OWNERSHIP',
    'SMOKE_PROMOTION_INTERRUPTION_AUTHORITY',
    'PRE_EXISTING_APP_PATHS_AUTHORITY',
    'HKCU_INSTALLED_VALUE_OWNERSHIP',
    'PROVISIONAL_USER_MARKER_OWNERSHIP',
    'ATTRIBUTION_TOTALITY'
  )
}

function Get-SupervisorInvocationScenarios {
  return @(
    'UNATTRIBUTED',
    'TEST',
    'NO_MARKER',
    'NO_MARKER_WINDOWS_POWERSHELL',
    'VALID_THEN_DEADLINE',
    'NEGATIVE_EXIT',
    'MALFORMED_MARKER',
    'TORN_MARKER',
    'STALE_MARKER',
    'INACCESSIBLE_MARKER',
    'CANCELLATION',
    'DURING_MSI',
    'DURING_OWNERSHIP_CAPTURE',
    'PRIMARY_FALLBACK_FOREIGN_DESCENDANTS',
    'PRE_EXISTING_APP_PATHS',
    'OWNED_RESOURCES_THEN_DEADLINE',
    'OWNED_RESOURCES_FOR_INTERRUPTION',
    'OWNED_RESOURCES_NORMAL_SUCCESS',
    'OWNED_RESOURCES_REPLACED_THEN_DEADLINE',
    'OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE',
    'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE',
    'OWNED_SHORTCUT_REPLACED_THEN_DEADLINE',
    'OWNED_PROFILE_PATH_MISMATCH_THEN_DEADLINE',
    'OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE',
    'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE',
    'SMOKE_AFTER_PROMOTION_THEN_DEADLINE',
    'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE',
    'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE',
    'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE',
    'STARTUP_PROTOCOL',
    'REPLACEMENT_RETRY',
    'REPLACED_ENTRY_RETRY',
    'PROFILE_ALTERNATE_LEAF',
    'PROFILE_RETRY',
    'EXECUTABLE_IDENTITY_RETRY',
    'FOREIGN_CHILD_RETRY',
    'TERMINATION_RETRY',
    'PARAMETER_VALIDATION',
    'EARLY_INITIALIZATION_TIMEOUT',
    'CLEANUP_TIMEOUT',
    'INSTALLER_REPLACEMENT',
    'RESOURCE_COLLISION',
    'WORKFLOW_RETRY',
    'NORMAL_CLEANUP',
    'MANIFEST_VALIDATION',
    'SMOKE_PROMOTION_RETRY',
    'SMOKE_TOKEN_MISSING',
    'SMOKE_TOKEN_RETRY',
    'APP_PATH_MISMATCH',
    'HKCU_BASELINE_RESTORE',
    'HKCU_PENDING_RECEIPT',
    'HKCU_NONEMPTY',
    'HKCU_EMPTY',
    'HKCU_CONFLICT',
    'HKCU_PROVISIONAL',
    'USER_MARKER_OWNED',
    'USER_MARKER_REPLACEMENT',
    'PROTOCOL_REGRESSION'
  )
}

function Get-SupervisorInvocationPhases {
  return @(
    'UNATTRIBUTED',
    'TEST',
    'FIXTURE_SETUP',
    'SUPERVISOR_PROCESS',
    'PROCESS_START',
    'PROCESS_WAIT',
    'PROCESS_OUTPUT',
    'PROCESS_STATE',
    'RESOURCE_STATE',
    'RESOURCE_ASSERTION',
    'AUTHORITY_ASSERTION',
    'AUTHORITY_RESTORE',
    'WORKFLOW_CLEANUP_CONTROLLER',
    'PIPELINE_START',
    'PIPELINE_STOP',
    'MANIFEST_ASSERTION',
    'CLEANUP_ASSERTION',
    'HOSTILE_FAILURE',
    'FINALIZER'
  )
}

function Get-SupervisorInvocationCallsites {
  return @(
    'UNATTRIBUTED',
    'GENERAL',
    'CRITICAL_GATE_PATH',
    'CRITICAL_GATE_READ',
    'PROCESS_STATE_PATH',
    'PROCESS_STATE_READ',
    'PROCESS_TREE_ASSERTION',
    'CONTROLLER_INVOCATION_INPUT',
    'CONTROLLER_PROTOCOL_PARSE',
    'CONTROLLER_RESULT_FIELD',
    'EARLY_PROCESS_STATE_PATH',
    'EARLY_PROCESS_STATE_READ',
    'MANIFEST_PRESERVATION',
    'RESOURCE_FIELD_VALIDATION',
    'REPLACEMENT_SURVIVAL_READ',
    'AUTHORITY_RESTORE_WRITE',
    'AUTHORITY_RESTORE_REMOVE',
    'AUTHORITY_RESTORE_MOVE',
    'WORKFLOW_CLEANUP_RETRY',
    'FINAL_ABSENCE_CHECK'
  )
}

function Get-SupervisorInvocationFields {
  return @(
    'NONE',
    'STATE_DIRECTORY',
    'CRITICAL_GATE_PATH',
    'CRITICAL_GATE_CONTENT',
    'PROCESS_STATE_PATH',
    'WORKER_PID',
    'DESCENDANT_PID',
    'PROCESS_TREE',
    'PROTOCOL',
    'EXIT_CODE',
    'REPORTED_EXIT_CODE',
    'RESULT',
    'OWNED_ROOT',
    'INSTALL_ROOT',
    'SHORTCUT_FOLDER',
    'SHORTCUT',
    'SMOKE_DIRECTORY',
    'REGISTRY_PATH',
    'REGISTRY_ROOT',
    'USER_NAME',
    'USER_SID',
    'PROFILE_PATH',
    'MANIFEST_PATH',
    'RUN_ID',
    'TOKEN',
    'EXECUTABLE',
    'EXECUTABLE_BACKUP',
    'SHORTCUT_BACKUP',
    'INSTALL_ROOT_BACKUP',
    'BYTE_IDENTICAL_REPLACEMENT'
  )
}

function Get-SanitizedSupervisorInvocationToken([string]$Token, [string[]]$AllowList) {
  if ($Token -cin $AllowList) { return $Token }
  return 'UNATTRIBUTED'
}

function Get-SanitizedSupervisorFieldToken([string]$Token) {
  if ($Token -cin (Get-SupervisorInvocationFields)) { return $Token }
  return 'NONE'
}

function Get-SanitizedSupervisorInvocationDiagnostic(
  [string]$Test,
  [string]$Scenario,
  [string]$Phase,
  [string]$Callsite = 'GENERAL',
  [string]$Field = 'NONE'
) {
  $testName = Get-SanitizedSupervisorInvocationToken $Test (Get-SupervisorInvocationTests)
  $scenarioName = Get-SanitizedSupervisorInvocationToken $Scenario (Get-SupervisorInvocationScenarios)
  $phaseName = Get-SanitizedSupervisorInvocationToken $Phase (Get-SupervisorInvocationPhases)
  $callsiteName = Get-SanitizedSupervisorInvocationToken `
    $Callsite (Get-SupervisorInvocationCallsites)
  $fieldName = Get-SanitizedSupervisorFieldToken $Field
  return ('PROPR_WINDOWS_SUPERVISOR_INVOCATION:TEST:{0}:' +
    'SCENARIO:{1}:PHASE:{2}:CALLSITE:{3}:FIELD:{4}:FAILED') -f `
    $testName, $scenarioName, $phaseName, $callsiteName, $fieldName
}

function Set-SupervisorInvocationContext(
  [string]$Test,
  [string]$Scenario,
  [string]$Phase,
  [string]$Callsite = 'GENERAL',
  [string]$Field = 'NONE'
) {
  $script:currentSupervisorInvocationTest =
    Get-SanitizedSupervisorInvocationToken $Test (Get-SupervisorInvocationTests)
  $script:currentSupervisorInvocationScenario =
    Get-SanitizedSupervisorInvocationToken $Scenario (Get-SupervisorInvocationScenarios)
  $script:currentSupervisorInvocationPhase =
    Get-SanitizedSupervisorInvocationToken $Phase (Get-SupervisorInvocationPhases)
  $script:currentSupervisorInvocationCallsite =
    Get-SanitizedSupervisorInvocationToken $Callsite (Get-SupervisorInvocationCallsites)
  $script:currentSupervisorInvocationField = Get-SanitizedSupervisorFieldToken $Field
}

function Test-SupervisorInvocationDiagnosticExact([string]$Diagnostic) {
  $match = [regex]::Match(
    [string]$Diagnostic,
    ('^PROPR_WINDOWS_SUPERVISOR_INVOCATION:TEST:([A-Z_]+):' +
      'SCENARIO:([A-Z_]+):PHASE:([A-Z_]+):CALLSITE:([A-Z_]+):' +
      'FIELD:([A-Z_]+):FAILED$')
  )
  if (!$match.Success) { return $false }
  return $match.Groups[1].Value -cin (Get-SupervisorInvocationTests) -and
    $match.Groups[2].Value -cin (Get-SupervisorInvocationScenarios) -and
    $match.Groups[3].Value -cin (Get-SupervisorInvocationPhases) -and
    $match.Groups[4].Value -cin (Get-SupervisorInvocationCallsites) -and
    $match.Groups[5].Value -cin (Get-SupervisorInvocationFields)
}

function Test-WorkflowCleanupProtocolMismatchDiagnosticExact([string]$Diagnostic) {
  $match = [regex]::Match(
    [string]$Diagnostic,
    ('^PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:' +
      'INVOCATION:([A-Z_]+):OBSERVED:' +
      '(NONE|STARTUP|TERMINAL|MALFORMED|PARTIAL|DUPLICATE|REORDERED|EXTRA|OVERSIZED):' +
      'LINE_COUNT:(0|1|2|3\+):STDERR_COUNT:(0|[1-9][0-9]{0,3}):' +
      'PROCESS_EXIT:(0|20|21|122|123|124|125|INVALID):' +
      'LIFECYCLE:(EXITED|PROCESS_CREATION_FAILURE|OWNERSHIP_FAILURE|' +
      'TIMEOUT_BEFORE_STARTUP|TIMEOUT_AFTER_STARTUP|' +
      'CANCELLED_BEFORE_STARTUP|CANCELLED_AFTER_STARTUP|' +
      'ACTIVE_TREE_AFTER_EXIT|DRAIN_TIMEOUT|DRAIN_FAILURE):' +
      'TREE_TERMINATION:(NOT_REQUIRED|COMPLETE|FAILED):' +
      'STARTUP_CLASS:(NONE|READY|PARSER|PARAMETER_BINDING|TYPE_LOAD|OTHER):' +
      'LINE_NUMBER:([0-3])$'),
    [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (!$match.Success) { return $false }
  $standardErrorCount = 0
  if (![int]::TryParse(
      $match.Groups[4].Value,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$standardErrorCount
    ) -or $standardErrorCount -gt 4096) {
    return $false
  }
  return $match.Groups[1].Value -cin @(
    'STARTUP_PROTOCOL','REPLACEMENT_RETRY','REPLACED_ENTRY_RETRY',
    'PROFILE_ALTERNATE_LEAF','PROFILE_RETRY','EXECUTABLE_IDENTITY_RETRY',
    'FOREIGN_CHILD_RETRY','TERMINATION_RETRY','PARAMETER_VALIDATION',
    'EARLY_INITIALIZATION_TIMEOUT','CLEANUP_TIMEOUT','INSTALLER_REPLACEMENT',
    'RESOURCE_COLLISION','WORKFLOW_RETRY','NORMAL_CLEANUP','MANIFEST_VALIDATION',
    'SMOKE_PROMOTION_RETRY','SMOKE_TOKEN_MISSING','SMOKE_TOKEN_RETRY',
    'APP_PATH_MISMATCH','HKCU_BASELINE_RESTORE','HKCU_PENDING_RECEIPT',
    'HKCU_NONEMPTY','HKCU_EMPTY','HKCU_CONFLICT','HKCU_PROVISIONAL',
    'USER_MARKER_OWNED','USER_MARKER_REPLACEMENT','PROTOCOL_REGRESSION'
  )
}

function Get-SupervisorAttributionTotalityCases {
  return @(
    'GENERAL',
    'BOUNDARY_BOOTSTRAP_TIMEOUT',
    'BOUNDARY_WINDOWS_POWERSHELL_COMPATIBILITY',
    'BOUNDARY_OPERATION_DEADLINE',
    'BOUNDARY_NEGATIVE_WORKER_EXIT',
    'BOUNDARY_FAIL_CLOSED_MARKER',
    'BOUNDARY_LIVE_CANCELLATION',
    'BOUNDARY_MSI_INTERRUPTION',
    'BOUNDARY_PRIMARY_FALLBACK',
    'BOUNDARY_PRE_EXISTING_CLEANUP',
    'BOUNDARY_SMOKE_PROMOTION',
    'BOUNDARY_APP_PATHS_AUTHORITY',
    'BOUNDARY_HKCU_OWNERSHIP',
    'BOUNDARY_USER_MARKER',
    'CALLSITE_CRITICAL_GATE_PATH',
    'CALLSITE_CRITICAL_GATE_READ',
    'CALLSITE_PROCESS_STATE_READ',
    'CALLSITE_PROCESS_TREE_ASSERTION',
    'CALLSITE_CONTROLLER_INPUT_MANIFEST',
    'CALLSITE_CONTROLLER_INPUT_RUN_ID',
    'CALLSITE_CONTROLLER_INPUT_STATE_DIRECTORY',
    'CALLSITE_CONTROLLER_PROTOCOL_PARSE',
    'CALLSITE_CONTROLLER_RESULT_EXIT_CODE',
    'CALLSITE_CONTROLLER_RESULT_REPORTED_EXIT_CODE',
    'CALLSITE_CONTROLLER_RESULT_RESULT',
    'CALLSITE_EARLY_PROCESS_STATE_PATH',
    'CALLSITE_EARLY_PROCESS_STATE_READ',
    'CALLSITE_EARLY_WORKER_PID',
    'CALLSITE_EARLY_DESCENDANT_PID',
    'CALLSITE_EARLY_PROCESS_TREE_ASSERTION',
    'CALLSITE_EARLY_MANIFEST_PRESERVATION',
    'CALLSITE_REPLACEMENT_SURVIVAL_READ',
    'FIELD_EXECUTABLE_BACKUP',
    'FIELD_MANIFEST_PATH',
    'CALLSITE_WORKFLOW_CLEANUP_RETRY',
    'CALLSITE_FINAL_ABSENCE_CHECK',
    'FORGED_PREFIX_SECRET',
    'MISSING_GATE_STATE_DIRECTORY',
    'MISSING_EXECUTABLE_BACKUP',
    'NESTED_SHADOW_CRITICAL_GATE_PATH',
    'NESTED_SHADOW_PROCESS_STATE_READ',
    'ALLOWLISTED_TEST_SCENARIO_PHASE',
    'ALLOWLISTED_CALLSITE_FIELD',
    'POWERSHELL_GATE_PUBLICATION'
  )
}

function Get-SanitizedSupervisorAttributionCaseToken([string]$Token) {
  if ($Token -cin (Get-SupervisorAttributionTotalityCases)) { return $Token }
  return 'GENERAL'
}

function Get-SupervisorInvocationDiagnosticClassification(
  [string]$Diagnostic,
  [string]$Expected
) {
  if ([string]::IsNullOrWhiteSpace($Diagnostic)) { return 'missing' }
  if (Test-SupervisorInvocationDiagnosticExact $Diagnostic) {
    if ($Diagnostic -ceq $Expected) { return 'exact' }
    return 'sanitized-to-context'
  }
  return 'malformed'
}

function Get-SupervisorAttributionTotalityAssertionMessage(
  [string]$CaseId,
  [string]$ExpectedClassification,
  [string]$ObservedClassification
) {
  $caseName = Get-SanitizedSupervisorAttributionCaseToken $CaseId
  if ($ExpectedClassification -cnotin @(
      'exact','sanitized-to-context','malformed','missing'
    )) {
    $ExpectedClassification = 'malformed'
  }
  if ($ObservedClassification -cnotin @(
      'exact','sanitized-to-context','malformed','missing'
    )) {
    $ObservedClassification = 'malformed'
  }
  return ('supervisor invocation attribution totality diverged:' +
    'CASE:{0}:EXPECTED:{1}:OBSERVED:{2}') -f `
    $caseName, $ExpectedClassification, $ObservedClassification
}

function Invoke-SupervisorAttributedBoundary(
  [string]$Test,
  [string]$Scenario,
  [string]$Phase,
  [scriptblock]$Action,
  [string]$Callsite = 'GENERAL',
  [string]$Field = 'NONE'
) {
  $previousTest = $script:currentSupervisorInvocationTest
  $previousScenario = $script:currentSupervisorInvocationScenario
  $previousPhase = $script:currentSupervisorInvocationPhase
  $previousCallsite = $script:currentSupervisorInvocationCallsite
  $previousField = $script:currentSupervisorInvocationField
  Set-SupervisorInvocationContext $Test $Scenario $Phase $Callsite $Field
  try {
    & $Action
  } catch {
    $diagnosticMessage = [string]$_.Exception.Message
    if ((Test-SupervisorInvocationDiagnosticExact $diagnosticMessage) -or
        (Test-WorkflowCleanupProtocolMismatchDiagnosticExact $diagnosticMessage)) {
      throw
    }
    throw (Get-SanitizedSupervisorInvocationDiagnostic `
      $script:currentSupervisorInvocationTest `
      $script:currentSupervisorInvocationScenario `
      $script:currentSupervisorInvocationPhase `
      $script:currentSupervisorInvocationCallsite `
      $script:currentSupervisorInvocationField)
  } finally {
    $script:currentSupervisorInvocationTest = $previousTest
    $script:currentSupervisorInvocationScenario = $previousScenario
    $script:currentSupervisorInvocationPhase = $previousPhase
    $script:currentSupervisorInvocationCallsite = $previousCallsite
    $script:currentSupervisorInvocationField = $previousField
  }
}

function Invoke-SupervisorAttributedTest(
  [string]$Test,
  [scriptblock]$Action
) {
  Invoke-SupervisorAttributedBoundary `
    -Test $Test `
    -Scenario 'TEST' `
    -Phase 'TEST' `
    -Action $Action
}

function Invoke-SupervisorAttributedOperation(
  [string]$Scenario,
  [string]$Phase,
  [string]$Callsite,
  [string]$Field,
  [scriptblock]$Action
) {
  Invoke-SupervisorAttributedBoundary `
    -Test $script:currentSupervisorInvocationTest `
    -Scenario $Scenario `
    -Phase $Phase `
    -Callsite $Callsite `
    -Field $Field `
    -Action $Action
}

function Assert-SupervisorInvocationDiagnosticBounded(
  [string]$Diagnostic,
  [string]$Test,
  [string]$Scenario,
  [string]$Phase,
  [string]$Callsite = 'GENERAL',
  [string]$Field = 'NONE',
  [string]$CaseId = 'GENERAL'
) {
  $expected = Get-SanitizedSupervisorInvocationDiagnostic `
    $Test $Scenario $Phase $Callsite $Field
  Assert-True ($Diagnostic -ceq $expected) `
    (Get-SupervisorAttributionTotalityAssertionMessage `
      $CaseId 'exact' `
      (Get-SupervisorInvocationDiagnosticClassification $Diagnostic $expected))
  Assert-True ([Text.Encoding]::ASCII.GetByteCount($Diagnostic) -le 320) `
    (Get-SupervisorAttributionTotalityAssertionMessage `
      $CaseId 'exact' `
      (Get-SupervisorInvocationDiagnosticClassification $Diagnostic $expected))
  Assert-True ($Diagnostic -cmatch (
      '^PROPR_WINDOWS_SUPERVISOR_INVOCATION:TEST:[A-Z_]+:' +
      'SCENARIO:[A-Z_]+:PHASE:[A-Z_]+:CALLSITE:[A-Z_]+:' +
      'FIELD:[A-Z_]+:FAILED$'
    )) (Get-SupervisorAttributionTotalityAssertionMessage `
      $CaseId 'exact' `
      (Get-SupervisorInvocationDiagnosticClassification $Diagnostic $expected))
  foreach ($forbidden in @(
      $secretNeedle,
      $testRoot,
      $dummyInstaller,
      'Cannot bind argument',
      'LiteralPath',
      'Registry::',
      'S-1-5-',
      'fixture-user',
      'credential',
      'stdout',
      'stderr'
    )) {
    Assert-NotContains $Diagnostic $forbidden `
      (Get-SupervisorAttributionTotalityAssertionMessage `
        $CaseId 'exact' `
        (Get-SupervisorInvocationDiagnosticClassification $Diagnostic $expected))
  }
}

function Test-CriticalGatePublisherPowerShellCompatibility {
  $fixtureText = Get-Content -LiteralPath $fixtureWorkerPath -Raw -Encoding UTF8
  $match = [regex]::Match(
    $fixtureText,
    '(?sm)function Write-FixtureCriticalGate\(\[string\]\$Name\) \{(?<body>.*?)^\}'
  )
  Assert-True ($match.Success) `
    (Get-SupervisorAttributionTotalityAssertionMessage `
      'POWERSHELL_GATE_PUBLICATION' 'exact' 'missing')
  $body = $match.Groups['body'].Value
  Assert-True ($body -cmatch '\[IO\.FileOptions\]::WriteThrough' -and
      $body -cmatch '\$stream\.Flush\(\$true\)' -and
      $body -cmatch '\[IO\.Directory\]::Exists\(\$gatePath\)' -and
      $body -cmatch '\[IO\.File\]::Delete\(\$gatePath\)' -and
      $body -cmatch '\[IO\.File\]::Move\(\$temporaryGatePath, \$gatePath\)' -and
      $body -cnotmatch '\[IO\.File\]::Move\(\$temporaryGatePath, \$gatePath, \$true\)') `
    (Get-SupervisorAttributionTotalityAssertionMessage `
      'POWERSHELL_GATE_PUBLICATION' 'exact' 'malformed')
}

function Get-WorkflowCleanupProtocolMismatchDiagnostic(
  [string]$InvocationIdentifier,
  [string]$ObservedLineCategory,
  [int]$LineCount,
  [int]$StandardErrorCount,
  [string]$ValidatedProcessExit,
  [string]$LifecycleCategory,
  [string]$TreeTerminationCategory,
  [string]$StartupClass,
  [int]$LineNumber
) {
  $invocations = @(
    'STARTUP_PROTOCOL','REPLACEMENT_RETRY','REPLACED_ENTRY_RETRY',
    'PROFILE_ALTERNATE_LEAF','PROFILE_RETRY','EXECUTABLE_IDENTITY_RETRY',
    'FOREIGN_CHILD_RETRY','TERMINATION_RETRY','PARAMETER_VALIDATION',
    'EARLY_INITIALIZATION_TIMEOUT','CLEANUP_TIMEOUT','INSTALLER_REPLACEMENT',
    'RESOURCE_COLLISION','WORKFLOW_RETRY','NORMAL_CLEANUP','MANIFEST_VALIDATION',
    'SMOKE_PROMOTION_RETRY','SMOKE_TOKEN_MISSING','SMOKE_TOKEN_RETRY',
    'APP_PATH_MISMATCH','HKCU_BASELINE_RESTORE','HKCU_PENDING_RECEIPT',
    'HKCU_NONEMPTY','HKCU_EMPTY','HKCU_CONFLICT','HKCU_PROVISIONAL',
    'USER_MARKER_OWNED','USER_MARKER_REPLACEMENT','PROTOCOL_REGRESSION'
  )
  if ($InvocationIdentifier -cnotin $invocations) { $InvocationIdentifier = 'INVALID' }
  if ($ObservedLineCategory -cnotin @(
      'NONE','STARTUP','TERMINAL','MALFORMED','PARTIAL','DUPLICATE',
      'REORDERED','EXTRA','OVERSIZED'
    )) { $ObservedLineCategory = 'MALFORMED' }
  if ($LifecycleCategory -cnotin @(
      'EXITED','PROCESS_CREATION_FAILURE','OWNERSHIP_FAILURE',
      'TIMEOUT_BEFORE_STARTUP','TIMEOUT_AFTER_STARTUP',
      'CANCELLED_BEFORE_STARTUP','CANCELLED_AFTER_STARTUP',
      'ACTIVE_TREE_AFTER_EXIT','DRAIN_TIMEOUT','DRAIN_FAILURE'
    )) { $LifecycleCategory = 'DRAIN_FAILURE' }
  if ($TreeTerminationCategory -cnotin @('NOT_REQUIRED','COMPLETE','FAILED')) {
    $TreeTerminationCategory = 'FAILED'
  }
  if ($StartupClass -cnotin @(
      'NONE','READY','PARSER','PARAMETER_BINDING','TYPE_LOAD','OTHER'
    )) { $StartupClass = 'NONE' }
  if ($ValidatedProcessExit -cnotmatch '^(?:0|20|21|122|123|124|125)$') {
    $ValidatedProcessExit = 'INVALID'
  }
  $boundedLineCount = if ($LineCount -ge 3) { '3+' } else {
    [Math]::Max(0, $LineCount).ToString([Globalization.CultureInfo]::InvariantCulture)
  }
  $boundedStderrCount = [Math]::Min(4096, [Math]::Max(0, $StandardErrorCount))
  $boundedLineNumber = [Math]::Min(3, [Math]::Max(0, $LineNumber))
  return (('PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:' +
    'INVOCATION:{0}:OBSERVED:{1}:LINE_COUNT:{2}:STDERR_COUNT:{3}:' +
    'PROCESS_EXIT:{4}:LIFECYCLE:{5}:TREE_TERMINATION:{6}:' +
    'STARTUP_CLASS:{7}:LINE_NUMBER:{8}') -f `
    $InvocationIdentifier, $ObservedLineCategory, $boundedLineCount,
    $boundedStderrCount.ToString([Globalization.CultureInfo]::InvariantCulture),
    $ValidatedProcessExit, $LifecycleCategory, $TreeTerminationCategory,
    $StartupClass,
    $boundedLineNumber.ToString([Globalization.CultureInfo]::InvariantCulture))
}

function Invoke-WorkflowCleanupController(
  [Parameter(Mandatory=$true)]
  [ValidateSet(
    'STARTUP_PROTOCOL','REPLACEMENT_RETRY','REPLACED_ENTRY_RETRY',
    'PROFILE_ALTERNATE_LEAF','PROFILE_RETRY','EXECUTABLE_IDENTITY_RETRY',
    'FOREIGN_CHILD_RETRY','TERMINATION_RETRY','PARAMETER_VALIDATION',
    'EARLY_INITIALIZATION_TIMEOUT','CLEANUP_TIMEOUT','INSTALLER_REPLACEMENT',
    'RESOURCE_COLLISION','WORKFLOW_RETRY','NORMAL_CLEANUP','MANIFEST_VALIDATION',
    'SMOKE_PROMOTION_RETRY','SMOKE_TOKEN_MISSING','SMOKE_TOKEN_RETRY',
    'APP_PATH_MISMATCH','HKCU_BASELINE_RESTORE','HKCU_PENDING_RECEIPT',
    'HKCU_NONEMPTY','HKCU_EMPTY','HKCU_CONFLICT','HKCU_PROVISIONAL',
    'USER_MARKER_OWNED','USER_MARKER_REPLACEMENT','PROTOCOL_REGRESSION'
  )][string]$InvocationIdentifier,
  [string]$ManifestPath,
  [string]$RunId,
  [string]$FixtureRoot,
  [object]$CleanupTimeoutMilliseconds = 30000,
  [bool]$FixtureEarlyInitializationChild = $false,
  [string]$StartupFailureClass = '',
  [object]$InvocationTimeoutMilliseconds = 40000,
  [Threading.WaitHandle]$CancellationWaitHandle = $null,
  [bool]$SignalCancellationAfterStartup = $false,
  [bool]$BeginTimeoutAfterStartup = $false,
  [bool]$InjectTreeTerminationFailure = $false,
  [bool]$FixtureResultEmissionFailure = $false,
  [string]$ProtocolFixture = ''
) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $InvocationIdentifier `
    'WORKFLOW_CLEANUP_CONTROLLER'
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $InvocationIdentifier `
    'WORKFLOW_CLEANUP_CONTROLLER' `
    'CONTROLLER_INVOCATION_INPUT' `
    'MANIFEST_PATH'
  Assert-True (![string]::IsNullOrWhiteSpace([string]$ManifestPath)) `
    (Get-SanitizedSupervisorInvocationDiagnostic `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'MANIFEST_PATH')
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $InvocationIdentifier `
    'WORKFLOW_CLEANUP_CONTROLLER' `
    'CONTROLLER_INVOCATION_INPUT' `
    'RUN_ID'
  Assert-True (![string]::IsNullOrWhiteSpace([string]$RunId)) `
    (Get-SanitizedSupervisorInvocationDiagnostic `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'RUN_ID')
  if ($FixtureRoot) {
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'STATE_DIRECTORY'
    Assert-True (![string]::IsNullOrWhiteSpace([string]$FixtureRoot)) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        $script:currentSupervisorInvocationTest `
        $InvocationIdentifier `
        'WORKFLOW_CLEANUP_CONTROLLER' `
        'CONTROLLER_INVOCATION_INPUT' `
        'STATE_DIRECTORY')
  }
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $InvocationIdentifier `
    'WORKFLOW_CLEANUP_CONTROLLER' `
    'CONTROLLER_PROTOCOL_PARSE' `
    'PROTOCOL'
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $workflowCleanupPath,
    '-OwnershipManifest', $ManifestPath,
    '-Installer', $dummyInstaller,
    '-ExpectedRunId', $RunId,
    '-CleanupTimeoutMilliseconds', [string]$CleanupTimeoutMilliseconds,
    '-TerminationTimeoutMilliseconds', '3000'
  )) {
    $startInfo.ArgumentList.Add($argument)
  }
  if ($FixtureRoot) {
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'STATE_DIRECTORY'
    $startInfo.ArgumentList.Add('-FixtureRoot')
    $startInfo.ArgumentList.Add($FixtureRoot)
  }
  if ($FixtureEarlyInitializationChild) {
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'STATE_DIRECTORY'
    $startInfo.ArgumentList.Add('-FixtureEarlyInitializationChild')
  }
  if ($FixtureResultEmissionFailure) {
    $startInfo.ArgumentList.Add('-FixtureResultEmissionFailure')
  }
  if ($StartupFailureClass) {
    $startInfo.ArgumentList.Add('-StartupFailureClass')
    $startInfo.ArgumentList.Add($StartupFailureClass)
  }
  if ($ProtocolFixture) {
    $startInfo.ArgumentList.Add('-ProtocolFixture')
    $startInfo.ArgumentList.Add($ProtocolFixture)
  }
  $invocationTimeout = 0
  if (![int]::TryParse(
      [string]$InvocationTimeoutMilliseconds,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$invocationTimeout
    ) -or $invocationTimeout -lt 1 -or $invocationTimeout -gt 40000) {
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $InvocationIdentifier `
      'WORKFLOW_CLEANUP_CONTROLLER' `
      'CONTROLLER_INVOCATION_INPUT' `
      'STATE_DIRECTORY'
    throw 'workflow cleanup invocation timeout is invalid'
  }
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    $InvocationIdentifier `
    'WORKFLOW_CLEANUP_CONTROLLER' `
    'CONTROLLER_PROTOCOL_PARSE' `
    'PROTOCOL'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $job = $null
  $capture = $null
  $cancellationSignalTask = $null
  $processStarted = $false
  $lifecycleCategory = 'PROCESS_CREATION_FAILURE'
  $treeTerminationCategory = 'NOT_REQUIRED'
  $validatedProcessExit = 'INVALID'
  $drainComplete = $false
  $drainAttempted = $false
  try {
    $job = [ProPRWorkflowCleanupInvocationJob]::new()
    if (!$process.Start()) { throw 'workflow cleanup fixture did not start' }
    $processStarted = $true
    try {
      $job.AddProcess($process.Handle)
    } catch {
      $lifecycleCategory = 'OWNERSHIP_FAILURE'
      throw
    }
    $capture = [ProPRWorkflowCleanupProtocolCapture]::new()
    $capture.Start($process)
    if ($SignalCancellationAfterStartup) {
      if ($CancellationWaitHandle -isnot [Threading.EventWaitHandle]) {
        throw 'workflow cleanup after-startup cancellation event is invalid'
      }
      $cancellationSignalTask = $capture.SignalCancellationAfterStartup(
        [Threading.EventWaitHandle]$CancellationWaitHandle, $invocationTimeout)
    }
    $startupWindowTimedOut = $false
    if ($BeginTimeoutAfterStartup) {
      # The capture signals only after parsing one complete startup record.
      $startupWindowTimedOut = !$capture.WaitForStartup(5000)
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $cancelled = $false
    while (!$startupWindowTimedOut -and !$process.HasExited -and
        $watch.ElapsedMilliseconds -lt $invocationTimeout) {
      if ($null -ne $CancellationWaitHandle -and $CancellationWaitHandle.WaitOne(0)) {
        $cancelled = $true
        break
      }
      [Threading.Thread]::Sleep(25)
    }
    if (!$process.HasExited) {
      $lifecycleCategory = if ($cancelled) {
        'CANCELLED_BEFORE_STARTUP'
      } else { 'TIMEOUT_BEFORE_STARTUP' }
      $treeTerminationCategory = 'FAILED'
      if (!$InjectTreeTerminationFailure) {
        try {
          if ($job.TerminateAndWait(125, 3000)) {
            $treeTerminationCategory = 'COMPLETE'
          }
        } catch {}
      }
      [void]$process.WaitForExit(3000)
    } else {
      $lifecycleCategory = 'EXITED'
      $drainAttempted = $true
      $drainComplete = $capture.Finish(3000)
      if (!$drainComplete) {
        $lifecycleCategory = if ($capture.DrainFailed) {
          'DRAIN_FAILURE'
        } else { 'DRAIN_TIMEOUT' }
      }
      if ($process.ExitCode -in @(0,20,21,122,123,124,125)) {
        $validatedProcessExit =
          $process.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture)
      }
      if (!$job.WaitForNoActiveProcesses(3000)) {
        $lifecycleCategory = 'ACTIVE_TREE_AFTER_EXIT'
        $treeTerminationCategory = 'FAILED'
        if (!$InjectTreeTerminationFailure) {
          try {
            if ($job.TerminateAndWait(125, 3000)) {
              $treeTerminationCategory = 'COMPLETE'
            }
          } catch {}
        }
        if (!$drainComplete) {
          $drainComplete = $capture.Finish(0)
        }
      }
    }
    if (!$drainAttempted) {
      $drainAttempted = $true
      $drainComplete = $capture.Finish(3000)
    }
    if (!$drainComplete -and $lifecycleCategory -ceq 'EXITED') {
      $lifecycleCategory = if ($capture.DrainFailed) { 'DRAIN_FAILURE' } else { 'DRAIN_TIMEOUT' }
    }
    if ($lifecycleCategory -like '*BEFORE_STARTUP' -and
        $capture.StartupClass -cne 'NONE') {
      $lifecycleCategory = $lifecycleCategory.Replace('BEFORE_STARTUP', 'AFTER_STARTUP')
    }
    if ($process.HasExited -and $process.ExitCode -in @(0,20,21,122,123,124,125)) {
      $validatedProcessExit =
        $process.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($lifecycleCategory -cne 'EXITED' -or
        $treeTerminationCategory -cne 'NOT_REQUIRED' -or
        !$drainComplete -or
        !$capture.IsProtocolValid([int]$process.ExitCode)) {
      throw (Get-WorkflowCleanupProtocolMismatchDiagnostic `
        $InvocationIdentifier $capture.ObservedLineCategory $capture.LineCount `
        $capture.StandardErrorCount $validatedProcessExit $lifecycleCategory `
        $treeTerminationCategory $capture.StartupClass $capture.ObservedLineNumber)
    }
    return [PSCustomObject]@{
      InvocationIdentifier = $InvocationIdentifier
      ExitCode = $process.ExitCode
      Result = $capture.Result
      ControllerStatus = $capture.ControllerStatus
      ReportedExitCode = $capture.ReportedExitCode
      StartupClass = if ($capture.StartupClass -ceq 'READY') { '' } else {
        $capture.StartupClass
      }
      StartupProcessExit = if ($capture.StartupClass -ceq 'READY') { '' } else {
        [string]$capture.StartupProcessExit
      }
      StartupLine = if ($capture.StartupClass -ceq 'READY') { '' } else {
        [string]$capture.StartupLine
      }
      ProtocolLineCount = $capture.LineCount
      ProtocolStandardErrorCount = $capture.StandardErrorCount
      ProtocolStartupClass = $capture.StartupClass
      ProtocolStartupLineNumber = $capture.StartupRecordLineNumber
      ProtocolTerminalLineNumber = $capture.TerminalRecordLineNumber
    }
  } catch {
    if ($_.Exception.Message -like 'PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:*') {
      throw
    }
    $lineCategory = if ($null -eq $capture) { 'NONE' } else {
      $capture.ObservedLineCategory
    }
    $lineCount = if ($null -eq $capture) { 0 } else { $capture.LineCount }
    $stderrCount = if ($null -eq $capture) { 0 } else { $capture.StandardErrorCount }
    $startupClass = if ($null -eq $capture) { 'NONE' } else { $capture.StartupClass }
    $lineNumber = if ($null -eq $capture) { 0 } else { $capture.ObservedLineNumber }
    throw (Get-WorkflowCleanupProtocolMismatchDiagnostic `
      $InvocationIdentifier $lineCategory $lineCount $stderrCount `
      $validatedProcessExit $lifecycleCategory $treeTerminationCategory `
      $startupClass $lineNumber)
  } finally {
    if ($processStarted -and !$process.HasExited) {
      try { if ($null -ne $job) { [void]$job.TerminateAndWait(125, 3000) } } catch {}
      try { if (!$process.HasExited) { $process.Kill($true) } } catch {}
    }
    if ($null -ne $cancellationSignalTask) {
      try { [void]$cancellationSignalTask.Wait(3000) } catch {}
    }
    if ($null -ne $capture) { $capture.Dispose() }
    if ($null -ne $job) { $job.Dispose() }
    $process.Dispose()
  }
}

function Test-WorkflowCleanupStartupProtocol {
  foreach ($failureClass in @('PARSER','PARAMETER_BINDING','TYPE_LOAD','OTHER')) {
    $result = Invoke-WorkflowCleanupController `
      'STARTUP_PROTOCOL' $dummyInstaller $([Guid]::NewGuid().ToString('N')) `
      $testRoot 30000 $false `
      $failureClass
    Assert-True ($result.ExitCode -eq 125 -and
        $result.ReportedExitCode -eq 125 -and
        $result.Result -ceq 'FAILED' -and
        $result.ControllerStatus -ceq 'STARTUP_FAILURE' -and
        $result.StartupClass -ceq $failureClass -and
        $result.StartupProcessExit -match '^-?[0-9]+$' -and
        $result.StartupLine -match '^[1-9][0-9]{0,5}$') `
      "native $failureClass startup fixture did not emit the fixed two-line protocol"
    $startupDiagnostic = Get-SanitizedWorkflowCleanupResultDiagnostic $result
    $expectedStartupDiagnostic = ((
        'EXIT_CODE:125:RESULT:FAILED:CONTROLLER_STATUS:STARTUP_FAILURE:' +
        'REPORTED_EXIT_CODE:125:STARTUP_CLASS:{0}:STARTUP_PROCESS_EXIT:{1}:' +
        'STARTUP_LINE:{2}') -f `
      $failureClass, $result.StartupProcessExit, $result.StartupLine)
    Assert-True ($startupDiagnostic -ceq $expectedStartupDiagnostic) `
      "native $failureClass startup metadata was not preserved by the bounded diagnostic"
  }

  foreach ($invalidStatusLine in @(
      'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:RESULT:INVALID:STATUS:STARTUP_FAILURE:EXIT_CODE:125',
      'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:RESULT:FAILED:STATUS:STARTUP_FAILURE:EXIT_CODE:+125',
      'PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:TERMINAL:RESULT:FAILED:STATUS:STARTUP_FAILURE:EXIT_CODE:126'
    )) {
    Assert-True (!(Get-WorkflowCleanupControllerStatusMatch $invalidStatusLine).Success) `
      'workflow cleanup parser accepted a malformed terminal record'
  }

  $validStartupMetadata = [PSCustomObject]@{
    ExitCode = 125
    Result = 'FAILED'
    ControllerStatus = 'STARTUP_FAILURE'
    ReportedExitCode = 125
    StartupClass = 'PARSER'
    StartupProcessExit = '-2147483648'
    StartupLine = '999999'
  }
  Assert-True ((Get-SanitizedWorkflowCleanupResultDiagnostic $validStartupMetadata) -ceq (
      'EXIT_CODE:125:RESULT:FAILED:CONTROLLER_STATUS:STARTUP_FAILURE:' +
      'REPORTED_EXIT_CODE:125:STARTUP_CLASS:PARSER:' +
      'STARTUP_PROCESS_EXIT:-2147483648:STARTUP_LINE:999999'
    )) 'valid bounded startup metadata was not preserved'

  foreach ($invalidStartupMetadata in @(
      [PSCustomObject]@{},
      [PSCustomObject]@{
        StartupClass = 'parser'
        StartupProcessExit = '+125'
        StartupLine = '0'
      },
      [PSCustomObject]@{
        StartupClass = "PARSER`nDISCLOSURE"
        StartupProcessExit = '2147483648'
        StartupLine = '1000000'
      }
    )) {
    $invalidStartupMetadata | Add-Member -NotePropertyName ExitCode -NotePropertyValue 125
    $invalidStartupMetadata | Add-Member -NotePropertyName Result -NotePropertyValue 'FAILED'
    $invalidStartupMetadata | Add-Member `
      -NotePropertyName ControllerStatus -NotePropertyValue 'STARTUP_FAILURE'
    $invalidStartupMetadata | Add-Member -NotePropertyName ReportedExitCode -NotePropertyValue 125
    Assert-True ((Get-SanitizedWorkflowCleanupResultDiagnostic $invalidStartupMetadata) -ceq (
        'EXIT_CODE:125:RESULT:FAILED:CONTROLLER_STATUS:STARTUP_FAILURE:' +
        'REPORTED_EXIT_CODE:125:STARTUP_CLASS:INVALID:' +
        'STARTUP_PROCESS_EXIT:INVALID:STARTUP_LINE:INVALID'
      )) 'invalid startup metadata did not fail closed to fixed sentinels'
  }

  $nonStartupMetadata = [PSCustomObject]@{
    ExitCode = 21
    Result = 'FAILED'
    ControllerStatus = 'OWNED_RESOURCE_CLEANUP_FAILURE'
    ReportedExitCode = 21
    StartupClass = "PARSER`nDISCLOSURE"
    StartupProcessExit = 'not-an-exit'
    StartupLine = 'not-a-line'
  }
  Assert-True ((Get-SanitizedWorkflowCleanupResultDiagnostic $nonStartupMetadata) -ceq (
      'EXIT_CODE:21:RESULT:FAILED:' +
      'CONTROLLER_STATUS:OWNED_RESOURCE_CLEANUP_FAILURE:REPORTED_EXIT_CODE:21'
    )) 'non-startup cleanup diagnostic included startup-only metadata'
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_CONTROLLER_STARTUP:FIXED_PROTOCOL:PASSED'
  [Console]::Out.Flush()
}

function Get-WorkflowCleanupStateMachineAssertionMessage(
  [string]$Message,
  [string]$Diagnostic,
  [string]$Fixture
) {
  Assert-NotContains $Diagnostic $dummyInstaller `
    "$Fixture diagnostic disclosed the dummy installer"
  Assert-NotContains $Diagnostic $testRoot `
    "$Fixture diagnostic disclosed a path"
  $fixedMatch = [regex]::Match($Diagnostic, (
      '^PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:' +
      'INVOCATION:PROTOCOL_REGRESSION:OBSERVED:' +
      '(?<Observed>NONE|STARTUP|TERMINAL|MALFORMED|PARTIAL|DUPLICATE|REORDERED|EXTRA|OVERSIZED):' +
      'LINE_COUNT:(?<LineCount>0|1|2|3\+):STDERR_COUNT:(?<StderrCount>[0-9]+):' +
      'PROCESS_EXIT:(?<ProcessExit>0|20|21|122|123|124|125|INVALID):' +
      'LIFECYCLE:(?<Lifecycle>EXITED|PROCESS_CREATION_FAILURE|OWNERSHIP_FAILURE|' +
      'TIMEOUT_BEFORE_STARTUP|TIMEOUT_AFTER_STARTUP|' +
      'CANCELLED_BEFORE_STARTUP|CANCELLED_AFTER_STARTUP|' +
      'ACTIVE_TREE_AFTER_EXIT|DRAIN_TIMEOUT|DRAIN_FAILURE):' +
      'TREE_TERMINATION:(?<TreeTermination>NOT_REQUIRED|COMPLETE|FAILED):' +
      'STARTUP_CLASS:(?<StartupClass>NONE|READY|PARSER|PARAMETER_BINDING|TYPE_LOAD|OTHER):' +
      'LINE_NUMBER:(?<LineNumber>[0-3])$'
    ), [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  Assert-True $fixedMatch.Success `
    "$Fixture did not emit the fixed bounded diagnostic"
  $lineCount = if ($fixedMatch.Groups['LineCount'].Value -ceq '3+') {
    3
  } else { [int]$fixedMatch.Groups['LineCount'].Value }
  $expectedDiagnostic = Get-WorkflowCleanupProtocolMismatchDiagnostic `
    'PROTOCOL_REGRESSION' $fixedMatch.Groups['Observed'].Value $lineCount `
    ([int]$fixedMatch.Groups['StderrCount'].Value) `
    $fixedMatch.Groups['ProcessExit'].Value $fixedMatch.Groups['Lifecycle'].Value `
    $fixedMatch.Groups['TreeTermination'].Value $fixedMatch.Groups['StartupClass'].Value `
    ([int]$fixedMatch.Groups['LineNumber'].Value)
  Assert-True ($Diagnostic -ceq $expectedDiagnostic) `
    "$Fixture diagnostic did not equal the fixed bounded value"
  return "$Message`: $Diagnostic"
}

function Test-WorkflowCleanupProtocolStateMachine {
  $scriptText = Get-Content -LiteralPath $PSCommandPath -Raw -Encoding UTF8
  $expectedInvocations = @(
    'STARTUP_PROTOCOL','REPLACEMENT_RETRY','REPLACED_ENTRY_RETRY',
    'PROFILE_ALTERNATE_LEAF','PROFILE_RETRY','EXECUTABLE_IDENTITY_RETRY',
    'FOREIGN_CHILD_RETRY','TERMINATION_RETRY','PARAMETER_VALIDATION',
    'EARLY_INITIALIZATION_TIMEOUT','CLEANUP_TIMEOUT','INSTALLER_REPLACEMENT',
    'RESOURCE_COLLISION','WORKFLOW_RETRY','NORMAL_CLEANUP','MANIFEST_VALIDATION',
    'SMOKE_PROMOTION_RETRY','SMOKE_TOKEN_MISSING','SMOKE_TOKEN_RETRY',
    'APP_PATH_MISMATCH','HKCU_BASELINE_RESTORE','HKCU_PENDING_RECEIPT',
    'HKCU_NONEMPTY','HKCU_EMPTY','HKCU_CONFLICT','HKCU_PROVISIONAL',
    'USER_MARKER_OWNED','USER_MARKER_REPLACEMENT','PROTOCOL_REGRESSION'
  )
  foreach ($identifier in $expectedInvocations) {
    Assert-True ($scriptText -cmatch ((
        "Invoke-WorkflowCleanupController\s+``\r?\n\s+(?:" +
        "'|\-InvocationIdentifier\s+')") +
        [regex]::Escape($identifier) + "'"
      )) "workflow cleanup invocation identifier $identifier has no fixed callsite"
  }

  $cases = @(
    [PSCustomObject]@{
      Fixture='ONE_LINE_STARTUP'; Observed='STARTUP'; LineCount=1; ProcessExit=125
      Lifecycle='EXITED'; TreeTermination='NOT_REQUIRED'; StartupClass='READY'; LineNumber=1
    },
    [PSCustomObject]@{ Fixture='MISSING_TERMINAL'; Observed='STARTUP'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='DUPLICATE_STARTUP'; Observed='DUPLICATE'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='EXTRA_RECORD'; Observed='EXTRA'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='REORDERED_RECORDS'; Observed='REORDERED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='OVERSIZED_RECORD'; Observed='OVERSIZED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='MALFORMED_RECORD'; Observed='MALFORMED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='PARTIAL_RECORD'; Observed='PARTIAL'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='STDERR_RECORD'; Observed='TERMINAL'; Lifecycle='EXITED'; Stderr=1 },
    [PSCustomObject]@{ Fixture='INVALID_STARTUP_METADATA'; Observed='MALFORMED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='MISMATCHED_MANIFEST_EXIT_125'; Observed='MALFORMED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='MISMATCHED_CHILD_STDOUT_EXIT_21'; Observed='MALFORMED'; Lifecycle='EXITED' },
    [PSCustomObject]@{ Fixture='TIMEOUT_BEFORE_STARTUP'; Observed='NONE'; Lifecycle='TIMEOUT_BEFORE_STARTUP' },
    [PSCustomObject]@{
      Fixture='TIMEOUT_AFTER_STARTUP'; Observed='STARTUP'; LineCount=1; ProcessExit=125
      Lifecycle='TIMEOUT_AFTER_STARTUP'; TreeTermination='COMPLETE'
      StartupClass='READY'; LineNumber=1; BeginTimeoutAfterStartup=$true
    },
    [PSCustomObject]@{
      Fixture='STREAM_DRAIN_RACE'; Observed='TERMINAL'; LineCount=2; Stderr=0; ProcessExit=125
      Lifecycle='ACTIVE_TREE_AFTER_EXIT'; TreeTermination='COMPLETE'
      StartupClass='READY'; LineNumber=2; BeginTimeoutAfterStartup=$true
    }
  )
  foreach ($case in $cases) {
    $diagnostic = ''
    # Startup-gated cases get a separate five-second startup phase above; their
    # 250 ms countdown begins only after the complete startup record is captured.
    $caseInvocationTimeout = if ($case.Fixture -in @(
        'TIMEOUT_BEFORE_STARTUP','TIMEOUT_AFTER_STARTUP','STREAM_DRAIN_RACE'
      )) { 250 } else { 1000 }
    try {
      [void](Invoke-WorkflowCleanupController `
        -InvocationIdentifier 'PROTOCOL_REGRESSION' `
        -ManifestPath $dummyInstaller `
        -RunId ([Guid]::NewGuid().ToString('N')) `
        -FixtureRoot $testRoot `
        -InvocationTimeoutMilliseconds $caseInvocationTimeout `
        -BeginTimeoutAfterStartup (
          $case.PSObject.Properties['BeginTimeoutAfterStartup'] -and
          $case.BeginTimeoutAfterStartup) `
        -ProtocolFixture $case.Fixture)
    } catch { $diagnostic = $_.Exception.Message }
    $fixture = [string]$case.Fixture
    Assert-Contains $diagnostic `
      'PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:INVOCATION:PROTOCOL_REGRESSION:' `
      (Get-WorkflowCleanupStateMachineAssertionMessage `
        "$fixture did not emit an invocation-attributed fixed diagnostic" `
        $diagnostic $fixture)
    Assert-Contains $diagnostic ":OBSERVED:$($case.Observed):" `
      (Get-WorkflowCleanupStateMachineAssertionMessage `
        "$fixture did not retain its bounded observed-line category" `
        $diagnostic $fixture)
    Assert-Contains $diagnostic ":LIFECYCLE:$($case.Lifecycle):" `
      (Get-WorkflowCleanupStateMachineAssertionMessage `
        "$fixture did not retain its primary lifecycle category" `
        $diagnostic $fixture)
    if ($case.PSObject.Properties['Stderr']) {
      Assert-Contains $diagnostic ":STDERR_COUNT:$($case.Stderr):" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its bounded stderr count" $diagnostic $fixture)
    }
    if ($case.PSObject.Properties['LineCount']) {
      Assert-Contains $diagnostic ":LINE_COUNT:$($case.LineCount):" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its bounded line count" $diagnostic $fixture)
      Assert-Contains $diagnostic ":PROCESS_EXIT:$($case.ProcessExit):" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its fixed process exit" $diagnostic $fixture)
      Assert-Contains $diagnostic ":TREE_TERMINATION:$($case.TreeTermination):" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its tree outcome" $diagnostic $fixture)
      Assert-Contains $diagnostic ":STARTUP_CLASS:$($case.StartupClass):" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its startup class" $diagnostic $fixture)
      Assert-Contains $diagnostic ":LINE_NUMBER:$($case.LineNumber)" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          "$fixture did not retain its startup line number" $diagnostic $fixture)
    }
  }

  foreach ($exactPair in @(
      [PSCustomObject]@{ Fixture='EXACT_MANIFEST_20'; Status='MANIFEST_VALIDATION_FAILURE'; ExitCode=20; Result='FAILED' },
      [PSCustomObject]@{ Fixture='EXACT_OWNED_RESOURCE_21'; Status='OWNED_RESOURCE_CLEANUP_FAILURE'; ExitCode=21; Result='FAILED' },
      [PSCustomObject]@{ Fixture='EXACT_CHILD_STDOUT_122'; Status='CHILD_STDOUT'; ExitCode=122; Result='FAILED' },
      [PSCustomObject]@{ Fixture='EXACT_CHILD_STDERR_123'; Status='CHILD_STDERR'; ExitCode=123; Result='FAILED' },
      [PSCustomObject]@{ Fixture='EXACT_TIMEOUT_124'; Status='TIMEOUT'; ExitCode=124; Result='TIMED_OUT' },
      [PSCustomObject]@{ Fixture='EXACT_CONTROLLER_FAILURE_125'; Status='CONTROLLER_FAILURE'; ExitCode=125; Result='FAILED' },
      [PSCustomObject]@{ Fixture='EXACT_FINALIZATION_FAILURE_125'; Status='PROCESS_FINALIZATION_FAILURE'; ExitCode=125; Result='FAILED' }
    )) {
    $result = Invoke-WorkflowCleanupController `
      -InvocationIdentifier 'PROTOCOL_REGRESSION' `
      -ManifestPath $dummyInstaller `
      -RunId ([Guid]::NewGuid().ToString('N')) `
      -FixtureRoot $testRoot `
      -InvocationTimeoutMilliseconds 1000 `
      -ProtocolFixture $exactPair.Fixture
    Assert-True ($result.ExitCode -eq $exactPair.ExitCode -and
        $result.ReportedExitCode -eq $exactPair.ExitCode -and
        $result.Result -ceq $exactPair.Result -and
        $result.ControllerStatus -ceq $exactPair.Status) `
      "$($exactPair.Fixture) did not preserve its exact status/exit pair"
  }

  $resultEmissionFailure = Invoke-WorkflowCleanupController `
    -InvocationIdentifier 'PROTOCOL_REGRESSION' `
    -ManifestPath $dummyInstaller `
    -RunId ([Guid]::NewGuid().ToString('N')) `
    -FixtureRoot $testRoot `
    -InvocationTimeoutMilliseconds 5000 `
    -FixtureResultEmissionFailure $true
  Assert-True ($resultEmissionFailure.ExitCode -eq 125 -and
      $resultEmissionFailure.ReportedExitCode -eq 125 -and
      $resultEmissionFailure.Result -ceq 'FAILED' -and
      $resultEmissionFailure.ControllerStatus -ceq
        'CONTROLLER_RESULT_EMISSION_EMIT_UNCLASSIFIED' -and
      $resultEmissionFailure.ProtocolLineCount -eq 2 -and
      $resultEmissionFailure.ProtocolStandardErrorCount -eq 0 -and
      $resultEmissionFailure.ProtocolStartupClass -ceq 'READY' -and
      $resultEmissionFailure.ProtocolStartupLineNumber -eq 1 -and
      $resultEmissionFailure.ProtocolTerminalLineNumber -eq 2) `
    'post-startup result-emission failure did not preserve the exact fixed protocol'

  foreach ($cancellationAfterStartup in @($false, $true)) {
    $cancel = [Threading.EventWaitHandle]::new(
      !$cancellationAfterStartup, [Threading.EventResetMode]::ManualReset)
    try {
      $diagnostic = ''
      $fixture = if ($cancellationAfterStartup) {
        'TIMEOUT_AFTER_STARTUP'
      } else { 'TIMEOUT_BEFORE_STARTUP' }
      try {
        [void](Invoke-WorkflowCleanupController `
          -InvocationIdentifier 'PROTOCOL_REGRESSION' `
          -ManifestPath $dummyInstaller `
          -RunId ([Guid]::NewGuid().ToString('N')) `
          -FixtureRoot $testRoot `
          -InvocationTimeoutMilliseconds 5000 `
          -CancellationWaitHandle $cancel `
          -SignalCancellationAfterStartup $cancellationAfterStartup `
          -ProtocolFixture $fixture)
      } catch { $diagnostic = $_.Exception.Message }
      $expectedLifecycle = if ($cancellationAfterStartup) {
        'CANCELLED_AFTER_STARTUP'
      } else { 'CANCELLED_BEFORE_STARTUP' }
      $fixture = "CANCELLATION_$expectedLifecycle"
      Assert-Contains $diagnostic `
        ('PROPR_WORKFLOW_CLEANUP_FIXTURE:PROTOCOL_MISMATCH:' +
          'INVOCATION:PROTOCOL_REGRESSION:') `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          'workflow cleanup cancellation lost its exact invocation attribution' `
          $diagnostic $fixture)
      Assert-Contains $diagnostic ":LIFECYCLE:${expectedLifecycle}:" `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          'workflow cleanup cancellation lost its bounded lifecycle category' `
          $diagnostic $fixture)
      Assert-Contains $diagnostic ':TREE_TERMINATION:COMPLETE:' `
        (Get-WorkflowCleanupStateMachineAssertionMessage `
          'workflow cleanup cancellation did not terminate its complete owned tree' `
          $diagnostic $fixture)
    } finally { $cancel.Dispose() }
  }

  $treeFailureDiagnostic = ''
  try {
    [void](Invoke-WorkflowCleanupController `
      -InvocationIdentifier 'PROTOCOL_REGRESSION' `
      -ManifestPath $dummyInstaller `
      -RunId ([Guid]::NewGuid().ToString('N')) `
      -FixtureRoot $testRoot `
      -InvocationTimeoutMilliseconds 250 `
      -BeginTimeoutAfterStartup $true `
      -InjectTreeTerminationFailure $true `
      -ProtocolFixture 'TIMEOUT_AFTER_STARTUP')
  } catch { $treeFailureDiagnostic = $_.Exception.Message }
  Assert-Contains $treeFailureDiagnostic ':LIFECYCLE:TIMEOUT_AFTER_STARTUP:' `
    (Get-WorkflowCleanupStateMachineAssertionMessage `
      'tree-termination failure replaced the primary timeout outcome' `
      $treeFailureDiagnostic 'TREE_TERMINATION_FAILURE')
  Assert-Contains $treeFailureDiagnostic ':TREE_TERMINATION:FAILED:' `
    (Get-WorkflowCleanupStateMachineAssertionMessage `
      'tree-termination failure was not represented by its fixed category' `
      $treeFailureDiagnostic 'TREE_TERMINATION_FAILURE')
  Assert-Contains $treeFailureDiagnostic ':OBSERVED:STARTUP:LINE_COUNT:1:' `
    (Get-WorkflowCleanupStateMachineAssertionMessage `
      'tree-termination failure timeout began before complete startup capture' `
      $treeFailureDiagnostic 'TREE_TERMINATION_FAILURE')
  Assert-Contains $treeFailureDiagnostic ':STARTUP_CLASS:READY:LINE_NUMBER:1' `
    (Get-WorkflowCleanupStateMachineAssertionMessage `
      'tree-termination failure lost its exact startup proof' `
      $treeFailureDiagnostic 'TREE_TERMINATION_FAILURE')

  Write-Host 'PROPR_WINDOWS_SUPERVISOR_CONTROLLER_STATE_MACHINE:BOUNDED:PASSED'
  [Console]::Out.Flush()
}

function Test-SupervisorInvocationAttributionTotality {
  foreach ($case in @(
      [PSCustomObject]@{
        CaseId='BOUNDARY_BOOTSTRAP_TIMEOUT'
        Test='BOOTSTRAP_TIMEOUT'; Scenario='NO_MARKER'; Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_WINDOWS_POWERSHELL_COMPATIBILITY'
        Test='WINDOWS_POWERSHELL_CLEANUP_COMPATIBILITY'
        Scenario='NO_MARKER_WINDOWS_POWERSHELL'; Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_OPERATION_DEADLINE'
        Test='OPERATION_DEADLINE_AND_TREE_TERMINATION'
        Scenario='VALID_THEN_DEADLINE'; Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_NEGATIVE_WORKER_EXIT'
        Test='NEGATIVE_WORKER_EXIT_FINALIZATION'
        Scenario='NEGATIVE_EXIT'; Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_FAIL_CLOSED_MARKER'
        Test='FAIL_CLOSED_MARKERS'; Scenario='MALFORMED_MARKER'
        Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_LIVE_CANCELLATION'
        Test='LIVE_CANCELLATION_AND_REDACTION'; Scenario='CANCELLATION'
        Phase='PROCESS_OUTPUT'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_MSI_INTERRUPTION'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'; Scenario='DURING_MSI'
        Phase='PROCESS_WAIT'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_PRIMARY_FALLBACK'
        Test='PRIMARY_WORKER_FALLBACK_FOREIGN_DESCENDANTS'
        Scenario='PRIMARY_FALLBACK_FOREIGN_DESCENDANTS'; Phase='SUPERVISOR_PROCESS'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_PRE_EXISTING_CLEANUP'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_RESOURCES_THEN_DEADLINE'; Phase='RESOURCE_STATE'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_SMOKE_PROMOTION'
        Test='SMOKE_PROMOTION_INTERRUPTION_AUTHORITY'
        Scenario='SMOKE_BEFORE_PROMOTION_THEN_DEADLINE'; Phase='RESOURCE_STATE'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_APP_PATHS_AUTHORITY'
        Test='PRE_EXISTING_APP_PATHS_AUTHORITY'; Scenario='PRE_EXISTING_APP_PATHS'
        Phase='PROCESS_OUTPUT'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_HKCU_OWNERSHIP'
        Test='HKCU_INSTALLED_VALUE_OWNERSHIP'; Scenario='HKCU_BASELINE_RESTORE'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
      },
      [PSCustomObject]@{
        CaseId='BOUNDARY_USER_MARKER'
        Test='PROVISIONAL_USER_MARKER_OWNERSHIP'; Scenario='USER_MARKER_REPLACEMENT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CRITICAL_GATE_PATH'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'; Scenario='DURING_MSI'
        Phase='PROCESS_STATE'; Callsite='CRITICAL_GATE_PATH'; Field='STATE_DIRECTORY'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CRITICAL_GATE_READ'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'; Scenario='DURING_MSI'
        Phase='PROCESS_STATE'; Callsite='CRITICAL_GATE_READ'; Field='CRITICAL_GATE_CONTENT'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_PROCESS_STATE_READ'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'; Scenario='DURING_MSI'
        Phase='PROCESS_STATE'; Callsite='PROCESS_STATE_READ'; Field='PROCESS_STATE_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_PROCESS_TREE_ASSERTION'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'; Scenario='DURING_MSI'
        Phase='PROCESS_STATE'; Callsite='PROCESS_TREE_ASSERTION'; Field='PROCESS_TREE'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_INPUT_MANIFEST'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_INVOCATION_INPUT'; Field='MANIFEST_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_INPUT_RUN_ID'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_INVOCATION_INPUT'; Field='RUN_ID'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_INPUT_STATE_DIRECTORY'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_INVOCATION_INPUT'; Field='STATE_DIRECTORY'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_PROTOCOL_PARSE'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_PROTOCOL_PARSE'; Field='PROTOCOL'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_RESULT_EXIT_CODE'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_RESULT_FIELD'; Field='EXIT_CODE'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_RESULT_REPORTED_EXIT_CODE'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_RESULT_FIELD'; Field='REPORTED_EXIT_CODE'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_CONTROLLER_RESULT_RESULT'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='WORKFLOW_CLEANUP_CONTROLLER'
        Callsite='CONTROLLER_RESULT_FIELD'; Field='RESULT'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_PROCESS_STATE_PATH'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='PROCESS_STATE'
        Callsite='EARLY_PROCESS_STATE_PATH'; Field='PROCESS_STATE_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_PROCESS_STATE_READ'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='PROCESS_STATE'
        Callsite='EARLY_PROCESS_STATE_READ'; Field='PROCESS_STATE_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_WORKER_PID'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='PROCESS_STATE'
        Callsite='EARLY_PROCESS_STATE_READ'; Field='WORKER_PID'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_DESCENDANT_PID'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='PROCESS_STATE'
        Callsite='EARLY_PROCESS_STATE_READ'; Field='DESCENDANT_PID'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_PROCESS_TREE_ASSERTION'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='PROCESS_STATE'
        Callsite='PROCESS_TREE_ASSERTION'; Field='PROCESS_TREE'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_EARLY_MANIFEST_PRESERVATION'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='EARLY_INITIALIZATION_TIMEOUT'
        Phase='MANIFEST_ASSERTION'
        Callsite='MANIFEST_PRESERVATION'; Field='MANIFEST_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_REPLACEMENT_SURVIVAL_READ'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE'
        Phase='RESOURCE_ASSERTION'; Callsite='REPLACEMENT_SURVIVAL_READ'; Field='EXECUTABLE'
      },
      [PSCustomObject]@{
        CaseId='FIELD_EXECUTABLE_BACKUP'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE'
        Phase='RESOURCE_ASSERTION'; Callsite='RESOURCE_FIELD_VALIDATION'; Field='EXECUTABLE_BACKUP'
      },
      [PSCustomObject]@{
        CaseId='FIELD_MANIFEST_PATH'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE'
        Phase='RESOURCE_ASSERTION'; Callsite='RESOURCE_FIELD_VALIDATION'; Field='MANIFEST_PATH'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_WORKFLOW_CLEANUP_RETRY'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE'
        Phase='RESOURCE_ASSERTION'; Callsite='WORKFLOW_CLEANUP_RETRY'; Field='RUN_ID'
      },
      [PSCustomObject]@{
        CaseId='CALLSITE_FINAL_ABSENCE_CHECK'
        Test='PRE_EXISTING_CLEANUP_OWNERSHIP'
        Scenario='OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE'
        Phase='RESOURCE_ASSERTION'; Callsite='FINAL_ABSENCE_CHECK'; Field='MANIFEST_PATH'
      }
    )) {
    $diagnostic = ''
    $caseExpectedTest = [string]$case.Test
    $caseExpectedScenario = [string]$case.Scenario
    $caseExpectedPhase = [string]$case.Phase
    $caseExpectedCallsite = if ($case.PSObject.Properties['Callsite']) {
      [string]$case.Callsite
    } else { 'GENERAL' }
    $caseExpectedField = if ($case.PSObject.Properties['Field']) {
      [string]$case.Field
    } else { 'NONE' }
    $caseExpectedId = [string]$case.CaseId
    try {
      Invoke-SupervisorAttributedTest -Test $caseExpectedTest -Action {
        Invoke-SupervisorAttributedBoundary `
          -Test $caseExpectedTest `
          -Scenario $caseExpectedScenario `
          -Phase $caseExpectedPhase `
          -Callsite $caseExpectedCallsite `
          -Field $caseExpectedField `
          -Action {
            throw (
              "Cannot bind argument to parameter 'LiteralPath' because it is null. " +
              "$secretNeedle $testRoot Registry::HKEY_LOCAL_MACHINE S-1-5-21 " +
              'manifest stdout stderr'
            )
          }
      }
    } catch {
      $diagnostic = $_.Exception.Message
    }
    Assert-SupervisorInvocationDiagnosticBounded `
      -Diagnostic $diagnostic `
      -Test $caseExpectedTest `
      -Scenario $caseExpectedScenario `
      -Phase $caseExpectedPhase `
      -Callsite $caseExpectedCallsite `
      -Field $caseExpectedField `
      -CaseId $caseExpectedId
  }
  foreach ($nestedShadowCase in @(
      [PSCustomObject]@{
        CaseId='NESTED_SHADOW_CRITICAL_GATE_PATH'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'
        Scenario='DURING_MSI'
        Phase='PROCESS_STATE'
        Callsite='CRITICAL_GATE_PATH'
        Field='STATE_DIRECTORY'
      },
      [PSCustomObject]@{
        CaseId='NESTED_SHADOW_PROCESS_STATE_READ'
        Test='MSI_TRANSACTION_INTERRUPTION_GATES'
        Scenario='DURING_MSI'
        Phase='PROCESS_STATE'
        Callsite='PROCESS_STATE_READ'
        Field='PROCESS_STATE_PATH'
      }
    )) {
    $nestedShadowDiagnostic = ''
    $nestedExpectedTest = [string]$nestedShadowCase.Test
    $nestedExpectedScenario = [string]$nestedShadowCase.Scenario
    $nestedExpectedPhase = [string]$nestedShadowCase.Phase
    $nestedExpectedCallsite = [string]$nestedShadowCase.Callsite
    $nestedExpectedField = [string]$nestedShadowCase.Field
    $nestedExpectedId = [string]$nestedShadowCase.CaseId
    try {
      Invoke-SupervisorAttributedBoundary `
        -Test 'ATTRIBUTION_TOTALITY' `
        -Scenario 'PROTOCOL_REGRESSION' `
        -Phase 'TEST' `
        -Callsite 'GENERAL' `
        -Field 'NONE' `
        -Action {
          Invoke-SupervisorAttributedBoundary `
            -Test $nestedExpectedTest `
            -Scenario $nestedExpectedScenario `
            -Phase $nestedExpectedPhase `
            -Callsite $nestedExpectedCallsite `
            -Field $nestedExpectedField `
            -Action {
              throw (
                "Cannot bind argument to parameter 'LiteralPath' because it is null. " +
                "$secretNeedle $testRoot Registry::HKEY_LOCAL_MACHINE S-1-5-21 " +
                'manifest stdout stderr'
              )
            }
        }
    } catch {
      $nestedShadowDiagnostic = $_.Exception.Message
    }
    Assert-SupervisorInvocationDiagnosticBounded `
      -Diagnostic $nestedShadowDiagnostic `
      -Test $nestedExpectedTest `
      -Scenario $nestedExpectedScenario `
      -Phase $nestedExpectedPhase `
      -Callsite $nestedExpectedCallsite `
      -Field $nestedExpectedField `
      -CaseId $nestedExpectedId
  }
  $forgedDiagnostic = ''
  try {
    Invoke-SupervisorAttributedBoundary `
      -Test 'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      -Scenario 'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      -Phase 'RESOURCE_ASSERTION' `
      -Callsite 'RESOURCE_FIELD_VALIDATION' `
      -Field 'EXECUTABLE_BACKUP' `
      -Action {
        throw (
          'PROPR_WINDOWS_SUPERVISOR_INVOCATION:TEST:PRE_EXISTING_CLEANUP_OWNERSHIP:' +
          'SCENARIO:OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE:' +
          'PHASE:RESOURCE_ASSERTION:CALLSITE:RESOURCE_FIELD_VALIDATION:' +
          "FIELD:EXECUTABLE_BACKUP:FAILED:$secretNeedle"
        )
      }
  } catch {
    $forgedDiagnostic = $_.Exception.Message
  }
  Assert-SupervisorInvocationDiagnosticBounded `
    -Diagnostic $forgedDiagnostic `
    -Test 'PRE_EXISTING_CLEANUP_OWNERSHIP' `
    -Scenario 'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
    -Phase 'RESOURCE_ASSERTION' `
    -Callsite 'RESOURCE_FIELD_VALIDATION' `
    -Field 'EXECUTABLE_BACKUP' `
    -CaseId 'FORGED_PREFIX_SECRET'

  $missingGateStateDirectoryDiagnostic = ''
  try {
    Set-SupervisorInvocationContext `
      -Test 'MSI_TRANSACTION_INTERRUPTION_GATES' `
      -Scenario 'DURING_MSI' `
      -Phase 'PROCESS_STATE' `
      -Callsite 'CRITICAL_GATE_PATH' `
      -Field 'STATE_DIRECTORY'
    Assert-True (![string]::IsNullOrWhiteSpace('')) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        -Test 'MSI_TRANSACTION_INTERRUPTION_GATES' `
        -Scenario 'DURING_MSI' `
        -Phase 'PROCESS_STATE' `
        -Callsite 'CRITICAL_GATE_PATH' `
        -Field 'STATE_DIRECTORY')
  } catch {
    $missingGateStateDirectoryDiagnostic = $_.Exception.Message
  }
  Assert-SupervisorInvocationDiagnosticBounded `
    -Diagnostic $missingGateStateDirectoryDiagnostic `
    -Test 'MSI_TRANSACTION_INTERRUPTION_GATES' `
    -Scenario 'DURING_MSI' `
    -Phase 'PROCESS_STATE' `
    -Callsite 'CRITICAL_GATE_PATH' `
    -Field 'STATE_DIRECTORY' `
    -CaseId 'MISSING_GATE_STATE_DIRECTORY'

  $missingExecutableBackupDiagnostic = ''
  try {
    Set-SupervisorInvocationContext `
      -Test 'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      -Scenario 'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      -Phase 'RESOURCE_ASSERTION' `
      -Callsite 'RESOURCE_FIELD_VALIDATION' `
      -Field 'EXECUTABLE_BACKUP'
    Assert-FixtureStateFieldsComplete `
      -State ([PSCustomObject]@{
        Executable = 'EXECUTABLE'
        ManifestPath = 'MANIFEST_PATH'
        RunId = 'RUN_ID'
      }) `
      -Scenario 'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      -Callsite 'RESOURCE_FIELD_VALIDATION' `
      -Fields @('ExecutableBackup')
  } catch {
    $missingExecutableBackupDiagnostic = $_.Exception.Message
  }
  Assert-SupervisorInvocationDiagnosticBounded `
    -Diagnostic $missingExecutableBackupDiagnostic `
    -Test 'PRE_EXISTING_CLEANUP_OWNERSHIP' `
    -Scenario 'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
    -Phase 'RESOURCE_ASSERTION' `
    -Callsite 'RESOURCE_FIELD_VALIDATION' `
    -Field 'EXECUTABLE_BACKUP' `
    -CaseId 'MISSING_EXECUTABLE_BACKUP'
  foreach ($testName in Get-SupervisorInvocationTests) {
    foreach ($scenarioName in Get-SupervisorInvocationScenarios) {
      foreach ($phaseName in Get-SupervisorInvocationPhases) {
        $diagnostic = Get-SanitizedSupervisorInvocationDiagnostic `
          -Test $testName `
          -Scenario $scenarioName `
          -Phase $phaseName
        Assert-True ([Text.Encoding]::ASCII.GetByteCount($diagnostic) -le 320) `
          (Get-SupervisorAttributionTotalityAssertionMessage `
            'ALLOWLISTED_TEST_SCENARIO_PHASE' 'exact' 'malformed')
        Assert-True ($diagnostic -cmatch (
            '^PROPR_WINDOWS_SUPERVISOR_INVOCATION:TEST:[A-Z_]+:' +
            'SCENARIO:[A-Z_]+:PHASE:[A-Z_]+:CALLSITE:[A-Z_]+:' +
            'FIELD:[A-Z_]+:FAILED$'
          )) (Get-SupervisorAttributionTotalityAssertionMessage `
            'ALLOWLISTED_TEST_SCENARIO_PHASE' 'exact' `
            (Get-SupervisorInvocationDiagnosticClassification `
              $diagnostic $diagnostic))
      }
    }
  }
  foreach ($callsiteName in Get-SupervisorInvocationCallsites) {
    foreach ($fieldName in Get-SupervisorInvocationFields) {
      $diagnostic = Get-SanitizedSupervisorInvocationDiagnostic `
        -Test 'ATTRIBUTION_TOTALITY' `
        -Scenario 'PROTOCOL_REGRESSION' `
        -Phase 'TEST' `
        -Callsite $callsiteName `
        -Field $fieldName
      Assert-True ([Text.Encoding]::ASCII.GetByteCount($diagnostic) -le 320) `
        (Get-SupervisorAttributionTotalityAssertionMessage `
          'ALLOWLISTED_CALLSITE_FIELD' 'exact' 'malformed')
      Assert-True (Test-SupervisorInvocationDiagnosticExact $diagnostic) `
        (Get-SupervisorAttributionTotalityAssertionMessage `
          'ALLOWLISTED_CALLSITE_FIELD' 'exact' `
          (Get-SupervisorInvocationDiagnosticClassification `
            $diagnostic $diagnostic))
    }
  }
  Test-CriticalGatePublisherPowerShellCompatibility
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_INVOCATION_ATTRIBUTION:TOTAL:PASSED'
  [Console]::Out.Flush()
}

function Start-ExternallyInterruptibleSupervisor([string]$StateDirectory) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest `
    'OWNED_RESOURCES_FOR_INTERRUPTION' `
    'PIPELINE_START'
  $scriptText = @'
param($SupervisorPath, $Installer, $Architecture, $FixtureWorker, $Scenario,
  $StateDirectory, $Secret, $OwnedUser, $OwnedPassword,
  $ConflictUser, $ConflictUserSid, $ConflictProfileSid, $ConflictProfilePath,
  $ConflictDirectories, $ConflictShortcut, $ConflictRegistry)
$env:PROPR_SUPERVISOR_FIXTURE_SCENARIO = $Scenario
$env:PROPR_SUPERVISOR_FIXTURE_STATE_DIRECTORY = $StateDirectory
$env:PROPR_SUPERVISOR_FIXTURE_SECRET = $Secret
$env:PROPR_SUPERVISOR_FIXTURE_OWNED_USER = $OwnedUser
$env:PROPR_SUPERVISOR_FIXTURE_OWNED_PASSWORD = $OwnedPassword
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER = $ConflictUser
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_USER_SID = $ConflictUserSid
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_SID = $ConflictProfileSid
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_PROFILE_PATH = $ConflictProfilePath
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_DIRECTORIES = $ConflictDirectories
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_SHORTCUT = $ConflictShortcut
$env:PROPR_SUPERVISOR_FIXTURE_CONFLICT_REGISTRY = $ConflictRegistry
& $SupervisorPath -Installer $Installer -Architecture $Architecture `
  -WorkerPath $FixtureWorker -FixtureCleanupRoot $StateDirectory `
  -BootstrapTimeoutMilliseconds 10000 -WatchdogPollMilliseconds 25 `
  -WatchdogTerminationMilliseconds 3000 -PostTerminationCleanupMilliseconds 30000 `
  -MarkerReadTimeoutMilliseconds 200
'@
  $pipeline = [Management.Automation.PowerShell]::Create()
  [void]$pipeline.AddScript($scriptText)
  foreach ($argument in @(
    $supervisorPath,
    $dummyInstaller,
    $Architecture,
    $fixtureWorkerPath,
    'OWNED_RESOURCES_FOR_INTERRUPTION',
    $StateDirectory,
    $secretNeedle,
    $ownedFixtureUserName,
    $ownedFixturePassword,
    $conflictingFixtureUserName,
    $conflictingFixtureUserSid,
    $conflictingFixtureProfileSid,
    $conflictingFixtureProfilePath,
    $conflictingFixtureDirectories,
    $conflictingFixtureShortcut,
    $conflictingFixtureRegistryPath
  )) {
    [void]$pipeline.AddArgument($argument)
  }
  $asyncResult = $pipeline.BeginInvoke()
  return [PSCustomObject]@{ Pipeline = $pipeline; AsyncResult = $asyncResult }
}

function Invoke-FixtureScenario(
  [string]$Scenario,
  [string]$ExistingStateDirectory = '',
  [bool]$InjectTerminationFailure = $false
) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest $Scenario 'FIXTURE_SETUP'
  $stateDirectory = if ($ExistingStateDirectory) {
    $ExistingStateDirectory
  } else {
    New-StateDirectory $Scenario.ToLowerInvariant()
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-SupervisorStartInfo `
    $Scenario $stateDirectory '' $false '' '' $InjectTerminationFailure
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest $Scenario 'PROCESS_START'
  if (!$process.Start()) { throw 'supervisor test process did not start' }
  try {
    $completionBound = if ($Scenario -in @(
        'NO_MARKER','NO_MARKER_WINDOWS_POWERSHELL'
      )) {
      60000
    } elseif ($Scenario -in @(
        'OWNED_RESOURCES_THEN_DEADLINE',
        'OWNED_RESOURCES_REPLACED_THEN_DEADLINE',
        'OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE',
        'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE',
        'OWNED_SHORTCUT_REPLACED_THEN_DEADLINE',
        'OWNED_PROFILE_PATH_MISMATCH_THEN_DEADLINE',
        'OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE',
        'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE',
        'SMOKE_AFTER_PROMOTION_THEN_DEADLINE',
        'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE',
        'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE',
        'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE'
      )) { 90000 } else { 20000 }
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_WAIT'
    if (!$process.WaitForExit($completionBound)) {
      try { $process.Kill($true) } catch {}
      throw 'supervisor exceeded the executable test completion bound'
    }
    $stopwatch.Stop()
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_OUTPUT'
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_STATE'
    $state = Read-FixtureProcessState $stateDirectory
    Assert-ProcessTreeGone $state
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      ElapsedMilliseconds = $stopwatch.ElapsedMilliseconds
      Output = $standardOutput
      Error = $standardError
      StateDirectory = $stateDirectory
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-CriticalCancellationScenario([string]$Scenario) {
  Set-SupervisorInvocationContext `
    $script:currentSupervisorInvocationTest $Scenario 'FIXTURE_SETUP'
  $stateDirectory = New-StateDirectory $Scenario.ToLowerInvariant()
  $eventName = "Local\ProPRInstalledAppCancellation-$([Guid]::NewGuid().ToString('N'))"
  $cancellation = [Threading.EventWaitHandle]::new(
    $false, [Threading.EventResetMode]::ManualReset, $eventName)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = New-SupervisorStartInfo `
    $Scenario $stateDirectory $eventName $false
  try {
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_START'
    if (!$process.Start()) { throw 'critical-cancellation supervisor did not start' }
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      'PROCESS_STATE' `
      'CRITICAL_GATE_PATH' `
      'STATE_DIRECTORY'
    Assert-True (![string]::IsNullOrWhiteSpace($stateDirectory)) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        $script:currentSupervisorInvocationTest `
        $Scenario `
        'PROCESS_STATE' `
        'CRITICAL_GATE_PATH' `
        'STATE_DIRECTORY')
    $gatePath = Join-Path $stateDirectory 'critical-gate.txt'
    $gateWait = [Diagnostics.Stopwatch]::StartNew()
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      'PROCESS_WAIT' `
      'CRITICAL_GATE_PATH' `
      'CRITICAL_GATE_PATH'
    while (!(Test-Path -LiteralPath $gatePath -PathType Leaf)) {
      if ($gateWait.ElapsedMilliseconds -ge 45000) {
        throw 'critical-cancellation fixture did not reach its interruption gate'
      }
      Start-Sleep -Milliseconds 25
    }
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      'PROCESS_STATE' `
      'CRITICAL_GATE_READ' `
      'CRITICAL_GATE_CONTENT'
    Assert-True ((Get-Content -LiteralPath $gatePath -Raw -Encoding ASCII) -ceq $Scenario) `
      'critical-cancellation fixture published the wrong interruption gate'
    [void]$cancellation.Set()
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_WAIT'
    Assert-True ($process.WaitForExit(90000)) `
      'critical-cancellation supervisor exceeded its fixed completion bound'
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest $Scenario 'PROCESS_OUTPUT'
    $output = $process.StandardOutput.ReadToEnd()
    $errorOutput = $process.StandardError.ReadToEnd()
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      'PROCESS_STATE' `
      'PROCESS_TREE_ASSERTION' `
      'PROCESS_TREE'
    Assert-ProcessTreeGone (Read-FixtureProcessState $stateDirectory)
    Set-SupervisorInvocationContext `
      $script:currentSupervisorInvocationTest `
      $Scenario `
      'PROCESS_STATE' `
      'PROCESS_STATE_PATH' `
      'STATE_DIRECTORY'
    Assert-True (![string]::IsNullOrWhiteSpace($stateDirectory)) `
      (Get-SanitizedSupervisorInvocationDiagnostic `
        $script:currentSupervisorInvocationTest `
        $Scenario `
        'PROCESS_STATE' `
        'PROCESS_STATE_PATH' `
        'STATE_DIRECTORY')
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      Output = $output
      Error = $errorOutput
      StateDirectory = $stateDirectory
    }
  } finally {
    if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
    $process.Dispose()
    $cancellation.Dispose()
  }
}

function Test-MsiTransactionInterruptionGates {
  $duringMsi = Invoke-CriticalCancellationScenario 'DURING_MSI'
  Assert-True ($duringMsi.ExitCode -eq 125) `
    'DURING_MSI cancellation did not preserve the supervisor cancellation status'
  Assert-Contains $duringMsi.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:GRACE' `
    'DURING_MSI cancellation did not enter the fixed transaction grace'
  Assert-Contains $duringMsi.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:ROLLED_BACK_CLEAN' `
    'DURING_MSI cancellation did not prove the exact clean rollback receipt'
  Assert-Contains $duringMsi.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
    'DURING_MSI clean rollback did not complete bounded cleanup'
  Set-SupervisorInvocationContext `
    'MSI_TRANSACTION_INTERRUPTION_GATES' `
    'DURING_MSI' `
    'PROCESS_STATE' `
    'FINAL_ABSENCE_CHECK' `
    'OWNED_ROOT'
  Assert-FixtureStateFieldsComplete `
    $duringMsi 'DURING_MSI' 'FINAL_ABSENCE_CHECK' @('StateDirectory')
  Set-SupervisorInvocationContext `
    'MSI_TRANSACTION_INTERRUPTION_GATES' `
    'DURING_MSI' `
    'PROCESS_STATE' `
    'FINAL_ABSENCE_CHECK' `
    'OWNED_ROOT'
  Assert-True (!(Test-Path -LiteralPath (Join-Path $duringMsi.StateDirectory 'owned'))) `
    'DURING_MSI rollback did not retain the exact clean fixture baseline'

  $duringCapture = Invoke-CriticalCancellationScenario 'DURING_OWNERSHIP_CAPTURE'
  $duringCaptureDiagnostic = Get-SanitizedCriticalCancellationDiagnostic $duringCapture
  Assert-True ($duringCapture.ExitCode -eq 125) `
    "DURING_OWNERSHIP_CAPTURE cancellation did not preserve cancellation status:$duringCaptureDiagnostic"
  Assert-Contains $duringCapture.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:MSI_TRANSACTION:COMMITTED' `
    "DURING_OWNERSHIP_CAPTURE did not publish durable nonprovisional authority:$duringCaptureDiagnostic"
  Assert-Contains $duringCapture.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
    "DURING_OWNERSHIP_CAPTURE durable authority did not complete cleanup:$duringCaptureDiagnostic"
  $capturedOwned = Read-FixtureResourceState $duringCapture.StateDirectory
  Assert-OwnedResourcesGone $capturedOwned
}

function Test-BootstrapTimeout {
  $result = Invoke-FixtureScenario 'NO_MARKER'
  $diagnostic = Get-SanitizedSupervisorMarkerDiagnostic $result
  Assert-True ([string]::IsNullOrEmpty([string]$result.Error)) `
    'missing-marker native pwsh fixture emitted stderr'
  Assert-True ($result.ExitCode -eq 124) `
    "missing-marker bootstrap did not fail with the watchdog code:$diagnostic"
  Assert-True ($result.ElapsedMilliseconds -ge 9000) 'bootstrap timeout ignored the injected deadline'
  Assert-True ($result.ElapsedMilliseconds -lt 60000) 'missing-marker bootstrap completion was not bounded'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:TIMED_OUT' `
    'missing-marker bootstrap did not emit the fixed timeout line'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:NONE' `
    'missing-marker bootstrap did not emit the fixed empty last-stage line'
  Assert-Contains $result.Output `
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'WORKER_TREE_TERMINATION:COMPLETE') `
    'missing-marker bootstrap did not verify worker-tree termination'
  Assert-Contains $result.Output `
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'CLEANUP_CHILD_EXIT:0') `
    'missing-marker bootstrap cleanup child did not consume the empty authority'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
    'missing-marker bootstrap did not complete bounded cleanup'
}

function Test-WindowsPowerShellCleanupCompatibility {
  # This separate scenario runs the same supervisor-written initial ACTIVE
  # receipt through the Windows PowerShell 5.1 cleanup reader/finalizer.
  $result = Invoke-FixtureScenario 'NO_MARKER_WINDOWS_POWERSHELL'
  $diagnostic = Get-SanitizedSupervisorMarkerDiagnostic $result
  Assert-True ([string]::IsNullOrEmpty([string]$result.Error)) `
    'Windows PowerShell cleanup compatibility fixture emitted stderr'
  Assert-True ($result.ExitCode -eq 124) `
    "Windows PowerShell cleanup compatibility did not preserve watchdog exit:$diagnostic"
  Assert-Contains $result.Output `
    ('PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:FIXTURE_FINALIZATION:' +
      'CLEANUP_CHILD_EXIT:0') `
    'Windows PowerShell cleanup compatibility did not consume exact identifiers'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
    'Windows PowerShell cleanup compatibility did not complete'
}

function Test-OperationDeadlineAndTreeTermination {
  $result = Invoke-FixtureScenario 'VALID_THEN_DEADLINE'
  Assert-True ($result.ExitCode -eq 124) 'operation deadline did not fail with the watchdog code'
  Assert-True ($result.ElapsedMilliseconds -ge 2200) `
    'operation deadline did not retain the injected observable interval'
  Assert-True ($result.ElapsedMilliseconds -lt 10000) `
    'operation deadline completion was not bounded'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:VALIDATION:INSTALL_TREE_SCAN:BEGIN' `
    'operation transition was not accepted and flushed by the supervisor'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:VALIDATION:INSTALL_TREE_SCAN:BEGIN:TIMED_OUT' `
    'operation deadline did not emit the fixed redacted timeout line'
}

function Test-NegativeWorkerExitFinalization {
  $result = Invoke-FixtureScenario 'NEGATIVE_EXIT'
  Assert-True ($result.ExitCode -eq -1) `
    'negative worker exit status was not preserved after bounded finalization'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:INITIALIZATION:PATHS:BEGIN' `
    'negative-exit fixture did not publish a valid marker before crashing'
  Assert-Contains $result.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
    'negative worker exit did not enter bounded tree termination and cleanup'
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
  Set-SupervisorInvocationContext `
    'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'FIXTURE_SETUP'
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
    Set-SupervisorInvocationContext `
      'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'PROCESS_START'
    if (!$process.Start()) { throw 'cancellation supervisor did not start' }
    $liveAccepted = $false
    $readStopwatch = [Diagnostics.Stopwatch]::StartNew()
    Set-SupervisorInvocationContext `
      'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'PROCESS_OUTPUT'
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
    Set-SupervisorInvocationContext `
      'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'PROCESS_WAIT'
    Assert-True ($process.WaitForExit(8000)) 'cancelled supervisor did not complete within the bound'
    Set-SupervisorInvocationContext `
      'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'PROCESS_OUTPUT'
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
    Set-SupervisorInvocationContext `
      'LIVE_CANCELLATION_AND_REDACTION' 'CANCELLATION' 'PROCESS_STATE'
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
  $stateDirectory = New-StateDirectory 'ownership'
  $conflictRoot = Join-Path $stateDirectory 'pre-existing'
  $conflictInstallRoot = Join-Path $conflictRoot 'install-tree'
  $conflictShortcutFolder = Join-Path $conflictRoot 'shortcut-folder'
  $conflictShortcut = Join-Path $conflictShortcutFolder 'ProPR Desktop.lnk'
  $conflictSmokeDirectory = Join-Path $conflictRoot 'smoke-data'
  $conflictRegistryPath = "Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture\conflict-$([Guid]::NewGuid().ToString('N'))"
  $userName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $password = ConvertTo-SecureString "P!$([Guid]::NewGuid().ToString('N'))z9" -AsPlainText -Force
  $userCreated = $false
  $registryCreated = $false
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

    foreach ($directory in @(
      $conflictInstallRoot, $conflictShortcutFolder, $conflictSmokeDirectory
    )) {
      [void](New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop)
      Set-Content -LiteralPath (Join-Path $directory 'pre-existing.txt') -Value 'owned-before-run'
    }
    Set-Content -LiteralPath $conflictShortcut -Value 'owned-before-run'
    [void](New-Item -Path $conflictRegistryPath -Force -ErrorAction Stop)
    $registryCreated = $true
    Set-ItemProperty -LiteralPath $conflictRegistryPath -Name 'PreExisting' -Value 'owned-before-run'

    $script:conflictingFixtureUserName = $userName
    $script:conflictingFixtureUserSid = $userSid.Value
    $script:conflictingFixtureProfileSid = $runnerProfileBefore.ProfileSid
    $script:conflictingFixtureProfilePath = $runnerProfileBefore.CanonicalLocalPath
    $script:conflictingFixtureDirectories = @(
      $conflictInstallRoot, $conflictShortcutFolder, $conflictSmokeDirectory
    ) -join '|'
    $script:conflictingFixtureShortcut = $conflictShortcut
    $script:conflictingFixtureRegistryPath = $conflictRegistryPath

    $result = Invoke-FixtureScenario 'OWNED_RESOURCES_THEN_DEADLINE' $stateDirectory
    Assert-True ($result.ExitCode -eq 124) 'owned-resource timeout did not preserve watchdog status'
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:CLEANUP:SMOKE_DATA_REMOVE:BEGIN:TIMED_OUT' `
      'owned-resource fixture did not reach the forced timeout boundary'
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
      'forced timeout did not execute bounded post-termination cleanup'
    $redactedEvidence = "$($result.Output)`n$($result.Error)"
    foreach ($forbidden in @(
      $runnerProfileBefore.IdentitySid,
      $runnerProfileBefore.CanonicalLocalPath,
      $userName,
      $userSid.Value,
      $ownedFixtureUserName,
      $ownedFixturePassword
    )) {
      Assert-NotContains $redactedEvidence $forbidden `
        'ownership cleanup evidence exposed an identity or credential'
    }

    $owned = Read-FixtureResourceState $stateDirectory
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_RESOURCES_THEN_DEADLINE' `
      'AUTHORITY_ASSERTION'
    Assert-OwnedFixtureAuthorityComplete $owned 'OWNED_RESOURCES_THEN_DEADLINE'
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_RESOURCES_THEN_DEADLINE' `
      'RESOURCE_ASSERTION'
    foreach ($ownedPath in @(
      $owned.OwnedRoot, $owned.InstallRoot, $owned.ShortcutFolder,
      $owned.Shortcut, $owned.SmokeDirectory
    )) {
      Assert-True (!(Test-Path -LiteralPath $ownedPath)) `
        'post-termination cleanup left a run-owned file-system resource behind'
    }
    Assert-True (!(Test-Path -LiteralPath $owned.RegistryPath)) `
      'post-termination cleanup left a run-owned registry resource behind'
    Assert-True (!(Test-Path -LiteralPath $owned.RegistryRoot)) `
      'post-termination cleanup left the run-owned registry root behind'
    Assert-True ($null -eq (Get-LocalUser -Name $owned.UserName -ErrorAction SilentlyContinue)) `
      'post-termination cleanup left the run-owned local user behind'
    $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $owned.UserSid })
    Assert-True ($ownedProfiles.Count -eq 0) `
      'post-termination cleanup left the run-owned profile behind'

    $replacementStateDirectory = New-StateDirectory 'replacement-collision'
    $replacementResult = Invoke-FixtureScenario `
      'OWNED_RESOURCES_REPLACED_THEN_DEADLINE' $replacementStateDirectory
    Assert-True ($replacementResult.ExitCode -eq 125) `
      'replacement collision did not fail the standalone cleanup'
    Assert-Contains $replacementResult.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
      'replacement collision did not emit fixed cleanup failure evidence'
    $replacementOwned = Read-FixtureResourceState $replacementStateDirectory
    Assert-ReplacedFixtureResourcesSurvive $replacementOwned
    Assert-True (Test-Path -LiteralPath $replacementOwned.ManifestPath -PathType Leaf) `
      'false standalone cleanup result discarded authenticated recovery authority'
    Restore-ReplacedFixtureAuthority $replacementOwned
    $replacementRetry = Invoke-WorkflowCleanupController `
      'REPLACEMENT_RETRY' $replacementOwned.ManifestPath $replacementOwned.RunId `
      $replacementStateDirectory
    $replacementRetryDiagnostic =
      Get-SanitizedWorkflowCleanupResultDiagnostic $replacementRetry
    Assert-True ($replacementRetry.ExitCode -eq 0 -and
        $replacementRetry.ReportedExitCode -eq 0 -and
        $replacementRetry.Result -ceq 'COMPLETE' -and
        $replacementRetry.ControllerStatus -ceq 'EMPTY_OR_CLEANED' -and
        $replacementRetry.ProtocolLineCount -eq 2 -and
        $replacementRetry.ProtocolStandardErrorCount -eq 0 -and
        $replacementRetry.ProtocolStartupClass -ceq 'READY' -and
        $replacementRetry.ProtocolStartupLineNumber -eq 1 -and
        $replacementRetry.ProtocolTerminalLineNumber -eq 2) `
      "standalone cleanup did not retry to exact success after authority restoration:$replacementRetryDiagnostic"
    Assert-OwnedResourcesGone $replacementOwned
    Assert-True (!(Test-Path -LiteralPath $replacementOwned.ManifestPath)) `
      'successful standalone cleanup retry did not consume recovery authority'

    foreach ($replacementCase in @(
        [PSCustomObject]@{
          Scenario = 'OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE'
          Directory = 'replaced-executable'
          Label = 'executable'
        },
        [PSCustomObject]@{
          Scenario = 'OWNED_SHORTCUT_REPLACED_THEN_DEADLINE'
          Directory = 'replaced-shortcut'
          Label = 'shortcut'
        }
      )) {
      $replacedStateDirectory = New-StateDirectory $replacementCase.Directory
      $replacedResult = Invoke-FixtureScenario `
        $replacementCase.Scenario $replacedStateDirectory
      Assert-True ($replacedResult.ExitCode -eq 125) `
        "replacement $($replacementCase.Label) did not fail before cleanup"
      Assert-Contains $replacedResult.Output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
        "replacement $($replacementCase.Label) did not emit fixed cleanup failure evidence"
      $replacedOwned = Read-FixtureResourceState $replacedStateDirectory
      if ($replacementCase.Label -ceq 'executable') {
        Assert-ReplacedExecutableSurvives $replacedOwned
      } else {
        Assert-ReplacedShortcutSurvives $replacedOwned
      }
      Assert-MsiPreflightPreservedResources $replacedOwned
      $replacedManifest = Get-Content -LiteralPath $replacedOwned.ManifestPath `
        -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
      Assert-True ($replacedManifest.State -ceq 'ACTIVE') `
        "replacement $($replacementCase.Label) discarded ACTIVE recovery authority"
      Restore-ReplacedFixtureAuthority $replacedOwned
      $replacedRetry = Invoke-WorkflowCleanupController `
        'REPLACED_ENTRY_RETRY' $replacedOwned.ManifestPath $replacedOwned.RunId `
        $replacedStateDirectory
      Assert-True ($replacedRetry.ExitCode -eq 0 -and
          $replacedRetry.Result -ceq 'COMPLETE') `
        "replacement $($replacementCase.Label) authority did not retry to success"
      Assert-OwnedResourcesGone $replacedOwned
    }

    $profileMismatchDirectory = New-StateDirectory 'profile-path-mismatch'
    $profileMismatchResult = Invoke-FixtureScenario `
      'OWNED_PROFILE_PATH_MISMATCH_THEN_DEADLINE' $profileMismatchDirectory
    Assert-True ($profileMismatchResult.ExitCode -eq 125) `
      'mismatched durable profile path did not fail closed'
    Assert-Contains $profileMismatchResult.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
      'mismatched durable profile path did not emit fixed cleanup failure evidence'
    $profileMismatchOwned = Read-FixtureResourceState $profileMismatchDirectory
    $survivingProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq [string]$profileMismatchOwned.UserSid })
    Assert-True ($survivingProfiles.Count -eq 1) `
      'mismatched durable path selected the owned profile for deletion'
    $survivingProfilePath = (Resolve-Path -LiteralPath `
      ([string]$survivingProfiles[0].LocalPath) -ErrorAction Stop).ProviderPath.TrimEnd('\')
    Assert-True ([string]::Equals(
        $survivingProfilePath,
        ([string]$profileMismatchOwned.ProfilePath).TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase
      )) 'mismatched-path regression did not preserve the exact live profile'
    $profileMismatchManifest = Get-Content -LiteralPath $profileMismatchOwned.ManifestPath `
      -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-True ($profileMismatchManifest.State -ceq 'ACTIVE') `
      'mismatched profile path discarded ACTIVE recovery authority'
    $profileMismatchUsers = @($profileMismatchManifest.Users | Where-Object {
      $_.Owned -and [string]$_.Sid -ceq [string]$profileMismatchOwned.UserSid
    })
    $remainingProfileUser = Get-LocalUser -Name $profileMismatchOwned.UserName `
      -ErrorAction Stop
    Assert-True ($profileMismatchUsers.Count -eq 1 -and
        [string]$remainingProfileUser.SID.Value -ceq [string]$profileMismatchOwned.UserSid -and
        [string]$remainingProfileUser.Description -ceq
          [string]$profileMismatchUsers[0].OwnershipMarker) `
      'mismatched profile path discarded authenticated marker and SID authority'
    $ownedProfileRecords = @($profileMismatchManifest.Profiles | Where-Object {
      $_.Owned -and [string]$_.Sid -ceq [string]$profileMismatchOwned.UserSid
    })
    Assert-True ($ownedProfileRecords.Count -eq 1 -and
        [string]::Equals(
          [string]$ownedProfileRecords[0].LocalPath,
          [string]$profileMismatchOwned.MismatchedProfilePath,
          [StringComparison]::OrdinalIgnoreCase
        )) 'mismatched durable profile record was silently re-authorized'

    # A canonical profile belonging to another direct child is still not an
    # owned path: its leaf is not the authenticated run username.
    $ownedProfileRecords[0].LocalPath = $runnerProfileBefore.CanonicalLocalPath
    Write-TestOwnershipManifest $profileMismatchOwned.ManifestPath $profileMismatchManifest
    $alternateLeafCleanup = Invoke-WorkflowCleanupController `
      'PROFILE_ALTERNATE_LEAF' $profileMismatchOwned.ManifestPath `
      $profileMismatchOwned.RunId $profileMismatchDirectory
    Assert-True ($alternateLeafCleanup.ExitCode -eq 21 -and
        $alternateLeafCleanup.Result -ceq 'FAILED') `
      'alternate ProfilesDirectory leaf did not fail closed'
    $alternateLeafProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq [string]$profileMismatchOwned.UserSid })
    Assert-True ($alternateLeafProfiles.Count -eq 1) `
      'alternate ProfilesDirectory leaf selected the owned profile for deletion'
    $alternateLeafManifest = Get-Content -LiteralPath $profileMismatchOwned.ManifestPath `
      -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-True ($alternateLeafManifest.State -ceq 'ACTIVE') `
      'alternate ProfilesDirectory leaf discarded ACTIVE recovery authority'

    $ownedProfileRecords[0].LocalPath = [string]$profileMismatchOwned.ProfilePath
    Write-TestOwnershipManifest $profileMismatchOwned.ManifestPath $profileMismatchManifest
    $profileMismatchRetry = Invoke-WorkflowCleanupController `
      'PROFILE_RETRY' $profileMismatchOwned.ManifestPath `
      $profileMismatchOwned.RunId $profileMismatchDirectory
    Assert-True ($profileMismatchRetry.ExitCode -eq 0 -and
        $profileMismatchRetry.Result -ceq 'COMPLETE') `
      'profile cleanup did not succeed after exact durable path restoration'
    Assert-OwnedResourcesGone $profileMismatchOwned

    $byteIdenticalDirectory = New-StateDirectory 'byte-identical-replaced-executable'
    $byteIdenticalResult = Invoke-FixtureScenario `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' $byteIdenticalDirectory
    Assert-True ($byteIdenticalResult.ExitCode -eq 125) `
      'byte-identical replace-via-move did not fail closed on entry identity'
    $byteIdenticalOwned = Read-FixtureResourceState $byteIdenticalDirectory
    Assert-ReplacedExecutableSurvives $byteIdenticalOwned
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'RESOURCE_FIELD_VALIDATION' `
      'MANIFEST_PATH'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_FIELD_VALIDATION' `
      @('ManifestPath','RunId','Executable','ExecutableBackup')
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'REPLACEMENT_SURVIVAL_READ' `
      'MANIFEST_PATH'
    $byteIdenticalManifest = Get-Content -LiteralPath $byteIdenticalOwned.ManifestPath `
      -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-True ($byteIdenticalManifest.State -ceq 'ACTIVE') `
      'byte-identical replace-via-move discarded ACTIVE recovery authority'
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'AUTHORITY_RESTORE_REMOVE' `
      'EXECUTABLE'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'AUTHORITY_RESTORE_REMOVE' `
      @('Executable')
    Remove-Item -LiteralPath $byteIdenticalOwned.Executable -Force -ErrorAction Stop
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'AUTHORITY_RESTORE_MOVE' `
      'EXECUTABLE_BACKUP'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'AUTHORITY_RESTORE_MOVE' `
      @('ExecutableBackup','Executable')
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'AUTHORITY_RESTORE_MOVE' `
      'EXECUTABLE_BACKUP'
    Move-Item -LiteralPath $byteIdenticalOwned.ExecutableBackup `
      -Destination $byteIdenticalOwned.Executable -ErrorAction Stop
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'WORKFLOW_CLEANUP_RETRY' `
      'RUN_ID'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'WORKFLOW_CLEANUP_RETRY' `
      @('ManifestPath','RunId')
    $byteIdenticalRetry = Invoke-WorkflowCleanupController `
      'EXECUTABLE_IDENTITY_RETRY' $byteIdenticalOwned.ManifestPath `
      $byteIdenticalOwned.RunId $byteIdenticalDirectory
    Assert-True ($byteIdenticalRetry.ExitCode -eq 0 -and
        $byteIdenticalRetry.Result -ceq 'COMPLETE') `
      'byte-identical file cleanup did not succeed after exact entry identity restoration'
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'FINAL_ABSENCE_CHECK' `
      'EXECUTABLE'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'FINAL_ABSENCE_CHECK' `
      @('Executable')
    Assert-True (!(Test-Path -LiteralPath $byteIdenticalOwned.Executable)) `
      'byte-identical file retry did not consume the exact owned entry'
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'RESOURCE_ASSERTION' `
      'FINAL_ABSENCE_CHECK' `
      'MANIFEST_PATH'
    Assert-FixtureStateFieldsComplete `
      $byteIdenticalOwned `
      'OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE' `
      'FINAL_ABSENCE_CHECK' `
      @('ManifestPath')
    Assert-True (!(Test-Path -LiteralPath $byteIdenticalOwned.ManifestPath)) `
      'byte-identical file retry did not consume the exact recovery authority'

    $foreignChildStateDirectory = New-StateDirectory 'in-place-foreign-child'
    $foreignChildResult = Invoke-FixtureScenario `
      'OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE' $foreignChildStateDirectory
    Assert-True ($foreignChildResult.ExitCode -eq 125) `
      'in-place foreign child did not fail the standalone cleanup'
    Assert-Contains $foreignChildResult.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
      'in-place foreign child did not emit fixed cleanup failure evidence'
    $foreignChildOwned = Read-FixtureResourceState $foreignChildStateDirectory
    $foreignChildPath = Join-Path $foreignChildOwned.InstallRoot 'foreign-in-place.txt'
    Assert-True ((Get-Content -LiteralPath $foreignChildPath -Raw).Trim() -ceq `
        'foreign-in-place') 'in-place foreign child was removed or changed'
    Assert-True (Test-Path -LiteralPath $foreignChildOwned.ManifestPath -PathType Leaf) `
      'in-place foreign-child failure discarded authenticated recovery authority'
    $foreignChildManifest = Get-Content -LiteralPath $foreignChildOwned.ManifestPath `
      -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-True ($foreignChildManifest.State -ceq 'ACTIVE') `
      'in-place foreign-child failure did not preserve the ACTIVE manifest'
    Remove-Item -LiteralPath $foreignChildPath -Force -ErrorAction Stop
    $foreignChildRetry = Invoke-WorkflowCleanupController `
      'FOREIGN_CHILD_RETRY' $foreignChildOwned.ManifestPath `
      $foreignChildOwned.RunId $foreignChildStateDirectory
    Assert-True ($foreignChildRetry.ExitCode -eq 0 -and
        $foreignChildRetry.Result -ceq 'COMPLETE') `
      'in-place foreign-child cleanup did not retry to exact success'
    Assert-OwnedResourcesGone $foreignChildOwned

    $terminationFailureStateDirectory = New-StateDirectory 'termination-failure'
    $terminationFailureResult = Invoke-FixtureScenario `
      'OWNED_RESOURCES_THEN_DEADLINE' $terminationFailureStateDirectory $true
    Assert-True ($terminationFailureResult.ExitCode -eq 125) `
      'unverified worker-tree termination did not fail closed'
    Assert-Contains $terminationFailureResult.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
      'unverified worker-tree termination did not emit fixed failure evidence'
    $terminationFailureOwned = Read-FixtureResourceState $terminationFailureStateDirectory
    Assert-ProcessTreeGone (Read-FixtureProcessState $terminationFailureStateDirectory)
    Assert-True (Test-Path -LiteralPath $terminationFailureOwned.ManifestPath -PathType Leaf) `
      'termination failure discarded authenticated recovery authority'
    $terminationFailureManifest = Get-Content `
      -LiteralPath $terminationFailureOwned.ManifestPath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
    Assert-True ($terminationFailureManifest.State -ceq 'ACTIVE') `
      'termination failure did not preserve the ACTIVE manifest'
    Assert-True (Test-Path -LiteralPath $terminationFailureOwned.InstallRoot -PathType Container) `
      'cleanup mutated resources before worker-tree termination was verified'
    $terminationRetry = Invoke-WorkflowCleanupController `
      'TERMINATION_RETRY' $terminationFailureOwned.ManifestPath `
      $terminationFailureOwned.RunId `
      $terminationFailureStateDirectory
    Assert-True ($terminationRetry.ExitCode -eq 0 -and
        $terminationRetry.Result -ceq 'COMPLETE') `
      'termination-failure authority did not retry to exact cleanup success'
    Assert-OwnedResourcesGone $terminationFailureOwned

    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictInstallRoot 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing install tree was removed or changed'
    Assert-True ((Get-ItemPropertyValue -LiteralPath $conflictRegistryPath -Name 'PreExisting') -ceq `
      'owned-before-run') 'pre-existing registry tree was removed or changed'
    Assert-True ((Get-Content -LiteralPath $conflictShortcut -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing shortcut was removed or changed'
    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictSmokeDirectory 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'pre-existing smoke data was removed or changed'
    $remainingUser = Get-LocalUser -Name $userName -ErrorAction Stop
    Assert-True ($remainingUser.SID.Equals($userSid)) 'pre-existing local user was removed or replaced'
    $fixtureUserProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -ceq $userSid.Value })
    Assert-True ($fixtureUserProfiles.Count -eq 0) `
      'pre-existing local user fixture unexpectedly acquired a profile'

    $gracefulStateDirectory = New-StateDirectory 'graceful-interruption'
    Set-SupervisorInvocationContext `
      'PRE_EXISTING_CLEANUP_OWNERSHIP' `
      'OWNED_RESOURCES_FOR_INTERRUPTION' `
      'PIPELINE_START'
    $graceful = Start-ExternallyInterruptibleSupervisor $gracefulStateDirectory
    try {
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'PROCESS_STATE'
      $gracefulProcessState = Read-FixtureProcessState $gracefulStateDirectory
      $gracefulOwned = Read-FixtureResourceState $gracefulStateDirectory
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'PIPELINE_STOP'
      $graceful.Pipeline.Stop()
      try { [void]$graceful.Pipeline.EndInvoke($graceful.AsyncResult) } catch {}
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'RESOURCE_ASSERTION'
      Assert-ProcessTreeGone $gracefulProcessState
      Assert-OwnedResourcesGone $gracefulOwned
    } finally {
      $graceful.Pipeline.Dispose()
    }

    $workflowStateDirectory = New-StateDirectory 'workflow-cleanup'
    $workflowRunId = [Guid]::NewGuid().ToString('N')
    $workflowManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$workflowRunId.json"
    $workflowSupervisor = [Diagnostics.Process]::new()
    $workflowSupervisor.StartInfo = New-SupervisorStartInfo `
      'OWNED_RESOURCES_FOR_INTERRUPTION' $workflowStateDirectory '' $false `
      $workflowManifest $workflowRunId
    try {
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'PROCESS_START'
      if (!$workflowSupervisor.Start()) { throw 'workflow supervisor fixture did not start' }
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'PROCESS_STATE'
      $workflowProcessState = Read-FixtureProcessState $workflowStateDirectory
      $workflowOwned = Read-FixtureResourceState $workflowStateDirectory
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'PROCESS_WAIT'
      $workflowSupervisor.Kill($false)
      Assert-True ($workflowSupervisor.WaitForExit(5000)) `
        'killed workflow supervisor did not exit within the bound'
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_FOR_INTERRUPTION' `
        'RESOURCE_ASSERTION'
      Assert-ProcessTreeGone $workflowProcessState
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'killed supervisor did not preserve the durable ownership manifest'
      $parameterFailure = Invoke-WorkflowCleanupController `
        'PARAMETER_VALIDATION' $workflowManifest $workflowRunId `
        $workflowStateDirectory -1
      Assert-True ($parameterFailure.ExitCode -eq 125 -and
          $parameterFailure.Result -ceq 'FAILED' -and
          $parameterFailure.ControllerStatus.StartsWith(
            'CONTROLLER_PARAMETER_VALIDATION_PARAMETERS_',
            [StringComparison]::Ordinal
          )) 'controller parameter failure was not caught and phase-classified'
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'controller parameter failure discarded authenticated recovery authority'
      $earlyInitializationTimeout = Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'WORKFLOW_CLEANUP_CONTROLLER' `
        -Callsite 'CONTROLLER_PROTOCOL_PARSE' `
        -Field 'PROTOCOL' `
        -Action {
          Invoke-WorkflowCleanupController `
            'EARLY_INITIALIZATION_TIMEOUT' $workflowManifest $workflowRunId `
            $workflowStateDirectory 5000 $true
        }
      Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'WORKFLOW_CLEANUP_CONTROLLER' `
        -Callsite 'CONTROLLER_RESULT_FIELD' `
        -Field 'EXIT_CODE' `
        -Action {
          Assert-True ($earlyInitializationTimeout.ExitCode -eq 124) `
            (Get-SanitizedSupervisorInvocationDiagnostic `
              $script:currentSupervisorInvocationTest `
              'EARLY_INITIALIZATION_TIMEOUT' `
              'WORKFLOW_CLEANUP_CONTROLLER' `
              'CONTROLLER_RESULT_FIELD' `
              'EXIT_CODE')
        }
      Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'WORKFLOW_CLEANUP_CONTROLLER' `
        -Callsite 'CONTROLLER_RESULT_FIELD' `
        -Field 'REPORTED_EXIT_CODE' `
        -Action {
          Assert-True ($earlyInitializationTimeout.ReportedExitCode -eq 124) `
            (Get-SanitizedSupervisorInvocationDiagnostic `
              $script:currentSupervisorInvocationTest `
              'EARLY_INITIALIZATION_TIMEOUT' `
              'WORKFLOW_CLEANUP_CONTROLLER' `
              'CONTROLLER_RESULT_FIELD' `
              'REPORTED_EXIT_CODE')
        }
      Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'WORKFLOW_CLEANUP_CONTROLLER' `
        -Callsite 'CONTROLLER_RESULT_FIELD' `
        -Field 'RESULT' `
        -Action {
          Assert-True ($earlyInitializationTimeout.Result -ceq 'TIMED_OUT') `
            (Get-SanitizedSupervisorInvocationDiagnostic `
              $script:currentSupervisorInvocationTest `
              'EARLY_INITIALIZATION_TIMEOUT' `
              'WORKFLOW_CLEANUP_CONTROLLER' `
              'CONTROLLER_RESULT_FIELD' `
              'RESULT')
        }
      $earlyInitializationState = Read-EarlyWorkflowCleanupProcessState `
        'EARLY_INITIALIZATION_TIMEOUT' $workflowStateDirectory
      Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'PROCESS_STATE' `
        -Callsite 'PROCESS_TREE_ASSERTION' `
        -Field 'PROCESS_TREE' `
        -Action {
          Assert-ProcessTreeGone $earlyInitializationState
        }
      Invoke-SupervisorAttributedOperation `
        -Scenario 'EARLY_INITIALIZATION_TIMEOUT' `
        -Phase 'MANIFEST_ASSERTION' `
        -Callsite 'MANIFEST_PRESERVATION' `
        -Field 'MANIFEST_PATH' `
        -Action {
          Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
            (Get-SanitizedSupervisorInvocationDiagnostic `
              $script:currentSupervisorInvocationTest `
              'EARLY_INITIALIZATION_TIMEOUT' `
              'MANIFEST_ASSERTION' `
              'MANIFEST_PRESERVATION' `
              'MANIFEST_PATH')
        }
      $timedOutCleanup = Invoke-WorkflowCleanupController `
        'CLEANUP_TIMEOUT' $workflowManifest $workflowRunId $workflowStateDirectory 1
      Assert-True ($timedOutCleanup.ExitCode -eq 124 -and
          $timedOutCleanup.ReportedExitCode -eq 124 -and
          $timedOutCleanup.Result -ceq 'TIMED_OUT') `
        'workflow cleanup did not report its injected fixed timeout'
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'timed-out workflow cleanup discarded authenticated recovery authority'

      $installerBackup = Join-Path $testRoot 'fixture-owned-entry.msi'
      Move-Item -LiteralPath $dummyInstaller -Destination $installerBackup -ErrorAction Stop
      [IO.File]::WriteAllBytes($dummyInstaller, [Text.Encoding]::ASCII.GetBytes(
        'foreign same-path MSI replacement must never be consulted'))
      $foreignInstallerDigest =
        (Get-FileHash -LiteralPath $dummyInstaller -Algorithm SHA256).Hash
      try {
        $replacedInstallerCleanup = Invoke-WorkflowCleanupController `
          'INSTALLER_REPLACEMENT' $workflowManifest $workflowRunId `
          $workflowStateDirectory
        Assert-True ($replacedInstallerCleanup.ExitCode -eq 21 -and
            $replacedInstallerCleanup.ReportedExitCode -eq 21 -and
            $replacedInstallerCleanup.Result -ceq 'FAILED' -and
            $replacedInstallerCleanup.ControllerStatus -ceq
              'OWNED_RESOURCE_CLEANUP_FAILURE') `
          'same-path installer replacement did not fail closed'
        Assert-MsiPreflightPreservedResources $workflowOwned
        $retainedAuthority = Get-Content -LiteralPath $workflowManifest -Raw -Encoding UTF8 |
          ConvertFrom-Json -ErrorAction Stop
        Assert-True ($retainedAuthority.State -ceq 'ACTIVE') `
          'same-path installer replacement discarded ACTIVE recovery authority'
        Assert-True ((Get-FileHash -LiteralPath $dummyInstaller -Algorithm SHA256).Hash -ceq
            $foreignInstallerDigest) `
          'foreign same-path installer was executed or changed'
      } finally {
        if (Test-Path -LiteralPath $dummyInstaller) {
          Remove-Item -LiteralPath $dummyInstaller -Force -ErrorAction SilentlyContinue
        }
        Move-Item -LiteralPath $installerBackup -Destination $dummyInstaller -ErrorAction Stop
      }
      Assert-True (
        [ProPRSupervisorInstallerIdentity]::Read($dummyInstaller) -ceq
          $dummyInstallerEntryIdentity -and
        (Get-FileHash -LiteralPath $dummyInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
          $dummyInstallerSha256
      ) 'exact installer authority was not restored for cleanup retry'

      Set-ItemProperty -LiteralPath $workflowOwned.RegistryPath `
        -Name 'ProPRInstalledAppOwner' -Value 'foreign-owner'
      $failedWorkflowCleanup = Invoke-WorkflowCleanupController `
        'RESOURCE_COLLISION' $workflowManifest $workflowRunId $workflowStateDirectory
      Assert-True ($failedWorkflowCleanup.ExitCode -eq 21 -and
          $failedWorkflowCleanup.ReportedExitCode -eq 21 -and
          $failedWorkflowCleanup.Result -ceq 'FAILED' -and
          $failedWorkflowCleanup.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
        'workflow cleanup did not report a fixed replacement-collision failure'
      Assert-True ((Get-ItemPropertyValue -LiteralPath $workflowOwned.RegistryPath `
          -Name 'ProPRInstalledAppOwner') -ceq 'foreign-owner') `
        'workflow cleanup removed a replacement registry object'
      Assert-True (Test-Path -LiteralPath $workflowManifest -PathType Leaf) `
        'failed workflow cleanup discarded authenticated recovery authority'

      Set-ItemProperty -LiteralPath $workflowOwned.RegistryPath `
        -Name 'ProPRInstalledAppOwner' -Value ([string]$workflowOwned.Token)
      $workflowCleanup = Invoke-WorkflowCleanupController `
        'WORKFLOW_RETRY' $workflowManifest $workflowRunId $workflowStateDirectory
      Assert-True ($workflowCleanup.ExitCode -eq 0 -and
          $workflowCleanup.ReportedExitCode -eq 0 -and
          $workflowCleanup.ControllerStatus -ceq 'EMPTY_OR_CLEANED' -and
          $workflowCleanup.InvocationIdentifier -ceq 'WORKFLOW_RETRY') `
        'workflow cleanup controller did not retry to fixed cleanup success'
      Assert-OwnedResourcesGone $workflowOwned
      Assert-True (!(Test-Path -LiteralPath $workflowManifest)) `
        'workflow cleanup did not consume the ownership manifest'
    } finally {
      if (!$workflowSupervisor.HasExited) { try { $workflowSupervisor.Kill($true) } catch {} }
      $workflowSupervisor.Dispose()
    }

    $normalStateDirectory = New-StateDirectory 'workflow-normal-already-cleaned'
    $normalRunId = [Guid]::NewGuid().ToString('N')
    $normalManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$normalRunId.json"
    $normalSupervisor = [Diagnostics.Process]::new()
    $normalSupervisor.StartInfo = New-SupervisorStartInfo `
      'OWNED_RESOURCES_NORMAL_SUCCESS' $normalStateDirectory '' $false `
      $normalManifest $normalRunId
    try {
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_NORMAL_SUCCESS' `
        'PROCESS_START'
      if (!$normalSupervisor.Start()) { throw 'normal workflow supervisor fixture did not start' }
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_NORMAL_SUCCESS' `
        'PROCESS_STATE'
      $normalOwned = Read-FixtureResourceState $normalStateDirectory
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_NORMAL_SUCCESS' `
        'PROCESS_WAIT'
      Assert-True ($normalSupervisor.WaitForExit(40000)) `
        'normal workflow supervisor fixture exceeded its bound'
      Assert-True ($normalSupervisor.ExitCode -eq 0) `
        'normal workflow supervisor fixture did not complete successfully'
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_CLEANUP_OWNERSHIP' `
        'OWNED_RESOURCES_NORMAL_SUCCESS' `
        'RESOURCE_ASSERTION'
      Assert-OwnedResourcesGone $normalOwned
      Assert-True (Test-Path -LiteralPath $normalManifest -PathType Leaf) `
        'normal supervisor did not preserve its empty ownership receipt'
      $normalReceipt = Get-Content -LiteralPath $normalManifest -Raw -Encoding UTF8 |
        ConvertFrom-Json -ErrorAction Stop
      Assert-True ($normalReceipt.SchemaVersion -eq 3 -and
          $normalReceipt.ManifestType -ceq 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP' -and
          $normalReceipt.State -ceq 'EMPTY' -and
          $normalReceipt.InstallerEntryIdentity -ceq $dummyInstallerEntryIdentity -and
          $normalReceipt.InstallerSha256 -ceq $dummyInstallerSha256 -and
          $normalReceipt.InstallerProductCode -ceq $dummyInstallerProductCode -and
          @($normalReceipt.Directories).Count -eq 0 -and
          @($normalReceipt.Files).Count -eq 0 -and
          @($normalReceipt.RegistryKeys).Count -eq 0 -and
          @($normalReceipt.RegistryValues).Count -eq 0 -and
          @($normalReceipt.Users).Count -eq 0 -and
          @($normalReceipt.Profiles).Count -eq 0) `
        'normal supervisor did not produce a typed authenticated empty-state receipt'
      $normalCleanup = Invoke-WorkflowCleanupController `
        'NORMAL_CLEANUP' $normalManifest $normalRunId $normalStateDirectory
      Assert-True ($normalCleanup.ExitCode -eq 0 -and
          $normalCleanup.ReportedExitCode -eq 0 -and
          $normalCleanup.ControllerStatus -ceq 'EMPTY_OR_CLEANED') `
        'always cleanup did not accept the normal already-cleaned receipt'
      Assert-True (!(Test-Path -LiteralPath $normalManifest)) `
        'always cleanup did not consume the normal empty-state receipt'
    } finally {
      if (!$normalSupervisor.HasExited) { try { $normalSupervisor.Kill($true) } catch {} }
      $normalSupervisor.Dispose()
    }

    foreach ($manifestCase in @('MISSING','MALFORMED','STALE')) {
      $badRunId = [Guid]::NewGuid().ToString('N')
      $badManifest = Join-Path ([IO.Path]::GetTempPath()) `
        "propr-installed-app-ownership-$badRunId.json"
      if ($manifestCase -eq 'MALFORMED') {
        [IO.File]::WriteAllText($badManifest, '{not-json', [Text.Encoding]::UTF8)
      } elseif ($manifestCase -eq 'STALE') {
        $createdTicks = [DateTime]::UtcNow.AddHours(-4).Ticks
        $staleManifest = [ordered]@{
          SchemaVersion = 3
          ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'; State = 'ACTIVE'
          RunId = $badRunId
          CreatedUtcTicks = $createdTicks
          ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
          InstallerPath = $dummyInstaller
          InstallerEntryIdentity = $dummyInstallerEntryIdentity
          InstallerSha256 = $dummyInstallerSha256
          InstallerProductCode = $dummyInstallerProductCode
          Fixture = $true
          FixtureRoot = $workflowStateDirectory; BaselineClean = $false
          InstallAttempted = $false; MsiTransactionState = 'NONE'
          Directories = @(); Files = @()
          RegistryKeys = @(); RegistryValues = @(); Users = @(); Profiles = @()
        }
        [IO.File]::WriteAllText(
          $badManifest,
          ($staleManifest | ConvertTo-Json -Depth 6 -Compress),
          [Text.Encoding]::UTF8
        )
      }
      $failedCleanup = Invoke-WorkflowCleanupController `
        'MANIFEST_VALIDATION' $badManifest $badRunId $workflowStateDirectory
      Assert-True ($failedCleanup.ExitCode -ne 0) `
        "$manifestCase workflow manifest did not fail closed"
      Assert-True ($failedCleanup.ExitCode -eq 20 -and
          $failedCleanup.ReportedExitCode -eq 20 -and
          $failedCleanup.ControllerStatus -ceq 'MANIFEST_VALIDATION_FAILURE' -and
          $failedCleanup.InvocationIdentifier -ceq 'MANIFEST_VALIDATION') `
        "$manifestCase workflow manifest did not report fixed validation status"
      if ($manifestCase -ne 'MISSING') {
        Assert-True (Test-Path -LiteralPath $badManifest -PathType Leaf) `
          "$manifestCase workflow failure discarded authenticated recovery authority"
        Remove-Item -LiteralPath $badManifest -Force -ErrorAction Stop
      }
    }

    Assert-True ((Get-Content -LiteralPath (Join-Path $conflictInstallRoot 'pre-existing.txt') -Raw).Trim() -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing install tree'
    Assert-True ((Get-ItemPropertyValue -LiteralPath $conflictRegistryPath -Name 'PreExisting') -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing registry tree'
    Assert-True ((Get-Content -LiteralPath $conflictShortcut -Raw).Trim() -ceq `
      'owned-before-run') 'external cleanup changed the pre-existing shortcut'
    Assert-True ((Get-LocalUser -Name $userName -ErrorAction Stop).SID.Equals($userSid)) `
      'external cleanup changed the pre-existing local user'
  } finally {
    $script:conflictingFixtureUserName = $null
    $script:conflictingFixtureUserSid = $null
    $script:conflictingFixtureProfileSid = $null
    $script:conflictingFixtureProfilePath = $null
    $script:conflictingFixtureDirectories = $null
    $script:conflictingFixtureShortcut = $null
    $script:conflictingFixtureRegistryPath = $null
    if ($registryCreated -and (Test-Path -LiteralPath $conflictRegistryPath)) {
      Remove-Item -LiteralPath $conflictRegistryPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    $fixtureRegistryRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\ProPRSupervisorFixture'
    if ((Test-Path -LiteralPath $fixtureRegistryRoot) -and
        @(Get-ChildItem -LiteralPath $fixtureRegistryRoot -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item -LiteralPath $fixtureRegistryRoot -Force -ErrorAction SilentlyContinue
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
    $ownedUser = Get-LocalUser -Name $ownedFixtureUserName -ErrorAction SilentlyContinue
    if ($null -ne $ownedUser) {
      $ownedProfiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.SID -ceq $ownedUser.SID.Value })
      foreach ($profile in $ownedProfiles) {
        Remove-CimInstance -InputObject $profile -ErrorAction SilentlyContinue
      }
      Remove-LocalUser -Name $ownedFixtureUserName -ErrorAction SilentlyContinue
    }
    Assert-RunnerProfileUnchanged $runnerProfileBefore
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:PRE_EXISTING_AUTHORITIES:PRESERVED'
  [Console]::Out.Flush()
}

function Test-SmokePromotionInterruptionAuthority {
  foreach ($testCase in @(
    @{ Scenario = 'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE'; Label = 'before promotion' },
    @{ Scenario = 'SMOKE_AFTER_PROMOTION_THEN_DEADLINE'; Label = 'after promotion' },
    @{ Scenario = 'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE'; Label = 'after artifact creation' }
  )) {
    $stateDirectory = New-StateDirectory (
      'smoke-' + $testCase.Scenario.ToLowerInvariant().Replace('_', '-'))
    $result = Invoke-FixtureScenario $testCase.Scenario $stateDirectory
    Assert-True ($result.ExitCode -eq 124) `
      "smoke interruption $($testCase.Label) did not preserve watchdog status"
    Assert-Contains $result.Output `
      'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
      "smoke interruption $($testCase.Label) did not complete recovery cleanup"
    $owned = Read-FixtureResourceState $stateDirectory
    Assert-OwnedResourcesGone $owned
  }

  $foreignStateDirectory = New-StateDirectory 'smoke-in-place-foreign-descendant'
  $foreignResult = Invoke-FixtureScenario `
    'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE' $foreignStateDirectory
  Assert-True ($foreignResult.ExitCode -eq 125) `
    'smoke foreign descendant did not fail closed'
  Assert-Contains $foreignResult.Output `
    'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:FAILED' `
    'smoke foreign descendant did not emit fixed cleanup failure evidence'
  $foreignOwned = Read-FixtureResourceState $foreignStateDirectory
  Assert-True ((Get-Content -LiteralPath $foreignOwned.ForeignSmokePath -Raw).Trim() -ceq `
      'foreign-smoke-in-place') 'smoke foreign descendant was removed or changed'
  Assert-True (Test-Path -LiteralPath $foreignOwned.ManifestPath -PathType Leaf) `
    'smoke foreign descendant discarded authenticated recovery authority'
  $foreignManifest = Get-Content -LiteralPath $foreignOwned.ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
  Assert-True ($foreignManifest.State -ceq 'ACTIVE') `
    'smoke foreign descendant did not preserve ACTIVE recovery authority'
  Remove-Item -LiteralPath $foreignOwned.ForeignSmokePath -Force -ErrorAction Stop
  $retry = Invoke-WorkflowCleanupController `
    'SMOKE_PROMOTION_RETRY' $foreignOwned.ManifestPath $foreignOwned.RunId `
    $foreignStateDirectory
  Assert-True ($retry.ExitCode -eq 0 -and $retry.Result -ceq 'COMPLETE') `
    'smoke foreign-descendant recovery did not retry to exact success'
  Assert-OwnedResourcesGone $foreignOwned

  $tokenStateDirectory = New-StateDirectory 'smoke-token-mismatch'
  $tokenResult = Invoke-FixtureScenario `
    'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE' $tokenStateDirectory
  Assert-True ($tokenResult.ExitCode -eq 125) `
    'mismatched smoke ownership token did not fail closed'
  $tokenOwned = Read-FixtureResourceState $tokenStateDirectory
  $tokenPath = Join-Path $tokenOwned.SmokeDirectory '.propr-installed-app-owner'
  Assert-True ((Get-Content -LiteralPath $tokenPath -Raw).Trim() -ceq 'foreign-owner') `
    'mismatched smoke ownership token was removed or changed'
  Assert-True (Test-Path -LiteralPath $tokenOwned.ManifestPath -PathType Leaf) `
    'mismatched smoke ownership token discarded recovery authority'
  Remove-Item -LiteralPath $tokenPath -Force -ErrorAction Stop
  $missingToken = Invoke-WorkflowCleanupController `
    'SMOKE_TOKEN_MISSING' $tokenOwned.ManifestPath $tokenOwned.RunId `
    $tokenStateDirectory
  Assert-True ($missingToken.ExitCode -eq 20 -and $missingToken.Result -ceq 'FAILED') `
    'missing smoke ownership token did not fail manifest validation closed'
  Assert-True (Test-Path -LiteralPath $tokenOwned.ManifestPath -PathType Leaf) `
    'missing smoke ownership token discarded recovery authority'
  [IO.File]::WriteAllText($tokenPath, [string]$tokenOwned.Token, [Text.Encoding]::ASCII)
  $tokenRetry = Invoke-WorkflowCleanupController `
    'SMOKE_TOKEN_RETRY' $tokenOwned.ManifestPath $tokenOwned.RunId $tokenStateDirectory
  Assert-True ($tokenRetry.ExitCode -eq 0 -and $tokenRetry.Result -ceq 'COMPLETE') `
    'restored exact smoke ownership token did not retry to cleanup success'
  Assert-OwnedResourcesGone $tokenOwned
}

function Test-PrimaryWorkerFallbackForeignDescendants {
  $stateDirectory = New-StateDirectory 'primary-fallback-foreign-descendants'
  $result = Invoke-FixtureScenario 'PRIMARY_FALLBACK_FOREIGN_DESCENDANTS' $stateDirectory
  $diagnostic = Get-SanitizedSupervisorMarkerDiagnostic $result
  Assert-True ($result.ExitCode -eq 0) `
    "primary worker fallback foreign-descendant fixture did not complete:$diagnostic"
  $state = Get-Content -LiteralPath (Join-Path $stateDirectory 'primary-fallback.json') `
    -Raw -Encoding ASCII | ConvertFrom-Json -ErrorAction Stop
  Assert-True ((Get-Content -LiteralPath $state.InstallForeign -Raw).Trim() -ceq `
      'foreign-install') 'primary install fallback removed or changed a foreign descendant'
  Assert-True ((Get-Content -LiteralPath $state.ShortcutForeign -Raw).Trim() -ceq `
      'foreign-shortcut') 'primary shortcut fallback removed or changed a foreign descendant'
}

function Test-PreExistingAppPathsAuthority {
  $appPaths = `
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
  $protocol = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
  $sentinelApplication = 'C:\pre-existing\propr-desktop.exe'
  $sentinelProtocol = 'pre-existing-protocol'
  Assert-True (!(Test-Path -LiteralPath $appPaths)) `
    'pre-existing App Paths fixture baseline was not clean'
  Assert-True (!(Test-Path -LiteralPath $protocol)) `
    'pre-existing protocol fixture baseline was not clean'
  try {
    [void](New-Item -Path $appPaths -Force -ErrorAction Stop)
    Set-Item -LiteralPath $appPaths -Value $sentinelApplication
    Set-ItemProperty -LiteralPath $appPaths -Name 'Path' -Value 'C:\pre-existing'
    [void](New-Item -Path $protocol -Force -ErrorAction Stop)
    Set-Item -LiteralPath $protocol -Value $sentinelProtocol
    Set-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value 'do-not-remove'

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = New-SupervisorStartInfo `
      'PRE_EXISTING_APP_PATHS' $testRoot '' $true
    try {
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_APP_PATHS_AUTHORITY' `
        'PRE_EXISTING_APP_PATHS' `
        'PROCESS_START'
      if (!$process.Start()) { throw 'pre-existing registry supervisor did not start' }
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_APP_PATHS_AUTHORITY' `
        'PRE_EXISTING_APP_PATHS' `
        'PROCESS_WAIT'
      Assert-True ($process.WaitForExit(20000)) `
        'pre-existing registry supervisor exceeded its bound'
      Set-SupervisorInvocationContext `
        'PRE_EXISTING_APP_PATHS_AUTHORITY' `
        'PRE_EXISTING_APP_PATHS' `
        'PROCESS_OUTPUT'
      $output = $process.StandardOutput.ReadToEnd()
      $errorOutput = $process.StandardError.ReadToEnd()
      Assert-True ($process.ExitCode -ne 0) `
        'pre-existing App Paths authority was not rejected'
      Assert-Contains $output `
        'PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE' `
        'pre-existing App Paths rejection did not finish bounded cleanup'
      Assert-NotContains "$output`n$errorOutput" $sentinelApplication `
        'pre-existing App Paths evidence was not redacted'
    } finally {
      if (!$process.HasExited) { try { $process.Kill($true) } catch {} }
      $process.Dispose()
    }
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) `
      'pre-existing App Paths executable was removed or changed'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('Path') -ceq 'C:\pre-existing') `
      'pre-existing App Paths values were removed or changed'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) `
      'pre-existing protocol key was removed or changed'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('URL Protocol') -ceq 'do-not-remove') `
      'pre-existing protocol values were removed or changed'

    $mismatchRunId = [Guid]::NewGuid().ToString('N')
    $mismatchManifest = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$mismatchRunId.json"
    $createdTicks = [DateTime]::UtcNow.Ticks
    $mismatchState = [ordered]@{
      SchemaVersion = 3
      ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'; State = 'ACTIVE'
      RunId = $mismatchRunId
      CreatedUtcTicks = $createdTicks
      ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
      InstallerPath = $dummyInstaller
      InstallerEntryIdentity = $dummyInstallerEntryIdentity
      InstallerSha256 = $dummyInstallerSha256
      InstallerProductCode = $dummyInstallerProductCode
      Fixture = $false; FixtureRoot = $null
      BaselineClean = $true; InstallAttempted = $true
      MsiTransactionState = 'COMMITTED'
      Directories = @(); Files = @(); Users = @(); Profiles = @()
      RegistryValues = @([ordered]@{
        Kind = 'HKCU_INSTALLED'
        Path = 'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop'
        Name = 'installed'; Owned = $false; Provisional = $false
        BaselineKeyExisted = $false; BaselineValueExisted = $false
        BaselineValueKind = $null; BaselineValueData = $null
        IdentityValueKind = $null; IdentityValueData = $null; KeyCreatedByRun = $false
      })
      RegistryKeys = @(
        [ordered]@{
          Kind = 'PROTOCOL'; Path = $protocol; Owned = $true; Token = $null
          Identity = ('0' * 64); Provisional = $false
        },
        [ordered]@{
          Kind = 'APP_PATH'; Path = $appPaths; Owned = $true; Token = $null
          Identity = ('0' * 64); Provisional = $false
        }
      )
    }
    [IO.File]::WriteAllText(
      $mismatchManifest,
      ($mismatchState | ConvertTo-Json -Depth 6 -Compress),
      [Text.Encoding]::UTF8
    )
    $mismatchCleanup = Invoke-WorkflowCleanupController `
      'APP_PATH_MISMATCH' $mismatchManifest $mismatchRunId ''
    Assert-True ($mismatchCleanup.ExitCode -ne 0) `
      'mismatched App Paths ownership identity did not fail closed'
    Assert-True ($mismatchCleanup.ExitCode -eq 20 -and
        $mismatchCleanup.ReportedExitCode -eq 20 -and
        $mismatchCleanup.ControllerStatus -ceq 'MANIFEST_VALIDATION_FAILURE' -and
        $mismatchCleanup.InvocationIdentifier -ceq 'APP_PATH_MISMATCH') `
      'mismatched App Paths ownership did not report fixed validation status'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) `
      'mismatched App Paths ownership removed the pre-existing executable value'
    Assert-True ((Get-Item -LiteralPath $appPaths).GetValue('Path') -ceq 'C:\pre-existing') `
      'mismatched App Paths ownership removed pre-existing values'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) `
      'mismatched protocol ownership removed the pre-existing key'
    Assert-True ((Get-Item -LiteralPath $protocol).GetValue('URL Protocol') -ceq 'do-not-remove') `
      'mismatched protocol ownership removed pre-existing values'
  } finally {
    if ((Test-Path -LiteralPath $appPaths) -and
        (Get-Item -LiteralPath $appPaths).GetValue('') -ceq $sentinelApplication) {
      Remove-Item -LiteralPath $appPaths -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $protocol) -and
        (Get-Item -LiteralPath $protocol).GetValue('') -ceq $sentinelProtocol) {
      Remove-Item -LiteralPath $protocol -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:APP_PATHS_PRE_EXISTING:PRESERVED'
  [Console]::Out.Flush()
}

function Test-HkcuInstalledValueOwnership {
  $desktopKey = 'Registry::HKEY_CURRENT_USER\Software\ProPR\Desktop'
  $installedName = 'installed'
  $sentinelInstalled = 'pre-existing-installed'
  $sentinelUnrelated = 'preserve-unrelated'
  Assert-True (!(Test-Path -LiteralPath $desktopKey)) `
    'HKCU installed-value fixture baseline was not clean'

  function New-HkcuManifest(
    [bool]$BaselineKeyExisted,
    [bool]$BaselineValueExisted,
    [AllowNull()][string]$BaselineKind,
    [AllowNull()][string]$BaselineData,
    [bool]$KeyCreatedByRun,
    [bool]$Provisional = $false,
    [bool]$InstallAttempted = $false
  ) {
    $runId = [Guid]::NewGuid().ToString('N')
    $path = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$runId.json"
    $createdTicks = [DateTime]::UtcNow.Ticks
    $installedIdentityData = [Convert]::ToBase64String(
      [BitConverter]::GetBytes([int32]1))
    $manifest = [ordered]@{
      SchemaVersion = 3
      ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'
      State = 'ACTIVE'
      RunId = $runId
      CreatedUtcTicks = $createdTicks
      ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
      InstallerPath = $dummyInstaller
      InstallerEntryIdentity = $dummyInstallerEntryIdentity
      InstallerSha256 = $dummyInstallerSha256
      InstallerProductCode = $dummyInstallerProductCode
      Fixture = $false
      FixtureRoot = $null
      BaselineClean = $InstallAttempted
      InstallAttempted = $InstallAttempted
      MsiTransactionState = if ($InstallAttempted) { 'PENDING' } else { 'NONE' }
      Directories = @()
      Files = @()
      RegistryKeys = @()
      RegistryValues = @([ordered]@{
        Kind = 'HKCU_INSTALLED'; Path = $desktopKey; Name = $installedName
        Owned = $true; Provisional = $Provisional
        BaselineKeyExisted = $BaselineKeyExisted
        BaselineValueExisted = $BaselineValueExisted
        BaselineValueKind = $BaselineKind
        BaselineValueData = $BaselineData
        IdentityValueKind = if ($Provisional) { $null } else { 'DWord' }
        IdentityValueData = if ($Provisional) { $null } else { $installedIdentityData }
        KeyCreatedByRun = $KeyCreatedByRun
      })
      Users = @()
      Profiles = @()
    }
    [IO.File]::WriteAllText(
      $path,
      ($manifest | ConvertTo-Json -Depth 6 -Compress),
      [Text.Encoding]::UTF8
    )
    return [PSCustomObject]@{ RunId = $runId; Path = $path }
  }

  try {
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, $sentinelInstalled, [Microsoft.Win32.RegistryValueKind]::String)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      'Unrelated', $sentinelUnrelated, [Microsoft.Win32.RegistryValueKind]::String)
    $baselineData = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes($sentinelInstalled))
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $restoreManifest = New-HkcuManifest $true $true 'String' $baselineData $false
    $restore = Invoke-WorkflowCleanupController `
      'HKCU_BASELINE_RESTORE' $restoreManifest.Path $restoreManifest.RunId ''
    Assert-True ($restore.ExitCode -eq 0 -and
        $restore.ControllerStatus -ceq 'EMPTY_OR_CLEANED') `
      'pre-existing HKCU installed value restoration did not complete'
    $restoredKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True ($restoredKey.GetValueKind($installedName).ToString() -ceq 'String' -and
        [string]$restoredKey.GetValue($installedName) -ceq $sentinelInstalled) `
      'pre-existing HKCU installed value was not restored exactly'
    Assert-True ([string]$restoredKey.GetValue('Unrelated') -ceq $sentinelUnrelated) `
      'unrelated HKCU value was changed during baseline restoration'

    $unchangedManifest = New-HkcuManifest `
      $true $true 'String' $baselineData $false $false $true
    $unchanged = Invoke-WorkflowCleanupController `
      'HKCU_PENDING_RECEIPT' $unchangedManifest.Path $unchangedManifest.RunId ''
    Assert-True ($unchanged.ExitCode -eq 21 -and
        $unchanged.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'path-only pending MSI receipt was not rejected before uninstall'
    $unchangedKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True ($unchangedKey.GetValueKind($installedName).ToString() -ceq 'String' -and
        [string]$unchangedKey.GetValue($installedName) -ceq $sentinelInstalled) `
      'rejected pending MSI receipt changed the unchanged HKCU baseline'
    Assert-True (Test-Path -LiteralPath $unchangedManifest.Path -PathType Leaf) `
      'rejected pending MSI receipt discarded authenticated recovery authority'
    Remove-Item -LiteralPath $unchangedManifest.Path -Force -ErrorAction Stop

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      'Unrelated', $sentinelUnrelated, [Microsoft.Win32.RegistryValueKind]::String)
    $nonemptyManifest = New-HkcuManifest $false $false $null $null $true
    $nonempty = Invoke-WorkflowCleanupController `
      'HKCU_NONEMPTY' $nonemptyManifest.Path $nonemptyManifest.RunId ''
    Assert-True ($nonempty.ExitCode -eq 0) `
      'run-owned HKCU value cleanup with unrelated values failed'
    $nonemptyKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True (@($nonemptyKey.GetValueNames()) -cnotcontains $installedName -and
        [string]$nonemptyKey.GetValue('Unrelated') -ceq $sentinelUnrelated) `
      'run-owned HKCU cleanup removed its nonempty key or unrelated value'

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $emptyManifest = New-HkcuManifest $false $false $null $null $true
    $empty = Invoke-WorkflowCleanupController `
      'HKCU_EMPTY' $emptyManifest.Path $emptyManifest.RunId ''
    Assert-True ($empty.ExitCode -eq 0 -and !(Test-Path -LiteralPath $desktopKey)) `
      'run-created empty HKCU key was not removed'

    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, 'foreign-conflict', [Microsoft.Win32.RegistryValueKind]::String)
    $conflictManifest = New-HkcuManifest $false $false $null $null $true
    $conflict = Invoke-WorkflowCleanupController `
      'HKCU_CONFLICT' $conflictManifest.Path $conflictManifest.RunId ''
    Assert-True ($conflict.ExitCode -eq 21 -and
        $conflict.ReportedExitCode -eq 21 -and
        $conflict.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'conflicting HKCU installed value did not fail with fixed resource-cleanup status'
    $conflictingKey = Get-Item -LiteralPath $desktopKey -ErrorAction Stop
    Assert-True ([string]$conflictingKey.GetValue($installedName) -ceq 'foreign-conflict') `
      'conflicting HKCU installed value was removed or changed'
    Assert-True (Test-Path -LiteralPath $conflictManifest.Path -PathType Leaf) `
      'conflicting HKCU cleanup discarded authenticated recovery authority'
    Remove-Item -LiteralPath $conflictManifest.Path -Force -ErrorAction Stop

    Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction Stop
    [void](New-Item -Path $desktopKey -Force -ErrorAction Stop)
    (Get-Item -LiteralPath $desktopKey).SetValue(
      $installedName, [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $provisionalManifest = New-HkcuManifest $false $false $null $null $true $true
    $provisional = Invoke-WorkflowCleanupController `
      'HKCU_PROVISIONAL' $provisionalManifest.Path $provisionalManifest.RunId ''
    Assert-True ($provisional.ExitCode -eq 21 -and
        $provisional.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'provisional HKCU evidence authorized manual registry deletion'
    Assert-True ((Get-Item -LiteralPath $desktopKey).GetValueKind($installedName).ToString() `
        -ceq 'DWord' -and
        [int](Get-ItemPropertyValue -LiteralPath $desktopKey -Name $installedName) -eq 1) `
      'provisional HKCU installed value was removed or changed'
    Assert-True (Test-Path -LiteralPath $provisionalManifest.Path -PathType Leaf) `
      'provisional HKCU failure discarded authenticated recovery authority'
    Remove-Item -LiteralPath $provisionalManifest.Path -Force -ErrorAction Stop
  } finally {
    if (Test-Path -LiteralPath $desktopKey) {
      Remove-Item -LiteralPath $desktopKey -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:HKCU_INSTALLED_VALUE:PRESERVED'
  [Console]::Out.Flush()
}

function Test-ProvisionalUserMarkerOwnership {
  function New-ProvisionalUserManifest([string]$UserName, [string]$OwnershipMarker) {
    $runId = [Guid]::NewGuid().ToString('N')
    $path = Join-Path ([IO.Path]::GetTempPath()) `
      "propr-installed-app-ownership-$runId.json"
    $createdTicks = [DateTime]::UtcNow.Ticks
    $manifest = [ordered]@{
      SchemaVersion = 3
      ManifestType = 'PROPR_WINDOWS_INSTALLED_APP_OWNERSHIP'
      State = 'ACTIVE'
      RunId = $runId
      CreatedUtcTicks = $createdTicks
      ExpiresUtcTicks = $createdTicks + ([TimeSpan]::TicksPerHour * 3)
      InstallerPath = $dummyInstaller
      InstallerEntryIdentity = $dummyInstallerEntryIdentity
      InstallerSha256 = $dummyInstallerSha256
      InstallerProductCode = $dummyInstallerProductCode
      Fixture = $true
      FixtureRoot = $testRoot
      BaselineClean = $false
      InstallAttempted = $false
      MsiTransactionState = 'NONE'
      Directories = @()
      Files = @()
      RegistryKeys = @()
      RegistryValues = @()
      Users = @([ordered]@{
        Name = $UserName
        Sid = $null
        Owned = $true
        Provisional = $true
        OwnershipMarker = $OwnershipMarker
      })
      Profiles = @()
    }
    [IO.File]::WriteAllText(
      $path,
      ($manifest | ConvertTo-Json -Depth 6 -Compress),
      [Text.Encoding]::UTF8
    )
    return [PSCustomObject]@{ RunId = $runId; Path = $path }
  }

  $password = ConvertTo-SecureString "P!$([Guid]::NewGuid().ToString('N'))u8" `
    -AsPlainText -Force
  $positiveName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $positiveMarker = "prpr-own-$([Guid]::NewGuid().ToString('N'))"
  $replacementName = "prpr$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $replacementMarker = "prpr-own-$([Guid]::NewGuid().ToString('N'))"
  $positiveManifest = $null
  $replacementManifest = $null
  try {
    $positiveManifest = New-ProvisionalUserManifest $positiveName $positiveMarker
    New-LocalUser -Name $positiveName -Password $password `
      -Description $positiveMarker -AccountNeverExpires -PasswordNeverExpires | Out-Null
    $positive = Invoke-WorkflowCleanupController `
      'USER_MARKER_OWNED' $positiveManifest.Path $positiveManifest.RunId $testRoot
    Assert-True ($positive.ExitCode -eq 0 -and
        $positive.Result -ceq 'COMPLETE') `
      'marker-bound provisional local-user recovery did not complete'
    Assert-True ($null -eq (Get-LocalUser -Name $positiveName -ErrorAction SilentlyContinue)) `
      'marker-bound provisional local-user recovery left its account behind'

    $replacementManifest = New-ProvisionalUserManifest $replacementName $replacementMarker
    New-LocalUser -Name $replacementName -Password $password `
      -Description "prpr-own-$([Guid]::NewGuid().ToString('N'))" `
      -AccountNeverExpires -PasswordNeverExpires | Out-Null
    $replacementSid = (Get-LocalUser -Name $replacementName -ErrorAction Stop).SID.Value
    $replacement = Invoke-WorkflowCleanupController `
      'USER_MARKER_REPLACEMENT' $replacementManifest.Path `
      $replacementManifest.RunId $testRoot
    Assert-True ($replacement.ExitCode -eq 21 -and
        $replacement.ControllerStatus -ceq 'OWNED_RESOURCE_CLEANUP_FAILURE') `
      'provisional username authorized replacement-account deletion'
    $survivingReplacement = Get-LocalUser -Name $replacementName -ErrorAction Stop
    Assert-True ($survivingReplacement.SID.Value -ceq $replacementSid) `
      'replacement account identity changed during provisional cleanup'
    Assert-True (Test-Path -LiteralPath $replacementManifest.Path -PathType Leaf) `
      'provisional replacement failure discarded authenticated recovery authority'
    $replacementAuthority = Get-Content -LiteralPath $replacementManifest.Path `
      -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-True ($replacementAuthority.State -ceq 'ACTIVE') `
      'provisional replacement failure did not preserve the ACTIVE manifest'
  } finally {
    foreach ($name in @($positiveName, $replacementName)) {
      $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
      if ($null -ne $user) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
    }
    foreach ($manifest in @($positiveManifest, $replacementManifest)) {
      if ($null -ne $manifest -and (Test-Path -LiteralPath $manifest.Path)) {
        Remove-Item -LiteralPath $manifest.Path -Force -ErrorAction SilentlyContinue
      }
    }
  }
  Write-Host 'PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:PROVISIONAL_USER_MARKER:PRESERVED'
  [Console]::Out.Flush()
}

if (![OperatingSystem]::IsWindows()) { throw 'supervisor behavior tests require Windows' }
$actualArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
Assert-True ($actualArchitecture -ceq $Architecture) `
  "supervisor behavior tests expected $Architecture but are running on $actualArchitecture"

Test-WorkflowCleanupBodyParserRegression
[void](New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop)
Initialize-TestInstaller
try {
  Test-WorkflowCleanupStartupProtocol
  Test-WorkflowCleanupProtocolStateMachine
  Test-SupervisorInvocationAttributionTotality
  Invoke-SupervisorAttributedTest 'BOOTSTRAP_TIMEOUT' { Test-BootstrapTimeout }
  Invoke-SupervisorAttributedTest 'WINDOWS_POWERSHELL_CLEANUP_COMPATIBILITY' {
    Test-WindowsPowerShellCleanupCompatibility
  }
  Invoke-SupervisorAttributedTest 'OPERATION_DEADLINE_AND_TREE_TERMINATION' {
    Test-OperationDeadlineAndTreeTermination
  }
  Invoke-SupervisorAttributedTest 'NEGATIVE_WORKER_EXIT_FINALIZATION' {
    Test-NegativeWorkerExitFinalization
  }
  Invoke-SupervisorAttributedTest 'FAIL_CLOSED_MARKERS' { Test-FailClosedMarkers }
  Invoke-SupervisorAttributedTest 'LIVE_CANCELLATION_AND_REDACTION' {
    Test-LiveCancellationAndRedaction
  }
  Invoke-SupervisorAttributedTest 'MSI_TRANSACTION_INTERRUPTION_GATES' {
    Test-MsiTransactionInterruptionGates
  }
  Invoke-SupervisorAttributedTest 'PRIMARY_WORKER_FALLBACK_FOREIGN_DESCENDANTS' {
    Test-PrimaryWorkerFallbackForeignDescendants
  }
  Invoke-SupervisorAttributedTest 'PRE_EXISTING_CLEANUP_OWNERSHIP' {
    Test-PreExistingCleanupOwnership
  }
  Invoke-SupervisorAttributedTest 'SMOKE_PROMOTION_INTERRUPTION_AUTHORITY' {
    Test-SmokePromotionInterruptionAuthority
  }
  Invoke-SupervisorAttributedTest 'PRE_EXISTING_APP_PATHS_AUTHORITY' {
    Test-PreExistingAppPathsAuthority
  }
  Invoke-SupervisorAttributedTest 'HKCU_INSTALLED_VALUE_OWNERSHIP' {
    Test-HkcuInstalledValueOwnership
  }
  Invoke-SupervisorAttributedTest 'PROVISIONAL_USER_MARKER_OWNERSHIP' {
    Test-ProvisionalUserMarkerOwnership
  }
  Write-Host "PROPR_WINDOWS_SUPERVISOR_TESTS:${Architecture}:PASSED"
  [Console]::Out.Flush()
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
