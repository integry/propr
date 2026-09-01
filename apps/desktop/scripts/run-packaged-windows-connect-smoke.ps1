param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('x64','arm64')]
  [string]$Architecture
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
$applicationTimeoutMilliseconds = 5 * 60 * 1000
$terminationTimeoutMilliseconds = 30 * 1000
$cleanupTimeoutMilliseconds = 60 * 1000
$primaryFailure = $null
$primaryPhase = $null
$failurePhase = 'source-layout'
$cleanupSecondary = 'none'
$testUser = $null
$testUserSid = $null
$stageParent = $null
$stageRoot = $null
$stageLeaf = $null
$stdout = $null
$stderr = $null
$privilegedSid = $null

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
}

function Stop-SpawnedProcess {
  param([Parameter(Mandatory=$true)][Diagnostics.Process]$Process)
  if (!$Process.HasExited) {
    $Process.Kill()
    if (!$Process.WaitForExit($terminationTimeoutMilliseconds)) {
      Stop-PackagedConnect 'spawn-failed'
    }
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
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($boundedCleanupSource))
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
  try {
    if(!$cleanupProcess.Start()){return 'failed'}
    if(!$cleanupProcess.WaitForExit($cleanupTimeoutMilliseconds)){
      try{$cleanupProcess.Kill();$null=$cleanupProcess.WaitForExit($terminationTimeoutMilliseconds)}catch{}
      return 'timeout'
    }
    $cleanupOutput=$cleanupProcess.StandardOutput.ReadToEnd()
    $cleanupError=$cleanupProcess.StandardError.ReadToEnd()
    if($cleanupProcess.ExitCode -ne 0 -or $cleanupOutput.Length -ne 0 -or $cleanupError.Length -ne 0){return 'failed'}
    return 'none'
  } catch {
    try{if(!$cleanupProcess.HasExited){$cleanupProcess.Kill()}}catch{}
    return 'failed'
  } finally {
    $cleanupProcess.Dispose()
  }
}

$authenticatedRunnerTemp = $null
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
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

    Set-FailurePhase 'ordinary-user-preflight'
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $null = Get-CanonicalItem $node 'file'
    $stdout = Join-Path $authenticatedRunnerTemp ('propr-connect-' + [Guid]::NewGuid().ToString('N') + '.stdout')
    $stderr = Join-Path $authenticatedRunnerTemp ('propr-connect-' + [Guid]::NewGuid().ToString('N') + '.stderr')
    if ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr)) {
      Stop-PackagedConnect 'artifact-type'
    }
    $previousParent = [Environment]::GetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_PARENT', 'Process')
    $previousLeaf = [Environment]::GetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_LEAF', 'Process')
    try {
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_PARENT', $stageParent, 'Process')
      [Environment]::SetEnvironmentVariable('PROPR_DESKTOP_CONNECT_STAGING_LEAF', $stageLeaf, 'Process')
      try {
        Set-FailurePhase 'application-spawn'
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
            $reportedCategories += $record.category
            Set-FailurePhase $record.phase
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
    $primaryFailure = Get-FixedFailureCategory $_.Exception
    $primaryPhase = $failurePhase
  }
} finally {
  if ($null -ne $authenticatedRunnerTemp -and $null -ne $privilegedSid) {
    $cleanupResult = Invoke-BoundedCleanup
    if ($cleanupResult -eq 'timeout') {
      $cleanupSecondary = 'cleanup-timeout'
    } elseif ($cleanupResult -ne 'none') {
      $cleanupSecondary = 'cleanup-failed'
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
  [Console]::Error.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=$primaryFailure`:phase=$primaryPhase`:cleanup=$cleanupSecondary")
  exit 1
}
[Console]::Out.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:passed:$Architecture")
