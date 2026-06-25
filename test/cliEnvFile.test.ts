import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearEnvKeys, upsertEnvVars } from "../packages/cli/src/utils/envFile.js";

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

test("upsertEnvVars rejects values the env-file reader would truncate as inline comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");

  assert.throws(
    () => upsertEnvVars(envPath, { PROPR_GH_RELAY_TOKEN: "rly_value #notacomment" }),
    /whitespace followed by '#'/,
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

test("clearEnvKeys removes the given keys and preserves unrelated lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    "# header\nGH_AUTH_MODE=app\nexport GITHUB_USER_WHITELIST=alice,bob\nGH_APP_ID=1\n",
    "utf-8",
  );

  clearEnvKeys(envPath, ["GITHUB_USER_WHITELIST"]);

  // The targeted key (export-prefixed) is gone; everything else is untouched.
  assert.equal(readFileSync(envPath, "utf-8"), "# header\nGH_AUTH_MODE=app\nGH_APP_ID=1\n");
});

test("clearEnvKeys is a no-op for absent keys and a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "GH_AUTH_MODE=app\n", "utf-8");

  clearEnvKeys(envPath, ["NOT_PRESENT"]);
  assert.equal(readFileSync(envPath, "utf-8"), "GH_AUTH_MODE=app\n", "an absent key leaves the file untouched");

  // A missing file must not throw.
  clearEnvKeys(join(dir, "nope.env"), ["ANY"]);
});
