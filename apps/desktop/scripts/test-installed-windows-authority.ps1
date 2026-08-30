param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installRoot = Join-Path $env:ProgramFiles 'ProPR Desktop'
$application = Join-Path $installRoot 'propr-desktop.exe'
$authority = Join-Path $installRoot 'resources\windows-authority'
$helper = Join-Path $authority 'propr-windows-authority.exe'
$testUser = "propr-ci-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$passwordText = "P!$([Guid]::NewGuid().ToString('N'))a7"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$testUser", $password)

try {
  $install = Start-Process msiexec.exe -ArgumentList @('/i', "`"$installerPath`"", '/qn', '/norestart') -Wait -PassThru
  if ($install.ExitCode -notin @(0,3010)) { throw "machine installer exited $($install.ExitCode)" }
  if (!(Test-Path -LiteralPath $application -PathType Leaf) -or !(Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw 'machine installer did not install the canonical application authority layout'
  }
  $image = New-Object byte[] 4096
  $imageStream = [IO.File]::OpenRead($application)
  try { $imageLength = $imageStream.Read($image,0,$image.Length) } finally { $imageStream.Dispose() }
  if ($imageLength -lt 512 -or [BitConverter]::ToUInt16($image,0) -ne 0x5a4d) { throw 'installed application is not PE' }
  $pe = [BitConverter]::ToUInt32($image,0x3c)
  $expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
  if ($pe + 6 -gt $imageLength -or [Text.Encoding]::ASCII.GetString($image,[int]$pe,4) -cne "PE`0`0" -or
      [BitConverter]::ToUInt16($image,[int]$pe+4) -ne $expectedMachine) {
    throw 'installed application architecture does not match the matrix target'
  }
  foreach ($protectedPath in @($installRoot, $application, $authority, $helper)) {
    $acl = Get-Acl -LiteralPath $protectedPath
    $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($owner -cne 'S-1-5-18' -or !$acl.AreAccessRulesProtected) {
      throw "$protectedPath is not SYSTEM-owned with a protected DACL"
    }
    foreach ($rule in $acl.Access) {
      if ($rule.IsInherited) { throw "$protectedPath retains an inherited effective ACE" }
      $dangerous = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
      if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $dangerous) -ne 0) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
          throw "$protectedPath grants mutation to $sid"
        }
      }
    }
  }

  New-LocalUser -Name $testUser -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $process = Start-Process -FilePath $application -ArgumentList '--propr-authority-smoke' -Credential $credential -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "standard-user installed authority handshake exited $($process.ExitCode)" }

  $helper64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
  $authority64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($authority))
  $application64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($application))
  $attack = @"
`$helper=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$helper64'))
`$authority=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$authority64'))
`$application=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$application64'))
`$failed=`$false
function Denied([scriptblock]`$operation) {
  try { & `$operation; `$script:failed=`$true }
  catch [UnauthorizedAccessException] { }
  catch [IO.IOException] { if (`$_.Exception.HResult -notin @(-2147024891,-2147024864,-2147024713)) { throw } }
}
Denied { [IO.File]::OpenWrite(`$helper).Dispose() }
Denied { [IO.File]::Delete(`$helper) }
Denied { [IO.File]::Move(`$helper,"`$helper.replaced") }
Denied { [IO.File]::WriteAllBytes((Join-Path `$authority 'replacement.node'),[byte[]](1,2,3)) }
Denied { [IO.File]::OpenWrite(`$application).Dispose() }
Denied { [IO.File]::Delete(`$application) }
Denied { [IO.File]::Move(`$application,"`$application.replaced") }
if (`$failed) { exit 1 } else { exit 0 }
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($attack))
  $attackProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) `
    -Credential $credential -Wait -PassThru
  if ($attackProcess.ExitCode -ne 0) { throw 'standard user could mutate or replace the installed authority' }
} finally {
  if (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $testUser }
  Start-Process msiexec.exe -ArgumentList @('/x', "`"$installerPath`"", '/qn', '/norestart') -Wait | Out-Null
}
