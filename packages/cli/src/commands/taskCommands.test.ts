import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFollowupBodyArgument } from "./taskCommands.js";

test("resolveFollowupBodyArgument preserves multi-word follow-up text", () => {
  assert.equal(
    resolveFollowupBodyArgument(["Please", "also", "add", "tests"]),
    "Please also add tests"
  );
});

test("resolveFollowupBodyArgument leaves absent body undefined", () => {
  assert.equal(resolveFollowupBodyArgument(undefined), undefined);
});
