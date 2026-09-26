import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEnvSelection, clearEnvKeys, inspectStackInit, readEnvVars } from "./state.js";

function withStack(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(join(tmpdir(), "propr-local-setup-test-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("environment writes are private and re-runs preserve existing secrets", () => withStack((rootDir) => {
  const envPath = join(rootDir, ".env");
  const first = applyEnvSelection(rootDir, { API_TOKEN: "first-secret" });
  assert.deepEqual(first.written, ["API_TOKEN"]);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);

  const rerun = applyEnvSelection(rootDir, { API_TOKEN: "replacement", SAFE_VALUE: "yes" });
  assert.deepEqual(rerun.skipped, ["API_TOKEN"]);
  assert.deepEqual(readEnvVars(rootDir), { API_TOKEN: "first-secret", SAFE_VALUE: "yes" });
  assert.doesNotMatch(readFileSync(envPath, "utf8"), /replacement/);
}));

test("clearing a setup-owned key preserves unrelated values and private permissions", () => withStack((rootDir) => {
  const envPath = join(rootDir, ".env");
  writeFileSync(envPath, "TOKEN=secret\nKEEP=value\n", { mode: 0o644 });
  clearEnvKeys(rootDir, ["TOKEN"]);
  assert.equal(readFileSync(envPath, "utf8"), "KEEP=value\n");
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
}));

test("stack inspection requires the env file and every launcher directory", () => withStack((rootDir) => {
  writeFileSync(join(rootDir, ".env"), "A=b\n", { mode: 0o600 });
  mkdirSync(join(rootDir, "data"));
  mkdirSync(join(rootDir, "logs"));
  assert.equal(inspectStackInit(rootDir).initialized, false);
  mkdirSync(join(rootDir, "repos"));
  assert.equal(inspectStackInit(rootDir).initialized, true);
}));
