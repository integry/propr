export const windowsFixtureAclSource = String.raw`
$ErrorActionPreference='Stop'
function Set-ProprFixtureAcl {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateSet('directory','file')][string]$EntryKind,
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$EntryPath
  )
  try {
    if(-not [IO.Path]::IsPathRooted($EntryPath)){exit 40}
    $canonicalPath=[IO.Path]::GetFullPath($EntryPath)
    if(-not [String]::Equals($canonicalPath,$EntryPath,[StringComparison]::OrdinalIgnoreCase)){exit 40}
  } catch { exit 40 }
  try {
    $item=Get-Item -LiteralPath $canonicalPath
    $directory=$EntryKind -eq 'directory'
    if($directory -ne $item.PSIsContainer){exit 41}
  } catch { exit 41 }
  try {
    $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
    if($null -eq $current){exit 42}
  } catch { exit 42 }
  try {
    $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  } catch { exit 43 }
  try {
    $acl=Get-Acl -LiteralPath $canonicalPath
  } catch { exit 44 }
  try {
    $null=$acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.Access)){$null=$acl.RemoveAccessRuleSpecific($existing)}
  } catch { exit 45 }
  try {
    foreach($identity in @($current,$system,$admins)){
      $rights=[Security.AccessControl.FileSystemRights]::FullControl
      $accessType=[Security.AccessControl.AccessControlType]::Allow
      $rule=if($directory){
        $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation=[Security.AccessControl.PropagationFlags]::None
        [Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,$inheritance,$propagation,$accessType)
      }else{[Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,$accessType)}
      $null=$acl.AddAccessRule($rule)
    }
  } catch { exit 46 }
  try {
    $null=Set-Acl -LiteralPath $canonicalPath -AclObject $acl
  } catch { exit 47 }
}
try {
  Set-ProprFixtureAcl -EntryKind $env:PROPR_FIXTURE_ACL_KIND -EntryPath $env:PROPR_FIXTURE_ACL_PATH
} catch {
  exit 40
}`;

export const encodedWindowsFixtureAcl = Buffer.from(windowsFixtureAclSource, 'utf16le').toString('base64');
