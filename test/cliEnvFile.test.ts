import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
