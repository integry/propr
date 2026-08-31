param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
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
$primaryFailure = $null
try {
  $installerPath = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
} catch {
  throw 'installer resolution failed'
}
$installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
$application = Join-Path $installRoot 'propr-desktop.exe'
$testUser = "propr-ci-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$passwordText = "P!$([Guid]::NewGuid().ToString('N'))a7"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$testUser", $password)
$installAttempted = $false
$testUserSid = $null
$smokeUserDataDirectory = $null
$msiTimeoutMilliseconds = 10 * 60 * 1000
$applicationTimeoutMilliseconds = 5 * 60 * 1000
$terminationTimeoutMilliseconds = 30 * 1000
$redirectedStreamDrainTimeoutMilliseconds = 30 * 1000
$smokeEvidenceFileByteCap = 64 * 1024
$smokeEvidenceOpenRetryDeadlineMilliseconds = 2 * 1000
$smokeEvidenceOpenRetryDelayMilliseconds = 50
$smokeEventCodes = [ordered]@{
  'desktop.smoke.authorized' = 'SMOKE_AUTHORIZED'
  'desktop.app.ready' = 'APP_READY'
  'desktop.renderer.mvp_flows.ready' = 'MVP_FLOWS_READY'
  'desktop.renderer.layout.ready' = 'LAYOUT_READY'
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
$startMenuShortcutExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcut
$startMenuShortcutFolderExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcutFolder
$startMenuShortcutCreatedByRun = $false
$startMenuShortcutFolderCreatedByRun = $false
# Fixed encoded-child contract. Keep these codes in exact parity with $probeTemplate.
$shortcutProbeExitCategories = [ordered]@{
  10 = 'ENV_PATH_MISSING_OR_EMPTY'
  11 = 'PATH_NOT_ROOTED'
  12 = 'PRESENCE_MISMATCH'
  13 = 'ITEM_LOOKUP_OR_TYPE_FAILURE'
  14 = 'REPARSE_REJECTED'
  15 = 'ZERO_SIZE_REJECTED'
  16 = 'READ_OPEN_DENIED_OR_FAILED'
  17 = 'EMPTY_STREAM'
  18 = 'UNEXPECTED_CHILD_FAILURE'
}

function Write-Stage(
  [ValidateSet('INSTALL','VALIDATION','USER_SETUP','APP_LAUNCH','APP_EXIT','UNINSTALL','CLEANUP')][string]$Stage,
  [ValidateSet('BEGIN','COMPLETE','FAILED')][string]$Status
) {
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:{0}:{1}' -f $Stage, $Status)
}

function Write-CleanupSubstage(
  [ValidateSet('UNINSTALL','CLEANUP')][string]$Scope,
  [ValidateSet(
    'MSI_UNINSTALL',
    'INSTALL_TREE',
    'PROTOCOL',
    'SHORTCUT_FILE',
    'SHORTCUT_FOLDER',
    'ORDINARY_USER_ABSENCE_PROBE',
    'SMOKE_DATA',
    'PROFILE',
    'USER',
    'INSTALL_ROOT_FALLBACK',
    'PROTOCOL_FALLBACK',
    'SHORTCUT_FALLBACK',
    'FINAL_AGGREGATION'
  )][string]$Substage,
  [ValidateSet('BEGIN','COMPLETE','FAILED','SKIPPED')][string]$Status
) {
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:{0}:{1}:{2}' -f $Scope, $Substage, $Status)
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
  [string]$ShortcutPath,
  [string]$SmokeDirectory,
  [bool]$ExpectedPresent
) {
  $fullSmokeDirectory = [IO.Path]::GetFullPath($SmokeDirectory)
  if ((Split-Path -Leaf $fullSmokeDirectory) -notmatch '^propr-desktop-smoke-[a-f0-9]{32}$' -or
      ![string]::Equals(
        (Split-Path -Parent $fullSmokeDirectory),
        $machineTemp,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw 'ordinary-user shortcut probe requires the verified smoke directory'
  }
  $smokeDirectoryItem = Get-Item -LiteralPath $fullSmokeDirectory -Force -ErrorAction Stop
  if (!$smokeDirectoryItem.PSIsContainer -or
      ($smokeDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'ordinary-user shortcut probe requires the verified smoke directory'
  }
  $smokeDirectoryAcl = Get-Acl -LiteralPath $fullSmokeDirectory
  $smokeDirectoryRules = @($smokeDirectoryAcl.Access)
  $smokeDirectorySids = @($smokeDirectoryRules | ForEach-Object {
    ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value
  }) | Sort-Object -Unique
  if (!$smokeDirectoryAcl.AreAccessRulesProtected -or $smokeDirectoryRules.Count -ne 3) {
    throw 'ordinary-user shortcut probe requires the verified smoke directory'
  }

  $probeRootDirectory = Join-Path $fullSmokeDirectory 'shortcut-probe'
  $probeUserProfileDirectory = Join-Path $probeRootDirectory 'USERPROFILE'
  $probeAppDataDirectory = Join-Path $probeUserProfileDirectory 'AppData'
  $probeRoamingAppDataDirectory = Join-Path $probeAppDataDirectory 'Roaming'
  $probeLocalAppDataDirectory = Join-Path $probeAppDataDirectory 'Local'
  $probeTemporaryDirectory = Join-Path $probeRootDirectory 'TEMP'
  $probeTmpDirectory = Join-Path $probeRootDirectory 'TMP'
  $smokeDirectoryPrefix = $fullSmokeDirectory + [IO.Path]::DirectorySeparatorChar
  foreach ($directory in @(
    $probeRootDirectory,
    $probeUserProfileDirectory,
    $probeAppDataDirectory,
    $probeRoamingAppDataDirectory,
    $probeLocalAppDataDirectory,
    $probeTemporaryDirectory,
    $probeTmpDirectory
  )) {
    $fullDirectory = [IO.Path]::GetFullPath($directory)
    if (!$fullDirectory.StartsWith($smokeDirectoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'ordinary-user shortcut probe child profile escaped the smoke directory'
    }
    [void][IO.Directory]::CreateDirectory($fullDirectory)
    $directoryItem = Get-Item -LiteralPath $fullDirectory -Force -ErrorAction Stop
    if (!$directoryItem.PSIsContainer -or
        ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'ordinary-user shortcut probe child profile layout is invalid'
    }
    $directoryAcl = Get-Acl -LiteralPath $fullDirectory
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
      throw 'ordinary-user shortcut probe child profile ACL is not inherited from the smoke directory'
    }
  }

  # This is the complete probe child environment. Never add parent/CI variables here.
  $probeChildEnvironment = [ordered]@{
    'APPDATA' = $probeRoamingAppDataDirectory
    'LOCALAPPDATA' = $probeLocalAppDataDirectory
    'USERPROFILE' = $probeUserProfileDirectory
    'TEMP' = $probeTemporaryDirectory
    'TMP' = $probeTmpDirectory
    'SystemRoot' = $windowsDirectory
    'PROPR_DESKTOP_START_MENU_SHORTCUT' = $ShortcutPath
  }

  $expectedLiteral = if ($ExpectedPresent) { '$true' } else { '$false' }
  $probeTemplate = @'
$ErrorActionPreference = 'Stop'
$shortcut = $env:PROPR_DESKTOP_START_MENU_SHORTCUT
if ([string]::IsNullOrWhiteSpace($shortcut)) { exit 10 }
if (![IO.Path]::IsPathRooted($shortcut)) { exit 11 }
$stream = $null
try {
  $present = Test-Path -LiteralPath $shortcut -PathType Leaf -ErrorAction Stop
  if (!__EXPECTED_PRESENT__ -and !$present) { exit 0 }
  if ($present -ne __EXPECTED_PRESENT__) { exit 12 }
  try {
    $item = Get-Item -LiteralPath $shortcut -Force -ErrorAction Stop
  } catch {
    exit 13
  }
  if (!($item -is [IO.FileInfo])) { exit 13 }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 14 }
  if ($item.Length -le 0) { exit 15 }
  try {
    $stream = [IO.File]::Open(
      $shortcut,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite
    )
  } catch {
    exit 16
  }
  if ($stream.Length -le 0) { exit 17 }
} catch {
  exit 18
} finally {
  if ($null -ne $stream) {
    try { $stream.Dispose() } catch { exit 18 }
  }
}
exit 0
'@
  $probeSource = $probeTemplate.Replace('__EXPECTED_PRESENT__', $expectedLiteral)
  $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeSource))
  $powershell = Join-Path $windowsDirectory 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $expectation = if ($ExpectedPresent) { 'PRESENT' } else { 'ABSENT' }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.Environment.Clear()
  foreach ($entry in $probeChildEnvironment.GetEnumerator()) {
    $startInfo.Environment.Add([string]$entry.Key, [string]$entry.Value)
  }
  $startInfo.FileName = $powershell
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $windowsDirectory
  $startInfo.UserName = $UserName
  $startInfo.Domain = $Domain
  $startInfo.Password = $Credential.Password
  $startInfo.LoadUserProfile = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedProbe)) {
    $startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $started = $false
  $failureCategory = $null
  $processCleanupFailed = $false
  try {
    try {
      $started = $process.Start()
    } catch {
      if ($_.Exception -is [System.ComponentModel.Win32Exception]) {
        $spawnFailureCategories = [ordered]@{
          2 = 'FILE_NOT_FOUND'
          3 = 'PATH_NOT_FOUND_OR_DIRECTORY_INVALID'
          5 = 'ACCESS_DENIED'
          87 = 'INVALID_PARAMETER'
          267 = 'PATH_NOT_FOUND_OR_DIRECTORY_INVALID'
          1326 = 'LOGON_FAILURE'
          1385 = 'LOGON_TYPE_NOT_GRANTED'
        }
        $spawnFailureCategory = if ($spawnFailureCategories.Contains($_.Exception.NativeErrorCode)) {
          $spawnFailureCategories[$_.Exception.NativeErrorCode]
        } else {
          'UNKNOWN'
        }
        $failureCategory = 'SPAWN_FAILED:{0}' -f $spawnFailureCategory
      } else {
        $failureCategory = 'SPAWN_FAILED'
      }
    }
    if ($null -eq $failureCategory -and !$started) {
      $failureCategory = 'SPAWN_FAILED'
    }

    if ($null -eq $failureCategory) {
      try {
        $completed = $process.WaitForExit($terminationTimeoutMilliseconds)
      } catch {
        $failureCategory = 'UNKNOWN'
      }
      if ($null -eq $failureCategory -and !$completed) {
        $failureCategory = 'TIMEOUT'
      }
    }

    if ($null -eq $failureCategory) {
      try {
        $exitCode = $process.ExitCode
      } catch {
        $failureCategory = 'UNKNOWN'
      }
      if ($null -eq $failureCategory -and $exitCode -ne 0) {
        if ($shortcutProbeExitCategories.Contains($exitCode)) {
          $failureCategory = $shortcutProbeExitCategories[$exitCode]
        } else {
          $failureCategory = 'UNKNOWN'
        }
      }
    }
  } finally {
    if ($started) {
      try {
        if (!$process.HasExited) {
          $process.Kill($true)
          if (!$process.WaitForExit($terminationTimeoutMilliseconds)) {
            $processCleanupFailed = $true
          }
        }
      } catch {
        $processCleanupFailed = $true
      }
    }
    try {
      $process.Dispose()
    } catch {
      $processCleanupFailed = $true
    }
  }

  if ($processCleanupFailed -and $null -eq $failureCategory) {
    $failureCategory = 'UNKNOWN'
  }
  if ($null -eq $failureCategory) {
    Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:{0}:SUCCESS' -f $expectation)
    return
  }
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:{0}:{1}' -f $expectation, $failureCategory)
  throw 'ordinary-user shortcut probe failed'
}

function New-SmokeUserDataDirectory([Security.Principal.SecurityIdentifier]$UserSid) {
  $path = Join-Path $machineTemp "propr-desktop-smoke-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $path | Out-Null
  try {
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
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
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
    try {
      Invoke-Msi @('/i', "`"$installerPath`"", '/qn', '/norestart') 'machine install'
    } finally {
      $startMenuShortcutCreatedByRun =
        !$startMenuShortcutExistedBeforeInstall -and (Test-Path -LiteralPath $startMenuShortcut)
      $startMenuShortcutFolderCreatedByRun =
        !$startMenuShortcutFolderExistedBeforeInstall -and (Test-Path -LiteralPath $startMenuShortcutFolder)
    }
    Write-Stage 'INSTALL' 'COMPLETE'
  } catch {
    Write-Stage 'INSTALL' 'FAILED'
    throw
  }

  Write-Stage 'VALIDATION' 'BEGIN'
  try {
    if (!(Test-Path -LiteralPath $application -PathType Leaf)) {
      throw 'machine installer did not install the canonical application'
    }
    $forbidden = @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force | Where-Object {
      $_.Name -match '^propr-windows-(authority|launcher|bootstrap)' -or
      $_.Name -in @('windows-authority', 'windows-update-authority')
    })
    if ($forbidden.Count -ne 0) { throw 'installed MVP contains a deferred Windows update authority resource' }

    $image = New-Object byte[] 4096
    $stream = [IO.File]::OpenRead($application)
    try { $imageLength = $stream.Read($image, 0, $image.Length) } finally { $stream.Dispose() }
    $pe = if ($imageLength -ge 64) { [BitConverter]::ToUInt32($image, 0x3c) } else { 0 }
    $expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
    if ($imageLength -lt 512 -or [BitConverter]::ToUInt16($image, 0) -ne 0x5a4d -or
        $pe + 6 -gt $imageLength -or [Text.Encoding]::ASCII.GetString($image, [int]$pe, 4) -cne "PE`0`0" -or
        [BitConverter]::ToUInt16($image, [int]$pe + 4) -ne $expectedMachine) {
      throw 'installed application architecture does not match the matrix target'
    }

    $protocolCommand = (Get-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr\shell\open\command').GetValue('')
    if ($protocolCommand -cne "`"$application`" `"%1`"") {
      throw 'machine installer did not register canonical ProPR Connect protocol discovery'
    }
    $shortcutItem = Get-Item -LiteralPath $startMenuShortcut -Force -ErrorAction Stop
    if (!($shortcutItem -is [IO.FileInfo]) -or
        ($shortcutItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $shortcutItem.Length -le 0) {
      throw 'machine installer did not create the common Start Menu shortcut'
    }
    Write-Stage 'VALIDATION' 'COMPLETE'
  } catch {
    Write-Stage 'VALIDATION' 'FAILED'
    throw
  }

  Write-Stage 'USER_SETUP' 'BEGIN'
  try {
    New-LocalUser -Name $testUser -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
    $testUserSid = (Get-LocalUser -Name $testUser).SID
    $smokeUserDataDirectory = New-SmokeUserDataDirectory $testUserSid
    Test-StartMenuShortcutAsOrdinaryUser `
      -Credential $credential `
      -Domain $env:COMPUTERNAME `
      -UserName $testUser `
      -ShortcutPath $startMenuShortcut `
      -SmokeDirectory $smokeUserDataDirectory `
      -ExpectedPresent $true
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
    $applicationLaunch = Start-AlternateCredentialApplication `
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
    Write-Stage 'APP_LAUNCH' 'COMPLETE'
  } catch {
    Write-Stage 'APP_LAUNCH' 'FAILED'
    throw
  }
  Write-Stage 'APP_EXIT' 'BEGIN'
  try {
    $waitFailure = $null
    try {
      [void](Wait-BoundedProcess `
        -Process $applicationLaunch.Process `
        -TimeoutMilliseconds $applicationTimeoutMilliseconds `
        -AllowedExitCodes @(0) `
        -Operation 'ordinary-user installed application launch/render/profile smoke')
    } catch {
      $waitFailure = $_
    } finally {
      try {
        Close-RedirectedApplicationStreams $applicationLaunch `
          'ordinary-user installed application launch/render/profile smoke'
      } catch {
        if ($null -eq $waitFailure) { $waitFailure = $_ }
      } finally {
        $applicationLaunch.Process.Dispose()
        $applicationLaunch = $null
      }
    }
    $smokeEvidence = Get-SmokeEventEvidence $smokeUserDataDirectory $testUserSid
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
      try { Close-RedirectedApplicationStreams $applicationLaunch `
        'ordinary-user installed application launch/render/profile smoke' } finally {
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
      Invoke-Msi @('/x', "`"$installerPath`"", '/qn', '/norestart') 'machine uninstall'
      Write-CleanupSubstage 'UNINSTALL' 'MSI_UNINSTALL' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'MSI_UNINSTALL' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'BEGIN'
    try {
      if (Test-Path -LiteralPath $installRoot) { throw 'machine uninstall left the canonical install tree behind' }
      Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'INSTALL_TREE' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'BEGIN'
    try {
      if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr') {
        throw 'machine uninstall left protocol discovery metadata behind'
      }
      Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'PROTOCOL' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'BEGIN'
    try {
      if (Test-Path -LiteralPath $startMenuShortcut) {
        throw 'machine uninstall left the common Start Menu shortcut behind'
      }
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FILE' 'FAILED'
      $uninstallFailed = $true
    }

    Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'BEGIN'
    try {
      if (Test-Path -LiteralPath $startMenuShortcutFolder) {
        throw 'machine uninstall left the common Start Menu folder behind'
      }
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'COMPLETE'
    } catch {
      Write-CleanupSubstage 'UNINSTALL' 'SHORTCUT_FOLDER' 'FAILED'
      $uninstallFailed = $true
    }

    if ($null -ne $testUserSid) {
      Write-CleanupSubstage 'UNINSTALL' 'ORDINARY_USER_ABSENCE_PROBE' 'BEGIN'
      try {
        Test-StartMenuShortcutAsOrdinaryUser `
          -Credential $credential `
          -Domain $env:COMPUTERNAME `
          -UserName $testUser `
          -ShortcutPath $startMenuShortcut `
          -SmokeDirectory $smokeUserDataDirectory `
          -ExpectedPresent $false
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
    Remove-SmokeUserDataDirectory $smokeUserDataDirectory
    Write-CleanupSubstage 'CLEANUP' 'SMOKE_DATA' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'SMOKE_DATA' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'BEGIN'
  try {
    if ($null -ne $testUserSid) {
      $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
        $_.SID -eq $testUserSid.Value
      })
      foreach ($profile in $profiles) { Remove-CimInstance -InputObject $profile -ErrorAction Stop }
    }
    Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'PROFILE' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'USER' 'BEGIN'
  try {
    if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) {
      Remove-LocalUser -Name $testUser -ErrorAction Stop
    }
    Write-CleanupSubstage 'CLEANUP' 'USER' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'USER' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'BEGIN'
  try {
    if (Test-Path -LiteralPath $installRoot) {
      Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
    }
    Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'BEGIN'
  try {
    if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr') {
      Remove-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr' -Recurse -Force -ErrorAction Stop
    }
    Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'COMPLETE'
  } catch {
    Write-CleanupSubstage 'CLEANUP' 'PROTOCOL_FALLBACK' 'FAILED'
    $cleanupFailed = $true
  }

  Write-CleanupSubstage 'CLEANUP' 'SHORTCUT_FALLBACK' 'BEGIN'
  $shortcutFallbackFailed = $false
  try {
    if ($startMenuShortcutCreatedByRun -and (Test-Path -LiteralPath $startMenuShortcut)) {
      Remove-Item -LiteralPath $startMenuShortcut -Force -ErrorAction Stop
    }
  } catch {
    $shortcutFallbackFailed = $true
  }
  try {
    if ($startMenuShortcutFolderCreatedByRun -and (Test-Path -LiteralPath $startMenuShortcutFolder)) {
      $ownedShortcutFolder = Get-Item -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop
      if (!$ownedShortcutFolder.PSIsContainer -or
          ($ownedShortcutFolder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'owned common Start Menu folder is invalid'
      }
      $ownedShortcutFolderContents = @(Get-ChildItem -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop)
      if ($ownedShortcutFolderContents.Count -eq 0) {
        Remove-Item -LiteralPath $startMenuShortcutFolder -Force -ErrorAction Stop
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
    Write-CleanupSubstage 'CLEANUP' 'FINAL_AGGREGATION' 'COMPLETE'
    Write-Stage 'CLEANUP' 'COMPLETE'
  }
}
