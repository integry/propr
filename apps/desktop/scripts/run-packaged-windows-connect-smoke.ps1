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
$primaryFailure = $null
$cleanupFailure = $false
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
  return 'spawn-failed'
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

function Remove-BoundedStage {
  param(
    [Parameter(Mandatory=$true)][string]$Parent,
    [Parameter(Mandatory=$true)][string]$AuthenticatedRunnerTemp,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$PrivilegedUser,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$Administrators
  )
  if ([IO.Path]::GetDirectoryName($Parent) -cne $AuthenticatedRunnerTemp -or
      [IO.Path]::GetFileName($Parent) -cne 'propr-connect-packaged-stage') {
    throw [InvalidOperationException]::new('bounded-cleanup-rejected')
  }
  if (Test-Path -LiteralPath $Parent) {
    $cleanupItems = @((Get-Item -LiteralPath $Parent -Force -ErrorAction Stop))
    $cleanupItems += @(Get-ChildItem -LiteralPath $Parent -Force -Recurse -ErrorAction Stop)
    if ($cleanupItems.Count -gt 20002) { throw [InvalidOperationException]::new('bounded-cleanup-rejected') }
    foreach ($item in $cleanupItems) {
      $isRoot = [String]::Equals($item.FullName, $Parent, [StringComparison]::OrdinalIgnoreCase)
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ![String]::Equals([IO.Path]::GetFullPath($item.FullName), $item.FullName, [StringComparison]::OrdinalIgnoreCase) -or
          (!$isRoot -and !$item.FullName.StartsWith($Parent + '\', [StringComparison]::OrdinalIgnoreCase)) -or
          ($isRoot -and !$item.PSIsContainer)) {
        throw [InvalidOperationException]::new('bounded-cleanup-rejected')
      }
      $acl = if ($item.PSIsContainer) {
        [IO.Directory]::GetAccessControl($item.FullName, [Security.AccessControl.AccessControlSections]::Owner)
      } else {
        [IO.File]::GetAccessControl($item.FullName, [Security.AccessControl.AccessControlSections]::Owner)
      }
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
      if (@($PrivilegedUser.Value, $Administrators.Value) -cnotcontains $owner.Value) {
        throw [InvalidOperationException]::new('bounded-cleanup-rejected')
      }
    }
    Remove-Item -LiteralPath $Parent -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Parent) { throw [InvalidOperationException]::new('bounded-cleanup-incomplete') }
  }
}

$authenticatedRunnerTemp = $null
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
try {
  try {
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

    $testUser = 'prpc' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $plainPassword = [Guid]::NewGuid().ToString('N') + 'aA1!'
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$testUser", $securePassword)
    $createdUser = New-LocalUser -Name $testUser -Password $securePassword -PasswordNeverExpires -ErrorAction Stop
    $testUserSid = $createdUser.SID
    if ($null -eq $testUserSid -or $testUser.Length -gt 20) { Stop-PackagedConnect 'artifact-type' }
    $administrators = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
    if (@($administrators | Where-Object { $_.SID.Value -eq $testUserSid.Value }).Count -ne 0) {
      Stop-PackagedConnect 'artifact-type'
    }

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

    $aclEntries = @((Get-Item -LiteralPath $stageParent -Force), (Get-Item -LiteralPath $stageRoot -Force))
    $aclEntries += @(Get-ChildItem -LiteralPath $stageRoot -Force -Recurse -ErrorAction Stop)
    foreach ($item in $aclEntries) { Set-StagedEntryAcl $item $testUserSid $administratorsSid }
    foreach ($item in $aclEntries) { Assert-StagedEntryAcl $item $testUserSid $administratorsSid }

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
        $process = Start-Process `
          -FilePath $node `
          -ArgumentList @('scripts/smoke-packaged-connect.mjs') `
          -WorkingDirectory $desktopDirectory `
          -Credential $credential `
          -LoadUserProfile `
          -Wait `
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
    if ($process.ExitCode -ne 0) {
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
              $failureCategories -ccontains $record.category) {
            $reportedCategories += $record.category
          } elseif ($record.event -cne 'packaged_connect.child_failed') {
            Stop-PackagedConnect 'spawn-failed'
          }
        }
        if ($reportedCategories.Count -ne 1) { Stop-PackagedConnect 'spawn-failed' }
        Stop-PackagedConnect $reportedCategories[0]
      } catch {
        if ($_.Exception.Message -clike 'PROPR_PACKAGED_CONNECT_FAILURE:*') { throw }
        Stop-PackagedConnect 'spawn-failed'
      }
    }
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
  }
} finally {
  try {
    if ($null -ne $stageParent -and $null -ne $authenticatedRunnerTemp -and $null -ne $privilegedSid) {
      Remove-BoundedStage $stageParent $authenticatedRunnerTemp $privilegedSid $administratorsSid
    }
  } catch { $cleanupFailure = $true }
  foreach ($capture in @($stdout, $stderr)) {
    if ($null -ne $capture) {
      try {
        if ([IO.Path]::GetDirectoryName($capture) -cne $authenticatedRunnerTemp -or
            [IO.Path]::GetFileName($capture) -cnotmatch '^propr-connect-[a-f0-9]{32}\.(stdout|stderr)$') {
          throw [InvalidOperationException]::new('bounded-capture-cleanup-rejected')
        }
        Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $capture) { throw [InvalidOperationException]::new('bounded-capture-cleanup-incomplete') }
      } catch { $cleanupFailure = $true }
    }
  }
  if ($null -ne $testUser -and $null -ne $testUserSid) {
    try {
      $account = Get-LocalUser -Name $testUser -ErrorAction Stop
      if ($account.SID.Value -ne $testUserSid.Value -or $testUser -cnotmatch '^prpc[a-f0-9]{12}$') {
        throw [InvalidOperationException]::new('bounded-account-cleanup-rejected')
      }
      Remove-LocalUser -Name $testUser -ErrorAction Stop
      if ($null -ne (Get-LocalUser -Name $testUser -ErrorAction SilentlyContinue)) {
        throw [InvalidOperationException]::new('bounded-account-cleanup-incomplete')
      }
    } catch { $cleanupFailure = $true }
  }
}

if ($null -eq $primaryFailure -and $cleanupFailure) { $primaryFailure = 'artifact-inaccessible' }
if ($null -ne $primaryFailure) {
  if ($failureCategories -cnotcontains $primaryFailure) { $primaryFailure = 'spawn-failed' }
  [Console]::Error.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:$primaryFailure")
  exit 1
}
[Console]::Out.WriteLine("PROPR_WINDOWS_PACKAGED_CONNECT:passed:$Architecture")
