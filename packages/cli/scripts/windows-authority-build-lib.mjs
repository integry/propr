import { spawn, spawnSync } from "node:child_process";
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
  "TOOLCHAIN_MISMATCH",
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

const WINDOWS_BUILD_PROGRESS_PREFIX = "PROPR_BUILD_PROGRESS_V1";

export function formatWindowsBuildProgressFrame(frame) {
  const values = [frame.stage, frame.stages, frame.batch, frame.batches,
    frame.files, frame.totalFiles, frame.bytes, frame.totalBytes];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  return `${WINDOWS_BUILD_PROGRESS_PREFIX} ${frame.stage}/${frame.stages} ${frame.batch}/${frame.batches} ${frame.files}/${frame.totalFiles} ${frame.bytes}/${frame.totalBytes}\n`;
}

export function parseWindowsBuildProgressFrame(value) {
  if (typeof value !== "string" || value.length > 192) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  const match = /^PROPR_BUILD_PROGRESS_V1 (0|[1-9]\d*)\/(0|[1-9]\d*) (0|[1-9]\d*)\/(0|[1-9]\d*) (0|[1-9]\d*)\/(0|[1-9]\d*) (0|[1-9]\d*)\/(0|[1-9]\d*)\n$/u.exec(value);
  if (!match) throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  const numbers = match.slice(1).map(Number);
  if (!numbers.every(Number.isSafeInteger)) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
  }
  const [stage, stages, batch, batches, files, totalFiles, bytes, totalBytes] = numbers;
  if (stages < 1 || stage < 1 || stage > stages || batch > batches || files > totalFiles || bytes > totalBytes
    || stages > 64 || batches > WINDOWS_BUILD_LEASE_LIMITS.maxBatches
    || totalFiles > WINDOWS_BUILD_LEASE_LIMITS.maxFiles || totalBytes > WINDOWS_BUILD_LEASE_LIMITS.maxBytes) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "OVERSIZED_OUTPUT");
  }
  return Object.freeze({ stage, stages, batch, batches, files, totalFiles, bytes, totalBytes });
}

export function windowsBuildLeaseProgressFrames(plan) {
  if (!plan || !Array.isArray(plan.batches) || plan.batches.length < 1) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  let files = 0;
  let bytes = 0;
  const frames = [{ stage: 1, stages: 3, batch: 0, batches: plan.batches.length,
    files: 0, totalFiles: plan.files, bytes: 0, totalBytes: plan.bytes }];
  for (let index = 0; index < plan.batches.length; index += 1) {
    for (const input of plan.batches[index]) {
      files += 1;
      bytes += input.bytes;
    }
    frames.push({ stage: 2, stages: 3, batch: index + 1, batches: plan.batches.length,
      files, totalFiles: plan.files, bytes, totalBytes: plan.bytes });
  }
  frames.push({ stage: 3, stages: 3, batch: plan.batches.length, batches: plan.batches.length,
    files: plan.files, totalFiles: plan.files, bytes: plan.bytes, totalBytes: plan.bytes });
  return Object.freeze(frames.map((frame) => formatWindowsBuildProgressFrame(frame)));
}

export function createWindowsBuildProgressValidator(expectedFrames, stage = "BUILD_COMPILER") {
  if (!Array.isArray(expectedFrames) || expectedFrames.length < 1
    || expectedFrames.length > WINDOWS_BUILD_LEASE_LIMITS.maxBatches + 64) {
    throw new WindowsHelperBuildError(stage, "NONZERO_OUTPUT");
  }
  const expected = expectedFrames.map((frame) => parseWindowsBuildProgressFrame(frame));
  let index = 0;
  let prior;
  return Object.freeze({
    push(value) {
      const observed = parseWindowsBuildProgressFrame(value);
      const next = expected[index];
      if (!next || Object.keys(next).some((key) => observed[key] !== next[key])
        || (prior && (observed.stage < prior.stage || observed.batch < prior.batch
          || observed.files < prior.files || observed.bytes < prior.bytes))) {
        throw new WindowsHelperBuildError(stage, "NONZERO_OUTPUT");
      }
      prior = observed;
      index += 1;
    },
    finish() {
      if (index !== expected.length) throw new WindowsHelperBuildError(stage, "STALLED");
    },
    get count() { return index; },
  });
}

/**
 * Run a slow discovery tool under one hard deadline while accepting only the
 * exact fixed progress transcript selected by the caller. stderr is reserved
 * for those bounded frames; paths and native diagnostic text never cross it.
 */
export function runBoundedProgressBuildTool(command, args, options = {}) {
  const stage = options.stage ?? "BUILD_COMPILER";
  const timeout = options.timeout ?? WINDOWS_BUILD_LEASE_LIMITS.maxDeadlineMs;
  const maxBytes = options.maxBytes ?? MAX_COMPILER_DIAGNOSTIC_BYTES;
  const maxProgressBytes = options.maxProgressBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WINDOWS_BUILD_LEASE_LIMITS.maxDeadlineMs
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxProgressBytes) || maxProgressBytes < 1 || maxProgressBytes > 64 * 1024) {
    return Promise.reject(new WindowsHelperBuildError(stage, "NONZERO_OUTPUT"));
  }
  const validator = createWindowsBuildProgressValidator(options.progressFrames, stage);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdout = Buffer.alloc(0);
    let progress = Buffer.alloc(0);
    let progressBytes = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { child?.kill("SIGKILL"); } catch { /* The fixed diagnostic owns termination failure. */ }
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new WindowsHelperBuildError(stage, "STALLED")), timeout);
    timer.unref?.();
    try {
      child = (options.spawnImpl ?? spawn)(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(new WindowsHelperBuildError(stage, "SPAWN_ERROR", error));
      return;
    }
    child.once("error", (error) => finish(new WindowsHelperBuildError(stage, "SPAWN_ERROR", error)));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.byteLength > maxBytes) finish(new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT"));
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      progressBytes += bytes.byteLength;
      progress = Buffer.concat([progress, bytes]);
      if (progressBytes > maxProgressBytes) {
        finish(new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT"));
        return;
      }
      while (true) {
        const newline = progress.indexOf(0x0a);
        if (newline < 0) break;
        const frame = progress.subarray(0, newline + 1);
        progress = progress.subarray(newline + 1);
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(frame); }
        catch (error) { finish(new WindowsHelperBuildError(stage, "INVALID_UTF8", error)); return; }
        try { validator.push(text); }
        catch (error) { finish(error); return; }
      }
      if (progress.byteLength > 192) finish(new WindowsHelperBuildError(stage, "OVERSIZED_OUTPUT"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (progress.byteLength !== 0) return finish(new WindowsHelperBuildError(stage, "NONZERO_OUTPUT"));
      if (signal) return finish(new WindowsHelperBuildError(stage, "UNEXPECTED_EXIT"));
      if (code !== 0) return finish(new WindowsHelperBuildError(stage,
        stdout.byteLength === 0 ? "NONZERO_EMPTY_OUTPUT" : "NONZERO_OUTPUT"));
      try { validator.finish(); }
      catch (error) { finish(error); return; }
      finish(undefined, { stdout, stderr: Buffer.alloc(0) });
    });
  });
}

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
  const progressFrames = windowsBuildLeaseProgressFrames(plan);
  const validator = createWindowsBuildProgressValidator(progressFrames, options.stage ?? "BUILD_COMPILER");
  // Attach rejection handlers to every concurrently running authority before
  // awaiting them in fixed batch order. A later batch may fail first on a slow
  // host; it must remain a bounded protocol failure, never an unhandled one.
  const guardedReadiness = readiness.map((item) => Promise.resolve(item).then(
    (value) => ({ value }),
    (error) => ({ error }),
  ));
  let timer;
  try {
    await Promise.race([
      (async () => {
        validator.push(progressFrames[0]);
        for (let index = 0; index < guardedReadiness.length; index += 1) {
          const observed = await guardedReadiness[index];
          if ("error" in observed) throw observed.error;
          validator.push(observed.value);
        }
        validator.push(progressFrames.at(-1));
        validator.finish();
      })(),
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
// exact VS 17.14/Roslyn 4.14 and VS 18.9/Roslyn 5.900 toolchains selected by
// the hosted x64 and ARM64 builds. These
// values come from the signed Microsoft distribution payloads, not from a
// certificate observed on the runner. A valid chain, matching subject, or
// shared Microsoft root is deliberately insufficient.
const VS2026_COMPILER_SIGNER = Object.freeze({
  authenticodeLeafSha256: "b89f8f6bf4f50250528995fd16e228f1b24ee0017d8f87b0c756c1b85b82f58c",
  authenticodeSpkiSha256: "c36d219b65bcb11b4c7766f5e4707aac8e7f391fb57d9be21b31ff06c0c27d8a",
});
const VS2026_NATIVE_COMPILER_SIGNER = Object.freeze({
  authenticodeLeafSha256: "c30b441672c82883d92eddac6d24cb57e9960bda4486c7fb5865e74157f35850",
  authenticodeSpkiSha256: "72bc03497a5c3fd67db74a5c648239fa9d212ff61a64250d28e475d688d49b97",
});
const VS2022_COMPILER_SIGNER = Object.freeze({
  authenticodeLeafSha256: "35e68cd82f647085ef7da13ce37929fa2d298fae6cb1d41c66a00709d00c8eae",
  authenticodeSpkiSha256: "8598bc6053649a189e5ad15335f52fee71486e11f8e0f9947ae05814871e4560",
});
const SHARED_NATIVE_LINKER_SIGNER = Object.freeze({
  authenticodeLeafSha256: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed",
  authenticodeSpkiSha256: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d",
});

export const WINDOWS_BUILD_TOOL_SIGNER_POLICY = Object.freeze({
  "vs2026-18.9-x64": Object.freeze({
    compiler: VS2026_COMPILER_SIGNER,
    "native-compiler": VS2026_NATIVE_COMPILER_SIGNER,
    "native-linker": SHARED_NATIVE_LINKER_SIGNER,
  }),
  "vs2026-18.9-arm64": Object.freeze({
    compiler: VS2022_COMPILER_SIGNER,
    "native-compiler": VS2026_NATIVE_COMPILER_SIGNER,
    "native-linker": SHARED_NATIVE_LINKER_SIGNER,
  }),
  "vs2022-17.14-x64": Object.freeze({
    compiler: VS2022_COMPILER_SIGNER,
    "native-compiler": SHARED_NATIVE_LINKER_SIGNER,
    "native-linker": SHARED_NATIVE_LINKER_SIGNER,
  }),
  "sign-tool": Object.freeze({
    authenticodeLeafSha256: "0a9f9ec4820fcf1943ce23889211269e5d23e16d81c667060653bada8570eeb1",
    authenticodeSpkiSha256: "0af92917a95c39373521bd2fd5311057e26747e5084c5c320a34af8d6f9a7a85",
  }),
});

export const WINDOWS_BUILD_TOOLCHAIN_PROFILES = Object.freeze({
  "vs2026-18.9-x64": Object.freeze({
    visualStudioRange: "[18.9,18.10)",
    visualStudioVersion: "18.9.12112.369",
    visualStudioPathFamily: "VisualStudio/18",
    roslynVersion: "5.900.26.35703",
    msvcVersion: "14.51.36231",
    msvcProductVersion: "14.51.36256.0",
    runnerArchitecture: "x64",
  }),
  "vs2026-18.9-arm64": Object.freeze({
    visualStudioRange: "[18.9,18.10)",
    visualStudioVersion: "18.9.12112.369",
    visualStudioPathFamily: "VisualStudio/18",
    roslynVersion: "5.900.26.35703",
    msvcVersion: "14.51.36231",
    msvcProductVersion: "14.51.36256.0",
    runnerArchitecture: "arm64",
  }),
  "vs2022-17.14-x64": Object.freeze({
    visualStudioRange: "[17.14,17.15)",
    visualStudioVersion: "17.14.37502.11",
    visualStudioPathFamily: "VisualStudio/2022/17.14",
    roslynVersion: "4.14",
    msvcVersion: "14.44",
    msvcProductVersion: "14.44",
    runnerArchitecture: "x64",
  }),
});

export const WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY = Object.freeze({
  "vs2026-18.9-x64": Object.freeze({
    "roslyn-runtime": Object.freeze({
      sha256: "d4630911fcc8edd9ea0581c2d905270790b0f3de2b212d4f8a9a8b2164d016e5",
      files: 111,
      bytes: "35634755",
    }),
    "msvc-host-runtime": Object.freeze({
      sha256: "779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13",
      files: 84,
      bytes: "126253430",
    }),
  }),
  "vs2026-18.9-arm64": Object.freeze({
    "roslyn-runtime": Object.freeze({
      sha256: "65c926bb608189705239c90f011b52a1f493d569d00027468cdb5961aa21d026",
      files: 111,
      bytes: "35633203",
    }),
    "msvc-host-runtime": Object.freeze({
      sha256: "779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13",
      files: 84,
      bytes: "126253430",
    }),
  }),
  "vs2022-17.14-x64": Object.freeze({
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
  }),
  "wix-runtime": Object.freeze({
    sha256: "732cdbb86eda6156f859cda583c0e1632e0c1a213aaabc6bee052e335549b298",
    files: 33,
    bytes: "31929694",
  }),
});

export function authorizeWindowsBuildToolSigner(profile, role, observed) {
  const expected = role === "sign-tool"
    ? WINDOWS_BUILD_TOOL_SIGNER_POLICY[role]
    : WINDOWS_BUILD_TOOL_SIGNER_POLICY[profile]?.[role];
  if (!expected || !observed || observed.signatureKind !== "E"
    || observed.authenticodeLeafSha256 !== expected.authenticodeLeafSha256
    || observed.authenticodeSpkiSha256 !== expected.authenticodeSpkiSha256) {
    throw new WindowsHelperBuildError("BUILD_COMPILER", "NONZERO_OUTPUT");
  }
  return { signatureKind: "E", ...expected };
}

export function authorizeWindowsBuildToolDependencies(profile, role, observed) {
  const expected = role === "wix-runtime"
    ? WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY[role]
    : WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY[profile]?.[role];
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

export function assertModernRoslynVersion(version, profile = "vs2022-17.14-x64") {
  const allowed = profile === "vs2026-18.9-x64" || profile === "vs2026-18.9-arm64"
    ? /^5\.900\.26\.35703$/u
    : profile === "vs2022-17.14-x64" ? /^4\.14(?:\.\d+){1,2}$/u : null;
  if (!allowed?.test(version)) {
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
