import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalRootKey } from "./rootKey.js";

test("Windows root keys keep distinct case-sensitive directory names separate", () => {
  const upperCaseRoot = canonicalRootKey("C:\\Stacks\\CaseSensitive", "win32");
  const lowerCaseRoot = canonicalRootKey("C:\\Stacks\\casesensitive", "win32");

  assert.equal(upperCaseRoot, "C:\\Stacks\\CaseSensitive");
  assert.equal(lowerCaseRoot, "C:\\Stacks\\casesensitive");
  assert.notEqual(upperCaseRoot, lowerCaseRoot);
});
