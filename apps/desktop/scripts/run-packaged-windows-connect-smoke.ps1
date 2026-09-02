param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('x64','arm64')]
  [string]$Architecture,
  [ValidateSet('none','terminate-tree','cleanup-timeout','diagnostic-subphase','host-node-producer','launcher-authority')]
  [string]$LifecycleTestMode = 'none',
  [ValidateRange(0,2147483647)]
  [int]$LifecycleTestProcessId = 0,
  [ValidateSet(
    'host-node-command-result',
    'host-node-source',
    'host-node-path-binding',
    'host-node-launcher-return-authority',
    'host-launcher-native-initialization',
    'host-launcher-selected-path-input',
    'host-launcher-selected-path-extra-colon',
    'host-launcher-selected-path-get-full-path',
    'host-launcher-selected-path-absolute-shape',
    'host-launcher-selected-path-canonical-equality',
    'host-launcher-source-open',
    'host-launcher-source-type',
    'host-launcher-source-identity',
    'host-launcher-source-final-path',
    'host-launcher-final-open',
    'host-launcher-final-type',
    'host-launcher-final-identity',
    'host-launcher-final-path',
    'host-launcher-final-match',
    'host-launcher-source-reopen',
    'host-launcher-source-reopen-type',
    'host-launcher-source-reopen-identity',
    'host-launcher-source-reopen-final-path',
    'host-launcher-source-reopen-match',
    'host-capture-contract',
    'host-environment-publication'
  )]
  [string]$DiagnosticTestSubphase = 'host-node-command-result',
  [ValidateSet('positive','zero','multiple','non-application','missing-source','non-scalar-source')]
  [string]$HostNodeProducerTestCase = 'positive',
  [ValidateSet('normal','alias','retarget-alias','identity-mismatch')]
  [string]$LauncherAuthorityTestCase = 'normal',
  [string]$LauncherAuthorityTestPath = '',
  [string]$LauncherAuthorityTestRetargetPath = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$failureCategories = @(
  'artifact-missing',
  'artifact-inaccessible',
  'artifact-type',
  'architecture-mismatch',
  'spawn-failed'
)
$failurePhases = @(
  'source-layout',
  'runner-authority',
  'account-setup',
  'staging-copy',
  'staging-acl',
  'staged-contract',
  'staged-tree',
  'staged-architecture',
  'ordinary-user-preflight',
  'fixture-setup',
  'package-authority',
  'application-spawn',
  'application-runtime',
  'capture-parse',
  'result-verify',
  'cleanup'
)
$hostFailureSubphases = @(
  'host-node-command-result',
  'host-node-source',
  'host-node-path-binding',
  'host-node-launcher-return-authority',
  'host-launcher-native-initialization',
  'host-launcher-selected-path-input',
  'host-launcher-selected-path-extra-colon',
  'host-launcher-selected-path-get-full-path',
  'host-launcher-selected-path-absolute-shape',
  'host-launcher-selected-path-canonical-equality',
  'host-launcher-source-open',
  'host-launcher-source-type',
  'host-launcher-source-identity',
  'host-launcher-source-final-path',
  'host-launcher-final-open',
  'host-launcher-final-type',
  'host-launcher-final-identity',
  'host-launcher-final-path',
  'host-launcher-final-match',
  'host-launcher-source-reopen',
  'host-launcher-source-reopen-type',
  'host-launcher-source-reopen-identity',
  'host-launcher-source-reopen-final-path',
  'host-launcher-source-reopen-match',
  'host-capture-contract',
  'host-environment-publication',
  'host-state-contract'
)
$childFailureSubphases = @(
  'preflight-invocation',
  'descendant-enumeration',
  'executable-read',
  'unexpected-exit',
  'authority-contract'
)
$failureSubphases = @($hostFailureSubphases + $childFailureSubphases)
$applicationTimeoutMilliseconds = 5 * 60 * 1000
$terminationTimeoutMilliseconds = 30 * 1000
$cleanupTimeoutMilliseconds = 60 * 1000
$streamCloseTimeoutMilliseconds = 30 * 1000
$taskkillExecutable = 'C:\Windows\System32\taskkill.exe'
$primaryFailure = $null
$primaryPhase = $null
$primarySubphase = $null
$failurePhase = 'source-layout'
$failureSubphase = $null
$cleanupSecondary = 'none'
$testUser = $null
$testUserSid = $null
$stageParent = $null
$stageRoot = $null
$stageLeaf = $null
$stdout = $null
$stderr = $null
$privilegedSid = $null
$launcherAuthority = $null

function Stop-PackagedConnect {
  param([Parameter(Mandatory=$true)][ValidateSet(
    'artifact-missing','artifact-inaccessible','artifact-type','architecture-mismatch','spawn-failed'
  )][string]$Category)
  throw [InvalidOperationException]::new("PROPR_PACKAGED_CONNECT_FAILURE:$Category")
}

function Get-FixedFailureCategory {
  param([Parameter(Mandatory=$true)][Exception]$Exception)
  if ($Exception.Message -cmatch '^PROPR_PACKAGED_CONNECT_FAILURE:(artifact-missing|artifact-inaccessible|artifact-type|architecture-mismatch|spawn-failed)$') {
    return $Matches[1]
  }
  if ($failurePhase -in @('application-spawn','application-runtime','result-verify')) {
    return 'spawn-failed'
  }
  return 'artifact-inaccessible'
}

function Set-FailurePhase {
  param([Parameter(Mandatory=$true)][string]$Phase)
  if ($failurePhases -cnotcontains $Phase) {
    throw [InvalidOperationException]::new('invalid-fixed-failure-phase')
  }
  $script:failurePhase = $Phase
  if ($Phase -cne 'ordinary-user-preflight') {
    $script:failureSubphase = $null
  }
}

function Set-OrdinaryUserPreflightSubphase {
  param([Parameter(Mandatory=$true)][string]$Subphase)
  if ($failureSubphases -cnotcontains $Subphase) {
    throw [InvalidOperationException]::new('invalid-fixed-failure-subphase')
  }
  $script:failureSubphase = $Subphase
  $script:failurePhase = 'ordinary-user-preflight'
}

function Set-PrimaryFailureFromException {
  param([Parameter(Mandatory=$true)][Exception]$Exception)
  $script:primaryFailure = Get-FixedFailureCategory $Exception
  $script:primaryPhase = $failurePhase
  $script:primarySubphase = $null
  if ($script:primaryPhase -ceq 'ordinary-user-preflight') {
    $script:primarySubphase = if ($failureSubphases -ccontains $failureSubphase) {
      $failureSubphase
    } else {
      'host-state-contract'
    }
  }
}

function Get-ValidatedHostNodePath {
  param(
    [switch]$UseTestOnlyCommandResults,
    [AllowNull()][AllowEmptyCollection()][object[]]$TestOnlyCommandResults,
    [scriptblock]$TestOnlySourceProducer
  )
  Set-OrdinaryUserPreflightSubphase 'host-node-command-result'
  if ($UseTestOnlyCommandResults) {
    $commandResults = @($TestOnlyCommandResults)
  } else {
    $commandResults = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)
  }
  if ($commandResults.Count -ne 1 -or
      !($commandResults[0] -is [Management.Automation.ApplicationInfo])) {
    Stop-PackagedConnect 'artifact-type'
  }

  Set-OrdinaryUserPreflightSubphase 'host-node-source'
  $command = $commandResults[0]
  if ($null -eq $TestOnlySourceProducer) {
    $sourceResults = @($command.Source)
  } else {
    $sourceResults = @(& $TestOnlySourceProducer $command)
  }
  if ($sourceResults.Count -ne 1 -or
      !($sourceResults[0] -is [string]) -or
      [String]::IsNullOrEmpty($sourceResults[0])) {
    Stop-PackagedConnect 'artifact-type'
  }
  return $sourceResults[0]
}

function Stop-SpawnedProcess {
  param([Parameter(Mandatory=$true)][Diagnostics.Process]$Process)
  try {
    if ($Process.HasExited) { return }
    $processId = $Process.Id
    $processIdText = $processId.ToString([Globalization.CultureInfo]::InvariantCulture)
    $validatedProcessId = 0
    if ($processIdText -cnotmatch '^[1-9][0-9]{0,9}$' -or
        ![Int32]::TryParse(
          $processIdText,
          [Globalization.NumberStyles]::None,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$validatedProcessId
        ) -or $validatedProcessId -ne $processId) {
      Stop-PackagedConnect 'spawn-failed'
    }

    $taskkillStart = [Diagnostics.ProcessStartInfo]::new()
    $taskkillStart.FileName = $taskkillExecutable
    $taskkillStart.Arguments = [String]::Join(' ', [string[]]@('/PID', $processIdText, '/T', '/F'))
    $taskkillStart.UseShellExecute = $false
    $taskkillStart.CreateNoWindow = $true
    $taskkillStart.RedirectStandardOutput = $true
    $taskkillStart.RedirectStandardError = $true
    $taskkillProcess = [Diagnostics.Process]::new()
    $taskkillProcess.StartInfo = $taskkillStart
    try {
      if (!$taskkillProcess.Start()) { Stop-PackagedConnect 'spawn-failed' }
      $taskkillOutputClose = $taskkillProcess.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
      $taskkillErrorClose = $taskkillProcess.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
      if (!$taskkillProcess.WaitForExit($terminationTimeoutMilliseconds)) {
        try { $taskkillProcess.Kill() } catch {}
        try { $null = $taskkillProcess.WaitForExit($terminationTimeoutMilliseconds) } catch {}
        try {
          $null = [Threading.Tasks.Task]::WaitAll(
            [Threading.Tasks.Task[]]@($taskkillOutputClose, $taskkillErrorClose),
            $streamCloseTimeoutMilliseconds
          )
        } catch {}
        Stop-PackagedConnect 'spawn-failed'
      }
      if (![Threading.Tasks.Task]::WaitAll(
          [Threading.Tasks.Task[]]@($taskkillOutputClose, $taskkillErrorClose),
          $streamCloseTimeoutMilliseconds
        ) -or $taskkillOutputClose.IsFaulted -or $taskkillErrorClose.IsFaulted -or
        $taskkillProcess.ExitCode -ne 0 -or !$Process.WaitForExit($terminationTimeoutMilliseconds) -or
        !$Process.HasExited) {
        Stop-PackagedConnect 'spawn-failed'
      }
    } finally {
      $taskkillProcess.Dispose()
    }
  } catch {
    if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
    Stop-PackagedConnect 'spawn-failed'
  }
}

function Get-CanonicalItem {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][ValidateSet('directory','file')][string]$Kind
  )
  try {
    if (![IO.Path]::IsPathRooted($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) {
      Stop-PackagedConnect 'artifact-type'
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch [Management.Automation.ItemNotFoundException] {
    Stop-PackagedConnect 'artifact-missing'
  } catch {
    if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
    Stop-PackagedConnect 'artifact-inaccessible'
  }
  if (($Kind -eq 'directory') -ne $item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ![String]::Equals($item.FullName, $Path, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-PackagedConnect 'artifact-type'
  }
  return $item
}

$hostLauncherNativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ProprHostLauncherNative {
  public const uint FILE_READ_ATTRIBUTES = 0x00000080;
  public const uint FILE_SHARE_READ = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint FILE_SHARE_DELETE = 0x00000004;
  public const uint OPEN_EXISTING = 3;
  public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  public const uint FILE_ATTRIBUTE_DEVICE = 0x00000040;
  public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  public const uint FILE_TYPE_DISK = 0x0001;

  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
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

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_128 {
    public ulong Low;
    public ulong High;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public FILE_ID_128 FileId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle file,
    out BY_HANDLE_FILE_INFORMATION information
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle file,
    int fileInformationClass,
    out FILE_ID_INFO information,
    uint bufferSize
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint GetFileType(SafeFileHandle file);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(
    SafeFileHandle file,
    StringBuilder path,
    uint pathLength,
    uint flags
  );

  public static SafeFileHandle Open(string path, bool finalPathAuthority) {
    uint share = finalPathAuthority
      ? FILE_SHARE_READ
      : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    uint flags = FILE_FLAG_BACKUP_SEMANTICS;
    if (finalPathAuthority) flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    SafeFileHandle handle = CreateFileW(
      path,
      FILE_READ_ATTRIBUTES,
      share,
      IntPtr.Zero,
      OPEN_EXISTING,
      flags,
      IntPtr.Zero
    );
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(error);
    }
    return handle;
  }

  public static string GetIdentity(SafeFileHandle handle) {
    const int FileIdInfo = 18;
    FILE_ID_INFO information;
    if (!GetFileInformationByHandleEx(
      handle,
      FileIdInfo,
      out information,
      (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return String.Format(
      System.Globalization.CultureInfo.InvariantCulture,
      "{0:X16}:{1:X16}:{2:X16}",
      information.VolumeSerialNumber,
      information.FileId.High,
      information.FileId.Low
    );
  }

  public static uint GetAttributes(SafeFileHandle handle) {
    BY_HANDLE_FILE_INFORMATION information;
    if (!GetFileInformationByHandle(handle, out information)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return information.FileAttributes;
  }

  public static uint GetHandleType(SafeFileHandle handle) {
    uint type = GetFileType(handle);
    if (type == 0) {
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new Win32Exception(error);
    }
    return type;
  }

  public static string GetFinalPath(SafeFileHandle handle) {
    StringBuilder path = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
    if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (length >= path.Capacity) throw new Win32Exception(206);
    return path.ToString();
  }
}
'@

function Initialize-HostLauncherNative {
  if ($null -eq ('ProprHostLauncherNative' -as [type])) {
    Add-Type -TypeDefinition $hostLauncherNativeSource -Language CSharp -ErrorAction Stop
  }
}

function Get-BoundedAbsoluteWindowsPath {
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Path,
    [switch]$SelectedPathPredicates
  )
  if ($SelectedPathPredicates) {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-selected-path-input'
  }
  if ([String]::IsNullOrEmpty($Path) -or $Path.Length -gt 259 -or $Path -cmatch '[\x00-\x1f\x7f]' -or
      $Path.StartsWith('\\?\', [StringComparison]::Ordinal) -or
      $Path.StartsWith('\\.\', [StringComparison]::Ordinal) -or
      $Path.StartsWith('\??\', [StringComparison]::Ordinal)) {
    Stop-PackagedConnect 'artifact-type'
  }
  if ($SelectedPathPredicates) {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-selected-path-extra-colon'
  }
  if ($Path.Length -gt 2 -and $Path.Substring(2).Contains(':')) {
    Stop-PackagedConnect 'artifact-type'
  }
  if ($SelectedPathPredicates) {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-selected-path-get-full-path'
  }
  try {
    $fullPath = [IO.Path]::GetFullPath($Path)
  } catch {
    Stop-PackagedConnect 'artifact-type'
  }
  if ($SelectedPathPredicates) {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-selected-path-absolute-shape'
  }
  $driveAbsolute = $fullPath -cmatch '^[A-Za-z]:\\'
  $uncAbsolute = $fullPath -cmatch '^\\\\[^\\:]+\\[^\\:]+\\'
  if (!$driveAbsolute -and !$uncAbsolute) { Stop-PackagedConnect 'artifact-type' }
  if ($SelectedPathPredicates) {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-selected-path-canonical-equality'
  }
  if (![String]::Equals($fullPath, $Path, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-PackagedConnect 'artifact-type'
  }
  return $fullPath
}

function ConvertFrom-NativeFinalPath {
  param([Parameter(Mandatory=$true)][string]$Path)
  if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    return '\\' + $Path.Substring(8)
  }
  if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    return $Path.Substring(4)
  }
  Stop-PackagedConnect 'artifact-type'
}

function Assert-OrdinaryHostLauncherHandle {
  param([Parameter(Mandatory=$true)]$Handle)
  $attributes = [ProprHostLauncherNative]::GetAttributes($Handle)
  if ([ProprHostLauncherNative]::GetHandleType($Handle) -ne [ProprHostLauncherNative]::FILE_TYPE_DISK -or
      ($attributes -band [ProprHostLauncherNative]::FILE_ATTRIBUTE_DIRECTORY) -ne 0 -or
      ($attributes -band [ProprHostLauncherNative]::FILE_ATTRIBUTE_DEVICE) -ne 0 -or
      ($attributes -band [ProprHostLauncherNative]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    Stop-PackagedConnect 'artifact-type'
  }
}

function Get-TrustedHostLauncher {
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Path,
    [scriptblock]$TestOnlyBeforeFinalReopen,
    [scriptblock]$TestOnlyBeforeSourceReopen
  )
  $sourceHandle = $null
  $authorityHandle = $null
  $sourceReopenHandle = $null
  $authorityTransferred = $false
  try {
    Set-OrdinaryUserPreflightSubphase 'host-launcher-native-initialization'
    Initialize-HostLauncherNative
    $selectedPath = Get-BoundedAbsoluteWindowsPath -Path $Path -SelectedPathPredicates
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-open'
    $sourceHandle = [ProprHostLauncherNative]::Open($selectedPath, $false)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-type'
    Assert-OrdinaryHostLauncherHandle $sourceHandle
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-identity'
    $sourceIdentity = [ProprHostLauncherNative]::GetIdentity($sourceHandle)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-final-path'
    $finalPath = Get-BoundedAbsoluteWindowsPath (
      ConvertFrom-NativeFinalPath ([ProprHostLauncherNative]::GetFinalPath($sourceHandle))
    )

    if ($null -ne $TestOnlyBeforeFinalReopen) { & $TestOnlyBeforeFinalReopen }
    Set-OrdinaryUserPreflightSubphase 'host-launcher-final-open'
    $authorityHandle = [ProprHostLauncherNative]::Open($finalPath, $true)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-final-type'
    Assert-OrdinaryHostLauncherHandle $authorityHandle
    Set-OrdinaryUserPreflightSubphase 'host-launcher-final-identity'
    $authorityIdentity = [ProprHostLauncherNative]::GetIdentity($authorityHandle)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-final-path'
    $authorityFinalPath = Get-BoundedAbsoluteWindowsPath (
      ConvertFrom-NativeFinalPath ([ProprHostLauncherNative]::GetFinalPath($authorityHandle))
    )
    Set-OrdinaryUserPreflightSubphase 'host-launcher-final-match'
    if (![String]::Equals($sourceIdentity, $authorityIdentity, [StringComparison]::Ordinal) -or
        ![String]::Equals($finalPath, $authorityFinalPath, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-PackagedConnect 'artifact-type'
    }

    if ($null -ne $TestOnlyBeforeSourceReopen) { & $TestOnlyBeforeSourceReopen }
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-reopen'
    $sourceReopenHandle = [ProprHostLauncherNative]::Open($selectedPath, $false)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-reopen-type'
    Assert-OrdinaryHostLauncherHandle $sourceReopenHandle
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-reopen-identity'
    $sourceReopenIdentity = [ProprHostLauncherNative]::GetIdentity($sourceReopenHandle)
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-reopen-final-path'
    $sourceReopenFinalPath = Get-BoundedAbsoluteWindowsPath (
      ConvertFrom-NativeFinalPath ([ProprHostLauncherNative]::GetFinalPath($sourceReopenHandle))
    )
    Set-OrdinaryUserPreflightSubphase 'host-launcher-source-reopen-match'
    if (![String]::Equals($authorityIdentity, $sourceReopenIdentity, [StringComparison]::Ordinal) -or
        ![String]::Equals($finalPath, $sourceReopenFinalPath, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-PackagedConnect 'artifact-type'
    }

    $authorityTransferred = $true
    return [PSCustomObject]@{ Path = $finalPath; Handle = $authorityHandle }
  } catch {
    if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
    $nativeException = $_.Exception
    while ($null -ne $nativeException.InnerException) { $nativeException = $nativeException.InnerException }
    if ($nativeException -is [ComponentModel.Win32Exception] -and $nativeException.NativeErrorCode -in @(2,3)) {
      Stop-PackagedConnect 'artifact-missing'
    }
    Stop-PackagedConnect 'artifact-inaccessible'
  } finally {
    if ($null -ne $sourceHandle) { $sourceHandle.Dispose() }
    if ($null -ne $sourceReopenHandle) { $sourceReopenHandle.Dispose() }
    if (!$authorityTransferred -and $null -ne $authorityHandle) { $authorityHandle.Dispose() }
  }
}

function Assert-PeArchitecture {
  param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$ExpectedArchitecture
  )
  try {
    $stream = [IO.FileStream]::new($Executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $header = New-Object byte[] 4096
      $length = $stream.Read($header, 0, $header.Length)
    } finally {
      $stream.Dispose()
    }
  } catch {
    Stop-PackagedConnect 'artifact-inaccessible'
  }
  if ($length -lt 64 -or [Text.Encoding]::ASCII.GetString($header, 0, 2) -cne 'MZ') {
    Stop-PackagedConnect 'artifact-type'
  }
  $pe = [BitConverter]::ToUInt32($header, 0x3c)
  if ($pe -lt 0x40 -or $pe + 6 -gt $length -or
      [Text.Encoding]::ASCII.GetString($header, [int]$pe, 4) -cne "PE`0`0") {
    Stop-PackagedConnect 'artifact-type'
  }
  $expectedMachine = if ($ExpectedArchitecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
  if ([BitConverter]::ToUInt16($header, [int]$pe + 4) -ne $expectedMachine) {
    Stop-PackagedConnect 'architecture-mismatch'
  }
}

function Assert-PackageTreeTypes {
  param([Parameter(Mandatory=$true)][string]$Root)
  try {
    $entries = @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop)
  } catch {
    Stop-PackagedConnect 'artifact-inaccessible'
  }
  if ($entries.Count -lt 1 -or $entries.Count -gt 20000) { Stop-PackagedConnect 'artifact-type' }
  foreach ($entry in $entries) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (!$entry.PSIsContainer -and !($entry -is [IO.FileInfo]))) {
      Stop-PackagedConnect 'artifact-type'
    }
  }
  return $entries
}

function Assert-CopiedPackageTree {
  param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][object[]]$SourceEntries,
    [Parameter(Mandatory=$true)][string]$DestinationRoot,
    [Parameter(Mandatory=$true)][object[]]$DestinationEntries
  )
  if ($SourceEntries.Count -ne $DestinationEntries.Count) { Stop-PackagedConnect 'artifact-type' }
  $destinationByRelativePath = @{}
  foreach ($entry in $DestinationEntries) {
    $relative = $entry.FullName.Substring($DestinationRoot.Length).TrimStart('\')
    if ([String]::IsNullOrEmpty($relative) -or $destinationByRelativePath.ContainsKey($relative)) {
      Stop-PackagedConnect 'artifact-type'
    }
    $destinationByRelativePath.Add($relative, $entry)
  }
  foreach ($source in $SourceEntries) {
    $relative = $source.FullName.Substring($SourceRoot.Length).TrimStart('\')
    if (!$destinationByRelativePath.ContainsKey($relative)) { Stop-PackagedConnect 'artifact-missing' }
    $destination = $destinationByRelativePath[$relative]
    if ($source.PSIsContainer -ne $destination.PSIsContainer -or
        (!$source.PSIsContainer -and $source.Length -ne $destination.Length)) {
      Stop-PackagedConnect 'artifact-type'
    }
  }
}

function Set-StagedEntryAcl {
  param(
    [Parameter(Mandatory=$true)][IO.FileSystemInfo]$Item,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$OrdinaryUser,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$Administrators
  )
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $directory = $Item.PSIsContainer
  try {
    $acl = if ($directory) {
      [Security.AccessControl.DirectorySecurity]::new()
    } else {
      [Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($Administrators)
    foreach ($identity in @($OrdinaryUser, $system, $Administrators)) {
      $rights = if ($identity.Value -eq $OrdinaryUser.Value) {
        [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
      } else {
        [Security.AccessControl.FileSystemRights]::FullControl
      }
      $rule = if ($directory) {
        [Security.AccessControl.FileSystemAccessRule]::new(
          $identity,
          $rights,
          [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
          [Security.AccessControl.PropagationFlags]::None,
          [Security.AccessControl.AccessControlType]::Allow
        )
      } else {
        [Security.AccessControl.FileSystemAccessRule]::new(
          $identity, $rights, [Security.AccessControl.AccessControlType]::Allow
        )
      }
      $null = $acl.AddAccessRule($rule)
    }
    if ($directory) {
      [IO.Directory]::SetAccessControl($Item.FullName, [Security.AccessControl.DirectorySecurity]$acl)
    } else {
      [IO.File]::SetAccessControl($Item.FullName, [Security.AccessControl.FileSecurity]$acl)
    }
  } catch {
    Stop-PackagedConnect 'artifact-inaccessible'
  }
}

function Assert-StagedEntryAcl {
  param(
    [Parameter(Mandatory=$true)][IO.FileSystemInfo]$Item,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$OrdinaryUser,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$Administrators
  )
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  try {
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $acl = if ($Item.PSIsContainer) {
      [IO.Directory]::GetAccessControl($Item.FullName, $sections)
    } else {
      [IO.File]::GetAccessControl($Item.FullName, $sections)
    }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  } catch {
    Stop-PackagedConnect 'artifact-inaccessible'
  }
  if ($owner.Value -ne $Administrators.Value -or !$acl.AreAccessRulesProtected -or
      !$acl.AreAccessRulesCanonical -or $rules.Count -ne 3) {
    Stop-PackagedConnect 'artifact-type'
  }
  foreach ($identity in @($OrdinaryUser, $system, $Administrators)) {
    $matches = @($rules | Where-Object { $_.IdentityReference.Value -eq $identity.Value })
    $expected = if ($identity.Value -eq $OrdinaryUser.Value) {
      [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
    } else {
      [Security.AccessControl.FileSystemRights]::FullControl
    }
    $expectedInheritance = if ($Item.PSIsContainer) {
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    if ($matches.Count -ne 1 -or
        $matches[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $matches[0].FileSystemRights -ne $expected -or
        $matches[0].InheritanceFlags -ne $expectedInheritance -or
        $matches[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
        $matches[0].IsInherited) {
      Stop-PackagedConnect 'artifact-type'
    }
  }
}

$boundedCleanupSource = @'
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $runnerTemp=$env:PROPR_CLEANUP_RUNNER_TEMP
  $parent=$env:PROPR_CLEANUP_STAGE_PARENT
  $leaf=$env:PROPR_CLEANUP_STAGE_LEAF
  $privileged=[Security.Principal.SecurityIdentifier]::new($env:PROPR_CLEANUP_PRIVILEGED_SID)
  $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  if([String]::IsNullOrEmpty($runnerTemp) -or ![IO.Path]::IsPathRooted($runnerTemp) -or
    ![String]::Equals([IO.Path]::GetFullPath($runnerTemp),$runnerTemp,[StringComparison]::OrdinalIgnoreCase)){exit 91}
  if(![String]::IsNullOrEmpty($parent) -or ![String]::IsNullOrEmpty($leaf)){
    if([IO.Path]::GetDirectoryName($parent) -cne $runnerTemp -or
      [IO.Path]::GetFileName($parent) -cne 'propr-connect-packaged-stage' -or
      $leaf -cnotmatch '^propr-connect-package-[a-f0-9]{32}$'){exit 91}
    $root=[IO.Path]::Combine($parent,$leaf)
    if([IO.Path]::GetDirectoryName($root) -cne $parent -or [IO.Path]::GetFileName($root) -cne $leaf){exit 91}
    if(Test-Path -LiteralPath $root){
      $items=@((Get-Item -LiteralPath $root -Force -ErrorAction Stop))
      $items+=@(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
      if($items.Count -gt 20001){exit 91}
      foreach($item in $items){
        $isRoot=[String]::Equals($item.FullName,$root,[StringComparison]::OrdinalIgnoreCase)
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ![String]::Equals([IO.Path]::GetFullPath($item.FullName),$item.FullName,[StringComparison]::OrdinalIgnoreCase) -or
          (!$isRoot -and !$item.FullName.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) -or
          ($isRoot -and !$item.PSIsContainer)){exit 91}
        $sections=[Security.AccessControl.AccessControlSections]::Owner
        $acl=if($item.PSIsContainer){[IO.Directory]::GetAccessControl($item.FullName,$sections)}else{[IO.File]::GetAccessControl($item.FullName,$sections)}
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
        if(@($privileged.Value,$admins.Value) -cnotcontains $owner.Value){exit 91}
      }
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
      if(Test-Path -LiteralPath $root){exit 92}
    }
    if(Test-Path -LiteralPath $parent){
      $parentItem=Get-Item -LiteralPath $parent -Force -ErrorAction Stop
      if(!$parentItem.PSIsContainer -or ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop).Count -ne 0){exit 91}
      $parentAcl=[IO.Directory]::GetAccessControl($parent,[Security.AccessControl.AccessControlSections]::Owner)
      $parentOwner=$parentAcl.GetOwner([Security.Principal.SecurityIdentifier])
      if(@($privileged.Value,$admins.Value) -cnotcontains $parentOwner.Value){exit 91}
      Remove-Item -LiteralPath $parent -Force -ErrorAction Stop
      if(Test-Path -LiteralPath $parent){exit 92}
    }
  }
  foreach($capture in @($env:PROPR_CLEANUP_STDOUT,$env:PROPR_CLEANUP_STDERR)){
    if(![String]::IsNullOrEmpty($capture)){
      if([IO.Path]::GetDirectoryName($capture) -cne $runnerTemp -or
        [IO.Path]::GetFileName($capture) -cnotmatch '^propr-connect-[a-f0-9]{32}\.(stdout|stderr)$'){exit 91}
      if(Test-Path -LiteralPath $capture){
        $captureItem=Get-Item -LiteralPath $capture -Force -ErrorAction Stop
        if($captureItem.PSIsContainer -or ($captureItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 91}
        $captureAcl=[IO.File]::GetAccessControl($capture,[Security.AccessControl.AccessControlSections]::Owner)
        $captureOwner=$captureAcl.GetOwner([Security.Principal.SecurityIdentifier])
        if(@($privileged.Value,$admins.Value) -cnotcontains $captureOwner.Value){exit 91}
        Remove-Item -LiteralPath $capture -Force -ErrorAction Stop
        if(Test-Path -LiteralPath $capture){exit 92}
      }
    }
  }
  $user=$env:PROPR_CLEANUP_USER
  $userSid=$env:PROPR_CLEANUP_USER_SID
  if(![String]::IsNullOrEmpty($user) -or ![String]::IsNullOrEmpty($userSid)){
    if($user -cnotmatch '^prpc[a-f0-9]{12}$' -or [String]::IsNullOrEmpty($userSid)){exit 91}
    $account=Get-LocalUser -Name $user -ErrorAction Stop
    if($account.SID.Value -cne $userSid){exit 91}
    Remove-LocalUser -Name $user -ErrorAction Stop
    if($null -ne (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)){exit 92}
  }
  exit 0
} catch { exit 93 }
'@

function Invoke-BoundedCleanup {
  param(
    [string]$CleanupSource = $boundedCleanupSource,
    [ref]$ObservedProcessId
  )
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($CleanupSource))
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=Join-Path $PSHOME 'powershell.exe'
  $start.Arguments="-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $start.EnvironmentVariables['PROPR_CLEANUP_RUNNER_TEMP']=[string]$authenticatedRunnerTemp
  $cleanupStageParent=if($null -eq $stageLeaf){''}else{[string]$stageParent}
  $cleanupStageLeaf=if($null -eq $stageLeaf){''}else{[string]$stageLeaf}
  $start.EnvironmentVariables['PROPR_CLEANUP_STAGE_PARENT']=$cleanupStageParent
  $start.EnvironmentVariables['PROPR_CLEANUP_STAGE_LEAF']=$cleanupStageLeaf
  $start.EnvironmentVariables['PROPR_CLEANUP_PRIVILEGED_SID']=if($null -eq $privilegedSid){''}else{$privilegedSid.Value}
  $start.EnvironmentVariables['PROPR_CLEANUP_STDOUT']=[string]$stdout
  $start.EnvironmentVariables['PROPR_CLEANUP_STDERR']=[string]$stderr
  $start.EnvironmentVariables['PROPR_CLEANUP_USER']=[string]$testUser
  $start.EnvironmentVariables['PROPR_CLEANUP_USER_SID']=if($null -eq $testUserSid){''}else{$testUserSid.Value}
  $cleanupProcess=[Diagnostics.Process]::new()
  $cleanupProcess.StartInfo=$start
  $cleanupOutputBuffer=[IO.MemoryStream]::new()
  $cleanupErrorBuffer=[IO.MemoryStream]::new()
  try {
    if(!$cleanupProcess.Start()){return 'failed'}
    if($null -ne $ObservedProcessId){$ObservedProcessId.Value=$cleanupProcess.Id}
    $cleanupOutputClose=$cleanupProcess.StandardOutput.BaseStream.CopyToAsync($cleanupOutputBuffer)
    $cleanupErrorClose=$cleanupProcess.StandardError.BaseStream.CopyToAsync($cleanupErrorBuffer)
    if(!$cleanupProcess.WaitForExit($cleanupTimeoutMilliseconds)){
      try{$cleanupProcess.Kill()}catch{return 'failed'}
      try{if(!$cleanupProcess.WaitForExit($terminationTimeoutMilliseconds)){return 'failed'}}catch{return 'failed'}
      try {
        if(![Threading.Tasks.Task]::WaitAll(
            [Threading.Tasks.Task[]]@($cleanupOutputClose,$cleanupErrorClose),
            $streamCloseTimeoutMilliseconds
          ) -or $cleanupOutputClose.IsFaulted -or $cleanupErrorClose.IsFaulted){return 'failed'}
      } catch { return 'failed' }
      return 'timeout'
    }
    if(![Threading.Tasks.Task]::WaitAll(
        [Threading.Tasks.Task[]]@($cleanupOutputClose,$cleanupErrorClose),
        $streamCloseTimeoutMilliseconds
      ) -or $cleanupOutputClose.IsFaulted -or $cleanupErrorClose.IsFaulted -or
      $cleanupProcess.ExitCode -ne 0 -or $cleanupOutputBuffer.Length -ne 0 -or
      $cleanupErrorBuffer.Length -ne 0){return 'failed'}
    return 'none'
  } catch {
    try{
      if(!$cleanupProcess.HasExited){
        $cleanupProcess.Kill()
        $null=$cleanupProcess.WaitForExit($terminationTimeoutMilliseconds)
      }
    }catch{}
    return 'failed'
  } finally {
    $cleanupProcess.Dispose()
    $cleanupOutputBuffer.Dispose()
    $cleanupErrorBuffer.Dispose()
  }
}

$authenticatedRunnerTemp = $null
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')

if ($LifecycleTestMode -eq 'diagnostic-subphase') {
  Set-OrdinaryUserPreflightSubphase $DiagnosticTestSubphase
  try {
    throw [InvalidOperationException]::new(
      'C:\hostile\package S-1-5-21-123 account-name stdout stderr exception environment-secret'
    )
  } catch {
    Set-PrimaryFailureFromException $_.Exception
  }
}

if ($LifecycleTestMode -eq 'terminate-tree') {
  $lifecycleTarget = $null
  try {
    if ($LifecycleTestProcessId -lt 1) { Stop-PackagedConnect 'spawn-failed' }
    $lifecycleTarget = [Diagnostics.Process]::GetProcessById($LifecycleTestProcessId)
    if ($lifecycleTarget.HasExited) { Stop-PackagedConnect 'spawn-failed' }
    if ($lifecycleTarget.WaitForExit(250)) { Stop-PackagedConnect 'spawn-failed' }
    Stop-SpawnedProcess $lifecycleTarget
    if (!$lifecycleTarget.HasExited) { Stop-PackagedConnect 'spawn-failed' }
    [Console]::Out.WriteLine('PROPR_WINDOWS_PACKAGED_CONNECT_LIFECYCLE_TEST:tree-terminated')
    exit 0
  } catch {
    [Console]::Error.WriteLine('PROPR_WINDOWS_PACKAGED_CONNECT_LIFECYCLE_TEST:failed:category=spawn-failed')
    exit 1
  } finally {
    if ($null -ne $lifecycleTarget) { $lifecycleTarget.Dispose() }
  }
}

if ($LifecycleTestMode -eq 'host-node-producer') {
  try {
    if ($HostNodeProducerTestCase -eq 'positive') {
      $node = Get-ValidatedHostNodePath
    } elseif ($HostNodeProducerTestCase -eq 'zero') {
      $node = Get-ValidatedHostNodePath `
        -UseTestOnlyCommandResults `
        -TestOnlyCommandResults ([object[]]@())
    } elseif ($HostNodeProducerTestCase -eq 'non-application') {
      $node = Get-ValidatedHostNodePath `
        -UseTestOnlyCommandResults `
        -TestOnlyCommandResults ([object[]]@([PSCustomObject]@{ Source = 'C:\hostile\node.exe' }))
    } else {
      $knownApplications = @(Get-Command `
        -Name ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) `
        -CommandType Application `
        -ErrorAction Stop)
      $knownApplication = $knownApplications[0]
      if (!($knownApplication -is [Management.Automation.ApplicationInfo])) {
        Set-OrdinaryUserPreflightSubphase 'host-node-command-result'
        Stop-PackagedConnect 'artifact-type'
      }
      if ($HostNodeProducerTestCase -eq 'multiple') {
        $node = Get-ValidatedHostNodePath `
          -UseTestOnlyCommandResults `
          -TestOnlyCommandResults ([object[]]@($knownApplication, $knownApplication))
      } elseif ($HostNodeProducerTestCase -eq 'missing-source') {
        $node = Get-ValidatedHostNodePath `
          -UseTestOnlyCommandResults `
          -TestOnlyCommandResults ([object[]]@($knownApplication)) `
          -TestOnlySourceProducer { $null }
      } else {
        $node = Get-ValidatedHostNodePath `
          -UseTestOnlyCommandResults `
          -TestOnlyCommandResults ([object[]]@($knownApplication)) `
          -TestOnlySourceProducer { [object[]]@('C:\hostile\one.exe', 'C:\hostile\two.exe') }
      }
    }
    if (!($node -is [string]) -or [String]::IsNullOrEmpty($node)) {
      Set-OrdinaryUserPreflightSubphase 'host-node-source'
      Stop-PackagedConnect 'artifact-type'
    }
    [Console]::Out.WriteLine('PROPR_WINDOWS_PACKAGED_CONNECT_HOST_NODE_PRODUCER_TEST:accepted')
    exit 0
  } catch {
    Set-PrimaryFailureFromException $_.Exception
  }
}

if ($LifecycleTestMode -eq 'launcher-authority') {
  Set-OrdinaryUserPreflightSubphase 'host-node-path-binding'
  try {
    $beforeFinalReopen = $null
    $beforeSourceReopen = $null
    if ($LauncherAuthorityTestCase -eq 'identity-mismatch') {
      $beforeFinalReopen = {
        $replacementBackup = $LauncherAuthorityTestPath + '.propr-identity-' + [Guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $LauncherAuthorityTestPath -Destination $replacementBackup -ErrorAction Stop
        [IO.File]::WriteAllBytes($LauncherAuthorityTestPath, [byte[]]@(0x4d,0x5a))
      }
    } elseif ($LauncherAuthorityTestCase -eq 'retarget-alias') {
      $beforeSourceReopen = {
        $null = Get-BoundedAbsoluteWindowsPath $LauncherAuthorityTestRetargetPath
        Remove-Item -LiteralPath $LauncherAuthorityTestPath -Force -ErrorAction Stop
        $null = New-Item `
          -ItemType SymbolicLink `
          -Path $LauncherAuthorityTestPath `
          -Target $LauncherAuthorityTestRetargetPath `
          -ErrorAction Stop
      }
    }
    $launcherAuthority = Get-TrustedHostLauncher `
      -Path $LauncherAuthorityTestPath `
      -TestOnlyBeforeFinalReopen $beforeFinalReopen `
      -TestOnlyBeforeSourceReopen $beforeSourceReopen
    $launcherAuthority.Handle.Dispose()
    $launcherAuthority = $null
    [Console]::Out.WriteLine('PROPR_WINDOWS_PACKAGED_CONNECT_LAUNCHER_AUTHORITY_TEST:accepted')
    exit 0
  } catch {
    Set-PrimaryFailureFromException $_.Exception
  } finally {
    if ($null -ne $launcherAuthority) {
      $launcherAuthority.Handle.Dispose()
      $launcherAuthority = $null
    }
  }
}

if ($LifecycleTestMode -in @('diagnostic-subphase','host-node-producer','launcher-authority')) {
  # The shared final diagnostic below emits the injected fixed state.
} elseif ($LifecycleTestMode -eq 'cleanup-timeout') {
  $cleanupTimeoutMilliseconds = 750
  $terminationTimeoutMilliseconds = 3000
  $streamCloseTimeoutMilliseconds = 3000
  $primaryFailure = 'artifact-type'
  $primaryPhase = 'staged-tree'
  $neverSettlingCleanupSource = 'while($true){Start-Sleep -Seconds 1}'
  $observedCleanupProcessId = 0
  $cleanupResult = Invoke-BoundedCleanup `
    -CleanupSource $neverSettlingCleanupSource `
    -ObservedProcessId ([ref]$observedCleanupProcessId)
  $cleanupProcessStillRunning = $false
  if ($observedCleanupProcessId -gt 0) {
    try {
      $observedCleanupProcess = [Diagnostics.Process]::GetProcessById($observedCleanupProcessId)
      try { $cleanupProcessStillRunning = !$observedCleanupProcess.HasExited } finally { $observedCleanupProcess.Dispose() }
    } catch {}
  }
  if ($cleanupResult -eq 'timeout' -and !$cleanupProcessStillRunning) {
    $cleanupSecondary = 'cleanup-timeout'
  } else {
    $cleanupSecondary = 'cleanup-failed'
  }
} else {
try {
  try {
    Set-FailurePhase 'source-layout'
    $desktopDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $sourceRoot = [IO.Path]::GetFullPath((Join-Path $desktopDirectory "out\propr-desktop-win32-$Architecture"))
    if ([IO.Path]::GetDirectoryName($sourceRoot) -cne (Join-Path $desktopDirectory 'out') -or
        [IO.Path]::GetFileName($sourceRoot) -cne "propr-desktop-win32-$Architecture") {
      Stop-PackagedConnect 'artifact-type'
    }
    $null = Get-CanonicalItem $sourceRoot 'directory'
    $sourceExecutable = Join-Path $sourceRoot 'propr-desktop.exe'
    $sourceResources = Join-Path $sourceRoot 'resources'
    $sourceArchive = Join-Path $sourceResources 'app.asar'
    $sourceLocales = Join-Path $sourceRoot 'locales'
    $null = Get-CanonicalItem $sourceExecutable 'file'
    $null = Get-CanonicalItem $sourceResources 'directory'
    $null = Get-CanonicalItem $sourceArchive 'file'
    $null = Get-CanonicalItem $sourceLocales 'directory'
    foreach ($requiredFile in @('chrome_100_percent.pak','chrome_200_percent.pak','icudtl.dat','resources.pak','v8_context_snapshot.bin')) {
      $null = Get-CanonicalItem (Join-Path $sourceRoot $requiredFile) 'file'
    }
    $sourceEntries = @(Assert-PackageTreeTypes $sourceRoot)
    Assert-PeArchitecture $sourceExecutable $Architecture

    Set-FailurePhase 'runner-authority'
    if ([String]::IsNullOrEmpty($env:RUNNER_TEMP) -or ![IO.Path]::IsPathRooted($env:RUNNER_TEMP)) {
      Stop-PackagedConnect 'artifact-type'
    }
    $authenticatedRunnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if ($authenticatedRunnerTemp -cne $env:RUNNER_TEMP.TrimEnd('\')) {
      Stop-PackagedConnect 'artifact-type'
    }
    $runnerTempItem = Get-CanonicalItem $authenticatedRunnerTemp 'directory'
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $privilegedSid = $currentSid
    $runnerTempAcl = [IO.Directory]::GetAccessControl(
      $authenticatedRunnerTemp,
      [Security.AccessControl.AccessControlSections]::Owner
    )
    $runnerTempOwner = $runnerTempAcl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($null -eq $currentSid -or @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') -cnotcontains $runnerTempOwner.Value) {
      Stop-PackagedConnect 'artifact-type'
    }
    $privilegedPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$privilegedPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Stop-PackagedConnect 'artifact-inaccessible'
    }

    $stageParent = Join-Path $authenticatedRunnerTemp 'propr-connect-packaged-stage'
    if (Test-Path -LiteralPath $stageParent) { Stop-PackagedConnect 'artifact-type' }

    Set-FailurePhase 'account-setup'
    $testUser = 'prpc' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $plainPassword = [Guid]::NewGuid().ToString('N') + 'aA1!'
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$testUser", $securePassword)
    $createdUser = New-LocalUser -Name $testUser -Password $securePassword -PasswordNeverExpires -ErrorAction Stop
    $testUserSid = $createdUser.SID
    if ($null -eq $testUserSid -or $testUser.Length -gt 20) { Stop-PackagedConnect 'artifact-type' }
    $createdAccount = Get-LocalUser -Name $testUser -ErrorAction Stop
    if ($createdAccount.SID.Value -cne $testUserSid.Value) { Stop-PackagedConnect 'artifact-type' }
    $administratorsAccount = $administratorsSid.Translate([Security.Principal.NTAccount]).Value
    $administratorsName = $administratorsAccount.Substring($administratorsAccount.IndexOf('\') + 1)
    if ([String]::IsNullOrEmpty($administratorsName)) { Stop-PackagedConnect 'artifact-type' }
    $administratorsGroup = [ADSI]("WinNT://$env:COMPUTERNAME/$administratorsName,group")
    $ordinaryUserEntry = [ADSI]("WinNT://$env:COMPUTERNAME/$testUser,user")
    if ([bool]$administratorsGroup.psbase.Invoke('IsMember', $ordinaryUserEntry.Path)) {
      Stop-PackagedConnect 'artifact-type'
    }

    Set-FailurePhase 'staging-copy'
    $stageLeaf = 'propr-connect-package-' + [Guid]::NewGuid().ToString('N')
    $stageRoot = Join-Path $stageParent $stageLeaf
    $null = New-Item -ItemType Directory -Path $stageParent -ErrorAction Stop
    $null = New-Item -ItemType Directory -Path $stageRoot -ErrorAction Stop
    foreach ($entry in Get-ChildItem -LiteralPath $sourceRoot -Force -ErrorAction Stop) {
      Copy-Item -LiteralPath $entry.FullName -Destination $stageRoot -Recurse -Force -ErrorAction Stop
    }
    $stagedEntries = @(Assert-PackageTreeTypes $stageRoot)
    Assert-CopiedPackageTree $sourceRoot $sourceEntries $stageRoot $stagedEntries
    $null = Get-CanonicalItem $stageRoot 'directory'
    $stagedExecutable = Join-Path $stageRoot 'propr-desktop.exe'
    $null = Get-CanonicalItem $stagedExecutable 'file'
    $null = Get-CanonicalItem (Join-Path $stageRoot 'resources') 'directory'
    $null = Get-CanonicalItem (Join-Path $stageRoot 'resources\app.asar') 'file'
    Assert-PeArchitecture $stagedExecutable $Architecture

    Set-FailurePhase 'staging-acl'
    $aclEntries = @((Get-Item -LiteralPath $stageParent -Force), (Get-Item -LiteralPath $stageRoot -Force))
    $aclEntries += @(Get-ChildItem -LiteralPath $stageRoot -Force -Recurse -ErrorAction Stop)
    foreach ($item in $aclEntries) { Set-StagedEntryAcl $item $testUserSid $administratorsSid }
    foreach ($item in $aclEntries) { Assert-StagedEntryAcl $item $testUserSid $administratorsSid }

    $node = Get-ValidatedHostNodePath
    Set-OrdinaryUserPreflightSubphase 'host-node-path-binding'
    $launcherAuthority = Get-TrustedHostLauncher -Path $node
    Set-OrdinaryUserPreflightSubphase 'host-node-launcher-return-authority'
    $launcherAuthorityResults = @($launcherAuthority)
    if ($launcherAuthorityResults.Count -ne 1) { Stop-PackagedConnect 'artifact-type' }
    $launcherAuthority = $launcherAuthorityResults[0]
    $launcherPathProperty = $launcherAuthority.PSObject.Properties['Path']
    $launcherHandleProperty = $launcherAuthority.PSObject.Properties['Handle']
    if ($null -eq $launcherPathProperty -or $null -eq $launcherHandleProperty -or
        !($launcherPathProperty.Value -is [string]) -or
        [String]::IsNullOrEmpty($launcherPathProperty.Value) -or
        !($launcherHandleProperty.Value -is [Microsoft.Win32.SafeHandles.SafeFileHandle]) -or
        $launcherHandleProperty.Value.IsInvalid -or $launcherHandleProperty.Value.IsClosed) {
      Stop-PackagedConnect 'artifact-type'
    }
    $node = $launcherPathProperty.Value
    Set-OrdinaryUserPreflightSubphase 'host-capture-contract'
    $stdout = Join-Path $authenticatedRunnerTemp ('propr-connect-' + [Guid]::NewGuid().ToString('N') + '.stdout')
    $stderr = Join-Path $authenticatedRunnerTemp ('propr-connect-' + [Guid]::NewGuid().ToString('N') + '.stderr')
    if ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr)) {
      Stop-PackagedConnect 'artifact-type'
    }
    Set-OrdinaryUserPreflightSubphase 'host-environment-publication'
    $previousParent = [Environment]::GetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_PARENT', 'Process')
    $previousLeaf = [Environment]::GetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_LEAF', 'Process')
    try {
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_PARENT', $stageParent, 'Process')
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_LEAF', $stageLeaf, 'Process')
      try {
        Set-FailurePhase 'application-spawn'
        try {
          $process = Start-Process `
            -FilePath $node `
            -ArgumentList @('scripts/smoke-packaged-connect.mjs') `
            -WorkingDirectory $desktopDirectory `
            -Credential $credential `
            -LoadUserProfile `
            -PassThru `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -ErrorAction Stop
        } finally {
          $launcherAuthority.Handle.Dispose()
          $launcherAuthority = $null
        }
      } catch {
        Stop-PackagedConnect 'spawn-failed'
      }
    } finally {
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_PARENT', $previousParent, 'Process')
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_LEAF', $previousLeaf, 'Process')
    }
    Set-FailurePhase 'application-runtime'
    try {
      if (!$process.WaitForExit($applicationTimeoutMilliseconds)) {
        Stop-SpawnedProcess $process
        Stop-PackagedConnect 'spawn-failed'
      }
    } catch {
      try { Stop-SpawnedProcess $process } catch {}
      if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
      Stop-PackagedConnect 'spawn-failed'
    }
    if ($process.ExitCode -ne 0) {
      Set-FailurePhase 'capture-parse'
      try {
        $failureCapture = Get-CanonicalItem $stderr 'file'
        if ($failureCapture.Length -lt 1 -or $failureCapture.Length -gt 65536) {
          Stop-PackagedConnect 'spawn-failed'
        }
        $failureLines = @([IO.File]::ReadAllLines($stderr) | Where-Object { $_.Length -gt 0 })
        if ($failureLines.Count -lt 1 -or $failureLines.Count -gt 4) {
          Stop-PackagedConnect 'spawn-failed'
        }
        $reportedCategories = @()
        foreach ($line in $failureLines) {
          $record = ConvertFrom-Json -InputObject $line -ErrorAction Stop
          if ($record.event -ceq 'packaged_connect.artifact_failed' -and
              $failureCategories -ccontains $record.category -and
              $failurePhases -ccontains $record.phase) {
            if ($record.phase -ceq 'ordinary-user-preflight') {
              if ($childFailureSubphases -cnotcontains $record.subphase) {
                Stop-PackagedConnect 'artifact-type'
              }
              Set-OrdinaryUserPreflightSubphase $record.subphase
            } elseif ($null -ne $record.subphase) {
              Stop-PackagedConnect 'artifact-type'
            }
            $reportedCategories += $record.category
            if ($record.phase -cne 'ordinary-user-preflight') {
              Set-FailurePhase $record.phase
            }
          } elseif ($record.event -cne 'packaged_connect.child_failed') {
            Stop-PackagedConnect 'artifact-type'
          }
        }
        if ($reportedCategories.Count -ne 1) { Stop-PackagedConnect 'artifact-type' }
        Stop-PackagedConnect $reportedCategories[0]
      } catch {
        if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
        Stop-PackagedConnect 'artifact-type'
      }
    }
    Set-FailurePhase 'result-verify'
    foreach ($capture in @($stdout, $stderr)) {
      $captureItem = Get-CanonicalItem $capture 'file'
      if ($captureItem.Length -gt 65536) { Stop-PackagedConnect 'spawn-failed' }
    }
    $capturedStdout = [IO.File]::ReadAllText($stdout)
    $capturedStderr = [IO.File]::ReadAllText($stderr)
    $expectedSuccess = "Packaged Connect discovery passed for win32-$Architecture`: inherited-standard-handle."
    if ($capturedStderr.Length -ne 0 -or $capturedStdout.TrimEnd("`r", "`n") -cne $expectedSuccess) {
      Stop-PackagedConnect 'spawn-failed'
    }
  } catch {
    Set-PrimaryFailureFromException $_.Exception
  }
} finally {
  if ($null -ne $launcherAuthority) {
    try { $launcherAuthority.Handle.Dispose() } catch {}
    $launcherAuthority = $null
  }
  if ($null -ne $authenticatedRunnerTemp -and $null -ne $privilegedSid) {
    $cleanupResult = Invoke-BoundedCleanup
    if ($cleanupResult -eq 'timeout') {
      $cleanupSecondary = 'cleanup-timeout'
    } elseif ($cleanupResult -ne 'none') {
      $cleanupSecondary = 'cleanup-failed'
    }
  }
}
}

if ($null -eq $primaryFailure -and $cleanupSecondary -ne 'none') {
  $primaryFailure = 'artifact-inaccessible'
  $primaryPhase = 'cleanup'
}
if ($null -ne $primaryFailure) {
  if ($failureCategories -cnotcontains $primaryFailure) { $primaryFailure = 'spawn-failed' }
  if ($failurePhases -cnotcontains $primaryPhase) { $primaryPhase = 'application-runtime' }
  $subphaseEvidence = ''
  if ($primaryPhase -ceq 'ordinary-user-preflight') {
    if ($failureSubphases -cnotcontains $primarySubphase) {
      $primarySubphase = 'host-state-contract'
    }
    $subphaseEvidence = ":subphase=$primarySubphase"
  }
  [Console]::Error.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=$primaryFailure`:phase=$primaryPhase$subphaseEvidence`:cleanup=$cleanupSecondary")
  exit 1
}
[Console]::Out.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:passed:$Architecture")
