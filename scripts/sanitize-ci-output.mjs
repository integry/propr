#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REDACTION_ENVIRONMENT_VARIABLES = [
  "GITHUB_TOKEN_TO_REDACT",
  "PROPR_E2E_API_URL_TO_REDACT",
  "PROPR_E2E_TOKEN_TO_REDACT",
];

const CREDENTIAL_PATTERNS = [
  [/(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|token)?\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(\b(?:GITHUB_TOKEN|PROPR_E2E_TOKEN)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(["']?\b(?:access_?token|api_?key|client_?secret|password)\b["']?\s*[=:]\s*["']?)[^\s,"';&]+/gi, "$1[REDACTED]"],
  [/([?&](?:access_?token|api_?key|client_?secret|password)=)[^\s&#]+/gi, "$1[REDACTED]"],
  [/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]"],
  [/(https?:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, "$1[REDACTED]@"],
];

export function sanitizeCiOutput(output, environment = process.env) {
  let sanitized = output;
  const knownSecrets = REDACTION_ENVIRONMENT_VARIABLES
    .map((name) => environment[name])
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const secret of knownSecrets) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.replace(/~~~/g, "~~\u200b~");
}

export function sanitizeCiOutputFile(inputPath, outputPath, environment = process.env) {
  let output = "Test output file not available.";
  try {
    output = readFileSync(inputPath, "utf8");
  } catch {
    // Always create a safe diagnostic so artifact upload remains predictable.
  }
  writeFileSync(outputPath, sanitizeCiOutput(output, environment));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("Usage: node scripts/sanitize-ci-output.mjs <input> <output>");
    process.exitCode = 2;
  } else {
    sanitizeCiOutputFile(inputPath, outputPath);
  }
}
