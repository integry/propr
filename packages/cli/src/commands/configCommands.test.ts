import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeRemoteProfile, sanitizeRemoteProfiles } from "./configCommands.js";

test("sanitizeRemoteProfile redacts GitHub tokens for JSON-safe views", () => {
  assert.deepEqual(
    sanitizeRemoteProfile({
      remoteUrl: "https://api.example.com",
      defaultProject: "owner/repo",
      githubToken: "ghp_1234567890abcdef",
    }),
    {
      remoteUrl: "https://api.example.com",
      defaultProject: "owner/repo",
      githubToken: "ghp_...cdef",
    }
  );
});

test("sanitizeRemoteProfile does not expose short tokens", () => {
  assert.deepEqual(sanitizeRemoteProfile({ githubToken: "secret" }), {
    remoteUrl: undefined,
    defaultProject: undefined,
    githubToken: "(set)",
  });
});

test("sanitizeRemoteProfiles redacts every profile token", () => {
  const view = sanitizeRemoteProfiles({
    default: { githubToken: "ghp_defaulttoken" },
    staging: { githubToken: "ghp_stagingtoken" },
  });

  assert.equal(view.default.githubToken, "ghp_...oken");
  assert.equal(view.staging.githubToken, "ghp_...oken");
  assert.equal(JSON.stringify(view).includes("defaulttoken"), false);
  assert.equal(JSON.stringify(view).includes("stagingtoken"), false);
});
