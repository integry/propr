import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidProjectSlug } from "./resolveProject.js";

test("isValidProjectSlug accepts owner/repo values", () => {
  assert.equal(isValidProjectSlug("owner/repo"), true);
  assert.equal(isValidProjectSlug("owner-name/repo.name"), true);
  assert.equal(isValidProjectSlug(" owner/repo "), true);
});

test("isValidProjectSlug rejects missing, empty, or path-like project segments", () => {
  assert.equal(isValidProjectSlug("repo"), false);
  assert.equal(isValidProjectSlug("owner/"), false);
  assert.equal(isValidProjectSlug("/repo"), false);
  assert.equal(isValidProjectSlug("owner/repo/extra"), false);
  assert.equal(isValidProjectSlug("../repo"), false);
});
