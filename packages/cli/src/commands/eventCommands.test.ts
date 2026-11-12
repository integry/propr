import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventsCommand, formatEvent, parseEventQuery, parseWaitTimeout } from "./eventCommands.js";
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
    await listRepositoryEvents({ repository: "acme/app", domains: ["pull_request"], types: ["merged", "closed"], pullRequest: 7, fromStart: true }, client);
    await waitRepositoryEvents({ repository: "acme/app", afterCursor: "rec1.c", planId: "p", timeoutSeconds: 99 }, { client });
    assert.equal(urls[0].pathname, "/api/repository-events");
    assert.deepEqual(Object.fromEntries(urls[0].searchParams), { repository: "acme/app", fromStart: "true", domains: "pull_request", types: "merged,closed", pullRequest: "7" });
    assert.equal(urls[1].pathname, "/api/repository-events/wait");
    assert.deepEqual(Object.fromEntries(urls[1].searchParams), { repository: "acme/app", afterCursor: "rec1.c", planId: "p", timeoutSeconds: "30" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
