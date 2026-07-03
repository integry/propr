import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOptionalImplementationRepository } from "./implementCommands.js";

test("resolveOptionalImplementationRepository does not require a configured project", () => {
  const repository = resolveOptionalImplementationRepository(
    {},
    { getDefaultProject: () => undefined }
  );

  assert.equal(repository, undefined);
});

test("resolveOptionalImplementationRepository prefers explicit project over default", () => {
  const repository = resolveOptionalImplementationRepository(
    { project: "explicit/repo" },
    { getDefaultProject: () => "default/repo" }
  );

  assert.equal(repository, "explicit/repo");
});

test("resolveOptionalImplementationRepository falls back to default project", () => {
  const repository = resolveOptionalImplementationRepository(
    {},
    { getDefaultProject: () => "default/repo" }
  );

  assert.equal(repository, "default/repo");
});

test("resolveOptionalImplementationRepository rejects invalid repositories", () => {
  assert.throws(
    () => resolveOptionalImplementationRepository(
      { project: "not a repository" },
      { getDefaultProject: () => undefined }
    ),
    /Invalid project format/
  );
});
