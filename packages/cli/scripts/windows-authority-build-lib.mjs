import { spawnSync } from "node:child_process";

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
