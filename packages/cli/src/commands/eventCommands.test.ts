import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createEventsCommand, formatEvent, parseEventQuery, parseWaitTimeout, runEventsCommand } from "./eventCommands.js";
import { listRepositoryEvents, waitRepositoryEvents } from "../api/repositoryEvents.js";
import { ApiClient } from "../api/client.js";
import type { ConfigManager } from "../config/index.js";

test("events list and wait take the shared filters, --follow and --json; wait adds --timeout", () => {
  const command = createEventsCommand();
  const options = (name: string) => command.commands.find(sub => sub.name() === name)!.options.map(option => option.long);
  const shared = ["--project", "--after-cursor", "--from-start", "--domain", "--type", "--pr", "--plan", "--limit", "--follow", "--json"];
  assert.deepEqual(options("list"), shared);
  assert.deepEqual(options("wait"), [...shared, "--timeout"]);
});

test("filter options are validated into a query", () => {
  assert.deepEqual(parseEventQuery({ domain: "pull_request,epic_queue,pull_request", type: "merged", pr: "42", plan: "p-1", limit: "10", fromStart: true }, "acme/app"), {
    repository: "acme/app", afterCursor: undefined, fromStart: true, domains: ["pull_request", "epic_queue"], types: ["merged"],
    pullRequest: 42, planId: "p-1", limit: 10,
  });
  assert.throws(() => parseEventQuery({ domain: "nope" }, "acme/app"), /--domain must be among/);
  assert.throws(() => parseEventQuery({ type: "nope" }, "acme/app"), /--type must be among/);
  assert.throws(() => parseEventQuery({ limit: "101" }, "acme/app"), /at most 100/);
  assert.equal(parseWaitTimeout(undefined), 15);
  assert.equal(parseWaitTimeout("0"), 0);
  assert.throws(() => parseWaitTimeout("31"), /--timeout/);
  assert.throws(() => parseWaitTimeout("-1"), /--timeout/);
});

test("an event prints as one line with its subject, head and scalar payload", () => {
  assert.equal(formatEvent({
    cursor: "rec1.x", domain: "pull_request", type: "review_scored", repository: "acme/app", pullRequest: 42, entityId: "42",
    head: "b".repeat(40), payload: { score: 8, goal: 9, nested: { skip: true } }, occurredAt: "2026-11-12T12:00:00.000Z",
  }), "2026-11-12T12:00:00.000Z  pull_request/review_scored  #42 @bbbbbbbbbbbb  score=8 goal=9");
  assert.equal(formatEvent({
    cursor: "rec1.y", domain: "epic_queue", type: "advanced", repository: "acme/app", entityId: "exec-1", planId: "p-1",
    payload: {}, occurredAt: "2026-11-12T12:00:00.000Z",
  }), "2026-11-12T12:00:00.000Z  epic_queue/advanced  exec-1 plan p-1");
});

test("the API helpers send the documented query parameters", async () => {
  const urls: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify({ events: [], cursor: "rec1.c", truncated: false, outcome: "timeout", waitedMs: 1, timeoutSeconds: 30 }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new ApiClient({ getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager);
    await listRepositoryEvents({ repository: "acme/app", domains: ["pull_request"], types: ["merged", "closed"], pullRequest: 7, fromStart: true }, { client });
    await waitRepositoryEvents({ repository: "acme/app", afterCursor: "rec1.c", planId: "p", timeoutSeconds: 99 }, { client });
    assert.equal(urls[0].pathname, "/api/repository-events");
    assert.deepEqual(Object.fromEntries(urls[0].searchParams), { repository: "acme/app", fromStart: "true", domains: "pull_request", types: "merged,closed", pullRequest: "7" });
    assert.equal(urls[1].pathname, "/api/repository-events/wait");
    assert.deepEqual(Object.fromEntries(urls[1].searchParams), { repository: "acme/app", afterCursor: "rec1.c", planId: "p", timeoutSeconds: "30" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cursorless list establishing the current end is sent once; replayable lists keep retries", async () => {
  const urls: URL[] = [];
  const originalFetch = globalThis.fetch;
  // Every attempt fails in transport, as when the response establishing the boundary is lost.
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const client = new ApiClient({ getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager);
    await assert.rejects(listRepositoryEvents({ repository: "acme/app" }, { client }), /Network error/);
    assert.equal(urls.length, 1, "a retry would establish a later boundary and skip events appended in between");

    urls.length = 0;
    await assert.rejects(listRepositoryEvents({ repository: "acme/app", afterCursor: "rec1.c" }, { client }), /Network error/);
    assert.equal(urls.length, 3, "a read after a cursor is replayable");

    urls.length = 0;
    await assert.rejects(listRepositoryEvents({ repository: "acme/app", fromStart: true }, { client }), /Network error/);
    assert.equal(urls.length, 3, "a read from the start is replayable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Serve `pages` in order, one per request; the request after the last page
 * stays pending until its signal aborts, as a real fetch does. `onPending`
 * runs once that request is in flight.
 */
async function interruptedRun(pages: object[], args: Parameters<typeof runEventsCommand>[0], wait: boolean, onPending: () => void) {
  const urls: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    const page = pages[urls.length - 1];
    if (page) return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      setImmediate(onPending);
    });
  }) as typeof fetch;
  const log = mock.method(console, "log", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    const client = new ApiClient({ getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager);
    const code = await runEventsCommand({ project: "acme/app", ...args }, wait, { client, configManager: {} as ConfigManager });
    return {
      code, urls,
      out: log.mock.calls.map(call => String(call.arguments[0])),
      err: error.mock.calls.map(call => String(call.arguments[0])),
    };
  } finally {
    globalThis.fetch = originalFetch;
    log.mock.restore();
    error.mock.restore();
  }
}

const event = (n: number) => ({
  cursor: `rec1.e${n}`, domain: "pull_request", type: "opened", repository: "acme/app", pullRequest: n, entityId: String(n),
  payload: {}, occurredAt: "2026-11-12T12:00:00.000Z",
});

test("Ctrl-C while --follow drains history stops paging at once and prints the resume cursor", async () => {
  const run = await interruptedRun(
    [{ events: [event(1)], cursor: "rec1.p1", truncated: true }],
    { fromStart: true, follow: true, limit: "1" }, false, () => process.emit("SIGINT"),
  );
  assert.equal(run.code, 130);
  assert.equal(run.urls.length, 2, "no further page and no wait is requested after the interrupt");
  assert.ok(run.urls.every(url => url.pathname === "/api/repository-events"));
  assert.equal(run.out.length, 1, "only the page received before the interrupt is printed");
  assert.deepEqual(run.err, ["Stopped reading events. Resume with --after-cursor rec1.p1"]);
});

test("Ctrl-C during a single list cancels it and prints the cursor it started from", async () => {
  const run = await interruptedRun([], { afterCursor: "rec1.start" }, false, () => process.emit("SIGINT"));
  assert.equal(run.code, 130);
  assert.deepEqual(run.out, []);
  assert.deepEqual(run.err, ["Stopped reading events. Resume with --after-cursor rec1.start"]);
});

test("Ctrl-C during a followed wait prints the last cursor received", async () => {
  const run = await interruptedRun(
    [{ events: [event(2)], cursor: "rec1.w1", truncated: false, outcome: "events", waitedMs: 1, timeoutSeconds: 15 }],
    { afterCursor: "rec1.start", follow: true }, true, () => process.emit("SIGINT"),
  );
  assert.equal(run.code, 130);
  assert.deepEqual(run.urls.map(url => url.pathname), ["/api/repository-events/wait", "/api/repository-events/wait"]);
  assert.deepEqual(run.err, ["Stopped reading events. Resume with --after-cursor rec1.w1"]);
});
