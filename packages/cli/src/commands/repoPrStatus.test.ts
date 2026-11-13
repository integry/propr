import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRepoCommand, parsePrStatusFlag } from "./repoCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

test("--pr-status converts on/off and sends nothing when absent", () => {
  assert.deepEqual(parsePrStatusFlag(undefined), {});
  assert.deepEqual(parsePrStatusFlag("on"), { prStatusDisplay: true });
  assert.deepEqual(parsePrStatusFlag("OFF"), { prStatusDisplay: false });
  assert.throws(() => parsePrStatusFlag("yes"), /--pr-status must be on or off/);
});

async function postedRepos(args: string[], stored: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  let posted: Record<string, unknown>[] | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = (JSON.parse(String(init.body)) as { repos_to_monitor: Record<string, unknown>[] }).repos_to_monitor;
      return new Response(JSON.stringify({ success: true, repos_to_monitor: posted }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ repos_to_monitor: stored }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  console.log = () => undefined;
  console.error = () => undefined;
  await createRepoCommand().parseAsync(args, { from: "user" });
  assert.ok(posted, "the command posted the repository list");
  return posted;
}

test("repo add and toggle send prStatusDisplay only when --pr-status is given", async () => {
  const [added] = await postedRepos(["add", "integry/propr", "--pr-status", "on"], []);
  assert.equal(added.prStatusDisplay, true);
  const [plain] = await postedRepos(["add", "integry/propr"], []);
  assert.equal("prStatusDisplay" in plain, false);

  const stored = { id: "repo-1", name: "integry/propr", enabled: true, prStatusDisplay: true };
  const [off] = await postedRepos(["toggle", "integry/propr", "--pr-status", "off"], [stored]);
  assert.equal(off.prStatusDisplay, false);
  const [kept] = await postedRepos(["toggle", "integry/propr", "--enable"], [stored]);
  assert.equal(kept.prStatusDisplay, true);
});
