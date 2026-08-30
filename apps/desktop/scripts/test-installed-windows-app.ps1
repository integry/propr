param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
$application = Join-Path $installRoot 'propr-desktop.exe'
$testUser = "propr-ci-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$passwordText = "P!$([Guid]::NewGuid().ToString('N'))a7"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$testUser", $password)
$installed = $false
$smokeUserDataDirectory = $null
$machineTempValue = [Environment]::GetEnvironmentVariable('TEMP', [EnvironmentVariableTarget]::Machine)
if (!$machineTempValue) { throw 'machine temporary directory is unavailable' }
$machineTemp = [Environment]::ExpandEnvironmentVariables($machineTempValue)
if (![IO.Path]::IsPathRooted($machineTemp)) { throw 'machine temporary directory is not absolute' }
$machineTemp = (Resolve-Path -LiteralPath $machineTemp).Path

function Invoke-Msi([string[]]$Arguments, [string]$Operation) {
  $process = Start-Process msiexec.exe -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -notin @(0,3010)) { throw "$Operation exited $($process.ExitCode)" }
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
  Invoke-Msi @('/i', "`"$installerPath`"", '/qn', '/norestart') 'machine install'
  $installed = $true
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

  New-LocalUser -Name $testUser -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $testUserSid = (Get-LocalUser -Name $testUser).SID
  $smokeUserDataDirectory = New-SmokeUserDataDirectory $testUserSid
  $arguments = @(
    '--disable-gpu',
    '--propr-smoke-test',
    "`"--user-data-dir=$smokeUserDataDirectory`"",
    'propr://connect?api=https%3A%2F%2Fconnect.propr.dev'
  )
  $process = Start-Process -FilePath $application -ArgumentList $arguments -Credential $credential `
    -WorkingDirectory $env:ProgramFiles -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "ordinary-user installed application launch/render/profile smoke exited $($process.ExitCode)"
  }
} finally {
  try {
    Remove-SmokeUserDataDirectory $smokeUserDataDirectory
  } finally {
    if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $testUser }
    if ($installed) {
      Invoke-Msi @('/x', "`"$installerPath`"", '/qn', '/norestart') 'machine uninstall'
      if (Test-Path -LiteralPath $installRoot) { throw 'machine uninstall left the canonical install tree behind' }
      if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\propr') {
        throw 'machine uninstall left protocol discovery metadata behind'
      }
    }
  }
}
