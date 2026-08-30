#!/usr/bin/env node
// Explicit, Windows-only build for the committed authority supervisor.
// Runtime and ordinary source builds never invoke this script or a compiler.

import { createHash, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
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
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WindowsHelperBuildError,
  WINDOWS_BUILD_TOOLCHAIN_PROFILES,
  assertModernRoslynVersion,
  authorizeWindowsBuildToolDependencies,
  authorizeWindowsBuildToolSigner,
  awaitWindowsBuildLeaseReadiness,
  canonicalWindowsBuildSourceBytes,
  fixedBuildDiagnostic,
  formatWindowsBuildProgressFrame,
  planWindowsBuildLeaseReadiness,
  publishWindowsBuildArtifactNoReplace,
  runBoundedBuildTool,
  runBoundedProgressBuildTool,
  validateNativeWindowsDirectories,
  windowsBuildLeaseProgressFrames,
} from "./windows-authority-build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const source = join(cliDir, "native", "windows-authority-supervisor.cs");
const serviceSource = join(cliDir, "native", "windows-connect-authority-service.cs");
const serviceInstallerSource = join(cliDir, "native", "windows-connect-authority.wxs");
const launcherSource = join(cliDir, "native", "windows-authority-broker.c");
const bootstrapSource = join(cliDir, "native", "windows-authority-bootstrap.c");
const outputDirectory = join(cliDir, "native", "prebuilds", "win32-anycpu");
const output = join(outputDirectory, "connect-authority-supervisor.exe");
const manifestPath = join(outputDirectory, "connect-authority-supervisor.manifest.json");
const signaturePath = join(outputDirectory, "connect-authority-supervisor.manifest.sig");
const serviceOutputDirectory = join(cliDir, "native", "prebuilds", "win32-service");
const serviceOutput = join(serviceOutputDirectory, "ProPRConnectAuthority.exe");
const serviceInstallerOutput = join(serviceOutputDirectory, "ProPRConnectAuthority.msi");
const launcherOutputDirectory = join(cliDir, "native", "prebuilds", "win32-x64");
const launcherOutput = join(launcherOutputDirectory, "connect-authority-broker.exe");
const bootstrapOutput = join(launcherOutputDirectory, "connect-authority-bootstrap.exe");
const smokeFixtureSource = join(cliDir, "..", "..", "scripts", "fixtures", "windows-connect-docker-fixture.c");
const smokeFixtureOutput = join(cliDir, "..", "..", "scripts", "fixtures", "windows-connect-docker-fixture.exe");
const validation = process.argv.includes("--validation");
const evidenceArguments = process.argv.filter((item) => item.startsWith("--evidence-stage="));
const evidenceStage = evidenceArguments.length === 1 ? evidenceArguments[0].slice("--evidence-stage=".length) : undefined;
const nonce = randomBytes(32).toString("hex");
const protocolVersion = 2;
const sourceSha256 = "68b38a53d073b032e9ed0c1f5e9c8a69c306b399524b654a691e3eb13d271aff";
const serviceSourceSha256 = "512c4716be5396877360e6011c2a3034d58305d676c0db950120c47f2009fe0c";
const serviceInstallerSourceSha256 = "3f3d7034b47bbf1ad7100cdb5ce4bce9360e6479669629a5452c23b4eefc77e6";
const launcherSourceSha256 = "f5b29a4b2f8fbcce41690e2363d90440d73fbebb10114ec0eae53e9653f34a4c";
const bootstrapSourceSha256 = "9c78ab7d06b43dcee72420ec6442fc639b5542a8ef76be3a46d281843d43ef72";
const bootstrapSha256 = "2373622afcd21231ff5bd2953f5896af1eb8565bbe395eeb5128b0591145ea17";
const smokeFixtureSourceSha256 = "3dac9791aa8c9f1dbe6f731bd72277e2b551bac94b72e50c66b71cb87164556c";
let emergencyBuildWorkspace;
let evidenceCapability;
let evidenceReceiptEmitted = false;

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
if (evidenceArguments.length > 1 || (evidenceStage !== undefined
  && (!validation || !["BUILD_COMPILER", "BUILD_SOURCE", "BUILD_OUTPUT"].includes(evidenceStage)))) {
  throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN");
}

if (evidenceStage !== undefined) {
  let request;
  try {
    const bytes = readFileSync(0);
    if (bytes.byteLength > 256) throw new Error("oversized");
    const match = /^PROPR_BUILD_EVIDENCE_V1 ([0-9a-f]{64}) ([0-9a-f]{64})\n$/u.exec(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!match) throw new Error("invalid");
    request = { nonce: match[1], key: Buffer.from(match[2], "hex") };
    if (fstatSync(3).isFile()) throw new Error("receipt channel is not private");
  } catch (error) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN", error);
  }
  evidenceCapability = Object.freeze(request);
}

function emitAuthenticatedEvidenceReceipt(stage, mutationDenied) {
  if (!evidenceCapability || evidenceReceiptEmitted || stage !== evidenceStage
    || mutationDenied !== 3) throw new WindowsHelperBuildError(stage, "NONZERO_OUTPUT");
  const receipt = {
    version: 1,
    stage,
    nonce: evidenceCapability.nonce,
    hook: "runAuthorityLeasedBuildTool.after-native-input-authority-v1",
    mutationAttempted: true,
    mutationDenied: true,
    deniedOperations: 3,
  };
  const body = canonical(receipt);
  const authenticated = `${canonical({
    ...receipt,
    mac: createHmac("sha256", evidenceCapability.key).update(body).digest("hex"),
  })}\n`;
  if (Buffer.byteLength(authenticated) > 1024) throw new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT");
  writeSync(3, Buffer.from(authenticated, "utf8"));
  evidenceReceiptEmitted = true;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publishOrVerifyBaseline(temporary, final) {
  if (!existsSync(final)) {
    publishWindowsBuildArtifactNoReplace(temporary, final);
    return true;
  }
  const baseline = heldIdentity(final);
  const candidate = heldIdentity(temporary);
  if (baseline.bytes.byteLength !== candidate.bytes.byteLength || sha256(baseline.bytes) !== sha256(candidate.bytes)) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "NONZERO_OUTPUT");
  }
  rmSync(temporary, { force: true });
  return false;
}

function writeOrVerifyBaseline(final, bytes) {
  if (!existsSync(final)) {
    writeFileSync(final, bytes, { flag: "wx" });
    return true;
  }
  const baseline = heldIdentity(final);
  if (baseline.bytes.byteLength !== Buffer.byteLength(bytes) || !baseline.bytes.equals(Buffer.from(bytes))) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "NONZERO_OUTPUT");
  }
  return false;
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
    const key = input.path.toLowerCase();
    const prior = unique.get(key);
    // Directory inventories deliberately contain the tool executable too.
    // Never let its ordinary-file inventory row downgrade the stronger fixed
    // leaf/SPKI authorization row for the same identity.
    if (!prior || input.tool === true || prior.tool !== true) unique.set(key, input);
  }
  if (unique.size < 1 || unique.size > 30_000) {
    throw new WindowsHelperBuildError(options.stage, "OVERSIZED_OUTPUT");
  }
  const inventory = [...unique.values()].map((input) => {
    const named = lstatSync(input.path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.size < 0n || named.size > 1024n * 1024n * 1024n) {
      throw new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT");
    }
    return { ...input, bytes: Number(named.size) };
  });
  const plan = planWindowsBuildLeaseReadiness(inventory);
  const prepared = [];
  try {
    for (const batch of plan.batches) {
      const body = Buffer.from(`PROPR_BUILD_LEASE_V1\n${batch
        .map((input) => input.tool === true && options.allowUnsignedTool !== true
          ? `T ${input.sha256} ${input.signatureKind} ${input.authenticodeLeafSha256} ${input.authenticodeSpkiSha256} ${input.path}\n`
          : `F ${input.sha256} ${input.path}\n`).join("")}`, "utf8");
      if (body.byteLength > 64 * 1024 * 1024) throw new WindowsHelperBuildError(options.stage, "OVERSIZED_OUTPUT");
      const manifest = join(buildWorkspace, `.lease-${bootstrapLeaseSequence += 1}.txt`);
      writeFileSync(manifest, body, { flag: "wx", mode: 0o600 });
      prepared.push({ body, manifest });
    }
  } catch (error) {
    for (const { manifest } of prepared) rmSync(manifest, { force: true });
    throw error;
  }
  const authorities = [];
  const progressFrames = windowsBuildLeaseProgressFrames(plan);
  const deadline = Date.now() + plan.deadlineMs;
  let completedFiles = 0;
  let completedBytes = 0;
  let leaseProtocolFailure;
  try {
    for (let batchIndex = 0; batchIndex < prepared.length; batchIndex += 1) {
      const { body, manifest } = prepared[batchIndex];
      const batch = plan.batches[batchIndex];
      const batchFiles = batch.length;
      const batchBytes = batch.reduce((sum, input) => sum + input.bytes, 0);
      const progressNonce = randomBytes(32).toString("hex");
      const progressKey = randomBytes(32);
      const authority = spawn(bootstrapOutput, [
        "lease-build-inputs-v1", manifest, sha256(body),
        String(batchIndex + 1), String(prepared.length), String(completedFiles), String(plan.files),
        String(completedBytes), String(plan.bytes), progressNonce,
      ], {
        shell: false,
        windowsHide: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe", bootstrapAuthority.fd, "pipe"],
      });
      authority.stdin.on("error", () => {});
      const progressCapability = authority.stdio[4];
      if (!progressCapability || typeof progressCapability.end !== "function") {
        throw new WindowsHelperBuildError(options.stage, "SPAWN_ERROR");
      }
      progressCapability.on("error", () => {});
      progressCapability.end(progressKey);
      authorities.push({ authority, manifest });
      const expectedFrame = progressFrames[batchIndex + 1];
      await new Promise((resolveReady, rejectReady) => {
        let settled = false;
        let ready = Buffer.alloc(0);
        let authenticatedFrame = false;
        let stderrBytes = 0;
        const remaining = deadline - Date.now();
        let timer;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          authority.removeAllListeners("error");
          authority.removeAllListeners("exit");
          if (error) rejectReady(error); else resolveReady();
        };
        if (remaining < 1) return finish(new WindowsHelperBuildError(options.stage, "STALLED"));
        timer = setTimeout(() => finish(new WindowsHelperBuildError(options.stage, "STALLED")), remaining);
        timer.unref?.();
        authority.once("error", () => finish(new WindowsHelperBuildError(options.stage, "SPAWN_ERROR")));
        authority.once("exit", () => finish(new WindowsHelperBuildError(options.stage, "NONZERO_EMPTY_OUTPUT")));
        authority.stderr.on("data", (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          if (stderrBytes > 0) finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
        });
        authority.stdout.on("data", (chunk) => {
          if (settled || authenticatedFrame) {
            leaseProtocolFailure = leaseProtocolFailure
              ?? new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT");
            try { authority.kill(); } catch { /* The fixed protocol diagnostic owns termination. */ }
            return;
          }
          ready = Buffer.concat([ready, Buffer.from(chunk)]);
          if (ready.byteLength > 512) return finish(new WindowsHelperBuildError(options.stage, "OVERSIZED_OUTPUT"));
          const newline = ready.indexOf(0x0a);
          if (newline < 0) return;
          if (newline !== ready.byteLength - 1) return finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(ready); }
          catch { return finish(new WindowsHelperBuildError(options.stage, "INVALID_UTF8")); }
          const match = /^(PROPR_BUILD_LEASE_PROGRESS_V2 (0|[1-9]\d*)\/(0|[1-9]\d*) (0|[1-9]\d*)\/(0|[1-9]\d*) (0|[1-9]\d*)\/(0|[1-9]\d*) ([0-9a-f]{64})) ([0-9a-f]{64})\n$/u.exec(text);
          if (!match) return finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
          const bodyText = match[1];
          const mac = createHmac("sha256", progressKey).update(bodyText).digest("hex");
          const expected = /^PROPR_BUILD_PROGRESS_V1 \d+\/\d+ (\d+)\/(\d+) (\d+)\/(\d+) (\d+)\/(\d+)\n$/u.exec(expectedFrame);
          if (mac !== match[9] || match[8] !== progressNonce || !expected
            || Number(match[2]) !== Number(expected[1]) || Number(match[3]) !== Number(expected[2])
            || Number(match[4]) !== Number(expected[3]) || Number(match[5]) !== Number(expected[4])
            || Number(match[6]) !== Number(expected[5]) || Number(match[7]) !== Number(expected[6])) {
            return finish(new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT"));
          }
          authenticatedFrame = true;
        });
        authority.stdout.once("end", () => {
          if (!authenticatedFrame) finish(new WindowsHelperBuildError(options.stage, "NONZERO_EMPTY_OUTPUT"));
          else finish();
        });
      });
      completedFiles += batchFiles;
      completedBytes += batchBytes;
    }
  } catch (error) {
    for (const { authority } of authorities) {
      try { authority.kill(); } catch { /* The fixed spawn diagnostic owns cleanup failure. */ }
    }
    await Promise.all(authorities.map(({ authority }) => new Promise((resolveExit) => {
      if (authority.exitCode !== null || authority.signalCode !== null) return resolveExit();
      const timer = setTimeout(resolveExit, 5_000);
      authority.once("exit", () => { clearTimeout(timer); resolveExit(); });
    })));
    for (const { manifest } of prepared) rmSync(manifest, { force: true });
    throw error instanceof WindowsHelperBuildError
      ? error : new WindowsHelperBuildError(options.stage, "SPAWN_ERROR", error);
  }
  let primaryFailure;
  try {
    await awaitWindowsBuildLeaseReadiness(
      progressFrames.slice(1, -1).map((frame) => Promise.resolve(frame)), plan, { stage: options.stage },
    );
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    if (leaseProtocolFailure || completedFiles !== plan.files || completedBytes !== plan.bytes) {
      if (leaseProtocolFailure) throw leaseProtocolFailure;
      throw new WindowsHelperBuildError(options.stage, "STALLED");
    }
    if (options.evidenceLeaseTarget) {
      let denied = 0;
      for (const mutate of [
        () => writeFileSync(options.evidenceLeaseTarget, "same-user lease mutation\n"),
        () => rmSync(options.evidenceLeaseTarget),
        () => renameSync(options.evidenceLeaseTarget, `${options.evidenceLeaseTarget}.same-user-replaced`),
      ]) {
        try { mutate(); } catch { denied += 1; }
      }
      if (denied !== 3) throw new WindowsHelperBuildError(options.stage, "NONZERO_OUTPUT");
      emitAuthenticatedEvidenceReceipt(options.stage, denied);
      // A malformed release byte makes the real native lease authority fail
      // closed. No compiler child is created after the evidence mutation.
      for (const { authority } of authorities) authority.stdin.end(Buffer.from("!"));
      return undefined;
    }
    return runBoundedBuildTool(command, args, options);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    for (const { authority } of authorities) {
      if (!authority.stdin.writableEnded) authority.stdin.end(Buffer.from("X"));
    }
    const released = await Promise.all(authorities.map(({ authority }) => new Promise((resolveExit) => {
      if (authority.exitCode !== null) resolveExit(authority.exitCode === 0);
      else {
        const timer = setTimeout(() => { authority.kill(); resolveExit(false); }, 5_000);
        authority.once("exit", (code) => { clearTimeout(timer); resolveExit(code === 0); });
      }
    })));
    for (const { manifest } of authorities) rmSync(manifest, { force: true });
    if (released.some((value) => !value) && primaryFailure === undefined) {
      throw new WindowsHelperBuildError(options.stage, "NONZERO_EMPTY_OUTPUT");
    }
  }
}

// Bootstrap only from the already audited, checksum-pinned native probe.  Its
// GetWindowsDirectoryW/GetSystemWindowsDirectoryW result is independent of the
// runner's drive, architecture, PATH, SystemRoot and windir.  Unlike an object
// manager GLOBALROOT name, the resulting DOS path is a valid CreateProcessW
// application name.
const committedBootstrapSource = heldIdentity(bootstrapSource, true);
const bootstrapSourceBytes = canonicalWindowsBuildSourceBytes(committedBootstrapSource.bytes, "BUILD_COMPILER");
const bootstrapAuthority = heldIdentity(bootstrapOutput, true);
if (sha256(bootstrapSourceBytes) !== bootstrapSourceSha256
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
mkdirSync(serviceOutputDirectory, { recursive: true });
emergencyBuildWorkspace = join(outputDirectory, `.propr-build-${nonce}`);
const resolver = String.raw`
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false,$true)
$stderr=[IO.StreamWriter]::new([Console]::OpenStandardError(),$utf8,256,$true)
$stderr.AutoFlush=$true
[Console]::SetError($stderr)
[Console]::OutputEncoding=$utf8
function Send-ProprProgress([int]$stage){
  [Console]::Error.Write(('PROPR_BUILD_PROGRESS_V1 '+$stage+'/8 0/0 0/0 0/0'+[char]10))
}
$windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$system=[Environment]::SystemDirectory
$systemWindows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
if([string]::IsNullOrWhiteSpace($windows)-or[string]::IsNullOrWhiteSpace($system)-or[string]::IsNullOrWhiteSpace($programFiles)-or[string]::IsNullOrWhiteSpace($programFilesX86)-or
   $windows-ne$env:PROPR_BUILD_WINDOWS_DIRECTORY-or$system-ne$env:PROPR_BUILD_SYSTEM_DIRECTORY-or
   $systemWindows-ne$env:PROPR_BUILD_SYSTEM_WINDOWS_DIRECTORY){exit 31}
Send-ProprProgress 1
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
Send-ProprProgress 2
$authorizedSubjects=@(
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
)
function Test-AuthorizedResolverFile([string]$path){
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  return $signature.Status-eq'Valid'-and$authorizedSubjects-ccontains$signature.SignerCertificate.Subject
}
$currentPowerShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
if($currentPowerShell-ne$env:PROPR_BUILD_POWERSHELL-or-not(Test-AuthorizedResolverFile $currentPowerShell)){exit 44}
Send-ProprProgress 3
$vswhere=[IO.Path]::Combine($programFilesX86,'Microsoft Visual Studio','Installer','vswhere.exe')
if(-not(Test-AuthorizedResolverFile $vswhere)){exit 32}
$runnerArchitecture=$env:PROPR_BUILD_RUNNER_ARCHITECTURE
if($runnerArchitecture-ne'x64'-and$runnerArchitecture-ne'arm64'){exit 33}
function Complete-ProfileMismatch([string]$reason){
  if(@('VS_INVENTORY_TOOL','VS_INVENTORY_OVERSIZED','VS_INVENTORY_SCHEMA','VS_ENTERPRISE_ZERO','VS_ENTERPRISE_AMBIGUOUS','VS_ENTERPRISE_UNEXPECTED')-notcontains$reason){$reason='VS_INVENTORY_SCHEMA'}
  Send-ProprProgress 4;Send-ProprProgress 5;Send-ProprProgress 6;Send-ProprProgress 7
  $document=[ordered]@{profileMismatch=$reason;buildWorkspace=$workspace}
  Send-ProprProgress 8
  [Console]::Out.Write(($document|ConvertTo-Json -Compress))
}
# BEGIN BOUNDED_VSWHERE_PROCESS
function Get-RemainingInventoryMilliseconds([DateTime]$deadline){
  $remaining=[Math]::Ceiling(($deadline-[DateTime]::UtcNow).TotalMilliseconds)
  if($remaining-le0){return 0}
  if($remaining-ge[int]::MaxValue){return [int]::MaxValue}
  return [int]$remaining
}
function Complete-PendingInventoryRead([IO.Stream]$stream,[System.IAsyncResult]$pending,[DateTime]$deadline){
  if($null-eq$pending){return}
  $remaining=Get-RemainingInventoryMilliseconds $deadline
  if($remaining-gt0-and$pending.AsyncWaitHandle.WaitOne($remaining)){
    try{$stream.EndRead($pending)|Out-Null}catch{}
  }
}
function Invoke-BoundedRedirectedInventoryProcess([Diagnostics.ProcessStartInfo]$start,[int]$timeoutMilliseconds){
  $process=$null
  $stdout=[IO.MemoryStream]::new()
  $stderr=[IO.MemoryStream]::new()
  $outPending=$null;$errPending=$null;$reason=$null
  $deadline=[DateTime]::UtcNow.AddMilliseconds($timeoutMilliseconds)
  try{
    $process=[Diagnostics.Process]::new()
    $process.StartInfo=$start
    if(-not$process.Start()){$reason='VS_INVENTORY_TOOL'}
    $outBuffer=[byte[]]::new(4096);$errBuffer=[byte[]]::new(1024)
    if($null-eq$reason){
      $outPending=$process.StandardOutput.BaseStream.BeginRead($outBuffer,0,$outBuffer.Length,$null,$null)
      $errPending=$process.StandardError.BaseStream.BeginRead($errBuffer,0,$errBuffer.Length,$null,$null)
    }
    while($null-eq$reason-and($null-ne$outPending-or$null-ne$errPending)){
      $remaining=Get-RemainingInventoryMilliseconds $deadline
      if($remaining-le0){$reason='VS_INVENTORY_TOOL';break}
      $progress=$false
      if($null-ne$outPending-and$outPending.IsCompleted){
        $completed=$outPending;$outPending=$null
        $count=$process.StandardOutput.BaseStream.EndRead($completed);$progress=$true
        if($count-eq0){$outPending=$null}else{
          if($stdout.Length+$count-gt65536){$reason='VS_INVENTORY_OVERSIZED'}else{
            $stdout.Write($outBuffer,0,$count)
            $outPending=$process.StandardOutput.BaseStream.BeginRead($outBuffer,0,$outBuffer.Length,$null,$null)
          }
        }
      }
      if($null-eq$reason-and$null-ne$errPending-and$errPending.IsCompleted){
        $completed=$errPending;$errPending=$null
        $count=$process.StandardError.BaseStream.EndRead($completed);$progress=$true
        if($count-eq0){$errPending=$null}else{
          if($stderr.Length+$count-gt4096){$reason='VS_INVENTORY_OVERSIZED'}else{
            $stderr.Write($errBuffer,0,$count)
            $errPending=$process.StandardError.BaseStream.BeginRead($errBuffer,0,$errBuffer.Length,$null,$null)
          }
        }
      }
      if($null-eq$reason-and-not$progress){[Threading.Thread]::Sleep([Math]::Min(5,$remaining))}
    }
    if($null-eq$reason){
      $remaining=Get-RemainingInventoryMilliseconds $deadline
      if($remaining-le0-or-not$process.WaitForExit($remaining)){$reason='VS_INVENTORY_TOOL'}
    }
    if($null-eq$reason-and($process.ExitCode-ne0-or$stderr.Length-ne0-or$stdout.Length-lt2)){$reason='VS_INVENTORY_TOOL'}
  }catch{$reason='VS_INVENTORY_TOOL'}
  if($null-ne$reason-and$null-ne$process){
    try{if(-not$process.HasExited){$process.Kill()}}catch{}
    # Cleanup gets its own short bound only after the one execution deadline
    # has failed. Every outstanding EndRead is settled when the killed child
    # closes its pipes; no parameterless process wait remains.
    $cleanupDeadline=[DateTime]::UtcNow.AddSeconds(5)
    if($null-ne$outPending){Complete-PendingInventoryRead $process.StandardOutput.BaseStream $outPending $cleanupDeadline}
    if($null-ne$errPending){Complete-PendingInventoryRead $process.StandardError.BaseStream $errPending $cleanupDeadline}
    try{
      $remaining=Get-RemainingInventoryMilliseconds $cleanupDeadline
      if($remaining-gt0){$process.WaitForExit($remaining)|Out-Null}
    }catch{}
  }
  $result=if($null-eq$reason){[pscustomobject]@{reason=$null;bytes=$stdout.ToArray()}}else{[pscustomobject]@{reason=$reason;bytes=$null}}
  if($null-ne$process){$process.Dispose()};$stdout.Dispose();$stderr.Dispose()
  return $result
}
function Invoke-BoundedVswhereInventory([string]$path){
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$path
  $start.Arguments="-all -prerelease -products * -format json -utf8"
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  return Invoke-BoundedRedirectedInventoryProcess $start 30000
}
# END BOUNDED_VSWHERE_PROCESS
# BEGIN BOUNDED_VSWHERE_SCHEMA
function Test-BoundedInventoryScalar([object]$value){
  if($null-eq$value){return $true}
  if($value-is[string]){return $value.Length-le2048-and$value.IndexOf([char]0)-lt0}
  if($value-is[bool]-or$value-is[byte]-or$value-is[sbyte]-or$value-is[int16]-or$value-is[uint16]-or
     $value-is[int32]-or$value-is[uint32]-or$value-is[int64]-or$value-is[uint64]-or$value-is[decimal]-or
     $value-is[DateTime]){return $true}
  if($value-is[single]){return -not[single]::IsNaN($value)-and-not[single]::IsInfinity($value)}
  if($value-is[double]){return -not[double]::IsNaN($value)-and-not[double]::IsInfinity($value)}
  return $false
}
function Test-BoundedInventoryObject([object]$value,[ref]$totalProperties,[int]$depth){
  if($null-eq$value-or$value.GetType().FullName-ne'System.Management.Automation.PSCustomObject'){return $false}
  $properties=@($value.PSObject.Properties)
  if($properties.Count-gt64){return $false}
  $totalProperties.Value=[int]$totalProperties.Value+$properties.Count
  if($totalProperties.Value-gt1024){return $false}
  foreach($property in $properties){
    if([string]::IsNullOrEmpty($property.Name)-or$property.Name.Length-gt128){return $false}
    if(Test-BoundedInventoryScalar $property.Value){continue}
    if($depth-ne0-or-not(Test-BoundedInventoryObject $property.Value $totalProperties 1)){return $false}
  }
  return $true
}
function ConvertTo-BoundedInventoryInstance([object]$value,[ref]$totalProperties){
  if(-not(Test-BoundedInventoryObject $value $totalProperties 0)){throw [IO.InvalidDataException]::new()}
  $properties=@($value.PSObject.Properties)
  foreach($required in @('instanceId','installationPath','installationVersion','productId','isComplete','isLaunchable')){
    if($properties.Name-cnotcontains$required){throw [IO.InvalidDataException]::new()}
  }
  $channelPathProperty=$value.PSObject.Properties['channelPath']
  if($null-ne$channelPathProperty-and(-not($channelPathProperty.Value-is[string])-or
     $channelPathProperty.Value.Length-lt1-or$channelPathProperty.Value.Length-gt2048-or
     $channelPathProperty.Value.IndexOf([char]0)-ge0)){throw [IO.InvalidDataException]::new()}
  if(-not($value.instanceId-is[string])-or$value.instanceId.Length-lt1-or$value.instanceId.Length-gt128-or$value.instanceId.IndexOf([char]0)-ge0-or
     -not($value.installationPath-is[string])-or$value.installationPath.Length-lt3-or$value.installationPath.Length-gt260-or$value.installationPath.IndexOf([char]0)-ge0-or
     -not($value.installationVersion-is[string])-or$value.installationVersion.Length-lt1-or$value.installationVersion.Length-gt64-or$value.installationVersion.IndexOf([char]0)-ge0-or
     -not($value.productId-is[string])-or$value.productId.Length-lt1-or$value.productId.Length-gt128-or$value.productId.IndexOf([char]0)-ge0-or
     -not($value.isComplete-is[bool])-or-not($value.isLaunchable-is[bool])){throw [IO.InvalidDataException]::new()}
  # Only these reviewed security fields survive metadata validation.
  return [pscustomobject][ordered]@{instanceId=$value.instanceId;productId=$value.productId;installationPath=$value.installationPath;installationVersion=$value.installationVersion;isComplete=$value.isComplete;isLaunchable=$value.isLaunchable}
}
function Select-ReviewedEnterpriseInventory([object[]]$instances,[string]$programFiles,[string]$runnerArchitecture){
  $enterprise=@($instances|Where-Object{$_.productId-ceq'Microsoft.VisualStudio.Product.Enterprise'})
  if($enterprise.Count-eq0){return [pscustomobject]@{reason='VS_ENTERPRISE_ZERO';selected=$null;profile=$null}}
  # Policy: multiple Enterprise installations are intentionally fatal before
  # reviewed-version filtering, even if exactly one would otherwise match.
  if($enterprise.Count-gt1){return [pscustomobject]@{reason='VS_ENTERPRISE_AMBIGUOUS';selected=$null;profile=$null}}
  if(-not$enterprise[0].isComplete-or-not$enterprise[0].isLaunchable){return [pscustomobject]@{reason='VS_ENTERPRISE_UNEXPECTED';selected=$null;profile=$null}}
  $expected18=[IO.Path]::Combine($programFiles,'Microsoft Visual Studio','18','Enterprise')
  $expected17=[IO.Path]::Combine($programFiles,'Microsoft Visual Studio','2022','Enterprise')
  $reviewed=@($enterprise|Where-Object{
    ($_.installationVersion-ceq'18.9.12112.369'-and[string]::Equals($_.installationPath,$expected18,[StringComparison]::OrdinalIgnoreCase))-or
    ($runnerArchitecture-eq'x64'-and$_.installationVersion-ceq'17.14.37502.11'-and[string]::Equals($_.installationPath,$expected17,[StringComparison]::OrdinalIgnoreCase))
  })
  if($reviewed.Count-ne1){return [pscustomobject]@{reason='VS_ENTERPRISE_UNEXPECTED';selected=$null;profile=$null}}
  $profile=if($reviewed[0].installationVersion-ceq'18.9.12112.369'){('vs2026-18.9-'+$runnerArchitecture)}else{'vs2022-17.14-x64'}
  return [pscustomobject]@{reason=$null;selected=$reviewed[0];profile=$profile}
}
# END BOUNDED_VSWHERE_SCHEMA
$inventoryResult=Invoke-BoundedVswhereInventory $vswhere
if($null-ne$inventoryResult.reason){Complete-ProfileMismatch $inventoryResult.reason;return}
try{
  $inventoryText=[Text.UTF8Encoding]::new($false,$true).GetString($inventoryResult.bytes)
  $rawInstances=@($inventoryText|ConvertFrom-Json)
  if($rawInstances.Count-gt16){throw [IO.InvalidDataException]::new()}
  $propertyCount=0
  $instances=@()
  foreach($rawInstance in $rawInstances){$instances+=@(ConvertTo-BoundedInventoryInstance $rawInstance ([ref]$propertyCount))}
}catch{Complete-ProfileMismatch 'VS_INVENTORY_SCHEMA';return}
if($instances.Count-eq0){Complete-ProfileMismatch 'VS_ENTERPRISE_ZERO';return}
$selection=Select-ReviewedEnterpriseInventory $instances $programFiles $runnerArchitecture
if($null-ne$selection.reason){Complete-ProfileMismatch $selection.reason;return}
$selected=$selection.selected
$profile=$selection.profile
$installation=$selected.installationPath
$installationVersion=$selected.installationVersion
Send-ProprProgress 4
$compiler=[IO.Path]::Combine($installation,'MSBuild','Current','Bin','Roslyn','csc.exe')
if(-not(Test-Path -LiteralPath $compiler -PathType Leaf)){exit 34}
$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).ProductVersion
if(($profile.StartsWith('vs2026')-and$version-ne'5.900.26.35703')-or
   ($profile-eq'vs2022-17.14-x64'-and$version-notmatch'^4\.14\.')){exit 35}
$toolsetPattern=if($profile.StartsWith('vs2026')){'^14\.51\.36231$'}else{'^14\.44\.'}
$toolsets=@(Get-ChildItem -LiteralPath ([IO.Path]::Combine($installation,'VC','Tools','MSVC')) -Directory|Where-Object{$_.Name-match$toolsetPattern})
if($toolsets.Count-ne1){exit 38}
$nativeCompiler=[IO.Path]::Combine($toolsets[0].FullName,'bin','Hostx64','x64','cl.exe')
$nativeLinker=[IO.Path]::Combine($toolsets[0].FullName,'bin','Hostx64','x64','link.exe')
if(-not(Test-Path -LiteralPath $nativeCompiler -PathType Leaf)){exit 39}
if(-not(Test-Path -LiteralPath $nativeLinker -PathType Leaf)){exit 41}
if($profile.StartsWith('vs2026')){
  if([Diagnostics.FileVersionInfo]::GetVersionInfo($nativeCompiler).ProductVersion-ne'14.51.36256.0'-or
     [Diagnostics.FileVersionInfo]::GetVersionInfo($nativeLinker).ProductVersion-ne'14.51.36256.0'){exit 46}
}
Send-ProprProgress 5
$sdkRoot=[IO.Path]::Combine($programFilesX86,'Windows Kits','10')
$sdkVersions=@(Get-ChildItem -LiteralPath ([IO.Path]::Combine($sdkRoot,'Include')) -Directory|Where-Object{$_.Name-match'^10\.0\.26100\.'})
if($sdkVersions.Count-ne1){exit 40}
$sdkVersion=$sdkVersions[0].Name
Send-ProprProgress 6
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
$references=@('mscorlib.dll','System.dll','System.Core.dll','System.Numerics.dll','System.Web.Extensions.dll','System.ServiceProcess.dll')|ForEach-Object{[IO.Path]::Combine($referenceRoot,$_)}
foreach($reference in $references){
  if(-not(Test-Path -LiteralPath $reference -PathType Leaf)){exit 36}
  $acl=Get-Acl -LiteralPath $reference
  if($acl.Owner-notmatch'^(NT SERVICE\\TrustedInstaller|BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$'){exit 37}
}
Send-ProprProgress 7
$document=[ordered]@{profile=$profile;windowsDirectory=$windows;systemWindowsDirectory=$windows;systemDirectory=$system;buildWorkspace=$workspace;compiler=$compiler;compilerVersion=$version;nativeCompiler=$nativeCompiler;nativeLinker=$nativeLinker;nativeIncludes=$nativeIncludes;nativeLibraries=$nativeLibraries;references=$references}
Send-ProprProgress 8
[Console]::Out.Write(($document|ConvertTo-Json -Compress))
`;

let resolvedToolchain;
try {
  const resolverProgressFrames = Object.freeze(Array.from({ length: 8 }, (_, index) =>
    formatWindowsBuildProgressFrame({
      stage: index + 1, stages: 8, batch: 0, batches: 0,
      files: 0, totalFiles: 0, bytes: 0, totalBytes: 0,
    })));
  const resolved = await runBoundedProgressBuildTool(trustedPowerShell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", resolver,
  ], {
    stage: "BUILD_COMPILER",
    timeout: 180_000,
    maxBytes: 16 * 1024,
    maxProgressBytes: 4 * 1024,
    progressFrames: resolverProgressFrames,
    env: {
      SystemRoot: bootstrapPaths.windowsDirectory,
      PROPR_BUILD_WINDOWS_DIRECTORY: bootstrapPaths.windowsDirectory,
      PROPR_BUILD_SYSTEM_WINDOWS_DIRECTORY: bootstrapPaths.systemWindowsDirectory,
      PROPR_BUILD_SYSTEM_DIRECTORY: bootstrapPaths.systemDirectory,
      PROPR_BUILD_STAGING_PARENT: outputDirectory,
      PROPR_BUILD_NONCE: nonce,
      PROPR_BUILD_POWERSHELL: trustedPowerShell,
      PROPR_BUILD_RUNNER_ARCHITECTURE: process.arch,
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
if (resolvedToolchain && typeof resolvedToolchain === "object" && !Array.isArray(resolvedToolchain)
  && Object.keys(resolvedToolchain).sort().join("\0") === ["buildWorkspace", "profileMismatch"].sort().join("\0")
  && ["VS_INVENTORY_TOOL", "VS_INVENTORY_OVERSIZED", "VS_INVENTORY_SCHEMA", "VS_ENTERPRISE_ZERO",
    "VS_ENTERPRISE_AMBIGUOUS", "VS_ENTERPRISE_UNEXPECTED"].includes(resolvedToolchain.profileMismatch)
  && typeof resolvedToolchain.buildWorkspace === "string") {
  emergencyBuildWorkspace = resolvedToolchain.buildWorkspace;
  throw new WindowsHelperBuildError("BUILD_COMPILER", resolvedToolchain.profileMismatch);
}
if (!resolvedToolchain || typeof resolvedToolchain !== "object" || Array.isArray(resolvedToolchain)
  || Object.keys(resolvedToolchain).sort().join("\0") !== [
    "profile", "buildWorkspace", "compiler", "compilerVersion", "nativeCompiler", "nativeLinker", "nativeIncludes", "nativeLibraries", "references", "systemDirectory", "systemWindowsDirectory", "windowsDirectory",
  ].sort().join("\0")
  || typeof resolvedToolchain.windowsDirectory !== "string"
  || typeof resolvedToolchain.systemWindowsDirectory !== "string"
  || typeof resolvedToolchain.systemDirectory !== "string"
  || typeof resolvedToolchain.buildWorkspace !== "string"
  || typeof resolvedToolchain.compiler !== "string"
  || typeof resolvedToolchain.compilerVersion !== "string"
  || !Object.hasOwn(WINDOWS_BUILD_TOOLCHAIN_PROFILES, resolvedToolchain.profile)
  || typeof resolvedToolchain.nativeCompiler !== "string"
  || typeof resolvedToolchain.nativeLinker !== "string"
  || !Array.isArray(resolvedToolchain.nativeIncludes) || resolvedToolchain.nativeIncludes.length !== 4
  || !resolvedToolchain.nativeIncludes.every((item) => typeof item === "string")
  || !Array.isArray(resolvedToolchain.nativeLibraries) || resolvedToolchain.nativeLibraries.length !== 3
  || !resolvedToolchain.nativeLibraries.every((item) => typeof item === "string")
  || !Array.isArray(resolvedToolchain.references)
  || resolvedToolchain.references.length !== 6
  || !resolvedToolchain.references.every((item) => typeof item === "string")) {
  throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
}
assertModernRoslynVersion(resolvedToolchain.compilerVersion.split(/[+-]/u, 1)[0], resolvedToolchain.profile);
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
// /noconfig and a minimal child environment disable ambient response/config
// lookup. Lease every ordinary file beside each executable as the bounded set
// from which Roslyn/MSVC can load private DLLs, message resources, and explicit
// tool configuration. The native compiler and linker share one directory.
const toolRuntimeInventories = [dirname(compiler), dirname(nativeCompiler)].map((path) => ({
  path,
  ...authoritativeDirectoryInventory(path),
}));
authorizeWindowsBuildToolDependencies(resolvedToolchain.profile, "roslyn-runtime", toolRuntimeInventories[0]);
authorizeWindowsBuildToolDependencies(resolvedToolchain.profile, "msvc-host-runtime", toolRuntimeInventories[1]);
const wixRuntimePath = join(cliDir, "..", "..", "node_modules", "electron-winstaller", "vendor");
const wixRuntimeInventory = { path: wixRuntimePath, ...authoritativeDirectoryInventory(wixRuntimePath) };
authorizeWindowsBuildToolDependencies(resolvedToolchain.profile, "wix-runtime", wixRuntimeInventory);
const nativeInputInventories = [...nativeIncludes, ...nativeLibraries].map((path) => ({
  path,
  ...authoritativeDirectoryInventory(path),
}));
const committedSource = heldIdentity(source, true);
const sourceBytes = canonicalWindowsBuildSourceBytes(committedSource.bytes);
if (sha256(sourceBytes) !== sourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedServiceSource = heldIdentity(serviceSource, true);
const serviceSourceBytes = canonicalWindowsBuildSourceBytes(committedServiceSource.bytes);
if (sha256(serviceSourceBytes) !== serviceSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedServiceInstallerSource = heldIdentity(serviceInstallerSource, true);
const serviceInstallerSourceBytes = canonicalWindowsBuildSourceBytes(committedServiceInstallerSource.bytes);
if (sha256(serviceInstallerSourceBytes) !== serviceInstallerSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedLauncherSource = heldIdentity(launcherSource, true);
const launcherSourceBytes = canonicalWindowsBuildSourceBytes(committedLauncherSource.bytes);
if (sha256(launcherSourceBytes) !== launcherSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const committedSmokeFixtureSource = heldIdentity(smokeFixtureSource, true);
const smokeFixtureSourceBytes = canonicalWindowsBuildSourceBytes(committedSmokeFixtureSource.bytes);
if (sha256(smokeFixtureSourceBytes) !== smokeFixtureSourceSha256) {
  throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
}
const readBuildToolSignerPolicy = (role, path) => {
  const result = runBoundedBuildTool(bootstrapOutput, ["signer-pins-v1", path], {
    stage: "BUILD_COMPILER", timeout: 60_000, maxBytes: 256, sensitiveValues: [path, bootstrapOutput],
  });
  const match = /^E ([0-9a-f]{64}) ([0-9a-f]{64})\r?\n$/u.exec(
    new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
  );
  if (!match) throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  return authorizeWindowsBuildToolSigner(resolvedToolchain.profile, role, {
    signatureKind: "E", authenticodeLeafSha256: match[1], authenticodeSpkiSha256: match[2],
  });
};
const heldInput = (item) => ({
  path: item.path,
  sha256: sha256(item.bytes),
  ...(item.tool ? { tool: true, ...readBuildToolSignerPolicy(item.role, item.path) } : {}),
});
const managedToolInputs = [heldInput({ path: compiler, bytes: heldCompiler.bytes, tool: true, role: "compiler" }),
  ...toolRuntimeInventories[0].inputs, ...heldReferences.map(heldInput)];
const nativeCompilerInputs = [heldInput({ path: nativeCompiler, bytes: heldNativeCompiler.bytes, tool: true, role: "native-compiler" }),
  ...toolRuntimeInventories[1].inputs,
  ...nativeInputInventories.slice(0, nativeIncludes.length).flatMap((item) => item.inputs)];
const nativeLinkerInputs = [heldInput({ path: nativeLinker, bytes: heldNativeLinker.bytes, tool: true, role: "native-linker" }),
  ...toolRuntimeInventories[1].inputs,
  ...nativeInputInventories.slice(nativeIncludes.length).flatMap((item) => item.inputs)];

// Build beside the committed release set. Existing finals remain immutable
// baselines; publication either verifies byte equality or uses no-replace.
const temporaryOutput = join(buildWorkspace, "connect-authority-supervisor.exe");
const temporarySource = join(buildWorkspace, "windows-authority-supervisor.cs");
const temporaryServiceSource = join(buildWorkspace, "windows-connect-authority-service.cs");
const temporaryService = join(buildWorkspace, "ProPRConnectAuthority.exe");
const temporaryServiceInstallerSource = join(buildWorkspace, "windows-connect-authority.wxs");
const temporaryServiceInstallerObject = join(buildWorkspace, "windows-connect-authority.wixobj");
const temporaryServiceInstaller = join(buildWorkspace, "ProPRConnectAuthority.msi");
const temporaryCompilerConfig = join(buildWorkspace, "windows-authority-compiler.config");
const temporaryPolicy = join(buildWorkspace, "windows-authority-signing-policy.txt");
const temporaryLauncherSource = join(buildWorkspace, "windows-authority-launcher.c");
const temporaryLauncher = join(buildWorkspace, "windows-authority-launcher.exe");
const temporaryLauncherObject = join(buildWorkspace, "windows-authority-launcher.obj");
const temporarySmokeFixtureSource = join(buildWorkspace, "windows-connect-docker-fixture.c");
const temporarySmokeFixtureObject = join(buildWorkspace, "windows-connect-docker-fixture.obj");
const temporarySmokeFixture = join(buildWorkspace, "windows-connect-docker-fixture.exe");
let sourceLease;
let serviceSourceLease;
let serviceInstallerSourceLease;
let compilerConfigLease;
let policyLease;
let launcherSourceLease;
let smokeFixtureSourceLease;
let signToolLease;
let publishedOutput = false;
let publishedLauncher = false;
let publishedManifest = false;
let publishedSignature = false;
let publishedSmokeFixture = false;
let publishedService = false;
let publishedServiceInstaller = false;
function closeBuildInputLeases() {
  for (const lease of [signToolLease, heldPowerShell, bootstrapAuthority, committedBootstrapSource,
    committedSmokeFixtureSource, committedLauncherSource, committedServiceInstallerSource, committedServiceSource, committedSource,
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
  serviceSourceLease = openSync(temporaryServiceSource, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  let serviceSourceOffset = 0;
  while (serviceSourceOffset < serviceSourceBytes.byteLength) {
    const count = writeSync(serviceSourceLease, serviceSourceBytes, serviceSourceOffset,
      serviceSourceBytes.byteLength - serviceSourceOffset, serviceSourceOffset);
    if (count <= 0) throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
    serviceSourceOffset += count;
  }
  fsyncSync(serviceSourceLease);
  closeSync(serviceSourceLease);
  serviceSourceLease = openSync(temporaryServiceSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  serviceInstallerSourceLease = openSync(temporaryServiceInstallerSource,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  if (writeSync(serviceInstallerSourceLease, serviceInstallerSourceBytes, 0,
    serviceInstallerSourceBytes.byteLength, 0) !== serviceInstallerSourceBytes.byteLength) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
  }
  fsyncSync(serviceInstallerSourceLease);
  closeSync(serviceInstallerSourceLease);
  serviceInstallerSourceLease = openSync(temporaryServiceInstallerSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  const compilerConfigBytes = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n<configuration><runtime /></configuration>\n',
    "utf8",
  );
  compilerConfigLease = openSync(temporaryCompilerConfig, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  if (writeSync(compilerConfigLease, compilerConfigBytes, 0, compilerConfigBytes.byteLength, 0)
    !== compilerConfigBytes.byteLength) throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
  fsyncSync(compilerConfigLease);
  closeSync(compilerConfigLease);
  compilerConfigLease = openSync(temporaryCompilerConfig, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    `/appconfig:${temporaryCompilerConfig}`,
    `/out:${temporaryOutput}`,
    ...references.map((item) => `/reference:${item}`),
    temporarySource,
  ];
  const serviceArgs = [
    "/nologo", "/noconfig", "/nostdlib+", "/target:exe", "/platform:anycpu", "/optimize+", "/deterministic+",
    ...(validation ? ["/define:PROPR_VALIDATION"] : []),
    `/appconfig:${temporaryCompilerConfig}`,
    `/out:${temporaryService}`,
    ...references.map((item) => `/reference:${item}`),
    temporaryServiceSource,
  ];
  smokeFixtureSourceLease = openSync(temporarySmokeFixtureSource, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  if (writeSync(smokeFixtureSourceLease, smokeFixtureSourceBytes, 0,
    smokeFixtureSourceBytes.byteLength, 0) !== smokeFixtureSourceBytes.byteLength) {
    throw new WindowsHelperBuildError("BUILD_SOURCE", "UNEXPECTED_EXIT");
  }
  fsyncSync(smokeFixtureSourceLease);
  closeSync(smokeFixtureSourceLease);
  smokeFixtureSourceLease = openSync(temporarySmokeFixtureSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  const compilerOptions = {
    stage: evidenceStage === "BUILD_SOURCE" ? "BUILD_SOURCE" : "BUILD_COMPILER",
    env: { SystemRoot: windowsDirectory, TEMP: buildWorkspace, TMP: buildWorkspace },
    timeout: 30_000,
    maxBytes: 64 * 1024,
    sensitiveValues: [compiler, source, temporarySource, temporaryOutput, buildWorkspace, ...references],
  };
  if (evidenceStage === "BUILD_SOURCE") {
    compilerOptions.evidenceLeaseTarget = temporarySource;
  } else if (evidenceStage === "BUILD_COMPILER") {
    // Attack a real compiler input after the native authority reports that all
    // inputs are leased and immediately before the compiler would be spawned.
    compilerOptions.evidenceLeaseTarget = temporaryCompilerConfig;
  }
  await runAuthorityLeasedBuildTool(compiler, args, compilerOptions, [
    ...managedToolInputs, { path: temporarySource, sha256: sha256(sourceBytes) },
    { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
  ]);
  const deterministicFirst = heldIdentity(temporaryOutput);
  rmSync(temporaryOutput, { force: true });
  await runAuthorityLeasedBuildTool(compiler, args, compilerOptions, [
    ...managedToolInputs, { path: temporarySource, sha256: sha256(sourceBytes) },
    { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
  ]);
  const deterministicSecond = heldIdentity(temporaryOutput);
  if (sha256(deterministicFirst.bytes) !== sha256(deterministicSecond.bytes)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
  }
  await runAuthorityLeasedBuildTool(compiler, serviceArgs, compilerOptions, [
    ...managedToolInputs, { path: temporaryServiceSource, sha256: sha256(serviceSourceBytes) },
    { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
  ]);
  const serviceFirst = heldIdentity(temporaryService);
  rmSync(temporaryService, { force: true });
  await runAuthorityLeasedBuildTool(compiler, serviceArgs, compilerOptions, [
    ...managedToolInputs, { path: temporaryServiceSource, sha256: sha256(serviceSourceBytes) },
    { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
  ]);
  const serviceSecond = heldIdentity(temporaryService);
  if (sha256(serviceFirst.bytes) !== sha256(serviceSecond.bytes)) {
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
    temporaryLauncherObject, "kernel32.lib", "advapi32.lib", "bcrypt.lib", "crypt32.lib", "wintrust.lib", "user32.lib",
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
    { path: temporarySmokeFixtureSource, sha256: sha256(smokeFixtureSourceBytes) },
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
  let signBuildPath;
  if (!validation) {
    const signTool = process.env.PROPR_WINDOWS_SIGNTOOL;
    const certificate = process.env.PROPR_WINDOWS_CODESIGN_SHA1;
    const timestamp = process.env.PROPR_WINDOWS_TIMESTAMP_URL;
    if (!signTool || !parse(signTool).root || !/^[0-9A-Fa-f]{40}$/.test(certificate ?? "")
      || !timestamp?.startsWith("https://")) {
      throw new Error("trusted absolute signtool, signing certificate, and HTTPS timestamp are required");
    }
    signToolLease = heldIdentity(signTool, true);
    const signToolPins = readBuildToolSignerPolicy("sign-tool", signTool);
    const signToolInput = { path: signTool, sha256: sha256(signToolLease.bytes), tool: true, ...signToolPins };
    const signPath = async (target) => {
      await runAuthorityLeasedBuildTool(signTool, [
        "sign", "/fd", "SHA256", "/sha1", certificate, "/tr", timestamp, "/td", "SHA256", target,
      ], { stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 64 * 1024, sensitiveValues: [signTool, target] }, [signToolInput]);
      await runAuthorityLeasedBuildTool(signTool, ["verify", "/pa", "/all", "/v", target], {
        stage: "BUILD_OUTPUT", timeout: 30_000, maxBytes: 64 * 1024, sensitiveValues: [signTool, target],
      }, [signToolInput, { path: target, sha256: sha256(heldIdentity(target).bytes) }]);
    };
    signBuildPath = signPath;
    const readSigningPins = async () => {
      const outputInput = { path: temporaryOutput, sha256: sha256(heldIdentity(temporaryOutput).bytes), tool: true };
      const pinResult = await runAuthorityLeasedBuildTool(temporaryOutput, ["--print-signing-pins-v1"], {
        stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 1024, sensitiveValues: [temporaryOutput],
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
      { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
      { path: temporaryPolicy, sha256: sha256(policyBytes) },
    ]);
    const policyFirst = heldIdentity(temporaryOutput);
    rmSync(temporaryOutput, { force: true });
    await runAuthorityLeasedBuildTool(compiler, policyArgs, {
      ...compilerOptions, sensitiveValues: [...compilerOptions.sensitiveValues, temporaryPolicy],
    }, [...managedToolInputs,
      { path: temporarySource, sha256: sha256(sourceBytes) },
      { path: temporaryCompilerConfig, sha256: sha256(compilerConfigBytes) },
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
    await signPath(temporaryService);
  }
  const candle = join(wixRuntimePath, "candle.exe");
  const light = join(wixRuntimePath, "light.exe");
  const wixInputs = wixRuntimeInventory.inputs;
  await runAuthorityLeasedBuildTool(candle, [
    "-nologo", "-arch", "x64", `-dAuthorityServicePath=${temporaryService}`,
    "-out", temporaryServiceInstallerObject, temporaryServiceInstallerSource,
  ], {
    stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 64 * 1024, allowUnsignedTool: true,
    env: { SystemRoot: windowsDirectory, TEMP: buildWorkspace, TMP: buildWorkspace },
    sensitiveValues: [candle, temporaryService, temporaryServiceInstallerSource, temporaryServiceInstallerObject],
  }, [{ path: candle, sha256: sha256(heldIdentity(candle).bytes), tool: true }, ...wixInputs,
    { path: temporaryService, sha256: sha256(heldIdentity(temporaryService).bytes) },
    { path: temporaryServiceInstallerSource, sha256: sha256(serviceInstallerSourceBytes) }]);
  await runAuthorityLeasedBuildTool(light, [
    "-nologo", "-sval", "-out", temporaryServiceInstaller, temporaryServiceInstallerObject,
  ], {
    stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 64 * 1024, allowUnsignedTool: true,
    env: { SystemRoot: windowsDirectory, TEMP: buildWorkspace, TMP: buildWorkspace },
    sensitiveValues: [light, temporaryServiceInstallerObject, temporaryServiceInstaller],
  }, [{ path: light, sha256: sha256(heldIdentity(light).bytes), tool: true }, ...wixInputs,
    { path: temporaryServiceInstallerObject, sha256: sha256(heldIdentity(temporaryServiceInstallerObject).bytes) }]);
  if (signBuildPath) await signBuildPath(temporaryServiceInstaller);
  const serviceInstaller = heldIdentity(temporaryServiceInstaller);
  if (serviceInstaller.bytes.length < 4096 || serviceInstaller.bytes.length > 4 * 1024 * 1024) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
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
  const service = heldIdentity(temporaryService);
  if (service.bytes.length < 1024 || service.bytes.length > 1024 * 1024
    || service.bytes[0] !== 0x4d || service.bytes[1] !== 0x5a) {
    throw new WindowsHelperBuildError("BUILD_OUTPUT", "UNEXPECTED_EXIT");
  }
  const serviceSha256 = sha256(service.bytes);
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
  for (const before of toolRuntimeInventories) {
    const after = authoritativeDirectoryInventory(before.path);
    if (after.sha256 !== before.sha256 || after.files !== before.files || after.bytes !== before.bytes) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
    }
  }
  for (const [path, before] of [[source, committedSource], [serviceSource, committedServiceSource],
    [serviceInstallerSource, committedServiceInstallerSource], [launcherSource, committedLauncherSource],
    [smokeFixtureSource, committedSmokeFixtureSource]]) {
    const after = heldIdentity(path);
    if (after.device !== before.device || after.file !== before.file || sha256(after.bytes) !== sha256(before.bytes)) {
      throw new WindowsHelperBuildError("BUILD_SOURCE", "NONZERO_OUTPUT");
    }
  }
  verifyStagedLease(temporarySource, sourceLease, sourceBytes);
  verifyStagedLease(temporaryServiceSource, serviceSourceLease, serviceSourceBytes);
  verifyStagedLease(temporaryServiceInstallerSource, serviceInstallerSourceLease, serviceInstallerSourceBytes);
  verifyStagedLease(temporaryCompilerConfig, compilerConfigLease, compilerConfigBytes);
  verifyStagedLease(temporaryLauncherSource, launcherSourceLease, launcherSourceBytes);
  verifyStagedLease(temporarySmokeFixtureSource, smokeFixtureSourceLease, smokeFixtureSourceBytes);
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
    service: {
      version: "3.0.0", sourceSha256: serviceSourceSha256, imageSha256: serviceSha256,
      installerSourceSha256: serviceInstallerSourceSha256,
      installerSha256: sha256(serviceInstaller.bytes),
      authenticodeLeafSha256: validation ? null : derivedSigningPins.authenticodeLeafSha256,
      authenticodeSpkiSha256: validation ? null : derivedSigningPins.authenticodeSpkiSha256,
    },
    pe: { architecture: "anycpu", managed: true, deterministic: true },
    build: {
      toolchainProfile: resolvedToolchain.profile,
      compilerSha256: sha256(heldCompiler.bytes),
      launcherCompilerSha256: sha256(heldNativeCompiler.bytes),
      launcherLinkerSha256: sha256(heldNativeLinker.bytes),
      bootstrapSourceSha256,
      bootstrapSha256,
      compilerRelativePath: `${WINDOWS_BUILD_TOOLCHAIN_PROFILES[resolvedToolchain.profile].visualStudioPathFamily}/MSBuild/Current/Bin/Roslyn/csc.exe`,
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
      toolDependencies: [...toolRuntimeInventories, wixRuntimeInventory].map((item, index) => ({
        name: index === 0 ? "roslyn-runtime" : index === 1 ? "msvc-host-runtime" : "wix-runtime",
        sha256: item.sha256, files: item.files, bytes: item.bytes,
      })),
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
  if (evidenceStage === "BUILD_OUTPUT") {
    await runAuthorityLeasedBuildTool(temporaryOutput, ["--print-signing-pins-v1"], {
      stage: "BUILD_OUTPUT", timeout: 60_000, maxBytes: 1024,
      sensitiveValues: [temporaryOutput], allowUnsignedTool: true,
      evidenceLeaseTarget: temporaryOutput,
    }, [{ path: temporaryOutput, sha256: sha256(heldIdentity(temporaryOutput).bytes), tool: true }]);
  }
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
  // Evidence executions must retain every committed baseline byte. The real
  // build reaches this point only after compiler/linker/signing authority and
  // every candidate artifact have passed; it may then rotate the exact
  // reviewed release set before no-replace publication below.
  if (evidenceStage === undefined) {
    for (const final of [output, launcherOutput, manifestPath, signaturePath, smokeFixtureOutput,
      serviceOutput, serviceInstallerOutput]) {
      if (!existsSync(final)) continue;
      heldIdentity(final);
      rmSync(final);
    }
  }
  // Publication is no-replace at the final names after every byte and held
  // compiler/reference identity has been verified. Cleanup below proves no
  // compiler output survives a failed build.
  publishedOutput = publishOrVerifyBaseline(temporaryOutput, output);
  publishedLauncher = publishOrVerifyBaseline(temporaryLauncher, launcherOutput);
  publishedManifest = writeOrVerifyBaseline(manifestPath, body);
  publishedSignature = writeOrVerifyBaseline(signaturePath, signature);
  publishedSmokeFixture = publishOrVerifyBaseline(temporarySmokeFixture, smokeFixtureOutput);
  publishedService = publishOrVerifyBaseline(temporaryService, serviceOutput);
  publishedServiceInstaller = publishOrVerifyBaseline(temporaryServiceInstaller, serviceInstallerOutput);
  closeSync(sourceLease);
  sourceLease = undefined;
  closeSync(serviceSourceLease);
  serviceSourceLease = undefined;
  closeSync(serviceInstallerSourceLease);
  serviceInstallerSourceLease = undefined;
  closeSync(compilerConfigLease);
  compilerConfigLease = undefined;
  if (policyLease !== undefined) {
    closeSync(policyLease);
    policyLease = undefined;
  }
  closeSync(launcherSourceLease);
  launcherSourceLease = undefined;
  closeSync(smokeFixtureSourceLease);
  smokeFixtureSourceLease = undefined;
  rmSync(temporarySource, { force: true });
  rmSync(temporaryServiceSource, { force: true });
  rmSync(temporaryServiceInstallerSource, { force: true });
  rmSync(temporaryServiceInstallerObject, { force: true });
  rmSync(temporaryCompilerConfig, { force: true });
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
  if (serviceSourceLease !== undefined) {
    try { closeSync(serviceSourceLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  if (serviceInstallerSourceLease !== undefined) {
    try { closeSync(serviceInstallerSourceLease); } catch { /* Fixed build diagnostic owns failure output. */ }
  }
  if (compilerConfigLease !== undefined) {
    try { closeSync(compilerConfigLease); } catch { /* Fixed build diagnostic owns failure output. */ }
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
  rmSync(temporaryServiceSource, { force: true });
  rmSync(temporaryServiceInstallerSource, { force: true });
  rmSync(temporaryServiceInstallerObject, { force: true });
  rmSync(temporaryServiceInstaller, { force: true });
  rmSync(temporaryService, { force: true });
  rmSync(temporaryCompilerConfig, { force: true });
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
  if (publishedService) rmSync(serviceOutput, { force: true });
  if (publishedServiceInstaller) rmSync(serviceInstallerOutput, { force: true });
  const failure = error instanceof WindowsHelperBuildError
    ? error
    : new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN", error);
  process.stderr.write(`${fixedBuildDiagnostic(failure)}\n`);
  process.exitCode = 1;
}
