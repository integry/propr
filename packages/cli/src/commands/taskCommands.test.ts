import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFollowupBodyArgument, selectBodySource } from "./taskCommands.js";

test("resolveFollowupBodyArgument preserves multi-word follow-up text", () => {
  assert.equal(
    resolveFollowupBodyArgument(["Please", "also", "add", "tests"]),
    "Please also add tests"
  );
});

test("resolveFollowupBodyArgument leaves absent body undefined", () => {
  assert.equal(resolveFollowupBodyArgument(undefined), undefined);
});

test("selectBodySource picks the single provided source", () => {
  assert.equal(selectBodySource({ argument: "text" }), "argument");
  assert.equal(selectBodySource({ file: "notes.md" }), "file");
  assert.equal(selectBodySource({ stdin: true }), "stdin");
  assert.equal(selectBodySource({}), "none");
});

test("selectBodySource treats an empty positional argument as absent", () => {
  assert.equal(selectBodySource({ argument: "", file: "notes.md" }), "file");
  assert.equal(selectBodySource({ argument: "" }), "none");
});

test("selectBodySource rejects conflicting sources instead of silently dropping input", () => {
  assert.throws(
    () => selectBodySource({ argument: "text", file: "notes.md" }),
    /only one of: argument, --file, or --stdin/
  );
  assert.throws(
    () => selectBodySource({ argument: "text", stdin: true }),
    /only one of: argument, --file, or --stdin/
  );
  assert.throws(
    () => selectBodySource({ file: "notes.md", stdin: true }),
    /only one of: argument, --file, or --stdin/
  );
});
