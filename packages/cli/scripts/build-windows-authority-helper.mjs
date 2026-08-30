#!/usr/bin/env node
// Explicit, Windows-only build for the committed authority supervisor.
// Runtime and ordinary source builds never invoke this script or a compiler.

import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WindowsHelperBuildError,
  assertModernRoslynVersion,
  fixedBuildDiagnostic,
  publishWindowsBuildArtifactNoReplace,
  runBoundedBuildTool,
  validateNativeWindowsDirectories,
} from "./windows-authority-build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const source = join(cliDir, "native", "windows-authority-supervisor.cs");
const launcherSource = join(cliDir, "native", "windows-authority-broker.c");
const bootstrapSource = join(cliDir, "native", "windows-authority-bootstrap.c");
const outputDirectory = join(cliDir, "native", "prebuilds", "win32-anycpu");
const output = join(outputDirectory, "connect-authority-supervisor.exe");
const manifestPath = join(outputDirectory, "connect-authority-supervisor.manifest.json");
const signaturePath = join(outputDirectory, "connect-authority-supervisor.manifest.sig");
const launcherOutputDirectory = join(cliDir, "native", "prebuilds", "win32-x64");
const launcherOutput = join(launcherOutputDirectory, "connect-authority-broker.exe");
const bootstrapOutput = join(launcherOutputDirectory, "connect-authority-bootstrap.exe");
const smokeFixtureSource = join(cliDir, "..", "..", "scripts", "fixtures", "windows-connect-docker-fixture.c");
const smokeFixtureOutput = join(cliDir, "..", "..", "scripts", "fixtures", "windows-connect-docker-fixture.exe");
const validation = process.argv.includes("--validation");
const nonce = randomBytes(32).toString("hex");
const protocolVersion = 2;
const sourceSha256 = "68b38a53d073b032e9ed0c1f5e9c8a69c306b399524b654a691e3eb13d271aff";
const launcherSourceSha256 = "30347ad0d3bc382b115977439db72538afab176d34e59a68426060d7ba51c071";
const bootstrapSourceSha256 = "1b4dd2771e235bb1a4912095667f804a5611397b2706a4db1f7fe9357f7f975e";
const bootstrapSha256 = "a633479040f27b4a8fab4fb982167803d05ecfdbb9063c3b76e25116575d8087";
const smokeFixtureSourceSha256 = "3dac9791aa8c9f1dbe6f731bd72277e2b551bac94b72e50c66b71cb87164556c";
let emergencyBuildWorkspace;

process.once("uncaughtException", (error) => {
  if (emergencyBuildWorkspace) rmSync(emergencyBuildWorkspace, { recursive: true, force: true });
  process.stderr.write(`${fixedBuildDiagnostic(error)}\n`);
  process.exitCode = 1;
});
process.once("unhandledRejection", (error) => {
  if (emergencyBuildWorkspace) rmSync(emergencyBuildWorkspace, { recursive: true, force: true });
  process.stderr.write(`${fixedBuildDiagnostic(error)}\n`);
  process.exitCode = 1;
});

if (process.platform !== "win32") {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "SPAWN_ERROR");
}
if (validation === process.argv.includes("--production")) {
  throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function heldIdentity(path, retain = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let complete = false;
  try {
    const stat = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) {
      throw new Error("build input identity is unavailable");
    }
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("build input changed while held");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw new Error("build input changed while held");
    }
    complete = true;
    return { bytes, device: stat.dev.toString(10), file: stat.ino.toString(10), ...(retain ? { fd } : {}) };
  } finally {
    if (!retain || !complete) closeSync(fd);
  }
}

function verifyStagedLease(path, fd, expectedBytes) {
  const held = fstatSync(fd, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  if (!held.isFile() || held.nlink !== 1n || named.isSymbolicLink()
    || held.dev !== named.dev || held.ino !== named.ino || held.size !== BigInt(expectedBytes.byteLength)) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
  }
  const actual = Buffer.alloc(expectedBytes.byteLength);
  let offset = 0;
  while (offset < actual.byteLength) {
    const count = readSync(fd, actual, offset, actual.byteLength - offset, offset);
    if (count <= 0) throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
    offset += count;
  }
  if (sha256(actual) !== sha256(expectedBytes)) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
  }
}

function authoritativeDirectoryInventory(root) {
  const hash = createHash("sha256");
  const inputs = [];
  let count = 0;
  let bytes = 0n;
  const visit = (directory, relative) => {
    const namedDirectory = lstatSync(directory, { bigint: true });
    if (!namedDirectory.isDirectory() || namedDirectory.isSymbolicLink()) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.isSymbolicLink()) throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
      const path = join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, childRelative);
      else if (entry.isFile()) {
        const held = heldIdentity(path);
        count += 1;
        bytes += BigInt(held.bytes.byteLength);
        if (count > 30_000 || bytes > 1024n * 1024n * 1024n) {
          throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
        }
        hash.update(Buffer.from(`${childRelative.length}:${childRelative}:`, "utf8"));
        const digest = sha256(held.bytes);
        hash.update(Buffer.from(digest, "ascii"));
        inputs.push({ path, sha256: digest });
      } else throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
    }
  };
  visit(root, "");
  return { sha256: hash.digest("hex"), files: count, bytes: bytes.toString(10), inputs };
}

let bootstrapLeaseSequence = 0;
async function runAuthorityLeasedBuildTool(command, args, options, rawInputs) {
  const unique = new Map();
  for (const input of rawInputs) {
    if (!input || typeof input.path !== "string" || !/^[0-9a-f]{64}$/u.test(input.sha256)
      || /[\0\r\n]/u.test(input.path)) throw new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT");
    if (input.tool === true && options.allowUnsignedTool !== true
      && (input.signatureKind !== "E" || !/^[0-9a-f]{64}$/u.test(input.authenticodeLeafSha256)
        || !/^[0-9a-f]{64}$/u.test(input.authenticodeSpkiSha256))) {
      throw new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT");
    }
    unique.set(input.path.toLowerCase(), input);
  }
  if (unique.size < 1 || unique.size > 30_000) {
    throw new WindowsHelperBuildError(options.stage, "OVERSIZED_OUTPUT");
  }
  const body = Buffer.from(`PROPR_BUILD_LEASE_V1\n${[...unique.values()]
    .map((input) => input.tool === true && options.allowUnsignedTool !== true
      ? `T ${input.sha256} ${input.signatureKind} ${input.authenticodeLeafSha256} ${input.authenticodeSpkiSha256} ${input.path}\n`
      : `F ${input.sha256} ${input.path}\n`).join("")}`, "utf8");
  if (body.byteLength > 64 * 1024 * 1024) throw new WindowsHelperBuildError(options.stage, "OVERSIZED_OUTPUT");
  const manifest = join(buildWorkspace, `.lease-${bootstrapLeaseSequence += 1}.txt`);
  writeFileSync(manifest, body, { flag: "wx", mode: 0o600 });
  const manifestDigest = sha256(body);
  const authority = spawn(bootstrapOutput, ["lease-build-inputs-v1", manifest, manifestDigest], {
    shell: false,
    windowsHide: true,
    env: {},
    stdio: ["pipe", "pipe", "pipe", bootstrapAuthority.fd],
  });
  authority.stdin.on("error", () => {});
  let ready = Buffer.alloc(0);
  let stderrBytes = 0;
  const readiness = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new WindowsHelperBuildError(options.stage, "STALLED")), 10_000);
    const finish = (error) => {
      clearTimeout(timer);
      authority.removeAllListeners("error");
      authority.removeAllListeners("exit");
      if (error) rejectReady(error); else resolveReady();
    };
    authority.once("error", () => finish(new WindowsHelperBuildError(options.stage, "SPAWN_ERROR")));
    authority.once("exit", () => finish(new WindowsHelperBuildError(options.stage, "NONZERO_EMPTY_OUTPUT")));
    authority.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 0) finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
    });
    authority.stdout.on("data", (chunk) => {
      ready = Buffer.concat([ready, Buffer.from(chunk)]);
      if (ready.byteLength > 2 || (ready.byteLength === 2 && !ready.equals(Buffer.from("R\n")))) {
        finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
      } else if (ready.byteLength === 2) finish();
    });
  });
  try {
    await readiness;
    return runBoundedBuildTool(command, args, options);
  } finally {
    authority.stdin.end(Buffer.from("X"));
    const authorityReleased = await new Promise((resolveExit) => {
      if (authority.exitCode !== null) resolveExit(authority.exitCode === 0);
      else {
        const timer = setTimeout(() => { authority.kill(); resolveExit(false); }, 5_000);
        authority.once("exit", (code) => { clearTimeout(timer); resolveExit(code === 0); });
      }
    });
    rmSync(manifest, { force: true });
    if (!authorityReleased) throw new WindowsHelperBuildError(options.stage, "NONZERO_EMPTY_OUTPUT");
  }
}

// Bootstrap only from the already audited, checksum-pinned native probe.  Its
// GetWindowsDirectoryW/GetSystemWindowsDirectoryW result is independent of the
// runner's drive, architecture, PATH, SystemRoot and windir.  Unlike an object
// manager GLOBALROOT name, the resulting DOS path is a valid CreateProcessW
// application name.
const committedBootstrapSource = heldIdentity(bootstrapSource, true);
const bootstrapAuthority = heldIdentity(bootstrapOutput, true);
if (sha256(committedBootstrapSource.bytes) !== bootstrapSourceSha256
  || sha256(bootstrapAuthority.bytes) !== bootstrapSha256) {
  closeSync(committedBootstrapSource.fd);
  closeSync(bootstrapAuthority.fd);
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
let bootstrapPaths;
try {
  const nativePaths = runBoundedBuildTool(bootstrapOutput, ["system-paths-v1"], {
    stage: "BUILD_COMPILER", timeout: 5_000, maxBytes: 4096, sensitiveValues: [bootstrapOutput],
  });
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(nativePaths.stdout).split(/\r?\n/u);
  if (lines.length !== 4 || lines[3] !== "") {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  bootstrapPaths = validateNativeWindowsDirectories({
    windowsDirectory: lines[0],
    systemWindowsDirectory: lines[1],
    systemDirectory: lines[2],
  });
  const after = heldIdentity(bootstrapOutput);
  if (after.device !== bootstrapAuthority.device || after.file !== bootstrapAuthority.file
    || sha256(after.bytes) !== bootstrapSha256) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
} catch (error) {
  closeSync(committedBootstrapSource.fd);
  closeSync(bootstrapAuthority.fd);
  throw error;
}
const trustedPowerShell = realpathSync.native(join(
  bootstrapPaths.systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe",
));
if (!/^[A-Za-z]:\\/u.test(trustedPowerShell)
  || dirname(dirname(dirname(trustedPowerShell))).toLowerCase() !== bootstrapPaths.systemDirectory.toLowerCase()) {
  closeSync(committedBootstrapSource.fd);
  closeSync(bootstrapAuthority.fd);
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
const heldPowerShell = heldIdentity(trustedPowerShell, true);
mkdirSync(outputDirectory, { recursive: true });
mkdirSync(launcherOutputDirectory, { recursive: true });
emergencyBuildWorkspace = join(outputDirectory, `.propr-build-${nonce}`);
const resolver = String.raw`
$ErrorActionPreference='Stop'
$windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$system=[Environment]::SystemDirectory
$systemWindows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
if([string]::IsNullOrWhiteSpace($windows)-or[string]::IsNullOrWhiteSpace($system)-or[string]::IsNullOrWhiteSpace($programFilesX86)-or
   $windows-ne$env:PROPR_BUILD_WINDOWS_DIRECTORY-or$system-ne$env:PROPR_BUILD_SYSTEM_DIRECTORY-or
   $systemWindows-ne$env:PROPR_BUILD_SYSTEM_WINDOWS_DIRECTORY){exit 31}
$workspace=[IO.Path]::Combine($env:PROPR_BUILD_STAGING_PARENT,('.propr-build-'+$env:PROPR_BUILD_NONCE))
if([IO.Directory]::Exists($workspace)-or[IO.File]::Exists($workspace)){exit 42}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$administrators=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($identity.User)
$security.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation=[Security.AccessControl.PropagationFlags]::None
foreach($sid in @($identity.User,$administrators,$systemSid)){
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$propagation,[Security.AccessControl.AccessControlType]::Allow))
}
[IO.Directory]::CreateDirectory($workspace,$security)|Out-Null
$workspaceAcl=Get-Acl -LiteralPath $workspace
$workspaceOwner=([Security.Principal.NTAccount]$workspaceAcl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
if(-not$workspaceAcl.AreAccessRulesProtected-or$workspaceOwner-ne$identity.User.Value){exit 43}
$authorizedSubjects=@(
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
)
function Test-AuthorizedMicrosoftFile([string]$path){
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  return $signature.Status-eq'Valid'-and$authorizedSubjects-ccontains$signature.SignerCertificate.Subject
}
$currentPowerShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
if($currentPowerShell-ne$env:PROPR_BUILD_POWERSHELL-or-not(Test-AuthorizedMicrosoftFile $currentPowerShell)){exit 44}
$vswhere=[IO.Path]::Combine($programFilesX86,'Microsoft Visual Studio','Installer','vswhere.exe')
if(-not(Test-AuthorizedMicrosoftFile $vswhere)){exit 32}
$installation=& $vswhere -latest -products '*' -version '[17.14,17.15)' -requires Microsoft.VisualStudio.Component.Roslyn.Compiler -property installationPath
if($LASTEXITCODE-ne0-or[string]::IsNullOrWhiteSpace($installation)-or$installation.Contains([char]10)){exit 33}
$compiler=[IO.Path]::Combine($installation.Trim(),'MSBuild','Current','Bin','Roslyn','csc.exe')
if(-not(Test-AuthorizedMicrosoftFile $compiler)){exit 34}
$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).ProductVersion
if($version-notmatch'^4\.14\.'){exit 35}
$toolsets=@(Get-ChildItem -LiteralPath ([IO.Path]::Combine($installation.Trim(),'VC','Tools','MSVC')) -Directory|Where-Object{$_.Name-match'^14\.44\.'})
if($toolsets.Count-ne1){exit 38}
$nativeCompiler=[IO.Path]::Combine($toolsets[0].FullName,'bin','Hostx64','x64','cl.exe')
$nativeLinker=[IO.Path]::Combine($toolsets[0].FullName,'bin','Hostx64','x64','link.exe')
if(-not(Test-AuthorizedMicrosoftFile $nativeCompiler)){exit 39}
if(-not(Test-AuthorizedMicrosoftFile $nativeLinker)){exit 41}
$sdkRoot=[IO.Path]::Combine($programFilesX86,'Windows Kits','10')
$sdkVersions=@(Get-ChildItem -LiteralPath ([IO.Path]::Combine($sdkRoot,'Include')) -Directory|Where-Object{$_.Name-match'^10\.0\.26100\.'})
if($sdkVersions.Count-ne1){exit 40}
$sdkVersion=$sdkVersions[0].Name
$nativeIncludes=@(
  [IO.Path]::Combine($toolsets[0].FullName,'include'),
  [IO.Path]::Combine($sdkRoot,'Include',$sdkVersion,'ucrt'),
  [IO.Path]::Combine($sdkRoot,'Include',$sdkVersion,'shared'),
  [IO.Path]::Combine($sdkRoot,'Include',$sdkVersion,'um')
)
$nativeLibraries=@(
  [IO.Path]::Combine($toolsets[0].FullName,'lib','x64'),
  [IO.Path]::Combine($sdkRoot,'Lib',$sdkVersion,'ucrt','x64'),
  [IO.Path]::Combine($sdkRoot,'Lib',$sdkVersion,'um','x64')
)
$referenceRoot=[IO.Path]::Combine($programFilesX86,'Reference Assemblies','Microsoft','Framework','.NETFramework','v4.8')
$references=@('mscorlib.dll','System.dll','System.Core.dll','System.Numerics.dll','System.Web.Extensions.dll')|ForEach-Object{[IO.Path]::Combine($referenceRoot,$_)}
foreach($reference in $references){
  if(-not(Test-Path -LiteralPath $reference -PathType Leaf)){exit 36}
  $acl=Get-Acl -LiteralPath $reference
  if($acl.Owner-notmatch'^(NT SERVICE\\TrustedInstaller|BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$'){exit 37}
}
$document=[ordered]@{windowsDirectory=$windows;systemWindowsDirectory=$windows;systemDirectory=$system;buildWorkspace=$workspace;compiler=$compiler;compilerVersion=$version;nativeCompiler=$nativeCompiler;nativeLinker=$nativeLinker;nativeIncludes=$nativeIncludes;nativeLibraries=$nativeLibraries;references=$references}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
[Console]::Out.Write(($document|ConvertTo-Json -Compress))
`;

let resolvedToolchain;
try {
  const resolved = runBoundedBuildTool(trustedPowerShell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", resolver,
  ], {
    stage: "BUILD_COMPILER",
    timeout: 15_000,
    maxBytes: 16 * 1024,
    env: {
      SystemRoot: bootstrapPaths.windowsDirectory,
      PROPR_BUILD_WINDOWS_DIRECTORY: bootstrapPaths.windowsDirectory,
      PROPR_BUILD_SYSTEM_WINDOWS_DIRECTORY: bootstrapPaths.systemWindowsDirectory,
      PROPR_BUILD_SYSTEM_DIRECTORY: bootstrapPaths.systemDirectory,
      PROPR_BUILD_STAGING_PARENT: outputDirectory,
      PROPR_BUILD_NONCE: nonce,
      PROPR_BUILD_POWERSHELL: trustedPowerShell,
    },
    sensitiveValues: [trustedPowerShell, bootstrapPaths.windowsDirectory, bootstrapPaths.systemDirectory],
  });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.stdout);
  resolvedToolchain = JSON.parse(text);
} catch (error) {
  throw error instanceof WindowsHelperBuildError
    ? error
    : new WindowsHelperBuildError("BUILD_COMPILER", "SPAWN_ERROR", error);
}
if (!resolvedToolchain || typeof resolvedToolchain !== "object" || Array.isArray(resolvedToolchain)
  || Object.keys(resolvedToolchain).sort().join("\0") !== [
    "buildWorkspace", "compiler", "compilerVersion", "nativeCompiler", "nativeLinker", "nativeIncludes", "nativeLibraries", "references", "systemDirectory", "systemWindowsDirectory", "windowsDirectory",
  ].sort().join("\0")
  || typeof resolvedToolchain.windowsDirectory !== "string"
  || typeof resolvedToolchain.systemWindowsDirectory !== "string"
  || typeof resolvedToolchain.systemDirectory !== "string"
  || typeof resolvedToolchain.buildWorkspace !== "string"
  || typeof resolvedToolchain.compiler !== "string"
  || typeof resolvedToolchain.compilerVersion !== "string"
  || typeof resolvedToolchain.nativeCompiler !== "string"
  || typeof resolvedToolchain.nativeLinker !== "string"
  || !Array.isArray(resolvedToolchain.nativeIncludes) || resolvedToolchain.nativeIncludes.length !== 4
  || !resolvedToolchain.nativeIncludes.every((item) => typeof item === "string")
  || !Array.isArray(resolvedToolchain.nativeLibraries) || resolvedToolchain.nativeLibraries.length !== 3
  || !resolvedToolchain.nativeLibraries.every((item) => typeof item === "string")
  || !Array.isArray(resolvedToolchain.references)
  || resolvedToolchain.references.length !== 5
  || !resolvedToolchain.references.every((item) => typeof item === "string")) {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
assertModernRoslynVersion(resolvedToolchain.compilerVersion.split(/[+-]/u, 1)[0]);
const windowsDirectory = realpathSync.native(resolvedToolchain.windowsDirectory);
const systemWindowsDirectory = realpathSync.native(resolvedToolchain.systemWindowsDirectory);
const systemDirectory = realpathSync.native(resolvedToolchain.systemDirectory);
const buildWorkspace = realpathSync.native(resolvedToolchain.buildWorkspace);
emergencyBuildWorkspace = buildWorkspace;
const compiler = realpathSync.native(resolvedToolchain.compiler);
const nativeCompiler = realpathSync.native(resolvedToolchain.nativeCompiler);
const nativeLinker = realpathSync.native(resolvedToolchain.nativeLinker);
const references = resolvedToolchain.references.map((item) => realpathSync.native(item));
const nativeIncludes = resolvedToolchain.nativeIncludes.map((item) => realpathSync.native(item));
const nativeLibraries = resolvedToolchain.nativeLibraries.map((item) => realpathSync.native(item));
if (!statSync(windowsDirectory).isDirectory() || !statSync(systemWindowsDirectory).isDirectory()
  || !statSync(systemDirectory).isDirectory()
  || !compiler.toLowerCase().includes("\\msbuild\\current\\bin\\roslyn\\csc.exe")
  || compiler.toLowerCase().includes("\\microsoft.net\\framework")) {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
}
if (windowsDirectory.toLowerCase() !== bootstrapPaths.windowsDirectory.toLowerCase()
  || systemWindowsDirectory.toLowerCase() !== bootstrapPaths.systemWindowsDirectory.toLowerCase()
  || systemDirectory.toLowerCase() !== bootstrapPaths.systemDirectory.toLowerCase()) {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
if (dirname(buildWorkspace).toLowerCase() !== realpathSync.native(outputDirectory).toLowerCase()
  || basename(buildWorkspace) !== `.propr-build-${nonce}`) {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
// The resolver is complete. PowerShell is no longer part of the build, while
// the immutable bootstrap source/image stay held for every native build-input
// lease and through final publication.
closeSync(heldPowerShell.fd);
heldPowerShell.fd = undefined;

const heldCompiler = heldIdentity(compiler, true);
const heldNativeCompiler = heldIdentity(nativeCompiler, true);
const heldNativeLinker = heldIdentity(nativeLinker, true);
const heldReferences = references.map((item) => ({ path: item, ...heldIdentity(item, true) }));
const nativeInputInventories = [...nativeIncludes, ...nativeLibraries].map((path) => ({
  path,
  ...authoritativeDirectoryInventory(path),
}));
const committedSource = heldIdentity(source, true);
const sourceBytes = committedSource.bytes;
if (sha256(sourceBytes) !== sourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedLauncherSource = heldIdentity(launcherSource, true);
const launcherSourceBytes = committedLauncherSource.bytes;
if (sha256(launcherSourceBytes) !== launcherSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedSmokeFixtureSource = heldIdentity(smokeFixtureSource, true);
if (sha256(committedSmokeFixtureSource.bytes) !== smokeFixtureSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const readBuildToolSignerPolicy = (path) => {
  const result = runBoundedBuildTool(bootstrapOutput, ["signer-pins-v1", path], {
    stage: "BUILD_COMPILER", timeout: 10_000, maxBytes: 256, sensitiveValues: [path, bootstrapOutput],
  });
  const match = /^E ([0-9a-f]{64}) ([0-9a-f]{64})\r?\n$/u.exec(
    new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
  );
  if (!match) throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  return { signatureKind: "E", authenticodeLeafSha256: match[1], authenticodeSpkiSha256: match[2] };
};
const heldInput = (item) => ({
  path: item.path,
  sha256: sha256(item.bytes),
  ...(item.tool ? { tool: true, ...readBuildToolSignerPolicy(item.path) } : {}),
});
const managedToolInputs = [heldInput({ path: compiler, bytes: heldCompiler.bytes, tool: true }), ...heldReferences.map(heldInput)];
const nativeCompilerInputs = [heldInput({ path: nativeCompiler, bytes: heldNativeCompiler.bytes, tool: true }),
  ...nativeInputInventories.slice(0, nativeIncludes.length).flatMap((item) => item.inputs)];
const nativeLinkerInputs = [heldInput({ path: nativeLinker, bytes: heldNativeLinker.bytes, tool: true }),
  ...nativeInputInventories.slice(nativeIncludes.length).flatMap((item) => item.inputs)];

// Remove the previous complete release set before any expensive work. Final
// publication below is no-replace; an ABA entry created during the build makes
// publication fail rather than being overwritten or deleted.
rmSync(output, { force: true });
rmSync(manifestPath, { force: true });
rmSync(signaturePath, { force: true });
rmSync(launcherOutput, { force: true });
rmSync(smokeFixtureOutput, { force: true });
const temporaryOutput = join(buildWorkspace, "connect-authority-supervisor.exe");
const temporarySource = join(buildWorkspace, "windows-authority-supervisor.cs");
const temporaryPolicy = join(buildWorkspace, "windows-authority-signing-policy.txt");
const temporaryLauncherSource = join(buildWorkspace, "windows-authority-launcher.c");
const temporaryLauncher = join(buildWorkspace, "windows-authority-launcher.exe");
const temporaryLauncherObject = join(buildWorkspace, "windows-authority-launcher.obj");
const temporarySmokeFixtureSource = join(buildWorkspace, "windows-connect-docker-fixture.c");
const temporarySmokeFixtureObject = join(buildWorkspace, "windows-connect-docker-fixture.obj");
const temporarySmokeFixture = join(buildWorkspace, "windows-connect-docker-fixture.exe");
let sourceLease;
let policyLease;
let launcherSourceLease;
let smokeFixtureSourceLease;
let signToolLease;
let publishedOutput = false;
let publishedLauncher = false;
let publishedManifest = false;
let publishedSignature = false;
let publishedSmokeFixture = false;
function closeBuildInputLeases() {
  for (const lease of [signToolLease, heldPowerShell, bootstrapAuthority, committedBootstrapSource,
    committedSmokeFixtureSource, committedLauncherSource, committedSource,
    ...heldReferences, heldNativeLinker, heldNativeCompiler, heldCompiler]) {
    if (lease?.fd === undefined) continue;
    try { closeSync(lease.fd); } catch { /* Fixed build diagnostic owns failure output. */ }
    lease.fd = undefined;
  }
}
try {
  sourceLease = openSync(temporarySource, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  let sourceOffset = 0;
  while (sourceOffset < sourceBytes.byteLength) {
    const count = writeSync(sourceLease, sourceBytes, sourceOffset, sourceBytes.byteLength - sourceOffset, sourceOffset);
    if (count <= 0) throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
    sourceOffset += count;
  }
  fsyncSync(sourceLease);
  const stagedSource = fstatSync(sourceLease, { bigint: true });
  if (!stagedSource.isFile() || stagedSource.size !== BigInt(sourceBytes.byteLength)) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
  }
  closeSync(sourceLease);
  sourceLease = openSync(temporarySource, constants.O_RDONLY | constants.O_NOFOLLOW);
  launcherSourceLease = openSync(temporaryLauncherSource, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  let launcherOffset = 0;
  while (launcherOffset < launcherSourceBytes.byteLength) {
    const count = writeSync(launcherSourceLease, launcherSourceBytes, launcherOffset,
      launcherSourceBytes.byteLength - launcherOffset, launcherOffset);
    if (count <= 0) throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
    launcherOffset += count;
  }
  fsyncSync(launcherSourceLease);
  closeSync(launcherSourceLease);
  launcherSourceLease = openSync(temporaryLauncherSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  const args = [
    "/nologo", "/noconfig", "/nostdlib+", "/target:exe", "/platform:anycpu", "/optimize+", "/deterministic+",
    `/out:${temporaryOutput}`,
    ...references.map((item) => `/reference:${item}`),
    temporarySource,
  ];
  smokeFixtureSourceLease = openSync(temporarySmokeFixtureSource, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  if (writeSync(smokeFixtureSourceLease, committedSmokeFixtureSource.bytes, 0,
    committedSmokeFixtureSource.bytes.byteLength, 0) !== committedSmokeFixtureSource.bytes.byteLength) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
  }
  fsyncSync(smokeFixtureSourceLease);
  closeSync(smokeFixtureSourceLease);
  smokeFixtureSourceLease = openSync(temporarySmokeFixtureSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  const compilerOptions = {
    stage: "BUILD_COMPILER",
    env: { SystemRoot: windowsDirectory, TEMP: buildWorkspace, TMP: buildWorkspace },
    timeout: 30_000,
    maxBytes: 64 * 1024,
    sensitiveValues: [compiler, source, temporarySource, temporaryOutput, buildWorkspace, ...references],
  };
  await runAuthorityLeasedBuildTool(compiler, args, compilerOptions, [
    ...managedToolInputs, { path: temporarySource, sha256: sha256(sourceBytes) },
  ]);
  const deterministicFirst = heldIdentity(temporaryOutput);
  rmSync(temporaryOutput, { force: true });
  await runAuthorityLeasedBuildTool(compiler, args, compilerOptions, [
    ...managedToolInputs, { path: temporarySource, sha256: sha256(sourceBytes) },
  ]);
  const deterministicSecond = heldIdentity(temporaryOutput);
  if (sha256(deterministicFirst.bytes) !== sha256(deterministicSecond.bytes)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
  }
  const nativeArgs = [
    "/nologo", "/TC", "/O2", "/MT", "/GS", "/guard:cf", "/Brepro", "/DUNICODE", "/D_UNICODE",
    "/c", `/Fo${temporaryLauncherObject}`, temporaryLauncherSource,
  ];
  const nativeOptions = {
    stage: "BUILD_COMPILER",
    env: {
      SystemRoot: windowsDirectory,
      TEMP: buildWorkspace,
      TMP: buildWorkspace,
      PATH: systemDirectory,
      INCLUDE: nativeIncludes.join(";"),
      LIB: nativeLibraries.join(";"),
    },
    timeout: 30_000,
    maxBytes: 64 * 1024,
    sensitiveValues: [nativeCompiler, nativeLinker, launcherSource, temporaryLauncherSource, temporaryLauncher,
      temporaryLauncherObject, buildWorkspace, ...resolvedToolchain.nativeIncludes, ...resolvedToolchain.nativeLibraries],
  };
  await runAuthorityLeasedBuildTool(nativeCompiler, nativeArgs, nativeOptions, [
    ...nativeCompilerInputs, { path: temporaryLauncherSource, sha256: sha256(launcherSourceBytes) },
  ]);
  const nativeLinkArgs = [
    "/NOLOGO", "/Brepro", "/SUBSYSTEM:CONSOLE", "/MANIFEST:EMBED", `/OUT:${temporaryLauncher}`,
    temporaryLauncherObject, "kernel32.lib", "advapi32.lib", "bcrypt.lib", "wintrust.lib", "user32.lib",
  ];
  await runAuthorityLeasedBuildTool(nativeLinker, nativeLinkArgs, nativeOptions, [
    ...nativeLinkerInputs, { path: temporaryLauncherObject, sha256: sha256(heldIdentity(temporaryLauncherObject).bytes) },
  ]);
  const launcherFirst = heldIdentity(temporaryLauncher);
  rmSync(temporaryLauncher, { force: true });
  rmSync(temporaryLauncherObject, { force: true });
  await runAuthorityLeasedBuildTool(nativeCompiler, nativeArgs, nativeOptions, [
    ...nativeCompilerInputs, { path: temporaryLauncherSource, sha256: sha256(launcherSourceBytes) },
  ]);
  await runAuthorityLeasedBuildTool(nativeLinker, nativeLinkArgs, nativeOptions, [
    ...nativeLinkerInputs, { path: temporaryLauncherObject, sha256: sha256(heldIdentity(temporaryLauncherObject).bytes) },
  ]);
  const launcherSecond = heldIdentity(temporaryLauncher);
  if (sha256(launcherFirst.bytes) !== sha256(launcherSecond.bytes)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
  }
  await runAuthorityLeasedBuildTool(nativeCompiler, [
    "/nologo", "/TC", "/O2", "/MT", "/GS", "/guard:cf", "/Brepro", "/DUNICODE", "/D_UNICODE",
    "/c", `/Fo${temporarySmokeFixtureObject}`, temporarySmokeFixtureSource,
  ], nativeOptions, [
    ...nativeCompilerInputs,
    { path: temporarySmokeFixtureSource, sha256: sha256(committedSmokeFixtureSource.bytes) },
  ]);
  await runAuthorityLeasedBuildTool(nativeLinker, [
    "/NOLOGO", "/Brepro", "/SUBSYSTEM:CONSOLE", "/MANIFEST:EMBED", `/OUT:${temporarySmokeFixture}`,
    temporarySmokeFixtureObject, "kernel32.lib",
  ], nativeOptions, [
    ...nativeLinkerInputs,
    { path: temporarySmokeFixtureObject, sha256: sha256(heldIdentity(temporarySmokeFixtureObject).bytes) },
  ]);
  const smokeFixture = heldIdentity(temporarySmokeFixture);
  if (smokeFixture.bytes.length < 1024 || smokeFixture.bytes.length > 256 * 1024
    || smokeFixture.bytes[0] !== 0x4d || smokeFixture.bytes[1] !== 0x5a) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
  }
  const systemPathResult = await runAuthorityLeasedBuildTool(temporaryLauncher, ["system-paths-v1"], {
    stage: "BUILD_COMPILER", timeout: 5_000, maxBytes: 4096, sensitiveValues: [temporaryLauncher],
    allowUnsignedTool: true,
  }, [{ path: temporaryLauncher, sha256: sha256(heldIdentity(temporaryLauncher).bytes), tool: true }]);
  const systemPathText = new TextDecoder("utf-8", { fatal: true }).decode(systemPathResult.stdout);
  const systemPaths = systemPathText.split(/\r?\n/u);
  if (systemPaths.length !== 4 || systemPaths[3] !== ""
    || realpathSync.native(systemPaths[0]).toLowerCase() !== windowsDirectory.toLowerCase()
    || realpathSync.native(systemPaths[1]).toLowerCase() !== systemWindowsDirectory.toLowerCase()
    || realpathSync.native(systemPaths[2]).toLowerCase() !== systemDirectory.toLowerCase()) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  let launcherSha256 = sha256(launcherSecond.bytes);
  let derivedSigningPins = { authenticodeLeafSha256: null, authenticodeSpkiSha256: null };
  if (!validation) {
    const signTool = process.env.PROPR_WINDOWS_SIGNTOOL;
    const certificate = process.env.PROPR_WINDOWS_CODESIGN_SHA1;
    const timestamp = process.env.PROPR_WINDOWS_TIMESTAMP_URL;
    if (!signTool || !parse(signTool).root || !/^[0-9A-Fa-f]{40}$/.test(certificate ?? "")
      || !timestamp?.startsWith("https://")) {
      throw new Error("trusted absolute signtool, signing certificate, and HTTPS timestamp are required");
    }
    signToolLease = heldIdentity(signTool, true);
    const signToolInput = heldInput({ path: signTool, bytes: signToolLease.bytes, tool: true });
    const signPath = async (target) => {
      await runAuthorityLeasedBuildTool(signTool, [
        "sign", "/fd", "SHA256", "/sha1", certificate, "/tr", timestamp, "/td", "SHA256", target,
      ], { stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 64 * 1024, sensitiveValues: [signTool, target] }, [signToolInput]);
      await runAuthorityLeasedBuildTool(signTool, ["verify", "/pa", "/all", "/v", target], {
        stage: "BUILD_OUTPUT", timeout: 30_000, maxBytes: 64 * 1024, sensitiveValues: [signTool, target],
      }, [signToolInput, { path: target, sha256: sha256(heldIdentity(target).bytes) }]);
    };
    const readSigningPins = async () => {
      const outputInput = { path: temporaryOutput, sha256: sha256(heldIdentity(temporaryOutput).bytes), tool: true };
      const pinResult = await runAuthorityLeasedBuildTool(temporaryOutput, ["--print-signing-pins-v1"], {
        stage: "BUILD_OUTPUT", timeout: 10_000, maxBytes: 1024, sensitiveValues: [temporaryOutput],
      }, [outputInput]);
      try {
        const pinText = new TextDecoder("utf-8", { fatal: true }).decode(pinResult.stdout);
        const pins = JSON.parse(pinText);
        if (!pins || typeof pins !== "object" || Array.isArray(pins)
          || Object.keys(pins).sort().join("\0") !== ["authenticodeLeafSha256", "authenticodeSpkiSha256"].sort().join("\0")
          || !/^[0-9a-f]{64}$/.test(pins.authenticodeLeafSha256)
          || !/^[0-9a-f]{64}$/.test(pins.authenticodeSpkiSha256)) throw new Error("pins");
        return pins;
      } catch (error) {
        throw new WindowsHelperBuildError("BUILD_OUTPUT", "NONZERO_OUTPUT", error);
      }
    };

    // First sign the deterministic policy-free image solely to inspect the
    // certificate that the signing service actually embedded. Then rebuild
    // with those derived pins as a named assembly resource, sign the final PE,
    // and require the final certificate/key to be identical.
    await signPath(temporaryOutput);
    derivedSigningPins = await readSigningPins();
    const policyBytes = Buffer.from(`${derivedSigningPins.authenticodeLeafSha256}\n${derivedSigningPins.authenticodeSpkiSha256}\n`, "ascii");
    policyLease = openSync(temporaryPolicy, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    if (writeSync(policyLease, policyBytes, 0, policyBytes.byteLength, 0) !== policyBytes.byteLength) {
      throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
    }
    fsyncSync(policyLease);
    closeSync(policyLease);
    policyLease = openSync(temporaryPolicy, constants.O_RDONLY | constants.O_NOFOLLOW);
    const policyArgs = [...args, `/resource:${temporaryPolicy},Propr.WindowsAuthority.SigningPins`];
    rmSync(temporaryOutput, { force: true });
    await runAuthorityLeasedBuildTool(compiler, policyArgs, {
      ...compilerOptions, sensitiveValues: [...compilerOptions.sensitiveValues, temporaryPolicy],
    }, [...managedToolInputs,
      { path: temporarySource, sha256: sha256(sourceBytes) },
      { path: temporaryPolicy, sha256: sha256(policyBytes) },
    ]);
    const policyFirst = heldIdentity(temporaryOutput);
    rmSync(temporaryOutput, { force: true });
    await runAuthorityLeasedBuildTool(compiler, policyArgs, {
      ...compilerOptions, sensitiveValues: [...compilerOptions.sensitiveValues, temporaryPolicy],
    }, [...managedToolInputs,
      { path: temporarySource, sha256: sha256(sourceBytes) },
      { path: temporaryPolicy, sha256: sha256(policyBytes) },
    ]);
    const policySecond = heldIdentity(temporaryOutput);
    if (sha256(policyFirst.bytes) !== sha256(policySecond.bytes)) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
    }
    await signPath(temporaryOutput);
    const finalPins = await readSigningPins();
    if (finalPins.authenticodeLeafSha256 !== derivedSigningPins.authenticodeLeafSha256
      || finalPins.authenticodeSpkiSha256 !== derivedSigningPins.authenticodeSpkiSha256) {
      throw new WindowsHelperBuildError("BUILD_OUTPUT", "NONZERO_OUTPUT");
    }
    await signPath(temporaryLauncher);
    launcherSha256 = sha256(heldIdentity(temporaryLauncher).bytes);
  }
  const helper = heldIdentity(temporaryOutput);
  if (helper.bytes.length < 1024 || helper.bytes.length > 512 * 1024 || helper.bytes[0] !== 0x4d || helper.bytes[1] !== 0x5a) {
    throw new Error("compiler output is not a bounded PE executable");
  }
  const peOffset = helper.bytes.readUInt32LE(0x3c);
  if (helper.bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("compiler output has invalid PE metadata");
  const optional = peOffset + 24;
  const magic = helper.bytes.readUInt16LE(optional);
  const dataDirectory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  const cliRva = dataDirectory < optional ? 0 : helper.bytes.readUInt32LE(dataDirectory + 14 * 8);
  const sectionCount = helper.bytes.readUInt16LE(peOffset + 6);
  const optionalSize = helper.bytes.readUInt16LE(peOffset + 20);
  const sections = optional + optionalSize;
  let cliOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sections + index * 40;
    const virtualSize = helper.bytes.readUInt32LE(section + 8);
    const virtualAddress = helper.bytes.readUInt32LE(section + 12);
    const rawSize = helper.bytes.readUInt32LE(section + 16);
    const rawAddress = helper.bytes.readUInt32LE(section + 20);
    if (cliRva >= virtualAddress && cliRva < virtualAddress + Math.max(virtualSize, rawSize)) {
      cliOffset = rawAddress + cliRva - virtualAddress;
      break;
    }
  }
  const corFlags = cliOffset < 0 || cliOffset + 20 > helper.bytes.length ? 0 : helper.bytes.readUInt32LE(cliOffset + 16);
  if (cliRva === 0 || cliOffset < 0 || (corFlags & 0x1) === 0 || (corFlags & 0x2) !== 0) {
    throw new Error("compiler output is not a managed AnyCPU PE");
  }
  const helperSha256 = sha256(helper.bytes);
  const launcher = heldIdentity(temporaryLauncher);
  if (launcher.bytes.length < 1024 || launcher.bytes.length > 1024 * 1024
    || launcher.bytes[0] !== 0x4d || launcher.bytes[1] !== 0x5a) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
  }
  const launcherPeOffset = launcher.bytes.readUInt32LE(0x3c);
  if (launcher.bytes.toString("ascii", launcherPeOffset, launcherPeOffset + 4) !== "PE\0\0"
    || launcher.bytes.readUInt16LE(launcherPeOffset + 4) !== 0x8664) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
  }
  const compilerAfter = heldIdentity(compiler);
  if (compilerAfter.device !== heldCompiler.device || compilerAfter.file !== heldCompiler.file || sha256(compilerAfter.bytes) !== sha256(heldCompiler.bytes)) {
    throw new Error("compiler identity changed during the build");
  }
  const nativeCompilerAfter = heldIdentity(nativeCompiler);
  if (nativeCompilerAfter.device !== heldNativeCompiler.device || nativeCompilerAfter.file !== heldNativeCompiler.file
    || sha256(nativeCompilerAfter.bytes) !== sha256(heldNativeCompiler.bytes)) {
    throw new Error("native compiler identity changed during the build");
  }
  const nativeLinkerAfter = heldIdentity(nativeLinker);
  if (nativeLinkerAfter.device !== heldNativeLinker.device || nativeLinkerAfter.file !== heldNativeLinker.file
    || sha256(nativeLinkerAfter.bytes) !== sha256(heldNativeLinker.bytes)) {
    throw new Error("native linker identity changed during the build");
  }
  for (let index = 0; index < references.length; index += 1) {
    const after = heldIdentity(references[index]);
    const before = heldReferences[index];
    if (after.device !== before.device || after.file !== before.file || sha256(after.bytes) !== sha256(before.bytes)) {
      throw new Error("compiler reference identity changed during the build");
    }
  }
  for (const before of nativeInputInventories) {
    const after = authoritativeDirectoryInventory(before.path);
    if (after.sha256 !== before.sha256 || after.files !== before.files || after.bytes !== before.bytes) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
    }
  }
  for (const [path, before] of [[source, committedSource], [launcherSource, committedLauncherSource],
    [smokeFixtureSource, committedSmokeFixtureSource]]) {
    const after = heldIdentity(path);
    if (after.device !== before.device || after.file !== before.file || sha256(after.bytes) !== sha256(before.bytes)) {
      throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
    }
  }
  verifyStagedLease(temporarySource, sourceLease, sourceBytes);
  verifyStagedLease(temporaryLauncherSource, launcherSourceLease, launcherSourceBytes);
  verifyStagedLease(temporarySmokeFixtureSource, smokeFixtureSourceLease, committedSmokeFixtureSource.bytes);
  if (policyLease !== undefined) {
    verifyStagedLease(temporaryPolicy, policyLease, Buffer.from(
      `${derivedSigningPins.authenticodeLeafSha256}\n${derivedSigningPins.authenticodeSpkiSha256}\n`,
      "ascii",
    ));
  }
  const manifest = {
    format: "propr-windows-authority-helper-v2",
    protocolVersion,
    sourceSha256,
    launcherSourceSha256,
    helperSha256,
    launcherSha256,
    pe: { architecture: "anycpu", managed: true, deterministic: true },
    build: {
      compilerSha256: sha256(heldCompiler.bytes),
      launcherCompilerSha256: sha256(heldNativeCompiler.bytes),
      launcherLinkerSha256: sha256(heldNativeLinker.bytes),
      bootstrapSourceSha256,
      bootstrapSha256,
      compilerRelativePath: "VisualStudio/2022/17.14/MSBuild/Current/Bin/Roslyn/csc.exe",
      toolSigners: [
        { name: "compiler", signatureKind: managedToolInputs[0].signatureKind,
          authenticodeLeafSha256: managedToolInputs[0].authenticodeLeafSha256,
          authenticodeSpkiSha256: managedToolInputs[0].authenticodeSpkiSha256 },
        { name: "native-compiler", signatureKind: nativeCompilerInputs[0].signatureKind,
          authenticodeLeafSha256: nativeCompilerInputs[0].authenticodeLeafSha256,
          authenticodeSpkiSha256: nativeCompilerInputs[0].authenticodeSpkiSha256 },
        { name: "native-linker", signatureKind: nativeLinkerInputs[0].signatureKind,
          authenticodeLeafSha256: nativeLinkerInputs[0].authenticodeLeafSha256,
          authenticodeSpkiSha256: nativeLinkerInputs[0].authenticodeSpkiSha256 },
      ],
      references: heldReferences.map((item) => ({
        name: basename(item.path),
        sha256: sha256(item.bytes),
      })),
      nativeInputs: nativeInputInventories.map((item, index) => ({
        name: `input-${index}`, sha256: item.sha256, files: item.files, bytes: item.bytes,
      })),
    },
    trust: validation
      ? { mode: "unsigned-validation", authenticodeLeafSha256: null, authenticodeSpkiSha256: null }
      : {
        mode: "production-signed",
        // These are recomputed from the certificate embedded in the signed PE.
        // Environment pin claims are deliberately ignored.
        authenticodeLeafSha256: derivedSigningPins.authenticodeLeafSha256,
        authenticodeSpkiSha256: derivedSigningPins.authenticodeSpkiSha256,
      },
  };
  if (!validation && (!/^[0-9a-f]{64}$/.test(manifest.trust.authenticodeLeafSha256)
    || !/^[0-9a-f]{64}$/.test(manifest.trust.authenticodeSpkiSha256))) {
    throw new Error("production Authenticode leaf/SPKI pins are required");
  }
  const body = `${canonical(manifest)}\n`;
  let signature = "UNSIGNED-VALIDATION\n";
  if (!validation) {
    const keyPath = process.env.PROPR_WINDOWS_AUTHORITY_MANIFEST_SIGNING_KEY;
    if (!keyPath || !parse(keyPath).root) throw new Error("an absolute release manifest signing key is required");
    const key = createPrivateKey(readFileSync(keyPath));
    signature = `${sign(null, Buffer.from(body), key).toString("base64")}\n`;
  }
  // Publication is no-replace at the final names after every byte and held
  // compiler/reference identity has been verified. Cleanup below proves no
  // compiler output survives a failed build.
  publishWindowsBuildArtifactNoReplace(temporaryOutput, output);
  publishedOutput = true;
  publishWindowsBuildArtifactNoReplace(temporaryLauncher, launcherOutput);
  publishedLauncher = true;
  writeFileSync(manifestPath, body, { flag: "wx" });
  publishedManifest = true;
  writeFileSync(signaturePath, signature, { flag: "wx" });
  publishedSignature = true;
  publishWindowsBuildArtifactNoReplace(temporarySmokeFixture, smokeFixtureOutput);
  publishedSmokeFixture = true;
  closeSync(sourceLease);
  sourceLease = undefined;
  if (policyLease !== undefined) {
    closeSync(policyLease);
    policyLease = undefined;
  }
  closeSync(launcherSourceLease);
  launcherSourceLease = undefined;
  closeSync(smokeFixtureSourceLease);
  smokeFixtureSourceLease = undefined;
  rmSync(temporarySource, { force: true });
  rmSync(temporaryPolicy, { force: true });
  rmSync(temporaryLauncherSource, { force: true });
  rmSync(temporaryLauncherObject, { force: true });
  rmSync(temporarySmokeFixtureSource, { force: true });
  rmSync(temporarySmokeFixtureObject, { force: true });
  rmSync(buildWorkspace, { recursive: true, force: true });
  emergencyBuildWorkspace = undefined;
  closeBuildInputLeases();
} catch (error) {
  closeBuildInputLeases();
  if (sourceLease !== undefined) {
    try { closeSync(sourceLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  if (policyLease !== undefined) {
    try { closeSync(policyLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  if (launcherSourceLease !== undefined) {
    try { closeSync(launcherSourceLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  if (smokeFixtureSourceLease !== undefined) {
    try { closeSync(smokeFixtureSourceLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  rmSync(temporarySource, { force: true });
  rmSync(temporaryPolicy, { force: true });
  rmSync(temporaryLauncherSource, { force: true });
  rmSync(temporaryLauncher, { force: true });
  rmSync(temporaryLauncherObject, { force: true });
  rmSync(temporarySmokeFixtureSource, { force: true });
  rmSync(temporarySmokeFixtureObject, { force: true });
  rmSync(temporarySmokeFixture, { force: true });
  rmSync(temporaryOutput, { force: true });
  rmSync(buildWorkspace, { recursive: true, force: true });
  emergencyBuildWorkspace = undefined;
  if (publishedOutput) rmSync(output, { force: true });
  if (publishedManifest) rmSync(manifestPath, { force: true });
  if (publishedSignature) rmSync(signaturePath, { force: true });
  if (publishedLauncher) rmSync(launcherOutput, { force: true });
  if (publishedSmokeFixture) rmSync(smokeFixtureOutput, { force: true });
  const failure = error instanceof WindowsHelperBuildError
    ? error
    : new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN", error);
  process.stderr.write(`${fixedBuildDiagnostic(failure)}\n`);
  process.exitCode = 1;
}
