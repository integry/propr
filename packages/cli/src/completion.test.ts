import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function generateCompletion(shell: "bash" | "zsh" | "fish"): string {
  return execFileSync("npx", ["tsx", "packages/cli/src/index.ts", "completion", shell], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("completion scripts include new command groups and options", () => {
  const bash = generateCompletion("bash");

  assert.match(bash, /task followup/);
  assert.match(bash, /task import/);
  assert.match(bash, /task revert/);
  assert.match(bash, /setting reindex-summaries/);
  assert.match(bash, /config profile set/);
  assert.match(bash, /backend/);
  assert.match(bash, /--dry-run/);
  assert.match(bash, /--clear-token/);
  assert.match(bash, /--ignore-cooldown/);
});

test("completion command supports every advertised shell", () => {
  assert.match(generateCompletion("bash"), /complete -F _propr_completion propr/);
  assert.match(generateCompletion("zsh"), /#compdef propr/);
  assert.match(generateCompletion("fish"), /complete -c propr/);
});
