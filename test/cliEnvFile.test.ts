import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { upsertEnvVars } from "../packages/cli/src/utils/envFile.js";

test("upsertEnvVars writes Docker env-file values without shell-style quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");

  upsertEnvVars(envPath, {
    PROPR_GH_RELAY_URL: "https://relay.example.test/v1",
    PROPR_GH_RELAY_TOKEN: "rly_secret-token_value.with-symbols",
  });

  assert.equal(
    readFileSync(envPath, "utf-8"),
    "PROPR_GH_RELAY_URL=https://relay.example.test/v1\nPROPR_GH_RELAY_TOKEN=rly_secret-token_value.with-symbols\n",
  );
});

test("upsertEnvVars rejects values Docker env files cannot represent on one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");

  assert.throws(
    () => upsertEnvVars(envPath, { PROPR_GH_RELAY_TOKEN: "rly_first\nsecond" }),
    /cannot contain newlines/,
  );
});

test("upsertEnvVars preserves export prefix when replacing a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "export PROPR_GH_RELAY_TOKEN=rly_old\n", "utf-8");

  upsertEnvVars(envPath, { PROPR_GH_RELAY_TOKEN: "rly_new" });

  assert.equal(readFileSync(envPath, "utf-8"), "export PROPR_GH_RELAY_TOKEN=rly_new\n");
});

test("upsertEnvVars tightens existing file permissions before writing", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "PROPR_GH_RELAY_TOKEN=rly_old\n", "utf-8");
  chmodSync(envPath, 0o644);

  upsertEnvVars(envPath, { PROPR_GH_RELAY_TOKEN: "rly_new" });

  assert.equal(readFileSync(envPath, "utf-8"), "PROPR_GH_RELAY_TOKEN=rly_new\n");
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
});
