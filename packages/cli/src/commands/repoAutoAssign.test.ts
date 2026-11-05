import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRepoCommand, formatAutoAssign, parseAutoAssignFlags, parseAutoAssignTo, parseOnOff } from "./repoCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

test("on/off flags convert explicitly and reject anything else", () => {
  assert.equal(parseOnOff("on", "--auto-assign"), true);
  assert.equal(parseOnOff(" OFF ", "--auto-assign"), false);
  for (const value of ["yes", "true", "1", "", "disabled"]) {
    assert.throws(() => parseOnOff(value, "--auto-assign"), /--auto-assign must be on or off/);
  }
});

test("--auto-assign-to accepts a login or none", () => {
  assert.equal(parseAutoAssignTo("octocat"), "octocat");
  assert.equal(parseAutoAssignTo("@octo-cat"), "octo-cat");
  assert.equal(parseAutoAssignTo("none"), null);
  assert.equal(parseAutoAssignTo("NONE"), null);
  for (const value of ["", "octo cat", "-octocat", "owner/repo"]) {
    assert.throws(() => parseAutoAssignTo(value), /GitHub login or none/);
  }
});

test("only supplied flags are converted into options", () => {
  assert.deepEqual(parseAutoAssignFlags({}), {});
  assert.deepEqual(parseAutoAssignFlags({ autoAssignReview: "off" }), { autoAssignRequestReview: false });
  assert.deepEqual(parseAutoAssignFlags({ autoAssign: "on", autoAssignTo: "none" }), { autoAssignPullRequests: true, autoAssignDefaultAssignee: null });
  assert.deepEqual(
    parseAutoAssignFlags({ autoAssign: "on", autoAssignTo: "octocat", autoAssignReview: "on" }),
    { autoAssignPullRequests: true, autoAssignDefaultAssignee: "octocat", autoAssignRequestReview: true }
  );
});

test("the list column shows the automatic assignment state", () => {
  assert.equal(formatAutoAssign({}), "Off");
  assert.equal(formatAutoAssign({ autoAssignPullRequests: false, autoAssignDefaultAssignee: "octocat" }), "Off");
  assert.equal(formatAutoAssign({ autoAssignPullRequests: true }), "On (issue author)");
  assert.equal(formatAutoAssign({ autoAssignPullRequests: true, autoAssignDefaultAssignee: "octocat", autoAssignRequestReview: true }), "On (@octocat, review)");
});

/** Runs a repo command against a fake API and returns the repository list it posted. */
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

test("repo add sends the three options only when given", async () => {
  const [withFlags] = await postedRepos(
    ["add", "integry/propr", "--auto-assign", "on", "--auto-assign-to", "octocat", "--auto-assign-review", "on"],
    []
  );
  assert.equal(withFlags.autoAssignPullRequests, true);
  assert.equal(withFlags.autoAssignDefaultAssignee, "octocat");
  assert.equal(withFlags.autoAssignRequestReview, true);

  const [withoutFlags] = await postedRepos(["add", "integry/propr"], []);
  for (const field of ["autoAssignPullRequests", "autoAssignDefaultAssignee", "autoAssignRequestReview"]) {
    assert.equal(field in withoutFlags, false, `${field} is omitted`);
  }
});

test("repo toggle changes only the flags given, and none clears the assignee", async () => {
  const stored = { id: "repo-1", name: "integry/propr", enabled: true, autoFollowupOnFailedCi: false, autoAssignPullRequests: true, autoAssignDefaultAssignee: "octocat", autoAssignRequestReview: true };
  const [reviewOff] = await postedRepos(["toggle", "integry/propr", "--auto-assign-review", "off"], [stored]);
  assert.deepEqual(
    [reviewOff.autoAssignPullRequests, reviewOff.autoAssignDefaultAssignee, reviewOff.autoAssignRequestReview],
    [true, "octocat", false]
  );

  const [cleared] = await postedRepos(["toggle", "integry/propr", "--auto-assign-to", "none"], [stored]);
  assert.deepEqual([cleared.autoAssignPullRequests, cleared.autoAssignDefaultAssignee, cleared.autoAssignRequestReview], [true, null, true]);
});
