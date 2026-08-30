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

function Invoke-Msi([string[]]$Arguments, [string]$Operation) {
  $process = Start-Process msiexec.exe -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -notin @(0,3010)) { throw "$Operation exited $($process.ExitCode)" }
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
  $arguments = @(
    '--disable-gpu',
    '--propr-smoke-test',
    'propr://connect?api=https%3A%2F%2Fconnect.propr.dev'
  )
  $process = Start-Process -FilePath $application -ArgumentList $arguments -Credential $credential `
    -WorkingDirectory $env:ProgramFiles -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "ordinary-user installed application launch/render/profile smoke exited $($process.ExitCode)"
  }
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
