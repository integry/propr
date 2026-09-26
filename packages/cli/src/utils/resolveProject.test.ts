import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import type { ConfigManager } from "../config/index.js";
import {
  configureProjectOptionInheritance,
  isValidProjectSlug,
  normalizeProjectSlug,
  ProjectResolutionError,
  resolveOptionalProject,
  resolveProject,
} from "./resolveProject.js";

function configWithDefault(defaultProject?: string): ConfigManager {
  return {
    getDefaultProject: () => defaultProject,
  } as ConfigManager;
}

async function parseProject(
  args: string[],
  defaultProject?: string
): Promise<string> {
  const program = new Command()
    .exitOverride()
    .option("-p, --project <project>");
  configureProjectOptionInheritance(program);

  let resolved: string | undefined;
  program
    .command("plan")
    .command("list")
    .option("-p, --project <project>")
    .action((options: { project?: string }) => {
      resolved = resolveProject(options, configWithDefault(defaultProject));
    });

  await program.parseAsync(args, { from: "user" });
  if (resolved === undefined) {
    throw new Error("project action did not run");
  }
  return resolved;
}

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

test("project option supports the documented nested form", async () => {
  assert.equal(
    await parseProject(["plan", "list", "-p", "nested/repo"]),
    "nested/repo"
  );
});

test("project option supports the documented global form", async () => {
  assert.equal(
    await parseProject(["-p", "global/repo", "plan", "list"]),
    "global/repo"
  );
});

test("nested project takes precedence over global and configured projects", async () => {
  assert.equal(
    await parseProject(
      ["-p", "global/repo", "plan", "list", "-p", "nested/repo"],
      "default/repo"
    ),
    "nested/repo"
  );
});

test("global project takes precedence over the configured project", async () => {
  assert.equal(
    await parseProject(["-p", "global/repo", "plan", "list"], "default/repo"),
    "global/repo"
  );
});

test("configured project is the final fallback", async () => {
  assert.equal(
    await parseProject(["plan", "list"], " default/repo "),
    "default/repo"
  );
});

test("optional projects are normalized and invalid values are rejected", () => {
  assert.equal(resolveOptionalProject({ project: " owner/repo " }), "owner/repo");
  assert.equal(resolveOptionalProject({}), undefined);
  assert.throws(
    () => resolveOptionalProject({ project: "not-a-slug" }),
    ProjectResolutionError
  );
});

test("invalid explicit and configured projects are rejected", () => {
  assert.throws(
    () => resolveProject({ project: "invalid" }, configWithDefault("default/repo")),
    ProjectResolutionError
  );
  assert.throws(
    () => resolveProject({}, configWithDefault("invalid")),
    ProjectResolutionError
  );
});
