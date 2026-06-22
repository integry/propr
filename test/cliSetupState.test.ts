import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSetupState,
  getEnvValue,
  getStackState,
  isPlaceholderEnvValue,
  isSetupComplete,
  isStackInitialized,
  nextActionableStep,
  readEnvValues,
  seedEnvDefaults,
  summarizeSetup,
  updateStep,
  writeEnvSelection,
} from "../packages/cli/src/commands/setup/state.js";
import { SETUP_STEPS } from "../packages/cli/src/commands/setup/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "propr-setup-"));
}

test("getStackState reports an uninitialized root and isStackInitialized agrees", () => {
  const dir = tempDir();
  const state = getStackState(dir);
  assert.equal(state.envExists, false);
  assert.equal(state.initialized, false);
  assert.equal(isStackInitialized(dir), false);
});

test("getStackState reports a fully scaffolded root as initialized", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "FOO=bar\n", "utf-8");
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "logs"));
  mkdirSync(join(dir, "repos"));
  assert.equal(getStackState(dir).initialized, true);
  assert.equal(isStackInitialized(dir), true);
});

test("readEnvValues parses assignments and ignores comments/blanks", () => {
  const dir = tempDir();
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "# comment\n\nexport GH_APP_ID=123\nGITHUB_USER_WHITELIST=alice,bob\n", "utf-8");
  assert.deepEqual(readEnvValues(envPath), { GH_APP_ID: "123", GITHUB_USER_WHITELIST: "alice,bob" });
  assert.equal(getEnvValue(envPath, "GH_APP_ID"), "123");
  assert.equal(getEnvValue(envPath, "MISSING"), undefined);
});

test("readEnvValues returns {} when the file is absent", () => {
  assert.deepEqual(readEnvValues(join(tempDir(), ".env")), {});
});

test("isPlaceholderEnvValue flags empty and .env.example placeholders", () => {
  assert.equal(isPlaceholderEnvValue(undefined), true);
  assert.equal(isPlaceholderEnvValue(""), true);
  assert.equal(isPlaceholderEnvValue("your_app_id"), true);
  assert.equal(isPlaceholderEnvValue("/path/to/key.pem"), true);
  assert.equal(isPlaceholderEnvValue("changeme"), true);
  assert.equal(isPlaceholderEnvValue("12345"), false);
});

test("writeEnvSelection writes explicit values and skips empty ones", () => {
  const dir = tempDir();
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "GH_APP_ID=old\nKEEP=me\n", "utf-8");

  const result = writeEnvSelection(envPath, { GH_APP_ID: "new", GH_INSTALLATION_ID: undefined, EMPTY: "" });

  assert.deepEqual(result.written, ["GH_APP_ID"]);
  assert.deepEqual(result.skipped.sort(), ["EMPTY", "GH_INSTALLATION_ID"]);
  const values = readEnvValues(envPath);
  assert.equal(values.GH_APP_ID, "new"); // explicit selection overwrites
  assert.equal(values.KEEP, "me"); // unrelated line preserved
});

test("seedEnvDefaults only fills missing or placeholder values", () => {
  const dir = tempDir();
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "HOST_CLAUDE_DIR=/real/claude\nGH_APP_ID=your_app_id\n", "utf-8");

  const result = seedEnvDefaults(envPath, {
    HOST_CLAUDE_DIR: "/detected/claude", // real value -> preserved
    GH_APP_ID: "555", // placeholder -> written
    HOST_CODEX_DIR: "/detected/codex", // missing -> written
  });

  assert.deepEqual(result.preserved, ["HOST_CLAUDE_DIR"]);
  assert.deepEqual(result.written.sort(), ["GH_APP_ID", "HOST_CODEX_DIR"]);
  const values = readEnvValues(envPath);
  assert.equal(values.HOST_CLAUDE_DIR, "/real/claude");
  assert.equal(values.GH_APP_ID, "555");
  assert.equal(values.HOST_CODEX_DIR, "/detected/codex");
});

test("step model advances and summarizes for renderers", () => {
  let state = createSetupState("/tmp/root");
  assert.equal(state.steps.length, SETUP_STEPS.length);
  assert.equal(nextActionableStep(state)?.id, SETUP_STEPS[0].id);

  state = updateStep(state, "checks", "done", { detail: "all green" });
  const checks = state.steps.find((s) => s.id === "checks");
  assert.equal(checks?.status, "done");
  assert.equal(checks?.detail, "all green");
  assert.equal(nextActionableStep(state)?.id, SETUP_STEPS[1].id);

  assert.equal(summarizeSetup(state).done, 1);
  assert.equal(isSetupComplete(state), false);

  // Drive every remaining step to a settled status.
  for (const def of SETUP_STEPS) {
    state = updateStep(state, def.id, def.optional ? "skipped" : "done");
  }
  assert.equal(isSetupComplete(state), true);
  assert.equal(nextActionableStep(state), undefined);
});
