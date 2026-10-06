import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildScheduleRequest,
  createScheduleCommand,
  formatScheduleRows,
  localTimeZone,
  scheduleState,
} from "./scheduleCommands.js";

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
}

type Responder = (request: RecordedRequest) => { status?: number; body?: unknown };

function scheduleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "8f0c7c9e-1111-4c1e-9a7a-000000000001",
    name: "Nightly dependency bump",
    repository: "acme/repo",
    cron: "0 3 * * *",
    timezone: "Europe/Berlin",
    instruction: { text: "Update dependencies" },
    enabled: true,
    owner: { userId: "1", username: "alice" },
    lastRunAt: null,
    nextRunAt: "2026-10-07T01:00:00.000Z",
    consecutiveFailures: 0,
    pausedReason: null,
    createdAt: "2026-10-06T12:00:00.000Z",
    updatedAt: "2026-10-06T12:00:00.000Z",
    ...overrides,
  };
}

async function run(
  args: string[],
  responder: Responder,
): Promise<{ stdout: string; stderr: string; requests: RecordedRequest[]; exitCode?: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: RecordedRequest[] = [];
  let exitCode: number | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const result = responder(request);
    if (result.status === 204) return new Response(null, { status: 204 });
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
  try {
    await createScheduleCommand().parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), requests, exitCode };
}

test("schedule exposes add, list, remove and run-now", () => {
  const command = createScheduleCommand();
  assert.deepEqual(command.commands.map((sub) => sub.name()), ["add", "list", "remove", "run-now"]);
  const add = command.commands.find((sub) => sub.name() === "add")!;
  assert.deepEqual(add.options.map((option) => option.long), [
    "--cron", "--project", "--repo", "--timezone", "--name", "--file", "--stdin", "--agent", "--model",
    "--ultrafix", "--ultrafix-goal", "--ultrafix-max-cycles", "--auto-merge", "--max-cost-usd", "--disabled", "--json",
  ]);
});

test("add sends the instruction with the local time zone by default", async () => {
  const created = scheduleFixture({ timezone: localTimeZone() });
  const result = await run(
    ["add", "--repo", "acme/repo", "--cron", "0 3 * * *", "Update", "dependencies", "--json"],
    () => ({ status: 201, body: { schedule: created } }),
  );
  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(result.requests.length, 1);
  const [request] = result.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url.pathname, "/api/schedules");
  assert.deepEqual(request.body, {
    repository: "acme/repo",
    cron: "0 3 * * *",
    timezone: localTimeZone(),
    instruction: { text: "Update dependencies" },
  });
  assert.deepEqual(JSON.parse(result.stdout), { schedule: created });
});

test("add maps every instruction option and reads the instruction from a file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "propr-schedule-"));
  try {
    const file = path.join(directory, "instruction.md");
    await writeFile(file, "  Triage new issues.\n");
    const result = await run([
      "add", "-p", "acme/repo", "--cron", "30 8 * * 1-5", "--timezone", "America/New_York", "--name", "Triage",
      "--file", file, "-a", "codex", "-m", "gpt-5", "--ultrafix", "--ultrafix-goal", "9", "--ultrafix-max-cycles", "4",
      "--auto-merge", "--max-cost-usd", "$2.50", "--disabled",
    ], () => ({ status: 201, body: { schedule: scheduleFixture({ enabled: false }) } }));
    assert.equal(result.exitCode, undefined, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      repository: "acme/repo",
      cron: "30 8 * * 1-5",
      timezone: "America/New_York",
      name: "Triage",
      enabled: false,
      instruction: {
        text: "Triage new issues.", agentAlias: "codex", model: "gpt-5", autoMerge: true, runUltrafix: true,
        ultrafixGoal: 9, ultrafixMaxCycles: 4, maxCostUsd: 2.5,
      },
    });
    assert.match(result.stdout, /Schedule created\./);
    assert.match(result.stdout, /State:\s+enabled|State:\s+disabled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("add rejects missing or conflicting input before calling the server", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["add", "-p", "acme/repo", "--cron", "0 3 * * *"], /instruction is required/],
    [["add", "-p", "acme/repo", "--cron", "0 3 * * *", "--ultrafix-goal", "9", "Fix"], /require --ultrafix/],
    [["add", "-p", "acme/repo", "--cron", "0 3 * * *", "--max-cost-usd", "0", "Fix"], /--max-cost-usd/],
    [["add", "-p", "acme/one", "--repo", "acme/two", "--cron", "0 3 * * *", "Fix"], /different repositories/],
    [["add", "--repo", "not-a-repo", "--cron", "0 3 * * *", "Fix"], /owner\/repo/],
  ];
  for (const [args, message] of cases) {
    const result = await run(args, () => { throw new Error("no request expected"); });
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.match(result.stderr, message);
    assert.equal(result.requests.length, 0);
  }
});

test("add reports the server's validation message", async () => {
  const result = await run(
    ["add", "-p", "acme/repo", "--cron", "* * * * *", "Fix"],
    () => ({ status: 400, body: { error: "Schedules may fire at most every 5 minutes" } }),
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /at most every 5 minutes/);
});

test("list shows id, name, repository, cron with zone, state, next and last run", async () => {
  const schedules = [
    scheduleFixture(),
    scheduleFixture({ id: "paused-id", enabled: false, pausedReason: "Paused after 3 consecutive failed runs", lastRunAt: "2026-10-05T01:00:00.000Z" }),
  ];
  const result = await run(["list", "--repo", "acme/repo"], () => ({ body: { schedules } }));
  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(result.requests[0].url.searchParams.get("repository"), "acme/repo");
  const [header] = result.stdout.split("\n");
  assert.match(header, /^ID\s+Name\s+Repository\s+Schedule\s+State\s+Next run\s+Last run$/);
  assert.match(result.stdout, /0 3 \* \* \* \(Europe\/Berlin\)/);
  assert.match(result.stdout, /paused: Paused after 3 consecutive failed runs/);
  assert.match(result.stdout, /Total: 2 schedule\(s\)/);

  const all = await run(["list", "--json"], () => ({ body: { schedules, admission: { maxConcurrent: 2, window: null, windowError: null, running: 0 } } }));
  assert.equal(all.requests[0].url.searchParams.has("repository"), false);
  assert.equal(JSON.parse(all.stdout).schedules.length, 2);
});

test("schedule rows and states distinguish enabled, disabled and paused", () => {
  assert.equal(scheduleState({ enabled: true, pausedReason: null }), "enabled");
  assert.equal(scheduleState({ enabled: false, pausedReason: null }), "disabled");
  assert.equal(scheduleState({ enabled: false, pausedReason: "Paused" }), "paused: Paused");
  const [row] = formatScheduleRows([scheduleFixture({ enabled: false }) as never]);
  assert.equal(row[5], "-");
  assert.equal(row[6], "-");
});

test("remove deletes the schedule and reports a missing one", async () => {
  const removed = await run(["remove", "abc", "--force"], () => ({ status: 204 }));
  assert.equal(removed.exitCode, undefined, removed.stderr);
  assert.equal(removed.requests[0].method, "DELETE");
  assert.equal(removed.requests[0].url.pathname, "/api/schedules/abc");
  assert.match(removed.stdout, /Schedule abc deleted/);

  const missing = await run(["remove", "missing", "--force"], () => ({ status: 404, body: { error: "Schedule not found" } }));
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Schedule not found: missing/);
});

test("run-now sends an idempotency key and reports the started run", async () => {
  const response = {
    schedule: scheduleFixture(),
    run: { id: 1, scheduleId: "abc", slot: "2026-10-06T12:00:00.000Z", trigger: "manual", status: "dispatched", reason: null, submissionId: "sub-1", taskId: null, createdAt: "", finishedAt: null },
  };
  const started = await run(["run-now", "abc", "--idempotency-key", "retry-key-123"], () => ({ body: response }));
  assert.equal(started.exitCode, undefined, started.stderr);
  assert.equal(started.requests[0].method, "POST");
  assert.equal(started.requests[0].url.pathname, "/api/schedules/abc/run-now");
  assert.equal(started.requests[0].headers["Idempotency-Key"], "retry-key-123");
  assert.match(started.stdout, /Started a run of "Nightly dependency bump"/);
  assert.match(started.stdout, /Submission: sub-1/);

  const generated = await run(["run-now", "abc", "--json"], () => ({ body: response }));
  assert.match(generated.requests[0].headers["Idempotency-Key"], /^cli-/);
  assert.deepEqual(JSON.parse(generated.stdout), response);

  const failed = await run(["run-now", "abc"], () => ({ body: { ...response, run: { ...response.run, status: "failed", reason: "Repository disabled" } } }));
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /did not start: Repository disabled/);

  const forbidden = await run(["run-now", "abc"], () => ({ status: 403, body: { error: "Only the schedule owner or an instance administrator can change this schedule" } }));
  assert.equal(forbidden.exitCode, 1);
  assert.match(forbidden.stderr, /Only the schedule owner/);

  assert.throws(() => buildScheduleRequest("acme/repo", "x", { cron: "0 3 * * *", ultrafixMaxCycles: "11", ultrafix: true }), /1 to 10/);
});
