import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidProjectSlug, normalizeProjectSlug } from "./resolveProject.js";

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

test("normalizeProjectSlug returns the trimmed slug for valid values", () => {
  assert.equal(normalizeProjectSlug("owner/repo"), "owner/repo");
  assert.equal(normalizeProjectSlug(" owner/repo "), "owner/repo");
  assert.equal(normalizeProjectSlug("\towner-name/repo.name\n"), "owner-name/repo.name");
});

test("normalizeProjectSlug returns null for invalid values", () => {
  assert.equal(normalizeProjectSlug("repo"), null);
  assert.equal(normalizeProjectSlug("owner/"), null);
  assert.equal(normalizeProjectSlug("owner/repo/extra"), null);
  assert.equal(normalizeProjectSlug("owner/ repo"), null);
});
