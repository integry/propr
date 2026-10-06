import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMaxCostOption, resolveOptionalImplementationRepository } from "./implementCommands.js";

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
    /Invalid project/
  );
});

test("resolveOptionalImplementationRepository trims surrounding whitespace before sending", () => {
  const repository = resolveOptionalImplementationRepository({ project: " owner/repo " });

  assert.equal(repository, "owner/repo");
});

test("parseMaxCostOption accepts USD amounts and rejects anything that is not one", () => {
  assert.equal(parseMaxCostOption(undefined), undefined);
  assert.equal(parseMaxCostOption("5"), 5);
  assert.equal(parseMaxCostOption("$2.50"), 2.5);
  for (const invalid of ["0", "-1", "five", "1e3", "100001"]) {
    assert.throws(() => parseMaxCostOption(invalid), /--max-cost must be a USD amount/, invalid);
  }
});
