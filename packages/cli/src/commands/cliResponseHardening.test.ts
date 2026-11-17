/**
 * CLI hardening: throttled event follow, unknown tasks, non-API remotes,
 * plan paging and labels, compact repo table, readable handoffs, degraded
 * remote status, readable durations and verified login. Every request goes to
 * a stubbed fetch; no real instance is contacted.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Command } from "commander";
import { ApiClient } from "../api/client.js";
import { InvalidApiResponseError, INVALID_API_RESPONSE_MESSAGE } from "../api/errors.js";
import type { ConfigManager } from "../config/index.js";
import { runEventsCommand } from "./eventCommands.js";
import { createTaskCommand } from "./taskCommands.js";
import { createPlanCommand, parsePlanListWindow } from "./planCommands.js";
import { createRepoCommand } from "./repoCommands.js";
import { createHandoffsCommand, describeHandoffState, formatHandoffList } from "./handoffCommands.js";
import { createRemoteStatusCommand } from "./systemCommands.js";
import { createGoalCommand } from "./goalCommands.js";
import { createStatsCommand } from "./statsCommands.js";
import { reportLoginVerification, verifyTokenWithRemote } from "../auth/verifyToken.js";
import type { FollowupHandoffStatus } from "../api/followupHandoffs.js";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});

class CommandExit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

type Responder = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HTML_PAGE = "<!doctype html><html><head><title>ProPR</title></head><body><div id=\"root\"></div></body></html>";
const html = (status = 200) => new Response(HTML_PAGE, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** Run one command with fetch, console and process.exit captured. */
async function run(command: Command, args: string[], responder: Responder) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: URL[] = [];
  let exitCode: number | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return responder(url, init);
  }) as typeof fetch;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    exitCode = Number(code ?? 0);
    throw new CommandExit(exitCode);
  }) as typeof process.exit;
  try {
    await command.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout, stderr, requests, exitCode };
}

function stubClient(): ApiClient {
  return new ApiClient({ getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager);
}

// 1. events wait --follow --timeout 0

test("events wait --follow --timeout 0 against an immediate stub starts waits at least one second apart", async () => {
  const starts: number[] = [];
  globalThis.fetch = (async () => {
    starts.push(Date.now());
    return json({ events: [], cursor: "rec1.c", truncated: false, outcome: "timeout", waitedMs: 0, timeoutSeconds: 0 });
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
  const stop = setTimeout(() => process.emit("SIGINT"), 2_500);
  try {
    const code = await runEventsCommand(
      { project: "a/b", follow: true, timeout: "0", afterCursor: "rec1.start" },
      true,
      { client: stubClient(), configManager: {} as ConfigManager },
    );
    assert.equal(code, 130);
  } finally {
    clearTimeout(stop);
  }
  // Without the pause this loop sent >1000 requests in this window.
  assert.ok(starts.length >= 2 && starts.length <= 3, `expected 2-3 waits in 2.5 s, got ${starts.length}`);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 990, `waits ${i - 1} and ${i} were ${starts[i] - starts[i - 1]} ms apart`);
  }
});

// 2. task get <unknown>

const unknownTaskStatus = {
  taskId: "nope", currentState: "pending", isInProgress: true, isCompleted: false, isFailed: false,
  history: [], taskInfo: null,
};

test("task get with an unknown id prints Task not found and exits 1, in text and --json mode", async () => {
  for (const args of [["get", "nope"], ["get", "nope", "--json"]]) {
    const result = await run(createTaskCommand(), args, () => json(unknownTaskStatus));
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.deepEqual(result.stdout, [], args.join(" "));
    assert.deepEqual(result.stderr, ["Error: Task not found: nope"], args.join(" "));
  }
});

test("task get shows history step durations in words, not milliseconds", async () => {
  const result = await run(createTaskCommand(), ["get", "task-1"], () => json({
    taskId: "task-1", currentState: "completed", isInProgress: false, isCompleted: true, isFailed: false,
    taskInfo: null,
    history: [
      { state: "claude_execution", timestamp: "2026-11-17T01:00:00.000Z", metadata: { duration: 339975 } },
      { state: "completed", timestamp: "2026-11-17T01:06:00.000Z", metadata: { duration: 250 } },
    ],
  }));
  assert.equal(result.exitCode, undefined);
  const text = result.stdout.join("\n");
  assert.match(text, /Duration: 5m 40s/);
  assert.match(text, /Duration: 250ms/);
  assert.doesNotMatch(text, /339975ms/);
});

// 3. a remote that answers with HTML

test("the API client rejects HTML, non-JSON and malformed JSON responses with one message", async () => {
  const client = stubClient();
  const cases: Array<[string, Response]> = [
    ["HTML 200", html()],
    ["HTML 404", html(404)],
    ["HTML 502", html(502)],
    ["plain text", new Response("hello", { headers: { "content-type": "text/plain" } })],
    ["malformed JSON", new Response("{not json", { headers: { "content-type": "application/json" } })],
    ["HTML without a content type", new Response(HTML_PAGE, { headers: { "content-type": "" } })],
  ];
  for (const [label, response] of cases) {
    globalThis.fetch = (async () => response) as typeof fetch;
    await assert.rejects(client.get("/api/tasks"), (error: unknown) => {
      assert.ok(error instanceof InvalidApiResponseError, label);
      assert.equal((error as Error).message, INVALID_API_RESPONSE_MESSAGE);
      return true;
    }, label);
  }
});

test("the API client keeps JSON, empty and error-JSON responses unchanged", async () => {
  const client = stubClient();
  globalThis.fetch = (async () => json({ ok: true })) as typeof fetch;
  assert.deepEqual((await client.get("/api/x")).data, { ok: true });
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  assert.equal((await client.delete("/api/x")).data, "");
  globalThis.fetch = (async () => json({ error: "Task not found" }, 404)) as typeof fetch;
  await assert.rejects(client.get("/api/x"), { name: "NotFoundError", message: "Task not found" });
});

test("a CSV request accepts text/csv and rejects an HTML page", async () => {
  const client = stubClient();
  globalThis.fetch = (async () => new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv; charset=utf-8" } })) as typeof fetch;
  assert.equal((await client.get<string>("/api/stats/cost.csv", { responseType: "csv" })).data, "a,b\n1,2\n");
  globalThis.fetch = (async () => html()) as typeof fetch;
  await assert.rejects(client.get("/api/stats/cost.csv", { responseType: "csv" }), InvalidApiResponseError);
});

test("backend commands pointed at an HTML host print one line and exit non-zero", async () => {
  const commands: Array<[string, () => Command, string[]]> = [
    ["remote-status", () => createRemoteStatusCommand(), []],
    ["task list --json", () => createTaskCommand(), ["list", "--json"]],
    ["task get", () => createTaskCommand(), ["get", "task-1"]],
    ["goal list", () => createGoalCommand(), ["list", "-p", "a/b"]],
    ["stats cost --csv", () => createStatsCommand(), ["cost", "--csv"]],
    ["plan list", () => createPlanCommand(), ["list", "-p", "a/b"]],
    ["repo list", () => createRepoCommand(), ["list"]],
    ["handoffs list", () => createHandoffsCommand(), ["list"]],
  ];
  for (const [label, create, args] of commands) {
    const result = await run(create(), args, () => html());
    assert.ok(result.exitCode !== undefined && result.exitCode !== 0, `${label} exits non-zero`);
    assert.deepEqual(result.stdout, [], `${label} prints nothing on stdout`);
    assert.equal(result.stderr.length, 1, `${label} prints one line: ${result.stderr.join(" | ")}`);
    assert.match(result.stderr[0], /did not return a ProPR API response\. Check the URL with `propr remote`\./, label);
    assert.doesNotMatch(result.stderr[0], /TypeError|Cannot read properties|<html/i, label);
  }
});

// 4. plan list paging and labels

const planSummary = (n: number, status = "pr_created") => ({
  draft_id: `plan-${n}`, name: `Plan ${n}`, repository: "a/b", status,
  created_at: "2026-11-17T00:00:00.000Z", updated_at: "2026-11-17T00:00:00.000Z",
});

/** A stub planner list over `total` plans, paged like the server. */
function planPages(total: number): Responder {
  return (url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const all = Array.from({ length: total }, (_, i) => planSummary(i + 1));
    const offset = (page - 1) * limit;
    return json({ drafts: all.slice(offset, offset + limit), total, page, limit, hasMore: offset + limit < total });
  };
}

test("plan list accepts --limit and --offset and pages through the server", async () => {
  const limited = await run(createPlanCommand(), ["list", "-p", "a/b", "-l", "3"], planPages(197));
  assert.equal(limited.requests[0].searchParams.get("limit"), "3");
  assert.equal(limited.requests[0].searchParams.get("page"), null);
  assert.match(limited.stdout.join("\n"), /Showing 1-3 of 197 plan\(s\)/);
  assert.match(limited.stdout.join("\n"), /Use --offset 3 --limit 3/);

  const offset = await run(createPlanCommand(), ["list", "-p", "a/b", "--limit", "4", "--offset", "6", "--json"], planPages(197));
  const body = JSON.parse(offset.stdout.join("\n"));
  assert.deepEqual(body.drafts.map((plan: { draft_id: string }) => plan.draft_id), ["plan-7", "plan-8", "plan-9", "plan-10"]);
  assert.equal(body.total, 197);
  assert.equal(body.offset, 6);
  assert.equal(body.hasMore, true);
  assert.deepEqual(offset.requests.map(url => url.searchParams.get("page")), ["2", "3"]);

  const last = await run(createPlanCommand(), ["list", "-p", "a/b", "--limit", "10", "--offset", "190"], planPages(197));
  assert.match(last.stdout.join("\n"), /Showing 191-197 of 197 plan\(s\)/);
  assert.doesNotMatch(last.stdout.join("\n"), /More plans available/);

  assert.throws(() => parsePlanListWindow({ limit: "0" }), /--limit/);
  assert.throws(() => parsePlanListWindow({ limit: "101" }), /at most 100/);
  assert.throws(() => parsePlanListWindow({ offset: "-1" }), /--offset/);
  const invalid = await run(createPlanCommand(), ["list", "-p", "a/b", "--offset", "x"], planPages(1));
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.requests.length, 0);
});

test("plan list shows the same status labels as plan get", async () => {
  const result = await run(createPlanCommand(), ["list", "-p", "a/b"], () => json({
    drafts: [planSummary(1, "pr_created"), planSummary(2, "merged"), planSummary(3, "draft")],
    total: 3, page: 1, limit: 10, hasMore: false,
  }));
  const text = result.stdout.join("\n");
  assert.match(text, /plan-1\s+Plan 1\s+PR Created/);
  assert.match(text, /plan-2\s+Plan 2\s+Merged/);
  assert.match(text, /plan-3\s+Plan 3\s+Draft/);
  assert.doesNotMatch(text, /pr_created/);
});

// 5. repo list columns

test("repo list shows PR title status and a short visual-preview value", async () => {
  const result = await run(createRepoCommand(), ["list"], () => json({ repos_to_monitor: [
    { id: "1", name: "a/on", enabled: true, autoFollowupOnFailedCi: false, visualPreview: { enabled: true, types: ["image"], githubAttachmentPlan: "auto" } },
    { id: "2", name: "a/off", enabled: true, autoFollowupOnFailedCi: false, prTitleStatus: false, visualPreview: { enabled: false, types: ["image"] } },
  ] }));
  const start = result.stdout.findIndex(line => line.startsWith("Repository"));
  assert.ok(start >= 0, result.stdout.join("\n"));
  const [header, , onRow, offRow] = result.stdout.slice(start);
  assert.match(header, /PR title status\s+Visual previews/);
  assert.match(onRow, /a\/on .*\bon\s+image\s*$/);
  assert.match(offRow, /a\/off .*\boff\s+off\s*$/);
  assert.ok(header.length < 200, `table is ${header.length} columns wide`);
  for (const row of [onRow, offRow]) assert.doesNotMatch(row, /conservative|MiB/);
});

// 6. handoffs list

function handoff(overrides: Partial<FollowupHandoffStatus> = {}): FollowupHandoffStatus {
  return {
    repository: "a/b", pullRequest: 1, taskId: "task-1", predecessorTaskIds: [], successorTaskId: null,
    phase: "agent_exited", status: "released_by_operator_force", statusReason: null, settlement: null,
    operatorAuthorized: false, liveness: "not_checked", branchName: "propr/1", commitHash: null,
    completionCommentUrl: null, nextAction: "none", retainedWorktreePath: "/tmp/w", updatedAt: Date.UTC(2026, 10, 17, 1, 2, 3),
    ...overrides,
  };
}

test("handoffs list prints a count, separates entries, labels states in words and shows the local updated time", async () => {
  const records = [handoff(), handoff({ pullRequest: 2 })];
  const result = await run(createHandoffsCommand(), ["list"], () => json({ handoffs: records }));
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.stdout, formatHandoffList(records));
  assert.equal(result.stdout[0], "2 follow-up handoffs tracked.");
  const text = result.stdout.join("\n");
  assert.match(text, /\n\na\/b#1\n/);
  assert.match(text, /\n\na\/b#2\n/);
  assert.match(text, /Phase:\s+Agent exited/);
  assert.match(text, /Status:\s+Released by operator force/);
  assert.doesNotMatch(text, /agent_exited|released_by_operator_force/);
  assert.ok(text.includes(`Updated:          ${new Date(Date.UTC(2026, 10, 17, 1, 2, 3)).toLocaleString()}`));
  assert.equal(describeHandoffState(null), "(none)");
  assert.deepEqual(formatHandoffList([]), ["No follow-up handoffs are tracked."]);
});

// 7. remote-status, login

const healthyStatus = {
  api: "healthy", redis: "connected", daemon: "running", worker: "running", githubAuth: "connected",
  claudeAuth: "connected", indexing: "idle", warnings: [], timestamp: "2026-11-17T00:00:00.000Z",
};

test("remote-status reports a failed indexing component instead of All systems operational", async () => {
  const healthy = await run(createRemoteStatusCommand(), [], () => json(healthyStatus));
  assert.match(healthy.stdout.join("\n"), /All systems operational\./);

  const degraded = await run(createRemoteStatusCommand(), [], () => json({ ...healthyStatus, indexing: "failed" }));
  const text = degraded.stdout.join("\n");
  assert.doesNotMatch(text, /All systems operational/);
  assert.match(text, /Indexing\s+\[!!\] failed/);
  assert.match(text, /Repository indexing is failed/);

  const warned = await run(createRemoteStatusCommand(), [], () => json({ ...healthyStatus, warnings: [{ type: "x", message: "Unified agent image is unavailable" }] }));
  assert.doesNotMatch(warned.stdout.join("\n"), /All systems operational/);
  assert.match(warned.stdout.join("\n"), /- Unified agent image is unavailable/);

  const partial = await run(createRemoteStatusCommand(), [], () => json({ api: "healthy", timestamp: "2026-11-17T00:00:00.000Z" }));
  assert.equal(partial.exitCode, undefined);
  assert.doesNotMatch(partial.stderr.join("\n") + partial.stdout.join("\n"), /TypeError|Cannot read properties/);
});

function loginConfig(remoteUrl: string | undefined): ConfigManager {
  return { getRemoteUrl: () => remoteUrl, getGithubToken: () => undefined } as unknown as ConfigManager;
}

test("login verifies the token against the configured remote and says when it could not", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const respond = (response: () => Response) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return response();
    }) as typeof fetch;
  };
  const report = async (remote: string | undefined, alreadySaved = false) => {
    const lines: string[] = [];
    const outcome = await reportLoginVerification(loginConfig(remote), "ghp_new", { log: line => lines.push(line), error: line => lines.push(line), alreadySaved });
    return { ...outcome, lines };
  };

  respond(() => json({ login: "octocat" }));
  const verified = await report("http://propr.test");
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.save, true);
  assert.deepEqual(verified.lines, ["Authentication successful! Verified against http://propr.test as octocat."]);
  assert.equal(seen.at(-1)?.url, "http://propr.test/api/auth/user");
  assert.equal(seen.at(-1)?.authorization, "Bearer ghp_new", "the new token is the one verified");

  respond(() => json({ error: "Bad credentials" }, 401));
  const rejected = await report("http://propr.test");
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.save, false);
  assert.match(rejected.lines[0], /rejected this token\. It was not saved\./);

  respond(() => html());
  const unverified = await report("http://propr.test");
  assert.equal(unverified.exitCode, 0);
  assert.match(unverified.lines[0], /Token saved, but it could not be verified against http:\/\/propr\.test: The remote did not return a ProPR API response/);
  assert.doesNotMatch(unverified.lines[0], /Authentication successful/);

  respond(() => { throw new TypeError("fetch failed"); });
  const unreachable = await report("http://propr.test");
  assert.match(unreachable.lines[0], /could not be verified/);

  const requestsBefore = seen.length;
  const noRemote = await report(undefined);
  assert.equal(seen.length, requestsBefore, "no request without a remote");
  assert.match(noRemote.lines[0], /not verified because no remote is configured/);
  assert.equal((await verifyTokenWithRemote(loginConfig(undefined), "t")).status, "no_remote");
});
