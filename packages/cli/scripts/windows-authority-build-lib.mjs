import { spawnSync } from "node:child_process";
import { linkSync, unlinkSync } from "node:fs";
import { win32 } from "node:path";

export const WINDOWS_HELPER_BUILD_STAGES = Object.freeze([
  "BUILD_COMPILER",
  "BUILD_SOURCE",
  "BUILD_OUTPUT",
]);

export const WINDOWS_HELPER_DIAGNOSTICS = Object.freeze([
  "UNKNOWN",
  "BAD_FLAG",
  "SYNTAX_ERROR",
  "MISSING_REFERENCE",
  "STALLED",
  "OVERSIZED_OUTPUT",
  "NONZERO_EMPTY_OUTPUT",
  "NONZERO_OUTPUT",
  "INVALID_UTF8",
  "SPAWN_ERROR",
  "UNEXPECTED_EXIT",
]);

const MAX_COMPILER_DIAGNOSTIC_BYTES = 64 * 1024;
const COMPILER_TIMEOUT_MS = 30_000;

export const WINDOWS_BUILD_LEASE_LIMITS = Object.freeze({
  maxFiles: 30_000,
  maxBytes: 1024 * 1024 * 1024,
  batchFiles: 512,
  batchBytes: 64 * 1024 * 1024,
  maxBatches: 128,
  baseDeadlineMs: 30_000,
  maxDeadlineMs: 180_000,
  minimumBytesPerSecond: 8 * 1024 * 1024,
  perFileMs: 2,
});

/**
 * Partition an already hash-validated inventory into a fixed bounded lease
 * protocol. A file is never split between authorities, so every READY token
 * still means that one native process owns a deny-write/delete lease over
 * complete file objects. The returned counters are the only readiness
 * progress exposed to the parent; no path or diagnostic text crosses the
 * channel.
 */
export function planWindowsBuildLeaseReadiness(inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > WINDOWS_BUILD_LEASE_LIMITS.maxFiles) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
  }
  let totalBytes = 0;
  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const input of inputs) {
    if (!input || typeof input !== "object" || !Number.isSafeInteger(input.bytes) || input.bytes < 0
      || input.bytes > WINDOWS_BUILD_LEASE_LIMITS.maxBytes) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
    }
    totalBytes += input.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > WINDOWS_BUILD_LEASE_LIMITS.maxBytes) {
      throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
    }
    if (batch.length > 0 && (batch.length >= WINDOWS_BUILD_LEASE_LIMITS.batchFiles
      || batchBytes + input.bytes > WINDOWS_BUILD_LEASE_LIMITS.batchBytes)) {
      batches.push(Object.freeze(batch));
      batch = [];
      batchBytes = 0;
    }
    batch.push(input);
    batchBytes += input.bytes;
  }
  if (batch.length > 0) batches.push(Object.freeze(batch));
  if (batches.length < 1 || batches.length > WINDOWS_BUILD_LEASE_LIMITS.maxBatches) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
  }
  const deadlineMs = Math.min(WINDOWS_BUILD_LEASE_LIMITS.maxDeadlineMs,
    WINDOWS_BUILD_LEASE_LIMITS.baseDeadlineMs
      + inputs.length * WINDOWS_BUILD_LEASE_LIMITS.perFileMs
      + Math.ceil(totalBytes * 1000 / WINDOWS_BUILD_LEASE_LIMITS.minimumBytesPerSecond));
  return Object.freeze({
    stages: Object.freeze(["INVENTORY", "LEASE_BATCH", "READY"]),
    files: inputs.length,
    bytes: totalBytes,
    deadlineMs,
    batches: Object.freeze(batches),
  });
}

export async function awaitWindowsBuildLeaseReadiness(readiness, plan, options = {}) {
  if (!Array.isArray(readiness) || readiness.length !== plan?.batches?.length
    || !Number.isSafeInteger(plan?.deadlineMs) || plan.deadlineMs < 1
    || plan.deadlineMs > WINDOWS_BUILD_LEASE_LIMITS.maxDeadlineMs) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  let timer;
  try {
    await Promise.race([
      Promise.all(readiness),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(new WindowsHelperBuildError(
          options.stage ?? "BUILD_COMPILER", "STALLED",
        )), plan.deadlineMs);
        timer?.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

// Reviewed leaf-certificate and SubjectPublicKeyInfo SHA-256 policy for the
// exact VS 17.14 / Roslyn 4.14 toolchain selected by the hosted build. These
// values come from the signed Microsoft distribution payloads, not from a
// certificate observed on the runner. A valid chain, matching subject, or
// shared Microsoft root is deliberately insufficient.
export const WINDOWS_BUILD_TOOL_SIGNER_POLICY = Object.freeze({
  compiler: Object.freeze({
    authenticodeLeafSha256: "35e68cd82f647085ef7da13ce37929fa2d298fae6cb1d41c66a00709d00c8eae",
    authenticodeSpkiSha256: "8598bc6053649a189e5ad15335f52fee71486e11f8e0f9947ae05814871e4560",
  }),
  "native-compiler": Object.freeze({
    authenticodeLeafSha256: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed",
    authenticodeSpkiSha256: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d",
  }),
  "native-linker": Object.freeze({
    authenticodeLeafSha256: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed",
    authenticodeSpkiSha256: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d",
  }),
  "sign-tool": Object.freeze({
    authenticodeLeafSha256: "0a9f9ec4820fcf1943ce23889211269e5d23e16d81c667060653bada8570eeb1",
    authenticodeSpkiSha256: "0af92917a95c39373521bd2fd5311057e26747e5084c5c320a34af8d6f9a7a85",
  }),
});

export const WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY = Object.freeze({
  "roslyn-runtime": Object.freeze({
    sha256: "72f9aafb187eb7db512466571374fc33d22d3120d1341c2bc6315c4e5e8b2209",
    files: 111,
    bytes: "38581501",
  }),
  "msvc-host-runtime": Object.freeze({
    sha256: "b2e20ac87ae5c38d72a2c6c6d2dbcfb013978b9e0240717656cd14b2d7957ac2",
    files: 53,
    bytes: "62411793",
  }),
});

export function authorizeWindowsBuildToolSigner(role, observed) {
  const expected = WINDOWS_BUILD_TOOL_SIGNER_POLICY[role];
  if (!expected || !observed || observed.signatureKind !== "E"
    || observed.authenticodeLeafSha256 !== expected.authenticodeLeafSha256
    || observed.authenticodeSpkiSha256 !== expected.authenticodeSpkiSha256) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  return { signatureKind: "E", ...expected };
}

export function authorizeWindowsBuildToolDependencies(role, observed) {
  const expected = WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY[role];
  if (!expected || !observed || observed.sha256 !== expected.sha256
    || observed.files !== expected.files || observed.bytes !== expected.bytes) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  return expected;
}

export class WindowsHelperBuildError extends Error {
  constructor(stage, diagnostic = "UNKNOWN", cause) {
    super("Windows authority helper build failed", cause === undefined ? undefined : { cause });
    this.name = "WindowsHelperBuildError";
    this.stage = WINDOWS_HELPER_BUILD_STAGES.includes(stage) ? stage : "BUILD_OUTPUT";
    this.diagnostic = WINDOWS_HELPER_DIAGNOSTICS.includes(diagnostic) ? diagnostic : "UNKNOWN";
  }

  get diagnosticIndex() {
    return WINDOWS_HELPER_DIAGNOSTICS.indexOf(this.diagnostic);
  }
}

/**
 * Return the one byte representation accepted for a security-pinned committed
 * source. Git attributes keep normal checkouts in this form; normalization is
 * retained at the build boundary so a pre-existing CRLF worktree cannot make
 * the bytes hashed differ from the bytes staged for the compiler. Bare CR is
 * not a text EOL and is rejected instead of being silently rewritten.
 */
export function canonicalWindowsBuildSourceBytes(value, stage = "BUILD_SOURCE") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x00) throw new WindowsHelperBuildError(stage, "NONZERO_OUTPUT");
    if (bytes[index] === 0x0d && (index + 1 >= bytes.byteLength || bytes[index + 1] !== 0x0a)) {
      throw new WindowsHelperBuildError(stage, "NONZERO_OUTPUT");
    }
  }
  return bytes.includes(0x0d)
    ? Buffer.from(bytes.toString("binary").replaceAll("\r\n", "\n"), "binary")
    : Buffer.from(bytes);
}

export function fixedBuildDiagnostic(error) {
  const failure = error instanceof WindowsHelperBuildError
    ? error
    : new WindowsHelperBuildError("BUILD_OUTPUT", "UNKNOWN", error);
  return `[win-authority-stage:${failure.stage}:${failure.diagnosticIndex}]`;
}

function boundedBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
}

export function sanitizeCompilerText(text, sensitiveValues = []) {
  let sanitized = text;
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || value.length === 0) continue;
    sanitized = sanitized.replaceAll(value, "<redacted>");
    sanitized = sanitized.replaceAll(value.replaceAll("\\", "/"), "<redacted>");
  }
  // Compiler diagnostics can repeat an absolute source/reference path in a
  // localized sentence. Classification only needs stable Roslyn error codes;
  // remove every remaining drive/UNC path and control character first.
  return sanitized
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n\0]*/g, "<redacted>")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?")
    .slice(0, MAX_COMPILER_DIAGNOSTIC_BYTES);
}

export function classifyCompilerFailure(text) {
  if (/\b(?:CS2007|CS1617)\b/u.test(text)) return "BAD_FLAG";
  if (/\bCS0006\b/u.test(text)) return "MISSING_REFERENCE";
  if (/\b(?:CS1001|CS1002|CS1003|CS1010|CS1022|CS1513|CS1525)\b/u.test(text)) return "SYNTAX_ERROR";
  return text.trim().length === 0 ? "NONZERO_EMPTY_OUTPUT" : "NONZERO_OUTPUT";
}

/**
 * Execute a compiler/tool with byte and wall-clock bounds. Nothing returned by
 * the child is suitable for logging: decoded text exists only long enough to
 * map a failure to a fixed diagnostic index.
 */
export function runBoundedBuildTool(command, args, options = {}) {
  const stage = options.stage ?? "BUILD_COMPILER";
  const maxBytes = options.maxBytes ?? MAX_COMPILER_DIAGNOSTIC_BYTES;
  const timeout = options.timeout ?? COMPILER_TIMEOUT_MS;
  let result;
  try {
    result = (options.spawnSyncImpl ?? spawnSync)(command, args, {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout,
      maxBuffer: maxBytes,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    throw new WindowsHelperBuildError(stage, "SPAWN_ERROR", error);
  }

  const stdout = boundedBytes(result.stdout);
  const stderr = boundedBytes(result.stderr);
  if (stdout.byteLength > maxBytes || stderr.byteLength > maxBytes
    || stdout.byteLength + stderr.byteLength > maxBytes) {
    throw new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT");
  }
  if (result.error) {
    const code = result.error.code;
    if (code === "ETIMEDOUT") throw new WindowsHelperBuildError(stage, "STALLED");
    if (code === "ENOBUFS") throw new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT");
    throw new WindowsHelperBuildError(stage, "SPAWN_ERROR", result.error);
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw new WindowsHelperBuildError(stage, result.signal === "SIGTERM" || result.signal === "SIGKILL"
      ? "STALLED"
      : "UNEXPECTED_EXIT");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([stdout, stderr]));
  } catch (error) {
    throw new WindowsHelperBuildError(stage, "INVALID_UTF8", error);
  }
  const sanitized = sanitizeCompilerText(text, options.sensitiveValues);
  if (result.status !== 0) {
    throw new WindowsHelperBuildError(stage, classifyCompilerFailure(sanitized));
  }
  if (result.status !== 0 || result.signal) {
    throw new WindowsHelperBuildError(stage, "UNEXPECTED_EXIT");
  }
  return { stdout, stderr };
}

export function assertModernRoslynVersion(version) {
  // VS 2022's in-box Roslyn has file version 4.x. Refuse Framework csc and
  // future/unreviewed major versions instead of silently changing toolchains.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/u.exec(version);
  if (!match || Number(match[1]) !== 4 || Number(match[2]) < 8 || Number(match[2]) > 20) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "BAD_FLAG");
  }
}

/** The production build's no-replace publication primitive. */
export function publishWindowsBuildArtifactNoReplace(temporaryPath, finalPath, options = {}) {
  options.beforePublish?.();
  linkSync(temporaryPath, finalPath);
  unlinkSync(temporaryPath);
}

/**
 * Validate the three paths returned by the native GetWindowsDirectoryW /
 * GetSystemWindowsDirectoryW / GetSystemDirectoryW probe.  In particular,
 * this deliberately does not compare against SystemRoot, windir, the Node
 * installation drive, or PATH: all of those are caller-controlled inputs.
 */
export function validateNativeWindowsDirectories(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  const windowsDirectory = value.windowsDirectory;
  const systemWindowsDirectory = value.systemWindowsDirectory;
  const systemDirectory = value.systemDirectory;
  const ordinary = (path) => typeof path === "string"
    && path.length >= 4
    && path.length < 32768
    && /^[A-Za-z]:\\[^\0\r\n]+$/u.test(path)
    && !path.startsWith("\\\\")
    && !path.includes("\\\\?\\")
    && !path.toLowerCase().includes("\\globalroot\\")
    && !path.split("\\").some((part) => part === "." || part === "..");
  if (!ordinary(windowsDirectory) || !ordinary(systemWindowsDirectory) || !ordinary(systemDirectory)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  const canonicalWindows = win32.normalize(windowsDirectory).toLowerCase();
  const canonicalSystemWindows = win32.normalize(systemWindowsDirectory).toLowerCase();
  const canonicalSystem = win32.normalize(systemDirectory).toLowerCase();
  if (canonicalWindows !== canonicalSystemWindows
    || win32.dirname(canonicalSystem) !== canonicalWindows
    || win32.basename(canonicalSystem) !== "system32"
    || win32.parse(canonicalSystem).root.toLowerCase() !== win32.parse(canonicalWindows).root.toLowerCase()) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  return Object.freeze({ windowsDirectory, systemWindowsDirectory, systemDirectory });
}
