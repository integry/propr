param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$WatchdogMarker,
  [Parameter(Mandatory=$true)][string]$OwnershipReadyEvent,
  [Parameter(Mandatory=$true)][string]$OwnershipManifest
)

enum SmokeEvidenceInspectionPhase {
  DIRECTORY
  ACL
  FILE_METADATA
  FILE_OPEN
  FILE_READ
  EVENT_PARSE
  SUMMARY
}

$ErrorActionPreference = 'Stop'
$bootstrapWatchdogTimeoutMilliseconds = 60 * 1000
$markerTransitionTimeoutMilliseconds = 30 * 1000
$ownershipHandshakeTimeoutMilliseconds = 5 * 1000
if ($OwnershipReadyEvent -notmatch '^Local\\ProPRInstalledApp-[a-f0-9]{32}$') {
  throw 'worker ownership event name is invalid'
}
$ownershipReady = [Threading.EventWaitHandle]::OpenExisting($OwnershipReadyEvent)
try {
  if (!$ownershipReady.WaitOne($ownershipHandshakeTimeoutMilliseconds)) {
    throw 'worker ownership was not established'
  }
} finally {
  $ownershipReady.Dispose()
}
$watchdogMarkerPath = [IO.Path]::GetFullPath($WatchdogMarker)
$watchdogMarkerParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ((Split-Path -Leaf $watchdogMarkerPath) -notmatch
      '^propr-installed-app-watchdog-[a-f0-9]{32}\.marker$' -or
    ![string]::Equals(
      (Split-Path -Parent $watchdogMarkerPath).TrimEnd('\'),
      $watchdogMarkerParent,
      [StringComparison]::OrdinalIgnoreCase
    )) {
  throw 'watchdog marker path is invalid'
}
$ownershipManifestPath = [IO.Path]::GetFullPath($OwnershipManifest)
if ((Split-Path -Leaf $ownershipManifestPath) -notmatch
      '^propr-installed-app-ownership-[a-f0-9]{32}\.json$' -or
    ![string]::Equals(
      (Split-Path -Parent $ownershipManifestPath).TrimEnd('\'),
      $watchdogMarkerParent,
      [StringComparison]::OrdinalIgnoreCase
    )) {
  throw 'ownership manifest path is invalid'
}
$bootstrapDeadline = [DateTime]::UtcNow.AddMilliseconds($bootstrapWatchdogTimeoutMilliseconds).Ticks
$bootstrapRecord = '{0}|INITIALIZATION|PATHS|BEGIN' -f $bootstrapDeadline
$bootstrapBytes = [Text.Encoding]::ASCII.GetBytes($bootstrapRecord)
$bootstrapStream = [IO.FileStream]::new(
  $watchdogMarkerPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::Write,
  [IO.FileShare]::Read,
  4096,
  [IO.FileOptions]::WriteThrough
)
try {
  $bootstrapStream.Write($bootstrapBytes, 0, $bootstrapBytes.Length)
  $bootstrapStream.Flush($true)
} finally {
  $bootstrapStream.Dispose()
}
Write-Host 'PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:INITIALIZATION:PATHS:BEGIN'
[Console]::Out.Flush()

$primaryFailure = $null
try {
  $installerPath = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
} catch {
  throw 'installer resolution failed'
}
$installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
$application = Join-Path $installRoot 'propr-desktop.exe'
$protocolRegistryPath = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr'
$appPathsRegistryPath = `
  'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\propr-desktop.exe'
$testUser = "propr-ci-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$passwordText = "P!$([Guid]::NewGuid().ToString('N'))a7"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$passwordText = $null
$credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$testUser", $password)
$installAttempted = $false
$testUserCreatedByRun = $false
$testUserSid = $null
$smokeUserDataDirectory = $null
$installRootExistedBeforeInstall = $false
$protocolExistedBeforeInstall = $false
$appPathsExistedBeforeInstall = $false
$installRootCreatedByRun = $false
$protocolCreatedByRun = $false
$appPathsCreatedByRun = $false
$protocolOwnedIdentity = $null
$appPathsOwnedIdentity = $null
$msiTimeoutMilliseconds = 10 * 60 * 1000
$applicationTimeoutMilliseconds = 5 * 60 * 1000
$terminationTimeoutMilliseconds = 30 * 1000
$redirectedStreamDrainTimeoutMilliseconds = 30 * 1000
$externalOperationTimeoutMilliseconds = 60 * 1000
$recursiveOperationTimeoutMilliseconds = 90 * 1000
$alternateUserLaunchTimeoutMilliseconds = 90 * 1000
$smokeEvidenceFileByteCap = 64 * 1024
$smokeEvidenceOpenRetryDeadlineMilliseconds = 2 * 1000
$smokeEvidenceOpenRetryDelayMilliseconds = 50
$smokeEventCodes = [ordered]@{
  'desktop.smoke.authorized' = 'SMOKE_AUTHORIZED'
  'desktop.app.ready' = 'APP_READY'
  'desktop.renderer.mvp_flows.ready' = 'MVP_FLOWS_READY'
  'desktop.renderer.layout.ready' = 'LAYOUT_READY'
  'desktop.native.reduced_window.ready' = 'REDUCED_NATIVE_WINDOW_READY'
  'desktop.renderer.ready' = 'RENDERER_READY'
  'desktop.app.shutdown' = 'APP_SHUTDOWN'
  'desktop.app.start_failed' = 'START_FAILED'
  'desktop.main_process.uncaught_exception' = 'UNCAUGHT_EXCEPTION'
  'desktop.log.write_failed' = 'LOG_WRITE_FAILURE'
}
$requiredSmokeEvents = @(
  'desktop.smoke.authorized',
  'desktop.app.ready',
  'desktop.renderer.mvp_flows.ready',
  'desktop.renderer.layout.ready',
  'desktop.native.reduced_window.ready',
  'desktop.renderer.ready',
  'desktop.app.shutdown'
)
$smokeEvidenceFileNames = @(
  'application.smoke-evidence.jsonl',
  'application.stdout.log',
  'application.stderr.log'
)
$machineTempValue = [Environment]::GetEnvironmentVariable('TEMP', [EnvironmentVariableTarget]::Machine)
if (!$machineTempValue) { throw 'machine temporary directory is unavailable' }
$machineTemp = [Environment]::ExpandEnvironmentVariables($machineTempValue)
if (![IO.Path]::IsPathRooted($machineTemp)) { throw 'machine temporary directory is not absolute' }
$machineTemp = (Resolve-Path -LiteralPath $machineTemp).Path
$windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
if (!$windowsDirectory -or ![IO.Path]::IsPathRooted($windowsDirectory)) {
  throw 'Windows directory is unavailable'
}
$windowsDirectory = (Resolve-Path -LiteralPath $windowsDirectory -ErrorAction Stop).Path
$windowsDirectoryItem = Get-Item -LiteralPath $windowsDirectory -Force -ErrorAction Stop
if (!$windowsDirectoryItem.PSIsContainer -or
    ($windowsDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Windows directory is invalid'
}
$commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
if (!$commonPrograms -or ![IO.Path]::IsPathRooted($commonPrograms)) {
  throw 'common Start Menu directory is unavailable'
}
$commonPrograms = (Resolve-Path -LiteralPath $commonPrograms -ErrorAction Stop).Path
$startMenuShortcutFolder = Join-Path $commonPrograms 'ProPR Desktop'
$startMenuShortcut = Join-Path $startMenuShortcutFolder 'ProPR Desktop.lnk'
$installRootExistedBeforeInstall = Test-Path -LiteralPath $installRoot
$protocolExistedBeforeInstall =
  Test-Path -LiteralPath $protocolRegistryPath
$appPathsExistedBeforeInstall = Test-Path -LiteralPath $appPathsRegistryPath
$startMenuShortcutExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcut
$startMenuShortcutFolderExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcutFolder
$startMenuShortcutCreatedByRun = $false
$startMenuShortcutFolderCreatedByRun = $false
$shortcutFileByteCap = 64 * 1024
$ownershipRunId = [IO.Path]::GetFileNameWithoutExtension($ownershipManifestPath).Substring(
  'propr-installed-app-ownership-'.Length)
$initialManifestItem = Get-Item -LiteralPath $ownershipManifestPath -Force -ErrorAction Stop
if (($initialManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $initialManifestItem.Length -le 0 -or $initialManifestItem.Length -gt 65536) {
  throw 'initial ownership manifest metadata is invalid'
}
$initialManifestBytes = [byte[]]::new([int]$initialManifestItem.Length)
$initialManifestStream = [IO.File]::Open(
  $ownershipManifestPath,
  [IO.FileMode]::Open,
  [IO.FileAccess]::Read,
  [IO.FileShare]::Read
)
try {
  $initialManifestOffset = 0
  while ($initialManifestOffset -lt $initialManifestBytes.Length) {
    $read = $initialManifestStream.Read(
      $initialManifestBytes,
      $initialManifestOffset,
      $initialManifestBytes.Length - $initialManifestOffset
    )
    if ($read -eq 0) { throw 'initial ownership manifest read was incomplete' }
    $initialManifestOffset += $read
  }
  if ($initialManifestStream.ReadByte() -ne -1) {
    throw 'initial ownership manifest changed during read'
  }
} finally {
  $initialManifestStream.Dispose()
}
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$initialOwnershipState = ConvertFrom-Json `
  -InputObject $strictUtf8.GetString($initialManifestBytes) -ErrorAction Stop
if ($initialOwnershipState.SchemaVersion -ne 1 -or
    [string]$initialOwnershipState.RunId -cne $ownershipRunId -or
    ![string]::Equals(
      [IO.Path]::GetFullPath([string]$initialOwnershipState.InstallerPath),
      $installerPath,
      [StringComparison]::OrdinalIgnoreCase
    )) {
  throw 'initial ownership manifest identity is invalid'
}
$ownershipToken = [Guid]::NewGuid().ToString('N')
$ownershipState = [ordered]@{
  SchemaVersion = 1
  RunId = $ownershipRunId
  CreatedUtcTicks = [int64]$initialOwnershipState.CreatedUtcTicks
  ExpiresUtcTicks = [int64]$initialOwnershipState.ExpiresUtcTicks
  InstallerPath = $installerPath
  Fixture = $false
  FixtureRoot = $null
  BaselineClean = $false
  InstallAttempted = $false
  Directories = @()
  Files = @()
  RegistryKeys = @()
  Users = @()
  Profiles = @()
}

function Write-OwnershipManifest {
  $temporaryManifest = "$ownershipManifestPath.new"
  $bytes = [Text.Encoding]::UTF8.GetBytes(
    ($ownershipState | ConvertTo-Json -Depth 6 -Compress))
  $stream = [IO.FileStream]::new(
    $temporaryManifest,
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
  [IO.File]::Move($temporaryManifest, $ownershipManifestPath, $true)
}

function Write-DurableOwnershipToken([string]$Path, [string]$Token) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($Token)
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

function Get-RegistryTreeIdentity([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  $root = Get-Item -LiteralPath $Path -ErrorAction Stop
  $records = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Queue[object]]::new()
  $pending.Enqueue([PSCustomObject]@{ Key = $root; Relative = '' })
  while ($pending.Count -ne 0) {
    $entry = $pending.Dequeue()
    $records.Add(('K|{0}' -f [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes([string]$entry.Relative))))
    foreach ($valueName in @($entry.Key.GetValueNames() | Sort-Object -CaseSensitive)) {
      $value = $entry.Key.GetValue(
        $valueName,
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      $valueBytes = if ($value -is [byte[]]) {
        $value
      } elseif ($value -is [string[]]) {
        [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
      } else {
        [Text.Encoding]::UTF8.GetBytes([Convert]::ToString(
          $value,
          [Globalization.CultureInfo]::InvariantCulture
        ))
      }
      $records.Add(('V|{0}|{1}|{2}' -f
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$valueName)),
        $entry.Key.GetValueKind($valueName).ToString(),
        [Convert]::ToBase64String($valueBytes)))
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $entry.Key.PSPath -ErrorAction Stop |
        Sort-Object -Property PSChildName -CaseSensitive)) {
      $relative = if ($entry.Relative) {
        '{0}\{1}' -f $entry.Relative, $child.PSChildName
      } else { [string]$child.PSChildName }
      $pending.Enqueue([PSCustomObject]@{ Key = $child; Relative = $relative })
    }
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($payload)).Replace('-', '').ToLowerInvariant()
  }
  finally { $sha256.Dispose() }
}

Write-OwnershipManifest

function Write-WatchdogMarker(
  [ValidateSet('INITIALIZATION','INSTALL','VALIDATION','USER_SETUP','APP_LAUNCH','APP_EXIT','UNINSTALL','CLEANUP')]
    [string]$Stage,
  [ValidateSet(
    'PATHS',
    'BASELINE',
    'MSI_INSTALL',
    'OWNERSHIP_CAPTURE',
    'INSTALL_TREE_SCAN',
    'APPLICATION_IMAGE',
    'PROTOCOL_ASSERTION',
    'APP_PATH_ASSERTION',
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
    'SHORTCUT_FALLBACK'
  )][string]$Substage,
  [int]$TimeoutMilliseconds,
  [ValidateSet('BEGIN','COMPLETE','FAILED')][string]$Status
) {
  $deadline = if ($Status -eq 'BEGIN') {
    [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds).Ticks
  } else {
    [DateTime]::UtcNow.AddMilliseconds($markerTransitionTimeoutMilliseconds).Ticks
  }
  $record = '{0}|{1}|{2}|{3}' -f $deadline, $Stage, $Substage, $Status
  $temporaryMarker = "$watchdogMarkerPath.$PID.new"
  $bytes = [Text.Encoding]::ASCII.GetBytes($record)
  $stream = $null
  try {
    $stream = [IO.FileStream]::new(
      $temporaryMarker,
      [IO.FileMode]::Create,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  [IO.File]::Move($temporaryMarker, $watchdogMarkerPath, $true)
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:{0}:{1}:{2}' -f `
    $Stage, $Substage, $Status)
  [Console]::Out.Flush()
}

function Invoke-BoundedExternalOperation(
  [string]$Stage,
  [string]$Substage,
  [int]$TimeoutMilliseconds,
  [scriptblock]$Operation
) {
  Write-WatchdogMarker $Stage $Substage $TimeoutMilliseconds 'BEGIN'
  try {
    $result = & $Operation
    Write-WatchdogMarker $Stage $Substage $TimeoutMilliseconds 'COMPLETE'
    return $result
  } catch {
    Write-WatchdogMarker $Stage $Substage $TimeoutMilliseconds 'FAILED'
    throw
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProPRWindowsLogon
{
    public const int LOGON32_LOGON_NETWORK = 3;
    public const int LOGON32_PROVIDER_DEFAULT = 0;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true,
        ExactSpelling = true, EntryPoint = "LogonUserW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool LogonUserW(
        string userName,
        string domain,
        IntPtr password,
        int logonType,
        int logonProvider,
        out SafeAccessTokenHandle token);
}
'@

Write-WatchdogMarker 'INITIALIZATION' 'PATHS' $bootstrapWatchdogTimeoutMilliseconds 'COMPLETE'
Write-WatchdogMarker 'INITIALIZATION' 'BASELINE' $externalOperationTimeoutMilliseconds 'BEGIN'
try {
  if ($installRootExistedBeforeInstall -or $protocolExistedBeforeInstall -or
      $appPathsExistedBeforeInstall -or
      $startMenuShortcutExistedBeforeInstall -or $startMenuShortcutFolderExistedBeforeInstall) {
    throw 'installed-app harness requires an unowned clean machine baseline'
  }
  $ownershipState.BaselineClean = $true
  Write-OwnershipManifest
  Write-WatchdogMarker 'INITIALIZATION' 'BASELINE' $externalOperationTimeoutMilliseconds 'COMPLETE'
} catch {
  Write-WatchdogMarker 'INITIALIZATION' 'BASELINE' $externalOperationTimeoutMilliseconds 'FAILED'
  throw
}

function Write-Stage(
  [ValidateSet('INSTALL','VALIDATION','USER_SETUP','APP_LAUNCH','APP_EXIT','UNINSTALL','CLEANUP')][string]$Stage,
  [ValidateSet('BEGIN','COMPLETE','FAILED')][string]$Status
) {
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:{0}:{1}' -f $Stage, $Status)
  [Console]::Out.Flush()
}

function Write-CleanupSubstage(
  [ValidateSet('UNINSTALL','CLEANUP')][string]$Scope,
  [ValidateSet(
    'MSI_UNINSTALL',
    'INSTALL_TREE',
    'PROTOCOL',
    'APP_PATH',
    'SHORTCUT_FILE',
    'SHORTCUT_FOLDER',
    'ORDINARY_USER_ABSENCE_PROBE',
    'SMOKE_DATA',
    'PROFILE',
    'USER',
    'INSTALL_ROOT_FALLBACK',
    'PROTOCOL_FALLBACK',
    'APP_PATH_FALLBACK',
    'SHORTCUT_FALLBACK',
    'FINAL_AGGREGATION'
  )][string]$Substage,
  [ValidateSet('BEGIN','COMPLETE','FAILED','SKIPPED')][string]$Status
) {
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:{0}:{1}:{2}' -f $Scope, $Substage, $Status)
  [Console]::Out.Flush()
}

function Stop-SpawnedProcessTree(
  [Diagnostics.Process]$Process,
  [string]$Operation
) {
  try {
    if (!$Process.HasExited) {
      $Process.Kill($true)
      if (!$Process.WaitForExit($terminationTimeoutMilliseconds)) {
        throw 'termination timeout'
      }
    }
  } catch {
    throw "$Operation process-tree termination failed"
  }
}

function Start-DirectProcess([hashtable]$StartParameters, [string]$Operation) {
  try {
    return Start-Process @StartParameters -PassThru -ErrorAction Stop
  } catch {
    throw "$Operation could not start"
  }
}

function Start-AlternateCredentialApplication(
  [string]$FilePath,
  [string[]]$Arguments,
  [Management.Automation.PSCredential]$Credential,
  [string]$Domain,
  [string]$UserName,
  [string]$WorkingDirectory,
  [string]$SmokeDirectory,
  [string]$WindowsDirectory,
  [string]$StandardOutputPath,
  [string]$StandardErrorPath,
  [string]$Operation
) {
  $process = $null
  $standardOutputStream = $null
  $standardErrorStream = $null
  $standardOutputCopy = $null
  $standardErrorCopy = $null
  $started = $false
  try {
    if (![IO.Path]::IsPathRooted($FilePath) -or ![IO.Path]::IsPathRooted($WorkingDirectory)) {
      throw 'alternate-credential application launch requires absolute paths'
    }

    $fullSmokeDirectory = [IO.Path]::GetFullPath($SmokeDirectory)
    if ((Split-Path -Leaf $fullSmokeDirectory) -notmatch '^propr-desktop-smoke-[a-f0-9]{32}$' -or
        ![string]::Equals(
          (Split-Path -Parent $fullSmokeDirectory),
          $machineTemp,
          [StringComparison]::OrdinalIgnoreCase
        )) {
      throw 'alternate-credential application launch requires the verified smoke directory'
    }
    $smokeDirectoryItem = Get-Item -LiteralPath $fullSmokeDirectory -Force -ErrorAction Stop
    if (!$smokeDirectoryItem.PSIsContainer -or
        ($smokeDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'alternate-credential application launch requires the verified smoke directory'
    }
    $smokeDirectoryAcl = Get-Acl -LiteralPath $fullSmokeDirectory
    $smokeDirectoryRules = @($smokeDirectoryAcl.Access)
    $smokeDirectorySids = @($smokeDirectoryRules | ForEach-Object {
      ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
    }) | Sort-Object -Unique
    if (!$smokeDirectoryAcl.AreAccessRulesProtected -or $smokeDirectoryRules.Count -ne 3) {
      throw 'alternate-credential application launch requires the verified smoke directory'
    }

    $profileDirectory = Join-Path $fullSmokeDirectory 'profile'
    $appDataDirectory = Join-Path $profileDirectory 'AppData'
    $roamingAppDataDirectory = Join-Path $appDataDirectory 'Roaming'
    $localAppDataDirectory = Join-Path $appDataDirectory 'Local'
    $temporaryDirectory = Join-Path $fullSmokeDirectory 'temp'
    foreach ($directory in @(
      $profileDirectory,
      $appDataDirectory,
      $roamingAppDataDirectory,
      $localAppDataDirectory,
      $temporaryDirectory
    )) {
      New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
      $directoryItem = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
      if (!$directoryItem.PSIsContainer -or
          ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'alternate-credential child profile layout is invalid'
      }
      $directoryAcl = Get-Acl -LiteralPath $directory
      $directoryRules = @($directoryAcl.Access)
      $directorySids = @($directoryRules | ForEach-Object {
        ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
      }) | Sort-Object -Unique
      $invalidDirectoryRules = @($directoryRules | Where-Object {
        !$_.IsInherited -or
        $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
          [Security.AccessControl.FileSystemRights]::FullControl
      })
      if ($directoryAcl.AreAccessRulesProtected -or $directoryRules.Count -ne 3 -or
          $invalidDirectoryRules.Count -ne 0 -or
          (Compare-Object $smokeDirectorySids $directorySids)) {
        throw 'alternate-credential child profile ACL is not inherited from the smoke directory'
      }
    }

    # This is the complete child environment. Never add parent/CI variables here.
    $childEnvironment = [ordered]@{
      'APPDATA' = $roamingAppDataDirectory
      'LOCALAPPDATA' = $localAppDataDirectory
      'PROPR_DESKTOP_SMOKE_TEST' = '1'
      'SystemRoot' = $WindowsDirectory
      'TEMP' = $temporaryDirectory
      'TMP' = $temporaryDirectory
      'USERPROFILE' = $profileDirectory
    }

    $standardOutputStream = [IO.FileStream]::new(
      $StandardOutputPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::Read,
      4096,
      [IO.FileOptions]::Asynchronous
    )
    $standardErrorStream = [IO.FileStream]::new(
      $StandardErrorPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::Read,
      4096,
      [IO.FileOptions]::Asynchronous
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.Environment.Clear()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UserName = $UserName
    $startInfo.Domain = $Domain
    $startInfo.Password = $Credential.Password
    $startInfo.LoadUserProfile = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
      $startInfo.ArgumentList.Add($argument)
    }
    foreach ($entry in $childEnvironment.GetEnumerator()) {
      $startInfo.Environment.Add([string]$entry.Key, [string]$entry.Value)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (!$process.Start()) { throw 'alternate-credential application process did not start' }
    $started = $true
    $standardOutputCopy = $process.StandardOutput.BaseStream.CopyToAsync($standardOutputStream)
    $standardErrorCopy = $process.StandardError.BaseStream.CopyToAsync($standardErrorStream)
    return [PSCustomObject]@{
      Process = $process
      StandardOutputStream = $standardOutputStream
      StandardErrorStream = $standardErrorStream
      StandardOutputCopy = $standardOutputCopy
      StandardErrorCopy = $standardErrorCopy
    }
  } catch {
    if ($started -and $null -ne $process) {
      try { Stop-SpawnedProcessTree $process $Operation } catch {}
    }
    foreach ($stream in @($standardOutputStream, $standardErrorStream)) {
      if ($null -ne $stream) { $stream.Dispose() }
    }
    foreach ($task in @($standardOutputCopy, $standardErrorCopy)) {
      if ($null -ne $task -and $task.IsCompleted) { $task.Dispose() }
    }
    if ($null -ne $process) { $process.Dispose() }
    throw "$Operation could not start"
  }
}

function Close-RedirectedApplicationStreams([PSCustomObject]$Launch, [string]$Operation) {
  $streamFailure = $false
  try {
    $copyTasks = [Threading.Tasks.Task[]]@($Launch.StandardOutputCopy, $Launch.StandardErrorCopy)
    if (![Threading.Tasks.Task]::WaitAll($copyTasks, $redirectedStreamDrainTimeoutMilliseconds)) {
      $streamFailure = $true
    } elseif (@($copyTasks | Where-Object { $_.IsCanceled -or $_.IsFaulted }).Count -ne 0) {
      $streamFailure = $true
    }
  } catch {
    $streamFailure = $true
  } finally {
    $Launch.StandardOutputStream.Dispose()
    $Launch.StandardErrorStream.Dispose()
    foreach ($task in @($Launch.StandardOutputCopy, $Launch.StandardErrorCopy)) {
      if ($task.IsCompleted) { $task.Dispose() }
    }
  }
  if ($streamFailure) { throw "$Operation redirected-stream drain failed" }
}

function Wait-BoundedProcess(
  [Diagnostics.Process]$Process,
  [int]$TimeoutMilliseconds,
  [int[]]$AllowedExitCodes,
  [string]$Operation
) {
  try {
    try {
      $completed = $Process.WaitForExit($TimeoutMilliseconds)
    } catch {
      Stop-SpawnedProcessTree $Process $Operation
      throw "$Operation bounded wait failed"
    }
    if (!$completed) {
      Stop-SpawnedProcessTree $Process $Operation
      throw "$Operation timed out"
    }

    try {
      $exitCode = $Process.ExitCode
    } catch {
      Stop-SpawnedProcessTree $Process $Operation
      throw "$Operation exit status is unavailable"
    }
    if ($exitCode -notin $AllowedExitCodes) {
      Stop-SpawnedProcessTree $Process $Operation
      throw "$Operation exited $exitCode"
    }
    return $exitCode
  } catch {
    if (!$Process.HasExited) { Stop-SpawnedProcessTree $Process $Operation }
    throw
  }
}

function Invoke-BoundedProcess(
  [hashtable]$StartParameters,
  [int]$TimeoutMilliseconds,
  [int[]]$AllowedExitCodes,
  [string]$Operation
) {
  $process = Start-DirectProcess $StartParameters $Operation
  try {
    return Wait-BoundedProcess $process $TimeoutMilliseconds $AllowedExitCodes $Operation
  } finally {
    $process.Dispose()
  }
}

function Invoke-Msi([string[]]$Arguments, [string]$Operation) {
  [void](Invoke-BoundedProcess `
    -StartParameters @{ FilePath = 'msiexec.exe'; ArgumentList = $Arguments } `
    -TimeoutMilliseconds $msiTimeoutMilliseconds `
    -AllowedExitCodes @(0,3010) `
    -Operation $Operation)
}

function Test-StartMenuShortcutAsOrdinaryUser(
  [Management.Automation.PSCredential]$Credential,
  [string]$Domain,
  [string]$UserName,
  [Security.Principal.SecurityIdentifier]$UserSid,
  [string]$ShortcutPath,
  [bool]$ExpectedPresent
) {
  $expectation = if ($ExpectedPresent) { 'PRESENT' } else { 'ABSENT' }
  $failureCategory = $null
  $passwordBuffer = [IntPtr]::Zero
  [Microsoft.Win32.SafeHandles.SafeAccessTokenHandle]$token = $null
  try {
    $passwordBuffer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode(
      $Credential.Password
    )
    if (![ProPRWindowsLogon]::LogonUserW(
      $UserName,
      $Domain,
      $passwordBuffer,
      [ProPRWindowsLogon]::LOGON32_LOGON_NETWORK,
      [ProPRWindowsLogon]::LOGON32_PROVIDER_DEFAULT,
      [ref]$token
    )) {
      $failureCategory = 'LOGON_FAILED'
    } else {
      [Security.Principal.WindowsIdentity]::RunImpersonated($token, [Action]{
        $identity = $null
        $stream = $null
        try {
          $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
          if ($null -eq $identity.User -or !$identity.User.Equals($UserSid)) {
            throw 'ordinary-user shortcut identity mismatch'
          }
          if ([string]::IsNullOrWhiteSpace($ShortcutPath) -or
              ![IO.Path]::IsPathRooted($ShortcutPath)) {
            throw 'ordinary-user shortcut path is invalid'
          }

          $present = Test-Path -LiteralPath $ShortcutPath -ErrorAction Stop
          if (!$ExpectedPresent -and !$present) { return }
          if ($present -ne $ExpectedPresent) {
            throw 'ordinary-user shortcut presence mismatch'
          }

          $item = Get-Item -LiteralPath $ShortcutPath -Force -ErrorAction Stop
          if (!($item -is [IO.FileInfo]) -or
              ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
              $item.Length -le 0 -or $item.Length -gt $shortcutFileByteCap) {
            throw 'ordinary-user shortcut metadata is invalid'
          }
          $stream = [IO.File]::Open(
            $ShortcutPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite
          )
          if ($stream.Length -le 0 -or $stream.Length -gt $shortcutFileByteCap -or
              $stream.ReadByte() -lt 0) {
            throw 'ordinary-user shortcut read failed'
          }
        } finally {
          if ($null -ne $stream) { $stream.Dispose() }
          if ($null -ne $identity) { $identity.Dispose() }
        }
      })
    }
  } catch {
    if ($null -eq $failureCategory) { $failureCategory = 'ACCESS_CHECK_FAILED' }
  } finally {
    if ($passwordBuffer -ne [IntPtr]::Zero) {
      try {
        [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($passwordBuffer)
      } catch {
        if ($null -eq $failureCategory) { $failureCategory = 'CLEANUP_FAILED' }
      }
    }
    if ($null -ne $token) {
      try { $token.Dispose() } catch {
        if ($null -eq $failureCategory) { $failureCategory = 'CLEANUP_FAILED' }
      }
    }
  }

  if ($null -eq $failureCategory) {
    Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:{0}:SUCCESS' -f $expectation)
    return
  }
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:{0}:{1}' -f $expectation, $failureCategory)
  throw 'ordinary-user shortcut probe failed'
}

function New-SmokeUserDataDirectory(
  [Security.Principal.SecurityIdentifier]$UserSid,
  [string]$Path
) {
  $path = [IO.Path]::GetFullPath($Path)
  if ((Split-Path -Leaf $path) -notmatch '^propr-desktop-smoke-[a-f0-9]{32}$' -or
      ![string]::Equals(
        (Split-Path -Parent $path), $machineTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'smoke user-data directory path is invalid'
  }
  $createdByRun = $false
  try {
    if (Test-Path -LiteralPath $path) {
      throw 'refusing to replace a pre-existing smoke user-data directory'
    }
    New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    $createdByRun = $true
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($administratorsSid)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @($UserSid, $systemSid, $administratorsSid)) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        $propagation,
        [Security.AccessControl.AccessControlType]::Allow
      )
      $acl.AddAccessRule($rule) | Out-Null
    }
    Set-Acl -LiteralPath $path -AclObject $acl

    $expectedSids = @($UserSid.Value, $systemSid.Value, $administratorsSid.Value) | Sort-Object -Unique
    $appliedAcl = Get-Acl -LiteralPath $path
    $actualRules = @($appliedAcl.Access)
    $actualSids = @($actualRules | ForEach-Object {
      ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
    }) | Sort-Object -Unique
    $invalidRules = @($actualRules | Where-Object {
      $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
        [Security.AccessControl.FileSystemRights]::FullControl
    })
    if (!$appliedAcl.AreAccessRulesProtected -or $actualRules.Count -ne 3 -or
        $invalidRules.Count -ne 0 -or (Compare-Object $expectedSids $actualSids)) {
      throw 'smoke user-data directory ACL is not restricted to the test user, SYSTEM, and Administrators'
    }
    return $path
  } catch {
    if ($createdByRun) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
  }
}

function Remove-SmokeUserDataDirectory([string]$Path) {
  if (!$Path) { return }
  $fullPath = [IO.Path]::GetFullPath($Path)
  if ((Split-Path -Leaf $fullPath) -notmatch '^propr-desktop-smoke-[a-f0-9]{32}$' -or
      ![string]::Equals((Split-Path -Parent $fullPath), $machineTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'refusing to clean a directory outside the bounded smoke user-data scope'
  }
  if (Test-Path -LiteralPath $fullPath) {
    $ownedDirectory = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (!$ownedDirectory.PSIsContainer -or
        ($ownedDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'refusing to clean an invalid smoke user-data directory'
    }
  }
  for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
    if (!(Test-Path -LiteralPath $fullPath)) { return }
    try {
      Remove-Item -LiteralPath $fullPath -Recurse -Force
    } catch {
      if ($attempt -eq 2) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
  if (Test-Path -LiteralPath $fullPath) { throw 'smoke user-data directory cleanup did not complete' }
}

function Get-SmokeEventEvidence(
  [string]$Path,
  [Security.Principal.SecurityIdentifier]$UserSid
) {
  [SmokeEvidenceInspectionPhase]$inspectionPhase = [SmokeEvidenceInspectionPhase]::DIRECTORY
  try {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ((Split-Path -Leaf $fullPath) -notmatch '^propr-desktop-smoke-[a-f0-9]{32}$' -or
        ![string]::Equals((Split-Path -Parent $fullPath), $machineTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'invalid smoke evidence directory'
    }
    $directory = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (!$directory.PSIsContainer -or
        ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'invalid smoke evidence directory'
    }

    $inspectionPhase = [SmokeEvidenceInspectionPhase]::ACL
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $expectedSids = @($UserSid.Value, $systemSid.Value, $administratorsSid.Value) | Sort-Object -Unique
    $appliedAcl = Get-Acl -LiteralPath $fullPath
    $actualRules = @($appliedAcl.Access)
    $actualSids = @($actualRules | ForEach-Object {
      ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
    }) | Sort-Object -Unique
    $invalidRules = @($actualRules | Where-Object {
      $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
        [Security.AccessControl.FileSystemRights]::FullControl
    })
    if (!$appliedAcl.AreAccessRulesProtected -or $actualRules.Count -ne 3 -or
        $invalidRules.Count -ne 0 -or (Compare-Object $expectedSids $actualSids)) {
      throw 'invalid smoke evidence directory'
    }

    $events = @{}
    foreach ($eventName in $smokeEventCodes.Keys) { $events[$eventName] = $false }
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    foreach ($fileName in $smokeEvidenceFileNames) {
      $inspectionPhase = [SmokeEvidenceInspectionPhase]::FILE_METADATA
      $filePath = Join-Path $fullPath $fileName
      try {
        $item = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
      } catch [Management.Automation.ItemNotFoundException] {
        continue
      }
      if (!($item -is [IO.FileInfo]) -or $item.PSIsContainer -or
          ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'invalid smoke evidence file'
      }

      $bytesToRead = [Math]::Min([int64]$item.Length, [int64]$smokeEvidenceFileByteCap)
      $bytes = New-Object byte[] ([int]$bytesToRead)
      $inspectionPhase = [SmokeEvidenceInspectionPhase]::FILE_OPEN
      $stream = $null
      try {
        $openRetryStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $openAttempt = 0
        while ($null -eq $stream) {
          if ($openAttempt -gt 0 -and
              $openRetryStopwatch.ElapsedMilliseconds -ge $smokeEvidenceOpenRetryDeadlineMilliseconds) {
            throw 'smoke evidence file open retry deadline expired'
          }
          $openAttempt += 1
          try {
            $stream = [IO.FileStream]::new(
              [string]$filePath,
              [IO.FileMode]::Open,
              [IO.FileAccess]::Read,
              [IO.FileShare]::Read,
              4096,
              [IO.FileOptions]::SequentialScan
            )
          } catch [IO.IOException] {
            $nativeErrorCode = $_.Exception.HResult -band 0xffff
            if ($nativeErrorCode -notin @(32, 33) -or
                $openRetryStopwatch.ElapsedMilliseconds -ge $smokeEvidenceOpenRetryDeadlineMilliseconds) {
              throw
            }
            $remainingMilliseconds = $smokeEvidenceOpenRetryDeadlineMilliseconds -
              $openRetryStopwatch.ElapsedMilliseconds
            $retryDelayMilliseconds = [Math]::Min(
              $smokeEvidenceOpenRetryDelayMilliseconds,
              $remainingMilliseconds
            )
            if ($retryDelayMilliseconds -le 0) { throw }
            Start-Sleep -Milliseconds $retryDelayMilliseconds
          }
        }
        $openRetryStopwatch.Stop()
        $inspectionPhase = [SmokeEvidenceInspectionPhase]::FILE_READ
        $offset = 0
        while ($offset -lt $bytes.Length) {
          $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
          if ($read -eq 0) { break }
          $offset += $read
        }
      } finally {
        if ($null -ne $stream) { $stream.Dispose() }
      }
      $inspectionPhase = [SmokeEvidenceInspectionPhase]::EVENT_PARSE
      if ($offset -eq 0) { continue }

      try {
        $text = $strictUtf8.GetString($bytes, 0, $offset)
      } catch {
        continue
      }
      foreach ($line in ($text -split "`r?`n")) {
        try {
          $record = ConvertFrom-Json -InputObject $line -ErrorAction Stop
          if ($null -eq $record -or $record -isnot [PSCustomObject]) { continue }
          $eventProperty = $record.PSObject.Properties['event']
          if ($null -eq $eventProperty -or $eventProperty.Name -cne 'event' -or
              $eventProperty.Value -isnot [string]) {
            continue
          }
          if ($fileName -ceq 'application.smoke-evidence.jsonl' -and
              @($record.PSObject.Properties).Count -ne 1) {
            continue
          }
          $eventName = $eventProperty.Value
          if (!$smokeEventCodes.Contains($eventName)) { continue }
          $events[$eventName] = $true
        } catch {
          continue
        }
      }
    }

    $inspectionPhase = [SmokeEvidenceInspectionPhase]::SUMMARY
    $summary = @()
    foreach ($eventName in $smokeEventCodes.Keys) {
      $state = if ($events[$eventName]) { 'PRESENT' } else { 'ABSENT' }
      $summary += ('{0}={1}' -f $smokeEventCodes[$eventName], $state)
    }
    Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:EVIDENCE:{0}' -f ($summary -join ','))
    return $events
  } catch {
    Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:EVIDENCE_INSPECTION_FAILED:{0}' -f $inspectionPhase)
    throw 'smoke evidence inspection failed'
  }
}

try {
  Write-Stage 'INSTALL' 'BEGIN'
  try {
    $installAttempted = $true
    $ownershipState.InstallAttempted = $true
    # The clean baseline plus the durable install-attempt transition owns any
    # canonical product resource that appears before MSI returns or hangs.
    $ownershipState.Directories = @(
      [ordered]@{
        Kind = 'INSTALL_ROOT'; Path = $installRoot; Owned = $true; Token = $null
      },
      [ordered]@{
        Kind = 'SHORTCUT_FOLDER'; Path = $startMenuShortcutFolder
        Owned = $true; Token = $null
      }
    )
    $ownershipState.Files = @([ordered]@{
      Kind = 'SHORTCUT_FILE'; Path = $startMenuShortcut; Owned = $true; Token = $null
    })
    $ownershipState.RegistryKeys = @(
      [ordered]@{
        Kind = 'PROTOCOL'; Path = $protocolRegistryPath
        Owned = $true; Token = $null; Identity = $null; Provisional = $true
      },
      [ordered]@{
        Kind = 'APP_PATH'; Path = $appPathsRegistryPath
        Owned = $true; Token = $null; Identity = $null; Provisional = $true
      }
    )
    Write-OwnershipManifest
    try {
      Invoke-BoundedExternalOperation `
        -Stage 'INSTALL' `
        -Substage 'MSI_INSTALL' `
        -TimeoutMilliseconds ($msiTimeoutMilliseconds + $terminationTimeoutMilliseconds + 5000) `
        -Operation {
          Invoke-Msi @('/i', "`"$installerPath`"", '/qn', '/norestart') 'machine install'
        }
    } finally {
      Invoke-BoundedExternalOperation `
        -Stage 'INSTALL' `
        -Substage 'OWNERSHIP_CAPTURE' `
        -TimeoutMilliseconds $externalOperationTimeoutMilliseconds `
        -Operation {
          $script:installRootCreatedByRun =
            !$installRootExistedBeforeInstall -and (Test-Path -LiteralPath $installRoot)
          $script:protocolCreatedByRun =
            !$protocolExistedBeforeInstall -and
              (Test-Path -LiteralPath $protocolRegistryPath)
          $script:appPathsCreatedByRun =
            !$appPathsExistedBeforeInstall -and (Test-Path -LiteralPath $appPathsRegistryPath)
          $script:startMenuShortcutCreatedByRun =
            !$startMenuShortcutExistedBeforeInstall -and (Test-Path -LiteralPath $startMenuShortcut)
          $script:startMenuShortcutFolderCreatedByRun =
            !$startMenuShortcutFolderExistedBeforeInstall -and
              (Test-Path -LiteralPath $startMenuShortcutFolder)
          $ownedDirectories = @()
          if ($script:installRootCreatedByRun) {
            $ownedDirectories += [ordered]@{
              Kind = 'INSTALL_ROOT'; Path = $installRoot; Owned = $true; Token = $null
            }
          }
          if ($script:startMenuShortcutFolderCreatedByRun) {
            $ownedDirectories += [ordered]@{
              Kind = 'SHORTCUT_FOLDER'; Path = $startMenuShortcutFolder
              Owned = $true; Token = $null
            }
          }
          $ownershipState.Directories = $ownedDirectories
          $ownershipState.Files = if ($script:startMenuShortcutCreatedByRun) {
            @([ordered]@{
              Kind = 'SHORTCUT_FILE'; Path = $startMenuShortcut; Owned = $true; Token = $null
            })
          } else { @() }
          $ownedRegistryKeys = @()
          if ($script:protocolCreatedByRun) {
            $script:protocolOwnedIdentity = Get-RegistryTreeIdentity $protocolRegistryPath
            $ownedRegistryKeys += [ordered]@{
              Kind = 'PROTOCOL'; Path = $protocolRegistryPath
              Owned = $true; Token = $null; Identity = $script:protocolOwnedIdentity
              Provisional = $false
            }
          }
          if ($script:appPathsCreatedByRun) {
            $script:appPathsOwnedIdentity = Get-RegistryTreeIdentity $appPathsRegistryPath
            $ownedRegistryKeys += [ordered]@{
              Kind = 'APP_PATH'; Path = $appPathsRegistryPath
              Owned = $true; Token = $null; Identity = $script:appPathsOwnedIdentity
              Provisional = $false
            }
          }
          $ownershipState.RegistryKeys = $ownedRegistryKeys
          Write-OwnershipManifest
        }
    }
    Write-Stage 'INSTALL' 'COMPLETE'
  } catch {
    Write-Stage 'INSTALL' 'FAILED'
    throw
  }

  Write-Stage 'VALIDATION' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation 'VALIDATION' 'INSTALL_TREE_SCAN' `
      $recursiveOperationTimeoutMilliseconds {
        if (!(Test-Path -LiteralPath $application -PathType Leaf)) {
          throw 'machine installer did not install the canonical application'
        }
        $forbidden = @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force | Where-Object {
          $_.Name -match '^propr-windows-(authority|launcher|bootstrap)' -or
          $_.Name -in @('windows-authority', 'windows-update-authority')
        })
        if ($forbidden.Count -ne 0) {
          throw 'installed MVP contains a deferred Windows update authority resource'
        }
      }

    Invoke-BoundedExternalOperation 'VALIDATION' 'APPLICATION_IMAGE' `
      $externalOperationTimeoutMilliseconds {
        $image = New-Object byte[] 4096
        $stream = [IO.File]::OpenRead($application)
        try { $imageLength = $stream.Read($image, 0, $image.Length) } finally { $stream.Dispose() }
        $pe = if ($imageLength -ge 64) { [BitConverter]::ToUInt32($image, 0x3c) } else { 0 }
        $expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
        if ($imageLength -lt 512 -or [BitConverter]::ToUInt16($image, 0) -ne 0x5a4d -or
            $pe + 6 -gt $imageLength -or
            [Text.Encoding]::ASCII.GetString($image, [int]$pe, 4) -cne "PE`0`0" -or
            [BitConverter]::ToUInt16($image, [int]$pe + 4) -ne $expectedMachine) {
          throw 'installed application architecture does not match the matrix target'
        }
      }

    Invoke-BoundedExternalOperation 'VALIDATION' 'PROTOCOL_ASSERTION' `
      $externalOperationTimeoutMilliseconds {
        $protocolCommand = (Get-Item -LiteralPath `
          "$protocolRegistryPath\shell\open\command").GetValue('')
        if ($protocolCommand -cne "`"$application`" `"%1`"") {
          throw 'machine installer did not register canonical ProPR Connect protocol discovery'
        }
      }

    Invoke-BoundedExternalOperation 'VALIDATION' 'APP_PATH_ASSERTION' `
      $externalOperationTimeoutMilliseconds {
        $appPathApplication = (Get-Item -LiteralPath $appPathsRegistryPath).GetValue('')
        if ($appPathApplication -cne $application) {
          throw 'machine installer did not register canonical executable discovery'
        }
      }

    Invoke-BoundedExternalOperation 'VALIDATION' 'SHORTCUT_ASSERTION' `
      $externalOperationTimeoutMilliseconds {
        $shortcutItem = Get-Item -LiteralPath $startMenuShortcut -Force -ErrorAction Stop
        if (!($shortcutItem -is [IO.FileInfo]) -or
            ($shortcutItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $shortcutItem.Length -le 0) {
          throw 'machine installer did not create the common Start Menu shortcut'
        }
      }
    Write-Stage 'VALIDATION' 'COMPLETE'
  } catch {
    Write-Stage 'VALIDATION' 'FAILED'
    throw
  }

  Write-Stage 'USER_SETUP' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation 'USER_SETUP' 'USER_CREATE' `
      $externalOperationTimeoutMilliseconds {
        if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) {
          throw 'refusing to replace a pre-existing local user'
        }
        $provisionalUser = [ordered]@{
          Name = $testUser
          Sid = $null
          Owned = $true
          Provisional = $true
        }
        $ownershipState.Users = @($provisionalUser)
        Write-OwnershipManifest
        New-LocalUser -Name $testUser -Password $password `
          -AccountNeverExpires -PasswordNeverExpires | Out-Null
        $script:testUserCreatedByRun = $true
        $script:testUserSid = (Get-LocalUser -Name $testUser -ErrorAction Stop).SID
        $provisionalUser.Sid = $script:testUserSid.Value
        $provisionalUser.Provisional = $false
        Write-OwnershipManifest
      }
    $testUserSid = Invoke-BoundedExternalOperation 'USER_SETUP' 'USER_SID' `
      $externalOperationTimeoutMilliseconds {
        $script:testUserSid
      }
    $smokeUserDataCandidate = Join-Path `
      $machineTemp "propr-desktop-smoke-$([Guid]::NewGuid().ToString('N'))"
    if (Test-Path -LiteralPath $smokeUserDataCandidate) {
      throw 'refusing to replace a pre-existing smoke user-data directory'
    }
    $smokeOwnershipRecord = [ordered]@{
      Kind = 'SMOKE_DATA'; Path = $smokeUserDataCandidate
      Owned = $true; Token = $ownershipToken; Provisional = $true
    }
    $ownershipState.Directories = @($ownershipState.Directories) + @($smokeOwnershipRecord)
    Write-OwnershipManifest
    $smokeUserDataDirectory = Invoke-BoundedExternalOperation `
      'USER_SETUP' 'SMOKE_DATA_CREATE' $recursiveOperationTimeoutMilliseconds {
        $ownedSmokeDirectory = New-SmokeUserDataDirectory $testUserSid $smokeUserDataCandidate
        Write-DurableOwnershipToken `
          -Path (Join-Path $ownedSmokeDirectory '.propr-installed-app-owner') `
          -Token $ownershipToken
        $smokeOwnershipRecord.Provisional = $false
        Write-OwnershipManifest
        $ownedSmokeDirectory
      }
    Invoke-BoundedExternalOperation `
      'USER_SETUP' 'SHORTCUT_PRESENT_PROBE' $externalOperationTimeoutMilliseconds {
        Test-StartMenuShortcutAsOrdinaryUser `
          -Credential $credential `
          -Domain $env:COMPUTERNAME `
          -UserName $testUser `
          -UserSid $testUserSid `
          -ShortcutPath $startMenuShortcut `
          -ExpectedPresent $true
      }
    Write-Stage 'USER_SETUP' 'COMPLETE'
  } catch {
    Write-Stage 'USER_SETUP' 'FAILED'
    throw 'ordinary-user setup failed'
  }

  $arguments = @(
    '--disable-gpu',
    '--propr-smoke-test',
    "--user-data-dir=$smokeUserDataDirectory",
    'propr://connect?api=https%3A%2F%2Fconnect.propr.dev'
  )
  Write-Stage 'APP_LAUNCH' 'BEGIN'
  $applicationLaunch = $null
  try {
    $applicationLaunch = Invoke-BoundedExternalOperation `
      'APP_LAUNCH' 'ALTERNATE_USER_START' $alternateUserLaunchTimeoutMilliseconds {
        Start-AlternateCredentialApplication `
          -FilePath $application `
          -Arguments $arguments `
          -Credential $credential `
          -Domain $env:COMPUTERNAME `
          -UserName $testUser `
          -WorkingDirectory $env:ProgramFiles `
          -SmokeDirectory $smokeUserDataDirectory `
          -WindowsDirectory $windowsDirectory `
          -StandardOutputPath (Join-Path $smokeUserDataDirectory 'application.stdout.log') `
          -StandardErrorPath (Join-Path $smokeUserDataDirectory 'application.stderr.log') `
          -Operation 'ordinary-user installed application launch/render/profile smoke'
      }
    Write-Stage 'APP_LAUNCH' 'COMPLETE'
  } catch {
    Write-Stage 'APP_LAUNCH' 'FAILED'
    throw
  }
  Write-Stage 'APP_EXIT' 'BEGIN'
  try {
    $waitFailure = $null
    try {
      Invoke-BoundedExternalOperation `
        'APP_EXIT' 'APPLICATION_WAIT' `
        ($applicationTimeoutMilliseconds + $terminationTimeoutMilliseconds + 5000) {
          [void](Wait-BoundedProcess `
            -Process $applicationLaunch.Process `
            -TimeoutMilliseconds $applicationTimeoutMilliseconds `
            -AllowedExitCodes @(0) `
            -Operation 'ordinary-user installed application launch/render/profile smoke')
        }
    } catch {
      $waitFailure = $_
    } finally {
      try {
        Invoke-BoundedExternalOperation `
          'APP_EXIT' 'STREAM_DRAIN' ($redirectedStreamDrainTimeoutMilliseconds + 5000) {
            Close-RedirectedApplicationStreams $applicationLaunch `
              'ordinary-user installed application launch/render/profile smoke'
          }
      } catch {
        if ($null -eq $waitFailure) { $waitFailure = $_ }
      } finally {
        $applicationLaunch.Process.Dispose()
        $applicationLaunch = $null
      }
    }
    $smokeEvidence = Invoke-BoundedExternalOperation `
      'APP_EXIT' 'EVIDENCE_INSPECTION' $externalOperationTimeoutMilliseconds {
        Get-SmokeEventEvidence $smokeUserDataDirectory $testUserSid
      }
    if ($null -ne $waitFailure) { throw $waitFailure }
    if (@($requiredSmokeEvents | Where-Object { !$smokeEvidence[$_] }).Count -ne 0) {
      throw 'SMOKE_REQUIRED_EVENTS_MISSING'
    }
    Write-Stage 'APP_EXIT' 'COMPLETE'
  } catch {
    Write-Stage 'APP_EXIT' 'FAILED'
    throw
  } finally {
    if ($null -ne $applicationLaunch) {
      try {
        Invoke-BoundedExternalOperation `
          'APP_EXIT' 'STREAM_DRAIN' ($redirectedStreamDrainTimeoutMilliseconds + 5000) {
            Close-RedirectedApplicationStreams $applicationLaunch `
              'ordinary-user installed application launch/render/profile smoke'
          }
      } finally {
        $applicationLaunch.Process.Dispose()
      }
    }
  }
} catch {
  $primaryFailure = $_
  throw
} finally {
  $cleanupFailed = $false
  if ($installAttempted) {
    Write-Stage 'UNINSTALL' 'BEGIN'
    $uninstallFailed = $false

    Write-CleanupSubstage 'UNINSTALL' 'MSI_UNINSTALL' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'MSI_UNINSTALL' `
        ($msiTimeoutMilliseconds + $terminationTimeoutMilliseconds + 5000) {
          if ($protocolCreatedByRun -and (Test-Path -LiteralPath $protocolRegistryPath) -and
              (!$protocolOwnedIdentity -or
                (Get-RegistryTreeIdentity $protocolRegistryPath) -cne $protocolOwnedIdentity)) {
            throw 'refusing to uninstall over protocol metadata with a mismatched ownership identity'
          }
          if ($appPathsCreatedByRun -and (Test-Path -LiteralPath $appPathsRegistryPath) -and
              (!$appPathsOwnedIdentity -or
                (Get-RegistryTreeIdentity $appPathsRegistryPath) -cne $appPathsOwnedIdentity)) {
            throw 'refusing to uninstall over executable metadata with a mismatched ownership identity'
          }
          Invoke-Msi @('/x', "`"$installerPath`"", '/qn', '/norestart') 'machine uninstall'
        }
      Write-CleanupSubstage 'UNINSTALL' 'MSI_UNINSTALL' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'MSI_UNINSTALL' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'INSTALL_TREE_ASSERTION' $externalOperationTimeoutMilliseconds {
          if (Test-Path -LiteralPath $installRoot) {
            throw 'machine uninstall left the canonical install tree behind'
          }
        }
      Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'PROTOCOL_ABSENCE_ASSERTION' $externalOperationTimeoutMilliseconds {
          if (Test-Path -LiteralPath $protocolRegistryPath) {
            throw 'machine uninstall left protocol discovery metadata behind'
          }
        }
      Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'APP_PATH' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'APP_PATH_ABSENCE_ASSERTION' $externalOperationTimeoutMilliseconds {
          if (Test-Path -LiteralPath $appPathsRegistryPath) {
            throw 'machine uninstall left executable discovery metadata behind'
          }
        }
      Write-CleanupSubstage 'UNINSTALL' 'APP_PATH' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'APP_PATH' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'SHORTCUT_FILE_ASSERTION' $externalOperationTimeoutMilliseconds {
          if (Test-Path -LiteralPath $startMenuShortcut) {
            throw 'machine uninstall left the common Start Menu shortcut behind'
          }
        }
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'BEGIN'
    try {
      Invoke-BoundedExternalOperation `
        'UNINSTALL' 'SHORTCUT_FOLDER_ASSERTION' $externalOperationTimeoutMilliseconds {
          if (Test-Path -LiteralPath $startMenuShortcutFolder) {
            throw 'machine uninstall left the common Start Menu folder behind'
          }
        }
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'FAILED'
      $uninstallFailed = $true
    }

    if ($null -ne $testUserSid) {
      Write-CleanupSubstage 'UNINSTALL' 'ORDINARY_USER_ABSENCE_PROBE' 'BEGIN'
      try {
        Invoke-BoundedExternalOperation `
          'UNINSTALL' 'SHORTCUT_ABSENCE_PROBE' $externalOperationTimeoutMilliseconds {
            Test-StartMenuShortcutAsOrdinaryUser `
              -Credential $credential `
              -Domain $env:COMPUTERNAME `
              -UserName $testUser `
              -UserSid $testUserSid `
              -ShortcutPath $startMenuShortcut `
              -ExpectedPresent $false
          }
        Write-CleanupSubstage 'UNINSTALL' 'ORDINARY_USER_ABSENCE_PROBE' 'COMPLETE'
      } catch {
        Write-CleanupSubstage 'UNINSTALL' 'ORDINARY_USER_ABSENCE_PROBE' 'FAILED'
        $uninstallFailed = $true
      }
    } else {
      Write-CleanupSubstage 'UNINSTALL' 'ORDINARY_USER_ABSENCE_PROBE' 'SKIPPED'
    }

    if ($uninstallFailed) {
      Write-Stage 'UNINSTALL' 'FAILED'
      $cleanupFailed = $true
    } else {
      Write-Stage 'UNINSTALL' 'COMPLETE'
    }
  }

  Write-Stage 'CLEANUP' 'BEGIN'
  Write-CleanupSubstage 'CLEANUP' 'SMOKE_DATA' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation `
      'CLEANUP' 'SMOKE_DATA_REMOVE' $recursiveOperationTimeoutMilliseconds {
        Remove-SmokeUserDataDirectory $smokeUserDataDirectory
      }
    Write-CleanupSubstage 'CLEANUP' 'SMOKE_DATA' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'SMOKE_DATA' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'BEGIN'
  try {
    if ($testUserCreatedByRun -and $null -ne $testUserSid) {
      $profiles = @(Invoke-BoundedExternalOperation `
        'CLEANUP' 'PROFILE_LOOKUP' $externalOperationTimeoutMilliseconds {
          @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
            $_.SID -eq $testUserSid.Value
          })
        })
      Invoke-BoundedExternalOperation `
        'CLEANUP' 'PROFILE_REMOVE' $recursiveOperationTimeoutMilliseconds {
          foreach ($profile in $profiles) {
            if ($profile.SID -ne $testUserSid.Value) {
              throw 'refusing to remove a profile not owned by the test user'
            }
            Remove-CimInstance -InputObject $profile -ErrorAction Stop
          }
        }
    }
    Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'USER' 'BEGIN'
  try {
    if ($testUserCreatedByRun -and $null -ne $testUserSid) {
      $ownedUser = Invoke-BoundedExternalOperation `
        'CLEANUP' 'USER_LOOKUP' $externalOperationTimeoutMilliseconds {
          Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue
        }
      if ($null -ne $ownedUser) {
        if (!$ownedUser.SID.Equals($testUserSid)) {
          throw 'refusing to remove a local user with a mismatched SID'
        }
        Invoke-BoundedExternalOperation `
          'CLEANUP' 'USER_REMOVE' $externalOperationTimeoutMilliseconds {
            Remove-LocalUser -Name $testUser -ErrorAction Stop
            if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) {
              throw 'test local user cleanup did not complete'
            }
          }
      }
    }
    Write-CleanupSubstage 'CLEANUP' 'USER' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'USER' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation `
      'CLEANUP' 'INSTALL_ROOT_FALLBACK' $recursiveOperationTimeoutMilliseconds {
        if ($installRootCreatedByRun -and (Test-Path -LiteralPath $installRoot)) {
          $ownedInstallRoot = Get-Item -LiteralPath $installRoot -Force -ErrorAction Stop
          if (!$ownedInstallRoot.PSIsContainer -or
              ($ownedInstallRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'refusing to remove an invalid owned install tree'
          }
          Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
        }
      }
    Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation `
      'CLEANUP' 'PROTOCOL_FALLBACK' $externalOperationTimeoutMilliseconds {
        if ($protocolCreatedByRun -and (Test-Path -LiteralPath $protocolRegistryPath)) {
          if (!$protocolOwnedIdentity -or
              (Get-RegistryTreeIdentity $protocolRegistryPath) -cne $protocolOwnedIdentity) {
            throw 'refusing to remove protocol metadata with a mismatched ownership identity'
          }
          Remove-Item -LiteralPath $protocolRegistryPath -Recurse -Force -ErrorAction Stop
        }
      }
    Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'APP_PATH_FALLBACK' 'BEGIN'
  try {
    Invoke-BoundedExternalOperation `
      'CLEANUP' 'APP_PATH_FALLBACK' $externalOperationTimeoutMilliseconds {
        if ($appPathsCreatedByRun -and (Test-Path -LiteralPath $appPathsRegistryPath)) {
          if (!$appPathsOwnedIdentity -or
              (Get-RegistryTreeIdentity $appPathsRegistryPath) -cne $appPathsOwnedIdentity) {
            throw 'refusing to remove executable metadata with a mismatched ownership identity'
          }
          Remove-Item -LiteralPath $appPathsRegistryPath -Recurse -Force -ErrorAction Stop
        }
      }
    Write-CleanupSubstage 'CLEANUP' 'APP_PATH_FALLBACK' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'APP_PATH_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'SHORTCUT_FALLBACK' 'BEGIN'
  $shortcutFallbackFailed = $false
  try {
    Invoke-BoundedExternalOperation `
      'CLEANUP' 'SHORTCUT_FALLBACK' $externalOperationTimeoutMilliseconds {
        if ($startMenuShortcutCreatedByRun -and (Test-Path -LiteralPath $startMenuShortcut)) {
          Remove-Item -LiteralPath $startMenuShortcut -Force -ErrorAction Stop
        }
        if ($startMenuShortcutFolderCreatedByRun -and
            (Test-Path -LiteralPath $startMenuShortcutFolder)) {
          $ownedShortcutFolder = Get-Item `
            -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop
          if (!$ownedShortcutFolder.PSIsContainer -or
              ($ownedShortcutFolder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'owned common Start Menu folder is invalid'
          }
          $ownedShortcutFolderContents = @(
            Get-ChildItem -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop
          )
          if ($ownedShortcutFolderContents.Count -eq 0) {
            Remove-Item -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop
          }
        }
      }
  } catch {
    $shortcutFallbackFailed = $true
  }
  if ($shortcutFallbackFailed) {
    Write-CleanupSubstage 'CLEANUP' 'SHORTCUT_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  } else {
    Write-CleanupSubstage 'CLEANUP' 'SHORTCUT_FALLBACK' 'COMPLETE'
  }

  Write-CleanupSubstage 'CLEANUP' 'FINAL_AGGREGATION' 'BEGIN'
  if ($cleanupFailed) {
    Write-CleanupSubstage 'CLEANUP' 'FINAL_AGGREGATION' 'FAILED'
    Write-Stage 'CLEANUP' 'FAILED'
    if ($null -eq $primaryFailure) {
      throw 'installed Windows cleanup did not complete'
    }
  } else {
    $ownershipState.BaselineClean = $false
    $ownershipState.InstallAttempted = $false
    $ownershipState.Directories = @()
    $ownershipState.Files = @()
    $ownershipState.RegistryKeys = @()
    $ownershipState.Users = @()
    $ownershipState.Profiles = @()
    Write-OwnershipManifest
    Write-CleanupSubstage 'CLEANUP' 'FINAL_AGGREGATION' 'COMPLETE'
    Write-Stage 'CLEANUP' 'COMPLETE'
  }
}
