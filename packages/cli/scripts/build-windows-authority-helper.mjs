#!/usr/bin/env node
// Explicit, Windows-only build for the committed authority supervisor.
// Runtime and ordinary source builds never invoke this script or a compiler.

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const source = join(cliDir, "native", "windows-authority-supervisor.cs");
const outputDirectory = join(cliDir, "native", "prebuilds", "win32-anycpu");
const output = join(outputDirectory, "connect-authority-supervisor.exe");
const manifestPath = join(outputDirectory, "connect-authority-supervisor.manifest.json");
const signaturePath = join(outputDirectory, "connect-authority-supervisor.manifest.sig");
const validation = process.argv.includes("--validation");
const protocolVersion = 2;
const sourceSha256 = "382cd0cfb00bf23d13a13e91fc90b4f5e1dc54bdbc5780903f1c8562c07d2248";

if (process.platform !== "win32") {
  throw new Error("the Windows authority helper build is Windows-only");
}
if (validation === process.argv.includes("--production")) {
  throw new Error("select exactly one of --validation or --production");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function heldIdentity(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    return { bytes, device: stat.dev.toString(10), file: stat.ino.toString(10) };
  } finally {
    closeSync(fd);
  }
}

// The drive is anchored in Node's executable, not SystemRoot/windir/PATH. The
// canonical Windows directory is then identity checked before any child runs.
const drive = parse(process.execPath).root;
if (!/^[A-Za-z]:\\$/.test(drive)) throw new Error("trusted Windows drive is unavailable");
const windowsDirectory = join(drive, "Windows");
if (!statSync(windowsDirectory).isDirectory()
  || realpathSync.native(windowsDirectory).toLowerCase() !== windowsDirectory.toLowerCase()) {
  throw new Error("trusted Windows directory is unavailable");
}
const compilerCandidates = [
  join(windowsDirectory, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(windowsDirectory, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const compiler = compilerCandidates.find(existsSync);
if (!compiler) throw new Error("trusted Windows C# compiler is unavailable");
const references = [
  join(dirname(compiler), "mscorlib.dll"),
  join(dirname(compiler), "System.dll"),
  join(dirname(compiler), "System.Core.dll"),
  join(dirname(compiler), "System.Numerics.dll"),
  join(dirname(compiler), "System.Web.Extensions.dll"),
];
if (references.some((item) => !existsSync(item))) throw new Error("trusted Windows compiler reference is unavailable");

const heldCompiler = heldIdentity(compiler);
const heldReferences = references.map((item) => ({ path: item, ...heldIdentity(item) }));
const sourceBytes = Buffer.from(readFileSync(source, "utf8").replaceAll("\r\n", "\n"), "utf8");
if (sha256(sourceBytes) !== sourceSha256) throw new Error("audited authority supervisor source digest changed");

mkdirSync(outputDirectory, { recursive: true });
const nonce = createHash("sha256").update(`${process.pid}:${Date.now()}:${process.hrtime.bigint()}`).digest("hex");
const temporaryOutput = join(outputDirectory, `.connect-authority-supervisor.${nonce}.exe`);
try {
  const args = [
    "/nologo", "/noconfig", "/nostdlib+", "/target:exe", "/platform:anycpu", "/optimize+", "/deterministic+",
    `/out:${temporaryOutput}`,
    ...references.map((item) => `/reference:${item}`),
    source,
  ];
  execFileSync(compiler, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { SystemRoot: windowsDirectory, TEMP: outputDirectory, TMP: outputDirectory },
    maxBuffer: 64 * 1024,
  });
  if (!validation) {
    const signTool = process.env.PROPR_WINDOWS_SIGNTOOL;
    const certificate = process.env.PROPR_WINDOWS_CODESIGN_SHA1;
    const timestamp = process.env.PROPR_WINDOWS_TIMESTAMP_URL;
    if (!signTool || !parse(signTool).root || !/^[0-9A-Fa-f]{40}$/.test(certificate ?? "")
      || !timestamp?.startsWith("https://")) {
      throw new Error("trusted absolute signtool, signing certificate, and HTTPS timestamp are required");
    }
    heldIdentity(signTool);
    execFileSync(signTool, [
      "sign", "/fd", "SHA256", "/sha1", certificate, "/tr", timestamp, "/td", "SHA256", temporaryOutput,
    ], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 });
    execFileSync(signTool, ["verify", "/pa", "/all", "/v", temporaryOutput], {
      shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024,
    });
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
  const compilerAfter = heldIdentity(compiler);
  if (compilerAfter.device !== heldCompiler.device || compilerAfter.file !== heldCompiler.file || sha256(compilerAfter.bytes) !== sha256(heldCompiler.bytes)) {
    throw new Error("compiler identity changed during the build");
  }
  for (let index = 0; index < references.length; index += 1) {
    const after = heldIdentity(references[index]);
    const before = heldReferences[index];
    if (after.device !== before.device || after.file !== before.file || sha256(after.bytes) !== sha256(before.bytes)) {
      throw new Error("compiler reference identity changed during the build");
    }
  }
  const manifest = {
    format: "propr-windows-authority-helper-v2",
    protocolVersion,
    sourceSha256,
    helperSha256,
    pe: { architecture: "anycpu", managed: true, deterministic: true },
    build: {
      compilerSha256: sha256(heldCompiler.bytes),
      compilerRelativePath: compiler.slice(windowsDirectory.length + 1).replaceAll("\\", "/"),
      references: heldReferences.map((item) => ({
        name: item.path.slice(dirname(compiler).length + 1),
        sha256: sha256(item.bytes),
      })),
    },
    trust: validation
      ? { mode: "unsigned-validation", authenticodeLeafSha256: null, authenticodeSpkiSha256: null }
      : {
        mode: "production-signed",
        authenticodeLeafSha256: process.env.PROPR_WINDOWS_AUTHENTICODE_LEAF_SHA256 ?? "",
        authenticodeSpkiSha256: process.env.PROPR_WINDOWS_AUTHENTICODE_SPKI_SHA256 ?? "",
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
  rmSync(output, { force: true });
  rmSync(manifestPath, { force: true });
  rmSync(signaturePath, { force: true });
  renameSync(temporaryOutput, output);
  writeFileSync(manifestPath, body, { flag: "wx" });
  writeFileSync(signaturePath, signature, { flag: "wx" });
  process.stdout.write(`Windows authority helper: BUILD_OUTPUT sha256=${helperSha256} trust=${manifest.trust.mode}\n`);
} catch (error) {
  rmSync(temporaryOutput, { force: true });
  rmSync(output, { force: true });
  rmSync(manifestPath, { force: true });
  rmSync(signaturePath, { force: true });
  throw error;
}
