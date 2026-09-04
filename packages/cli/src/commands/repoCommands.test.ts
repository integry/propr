import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRepoCommand } from "./repoCommands.js";
import type { MonitoredRepo } from "../api/repos.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
});

async function runRepoWrite(
  args: string[],
  currentRepos: MonitoredRepo[]
): Promise<MonitoredRepo[]> {
  let postedRepos: MonitoredRepo[] | undefined;
  console.log = () => undefined;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ repos_to_monitor: currentRepos }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const body = JSON.parse(String(init?.body)) as { repos_to_monitor: MonitoredRepo[] };
    postedRepos = body.repos_to_monitor;
    return new Response(JSON.stringify({ success: true, repos_to_monitor: postedRepos }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await createRepoCommand().parseAsync(args, { from: "user" });
  assert.ok(postedRepos, "expected repository configuration to be posted");
  return postedRepos;
}

test("repo add enables automatic CI follow-up only when requested", async () => {
  const existing: MonitoredRepo = {
    id: "repo-1",
    name: "integry/propr",
    enabled: true,
    autoFollowupOnFailedCi: true,
  };

  const enabled = await runRepoWrite(
    ["add", "integry/enabled", "--auto-ci-followup"],
    [existing]
  );
  assert.equal(enabled[0]?.autoFollowupOnFailedCi, true);
  assert.equal(enabled[1]?.autoFollowupOnFailedCi, true);

  const defaulted = await runRepoWrite(["add", "integry/defaulted"], [existing]);
  assert.equal(defaulted[0]?.autoFollowupOnFailedCi, true);
  assert.equal(defaulted[1]?.autoFollowupOnFailedCi, false);
});

test("repo toggle accepts positive and negative automatic CI follow-up flags", async () => {
  const other: MonitoredRepo = {
    id: "repo-2",
    name: "integry/other",
    enabled: true,
    autoFollowupOnFailedCi: true,
  };

  const enabled = await runRepoWrite(
    ["toggle", "integry/propr", "--auto-ci-followup"],
    [
      { id: "repo-1", name: "integry/propr", enabled: false, autoFollowupOnFailedCi: false },
      other,
    ]
  );
  assert.deepEqual(enabled[0], {
    id: "repo-1",
    name: "integry/propr",
    enabled: false,
    autoFollowupOnFailedCi: true,
  });
  assert.equal(enabled[1]?.autoFollowupOnFailedCi, true);

  const disabled = await runRepoWrite(
    ["toggle", "integry/propr", "--no-auto-ci-followup"],
    enabled
  );
  assert.equal(disabled[0]?.autoFollowupOnFailedCi, false);
  assert.equal(disabled[0]?.enabled, false);
  assert.equal(disabled[1]?.autoFollowupOnFailedCi, true);
});

test("repo add and toggle configure visual preview policy", async () => {
  const added = await runRepoWrite(
    ["add", "integry/previewed", "--visual-previews", "--preview-types", "image,video", "--preview-instructions", "Show desktop and mobile."],
    []
  );
  assert.deepEqual(added[0]?.visualPreview, {
    enabled: true,
    types: ["image", "video"],
    instructions: "Show desktop and mobile."
  });

  const disabled = await runRepoWrite(
    ["toggle", "integry/previewed", "--no-visual-previews"],
    added
  );
  assert.deepEqual(disabled[0]?.visualPreview, {
    enabled: false,
    types: ["image", "video"],
    instructions: "Show desktop and mobile."
  });
});
