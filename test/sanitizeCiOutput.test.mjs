import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeCiOutput } from "../scripts/sanitize-ci-output.mjs";

describe("CI output sanitization", () => {
  it("redacts configured values, authorization headers, tokens, and authenticated URLs", () => {
    const output = [
      "nightly-secret",
      "https://e2e.example.test/private",
      "Authorization: Bearer header-secret",
      "PROPR_E2E_TOKEN=variable-secret",
      '"access_token":"json-secret"',
      "https://example.test/callback?access_token=query-secret&ok=1",
      "https://user:password@example.test/repo",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
    ].join("\n");

    const sanitized = sanitizeCiOutput(output, {
      PROPR_E2E_TOKEN_TO_REDACT: "nightly-secret",
      PROPR_E2E_API_URL_TO_REDACT: "https://e2e.example.test",
    });

    for (const secret of [
      "nightly-secret",
      "https://e2e.example.test",
      "header-secret",
      "variable-secret",
      "json-secret",
      "query-secret",
      "user:password",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
    ]) {
      assert.equal(sanitized.includes(secret), false, `expected ${secret} to be redacted`);
    }
  });

  it("escapes markdown fences before diagnostics are embedded in comments", () => {
    assert.equal(sanitizeCiOutput("before\n~~~\nafter", {}), "before\n~~\u200b~\nafter");
  });
});
