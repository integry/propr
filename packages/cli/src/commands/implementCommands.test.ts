import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOptionalImplementationRepository } from "./implementCommands.js";

test("resolveOptionalImplementationRepository does not require a project", () => {
  const repository = resolveOptionalImplementationRepository({});

  assert.equal(repository, undefined);
});

test("resolveOptionalImplementationRepository asserts only an explicit project", () => {
  const repository = resolveOptionalImplementationRepository({ project: "explicit/repo" });

  assert.equal(repository, "explicit/repo");
});

test("resolveOptionalImplementationRepository rejects invalid repositories", () => {
  assert.throws(
    () => resolveOptionalImplementationRepository({ project: "not a repository" }),
    /Invalid project format/
  );
});

test("resolveOptionalImplementationRepository trims surrounding whitespace before sending", () => {
  const repository = resolveOptionalImplementationRepository({ project: " owner/repo " });

  assert.equal(repository, "owner/repo");
});
