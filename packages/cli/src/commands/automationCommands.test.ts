import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AUTOMATION_RUN_EXIT_CODES, createAutomationCommand } from "./automationCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`Command exited with ${code}`);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
});

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

type ResponderResult = { status?: number; body?: unknown } | Error;
/** `advance` moves the fake clock, simulating time spent waiting for the response. */
type Responder = (
  request: RecordedRequest,
  attempt: number,
  advance: (ms: number) => void,
) => ResponderResult | Promise<ResponderResult>;

function runFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    definitionId: "agent-1",
    ownerId: "1",
    trigger: "cli",
    triggerSource: "user:1",
    idempotencyKey: "abc12345",
    state: "queued",
    autonomyMode: "dry_run",
    reportTaskId: null,
    actionTaskId: null,
    report: null,
    reportTruncated: false,
    actionSummary: null,
    skipReason: null,
    failureReason: null,
    approvedBy: null,
    operatorNote: null,
    deferredUntil: null,
    deferrals: 0,
    createdAt: 1_790_000_000_000,
    startedAt: null,
    reportedAt: null,
    finishedAt: null,
    updatedAt: 1_790_000_000_000,
    ...overrides,
  };
}

async function run(
  args: string[],
  responder: Responder,
  options: { pollIntervalMs?: number } = {},
): Promise<{ stdout: string; stderr: string; requests: RecordedRequest[]; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: RecordedRequest[] = [];
  let exitCode = 0;
  let clock = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    const result = await responder(request, requests.length, (ms) => { clock += ms; });
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.exit = ((code?: string | number | null) => {
    exitCode = Number(code ?? 0);
    throw new CommandExit(exitCode);
  }) as typeof process.exit;
  const command = createAutomationCommand({
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  try {
    await command.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), requests, exitCode };
}

/** Trigger answers with `initial`, then each poll returns the next state in `polls`. */
function triggerThenPoll(initial: Record<string, unknown>, polls: Array<Record<string, unknown>>, created = true): Responder {
  let poll = 0;
  return (request) => {
    if (request.method === "POST") return { status: created ? 202 : 200, body: { run: initial, created } };
    const next = polls[Math.min(poll, polls.length - 1)];
    poll += 1;
    return { body: { run: next } };
  };
}

test("run prints the run id, state and created flag, and a replayed key prints created: false", async () => {
  const first = await run(["run", "agent-1", "--idempotency-key", "abc12345"], triggerThenPoll(runFixture(), []));
  assert.equal(first.exitCode, AUTOMATION_RUN_EXIT_CODES.completed);
  assert.match(first.stdout, /run: run-1/);
  assert.match(first.stdout, /state: queued/);
  assert.match(first.stdout, /created: true/);
  assert.equal(first.requests[0].headers["Idempotency-Key"], "abc12345");
  assert.deepEqual(first.requests[0].body, { trigger: "cli" });

  const second = await run(["run", "agent-1", "--idempotency-key", "abc12345"], triggerThenPoll(runFixture(), [], false));
  assert.match(second.stdout, /created: false/);
  assert.match(second.stdout, /no new run was started/);
});

test("run generates and prints a cli-<uuid> key when none is given", async () => {
  const result = await run(["run", "agent-1", "--source", "nightly-cron"], triggerThenPoll(runFixture(), []));
  const key = result.requests[0].headers["Idempotency-Key"];
  assert.match(key, /^cli-[0-9a-f-]{36}$/);
  assert.match(result.stdout, new RegExp(`idempotency key: ${key}`));
  assert.deepEqual(result.requests[0].body, { trigger: "cli", source: "nightly-cron" });
});

test("run --wait polls the run and prints only the report on stdout when it completes", async () => {
  const result = await run(["run", "agent-1", "--wait"], triggerThenPoll(runFixture(), [
    runFixture({ state: "running" }),
    runFixture({ state: "completed", report: "# Weekly report\n\nAll green." }),
  ]));
  assert.equal(result.exitCode, AUTOMATION_RUN_EXIT_CODES.completed);
  assert.equal(result.stdout, "# Weekly report\n\nAll green.");
  assert.match(result.stderr, /run: run-1/);
  assert.match(result.stderr, /state: running/);
  assert.match(result.stderr, /state: completed/);
  assert.deepEqual(result.requests.slice(1).map((request) => request.url.pathname), ["/api/agent-runs/run-1", "/api/agent-runs/run-1"]);
});

test("a deferred trigger exits 3 with the usage gate's reason on stderr", async () => {
  const deferred = runFixture({ state: "deferred", skipReason: "Claude usage is above the pause threshold", deferredUntil: 1_790_000_900_000 });
  const plain = await run(["run", "agent-1"], triggerThenPoll(deferred, []));
  assert.equal(plain.exitCode, AUTOMATION_RUN_EXIT_CODES.not_run);
  assert.match(plain.stderr, /Deferred: Claude usage is above the pause threshold/);

  const waited = await run(["run", "agent-1", "--wait"], triggerThenPoll(deferred, []));
  assert.equal(waited.exitCode, AUTOMATION_RUN_EXIT_CODES.not_run);
  assert.equal(waited.requests.length, 1, "a deferred run is not polled");
  assert.equal(waited.stdout, "");
});

test("a skipped run exits 3 and a failed run exits 1", async () => {
  const skipped = await run(["run", "agent-1", "--wait"], triggerThenPoll(runFixture({ state: "skipped", skipReason: "No capacity" }), []));
  assert.equal(skipped.exitCode, AUTOMATION_RUN_EXIT_CODES.not_run);
  assert.match(skipped.stderr, /Skipped: No capacity/);

  const failed = await run(["run", "agent-1", "--wait"], triggerThenPoll(runFixture(), [runFixture({ state: "failed", failureReason: "Agent crashed" })]));
  assert.equal(failed.exitCode, AUTOMATION_RUN_EXIT_CODES.error);
  assert.match(failed.stderr, /Failed: Agent crashed/);
});

test("run --wait exits 4 with the report when a preview run awaits approval", async () => {
  const result = await run(["run", "agent-1", "--wait"], triggerThenPoll(runFixture({ autonomyMode: "preview" }), [
    runFixture({ state: "awaiting_approval", autonomyMode: "preview", report: "Proposed actions" }),
  ]));
  assert.equal(result.exitCode, AUTOMATION_RUN_EXIT_CODES.awaiting_approval);
  assert.equal(result.stdout, "Proposed actions");
  assert.match(result.stderr, /propr automation approve run-1/);
});

test("run --wait exits 2 when the run is still in progress at the timeout", async () => {
  const result = await run(["run", "agent-1", "--wait", "--timeout", "12"], triggerThenPoll(runFixture(), [runFixture({ state: "running" })]));
  assert.equal(result.exitCode, AUTOMATION_RUN_EXIT_CODES.timed_out);
  assert.match(result.stderr, /Timed out after 12s/);
  // Polls at 5 s and 10 s; at 12 s the deadline has arrived, so no further poll starts.
  assert.equal(result.requests.length, 3);
  assert.equal(result.stdout, "");
});

test("run --wait times out when a poll response arrives after the deadline", async () => {
  const result = await run(["run", "agent-1", "--wait", "--timeout", "1"], (request, _attempt, advance) => {
    if (request.method === "POST") return { status: 202, body: { run: runFixture(), created: true } };
    advance(5_000);
    return { body: { run: runFixture({ state: "completed", report: "late" }) } };
  }, { pollIntervalMs: 500 });
  assert.equal(result.exitCode, AUTOMATION_RUN_EXIT_CODES.timed_out);
  assert.match(result.stderr, /Timed out after 1s waiting for run run-1 \(state: queued\)/);
  assert.equal(result.stdout, "");
});

test("run --wait aborts an in-flight poll at the deadline and exits 2", async () => {
  const result = await run(["run", "agent-1", "--wait", "--timeout", "1", "--json"], (request) => {
    if (request.method === "POST") return { status: 202, body: { run: runFixture(), created: true } };
    // The poll never answers on its own; only the deadline abort ends it.
    return new Promise<ResponderResult>((resolve) => {
      request.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        resolve(error);
      });
    });
  }, { pollIntervalMs: 950 });
  assert.equal(result.exitCode, AUTOMATION_RUN_EXIT_CODES.timed_out);
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests[1].signal?.aborted);
  const document = JSON.parse(result.stdout);
  assert.equal(document.timedOut, true);
  assert.equal(document.exitCode, AUTOMATION_RUN_EXIT_CODES.timed_out);
  assert.equal(document.run.state, "queued");
});

test("run --json prints a version 1 automation-run document with the exit code", async () => {
  const result = await run(["run", "agent-1", "--wait", "--json", "--idempotency-key", "abc12345"], triggerThenPoll(runFixture(), [
    runFixture({ state: "completed", report: "done" }),
  ]));
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assert.equal(document.kind, "automation-run");
  assert.equal(document.created, true);
  assert.equal(document.idempotencyKey, "abc12345");
  assert.equal(document.exitCode, 0);
  assert.equal(document.run.state, "completed");
  assert.equal(document.run.terminal, true);
});

test("a missing agent prints 'Agent not found' and exits 1", async () => {
  const result = await run(["run", "missing-agent"], () => ({ status: 404, body: { error: "Agent definition not found" } }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Agent not found: missing-agent/);
  assert.match(result.stderr, /--idempotency-key cli-/);

  const shown = await run(["show", "missing-agent", "--json"], () => ({ status: 404, body: { error: "Agent definition not found" } }));
  const document = JSON.parse(shown.stdout);
  assert.equal(document.kind, "automation-error");
  assert.equal(document.error.code, "not_found");
});

test("report writes the Markdown to stdout and metadata to stderr", async () => {
  const result = await run(["report", "run-1"], () => ({ body: { run: runFixture({ state: "completed", report: "# Findings\n" }) } }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "# Findings");
  assert.match(result.stderr, /run: run-1/);
  assert.match(result.stderr, /state: completed/);
  assert.equal(result.requests[0].url.pathname, "/api/agent-runs/run-1");
});

test("report exits 1 when the run has no report yet", async () => {
  const result = await run(["report", "run-1"], () => ({ body: { run: runFixture({ state: "running" }) } }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no report yet \(state: running\)/);
});

test("report --json still exits 1 when the run has no report yet", async () => {
  const result = await run(["report", "run-1", "--json"], () => ({ body: { run: runFixture({ state: "running" }) } }));
  assert.equal(result.exitCode, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.kind, "automation-run");
  assert.equal(document.run.state, "running");
  assert.equal(document.run.report, null);

  const present = await run(["report", "run-1", "--json"], () => ({ body: { run: runFixture({ state: "completed", report: "# Findings" }) } }));
  assert.equal(present.exitCode, 0);
});

test("approve sends the note; reject and cancel post to their endpoints", async () => {
  const responder: Responder = (request) => ({ body: { run: runFixture({ state: request.url.pathname.endsWith("approve") ? "acting" : "rejected" }) } });
  const approved = await run(["approve", "run-1", "--note", "Only the first issue"], responder);
  assert.equal(approved.requests[0].url.pathname, "/api/agent-runs/run-1/approve");
  assert.deepEqual(approved.requests[0].body, { note: "Only the first issue" });
  assert.match(approved.stdout, /Approved run run-1/);

  const rejected = await run(["reject", "run-1"], responder);
  assert.equal(rejected.requests[0].url.pathname, "/api/agent-runs/run-1/reject");
  const cancelled = await run(["cancel", "run-1", "--json"], responder);
  assert.equal(cancelled.requests[0].url.pathname, "/api/agent-runs/run-1/cancel");
  assert.equal(JSON.parse(cancelled.stdout).action, "cancel");

  const conflict = await run(["approve", "run-1"], () => ({ status: 409, body: { error: "Agent run is completed and is not awaiting approval" } }));
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr, /not awaiting approval/);
});

test("list and runs print tables, and the group answers to its alias", async () => {
  const command = createAutomationCommand();
  assert.deepEqual(command.aliases(), ["automations"]);
  const listed = await run(["list"], () => ({ body: {
    definitions: [{ id: "agent-1", name: "Weekly triage", enabled: true, autonomyMode: "preview", scheduleCron: "0 9 * * 1", scheduleEnabled: true, nextRunAt: null }],
    total: 1, limit: 50, offset: 0,
  } }));
  assert.match(listed.stdout, /Weekly triage/);
  assert.match(listed.stdout, /0 9 \* \* 1/);

  const runs = await run(["runs", "agent-1", "--limit", "5"], () => ({ body: { runs: [runFixture({ state: "skipped", skipReason: "No capacity" })], total: 1, limit: 5, offset: 0 } }));
  assert.equal(runs.requests[0].url.searchParams.get("limit"), "5");
  assert.match(runs.stdout, /skipped/);
  assert.match(runs.stdout, /No capacity/);
});
