param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
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
$machineTempValue = [Environment]::GetEnvironmentVariable('TEMP', [EnvironmentVariableTarget]::Machine)
if (!$machineTempValue) { throw 'machine temporary directory is unavailable' }
$machineTemp = [Environment]::ExpandEnvironmentVariables($machineTempValue)
if (![IO.Path]::IsPathRooted($machineTemp)) { throw 'machine temporary directory is not absolute' }
$machineTemp = (Resolve-Path -LiteralPath $machineTemp).Path

function Write-Stage(
  [ValidateSet('INSTALL','VALIDATION','USER_SETUP','APP_LAUNCH','APP_EXIT','UNINSTALL','CLEANUP')][string]$Stage,
  [ValidateSet('BEGIN','COMPLETE','FAILED')][string]$Status
) {
  Write-Host ('PROPR_WINDOWS_INSTALLED_SMOKE:{0}:{1}' -f $Stage, $Status)
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

try {
  Write-Stage 'INSTALL' 'BEGIN'
  try {
    $installAttempted = $true
    Invoke-Msi @('/i', "`"$installerPath`"", '/qn', '/norestart') 'machine install'
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
    Write-Stage 'USER_SETUP' 'COMPLETE'
  } catch {
    Write-Stage 'USER_SETUP' 'FAILED'
    throw 'ordinary-user setup failed'
  }

  $arguments = @(
    '--disable-gpu',
    '--propr-smoke-test',
    "`"--user-data-dir=$smokeUserDataDirectory`"",
    'propr://connect?api=https%3A%2F%2Fconnect.propr.dev'
  )
  Write-Stage 'APP_LAUNCH' 'BEGIN'
  $applicationProcess = $null
  try {
    $applicationStart = @{
      FilePath = $application
      ArgumentList = $arguments
      Credential = $credential
      LoadUserProfile = $true
      RedirectStandardOutput = (Join-Path $smokeUserDataDirectory 'application.stdout.log')
      RedirectStandardError = (Join-Path $smokeUserDataDirectory 'application.stderr.log')
      WorkingDirectory = $env:ProgramFiles
    }
    $applicationProcess = Start-DirectProcess $applicationStart `
      'ordinary-user installed application launch/render/profile smoke'
    Write-Stage 'APP_LAUNCH' 'COMPLETE'
  } catch {
    Write-Stage 'APP_LAUNCH' 'FAILED'
    throw
  }
  Write-Stage 'APP_EXIT' 'BEGIN'
  try {
    [void](Wait-BoundedProcess `
      -Process $applicationProcess `
      -TimeoutMilliseconds $applicationTimeoutMilliseconds `
      -AllowedExitCodes @(0) `
      -Operation 'ordinary-user installed application launch/render/profile smoke')
    Write-Stage 'APP_EXIT' 'COMPLETE'
  } catch {
    Write-Stage 'APP_EXIT' 'FAILED'
    throw
  } finally {
    if ($null -ne $applicationProcess) { $applicationProcess.Dispose() }
  }
} finally {
  $cleanupFailed = $false
  if ($installAttempted) {
    Write-Stage 'UNINSTALL' 'BEGIN'
    try {
      Invoke-Msi @('/x', "`"$installerPath`"", '/qn', '/norestart') 'machine uninstall'
      if (Test-Path -LiteralPath $installRoot) { throw 'machine uninstall left the canonical install tree behind' }
      if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr') {
        throw 'machine uninstall left protocol discovery metadata behind'
      }
      Write-Stage 'UNINSTALL' 'COMPLETE'
    } catch {
      Write-Stage 'UNINSTALL' 'FAILED'
      $cleanupFailed = $true
    }
  }

  Write-Stage 'CLEANUP' 'BEGIN'
  try {
    Remove-SmokeUserDataDirectory $smokeUserDataDirectory
  } catch {
    $cleanupFailed = $true
  }
  try {
    if ($null -ne $testUserSid) {
      $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
        $_.SID -eq $testUserSid.Value
      })
      foreach ($profile in $profiles) { Remove-CimInstance -InputObject $profile -ErrorAction Stop }
    }
  } catch {
    $cleanupFailed = $true
  }
  try {
    if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) {
      Remove-LocalUser -Name $testUser -ErrorAction Stop
    }
  } catch {
    $cleanupFailed = $true
  }
  try {
    if (Test-Path -LiteralPath $installRoot) {
      Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $cleanupFailed = $true
  }
  try {
    if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr') {
      Remove-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr' -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $cleanupFailed = $true
  }
  if ($cleanupFailed) {
    Write-Stage 'CLEANUP' 'FAILED'
    throw 'installed Windows cleanup did not complete'
  }
  Write-Stage 'CLEANUP' 'COMPLETE'
}
