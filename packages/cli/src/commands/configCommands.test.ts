import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { ConfigManager } from "../config/index.js";
import { configureProjectOptionInheritance } from "../utils/index.js";
import {
  createConfigCommand,
  isValidRemoteUrl,
  sanitizeRemoteProfile,
  sanitizeRemoteProfiles,
} from "./configCommands.js";

test("sanitizeRemoteProfile redacts GitHub tokens for JSON-safe views", () => {
  assert.deepEqual(
    sanitizeRemoteProfile({
      remoteUrl: "https://api.example.com",
      defaultProject: "owner/repo",
      githubToken: "ghp_1234567890abcdef",
    }),
    {
      remoteUrl: "https://api.example.com",
      defaultProject: "owner/repo",
      githubToken: "ghp_...cdef",
    }
  );
});

test("sanitizeRemoteProfile does not expose short tokens", () => {
  assert.deepEqual(sanitizeRemoteProfile({ githubToken: "secret" }), {
    remoteUrl: undefined,
    defaultProject: undefined,
    githubToken: "(set)",
  });
});

test("sanitizeRemoteProfile never previews most of a mid-length token", () => {
  // A 4+4 preview of a 9-12 character token would expose the bulk of it.
  assert.equal(sanitizeRemoteProfile({ githubToken: "123456789" }).githubToken, "(set)");
  assert.equal(sanitizeRemoteProfile({ githubToken: "123456789012" }).githubToken, "(set)");
  assert.equal(sanitizeRemoteProfile({ githubToken: "1234567890123" }).githubToken, "1234...0123");
});

test("sanitizeRemoteProfiles redacts every profile token", () => {
  const view = sanitizeRemoteProfiles({
    default: { githubToken: "ghp_defaulttoken" },
    staging: { githubToken: "ghp_stagingtoken" },
  });

  assert.equal(view.default.githubToken, "ghp_...oken");
  assert.equal(view.staging.githubToken, "ghp_...oken");
  assert.equal(JSON.stringify(view).includes("defaulttoken"), false);
  assert.equal(JSON.stringify(view).includes("stagingtoken"), false);
});

test("isValidRemoteUrl accepts only trimmed http and https URLs", () => {
  assert.equal(isValidRemoteUrl("https://api.example.com"), true);
  assert.equal(isValidRemoteUrl("http://localhost:3000"), true);
  assert.equal(isValidRemoteUrl(" https://api.example.com"), false);
  assert.equal(isValidRemoteUrl("not-a-url"), false);
  assert.equal(isValidRemoteUrl("ssh://api.example.com"), false);
});

test("profile set persists its nested project option", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-cli-profile-project-"));
  const previousHome = process.env.HOME;
  const originalLog = console.log;
  process.env.HOME = temporaryHome;
  console.log = () => {};

  try {
    const program = new Command()
      .exitOverride()
      .option("-p, --project <project>");
    configureProjectOptionInheritance(program);
    program.addCommand(createConfigCommand());

    await program.parseAsync(
      ["config", "profile", "set", "audit-project-only", "--project", " mcptestio/propr-e2e "],
      { from: "user" }
    );

    const manager = new ConfigManager(join(temporaryHome, ".propr"));
    await manager.init();
    assert.equal(
      manager.getRemoteProfiles()["audit-project-only"].defaultProject,
      "mcptestio/propr-e2e"
    );
  } finally {
    console.log = originalLog;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
