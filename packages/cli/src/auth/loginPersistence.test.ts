/**
 * `propr login` stores a token only after the remote has had its say, and the
 * API client treats any non-JSON error body as "not a ProPR API". Every
 * request goes to a stubbed fetch; no real instance or gh CLI is contacted.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiClient } from "../api/client.js";
import { ApiError, InvalidApiResponseError, INVALID_API_RESPONSE_MESSAGE } from "../api/errors.js";
import type { ConfigManager } from "../config/index.js";
import { loginWithGithubCli, type CapturedCommandRunner } from "./githubLogin.js";
import { completeLogin } from "./verifyToken.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A config manager that records every save on top of a previously stored token. */
function fakeConfig(remoteUrl: string | undefined) {
  const state = { token: "ghp_previous" as string | undefined, saves: [] as string[] };
  const manager = {
    getRemoteUrl: () => remoteUrl,
    getGithubToken: () => state.token,
    getConfigFilePath: () => "/home/test/.propr/config.json",
    setGithubToken: async (token: string) => { state.saves.push(token); state.token = token; },
  } as unknown as ConfigManager;
  return { manager, state };
}

/** The gh CLI seams: an existing session (or a completed login) yields `token`. */
function ghStub(token: string, existingSession: boolean) {
  let loggedIn = existingSession;
  const capturedCommand: CapturedCommandRunner = async (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "gh fixture" };
    return loggedIn ? { status: 0, stdout: token } : { status: 1, stdout: "" };
  };
  const authenticationHandoff = async () => { loggedIn = true; return { status: 0 }; };
  return { capturedCommand, authenticationHandoff };
}

for (const existingSession of [true, false]) {
  const path = existingSession ? "existing gh session" : "gh auth login";
  test(`interactive login (${path}) does not save before verification; a rejected token never replaces the stored one`, async () => {
    const { manager, state } = fakeConfig("http://propr.test");
    const result = await loginWithGithubCli(manager, { interactive: true, persist: false, ...ghStub("gho_rejected", existingSession) });
    assert.equal(result.ok, true);
    assert.equal(result.token, "gho_rejected");
    assert.deepEqual(state.saves, [], "persist: false must not store the token");

    globalThis.fetch = (async () => json({ error: "Bad credentials" }, 401)) as typeof fetch;
    const lines: string[] = [];
    const exitCode = await completeLogin(manager, result.token!, {
      successMessage: result.message, log: line => lines.push(line), error: line => lines.push(line),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(state.saves, []);
    assert.equal(state.token, "ghp_previous", "the previously stored credential survives");
    assert.deepEqual(lines, ["Error: http://propr.test rejected this token. It was not saved."]);
  });

  test(`interactive login (${path}) saves a verified token, then reports success`, async () => {
    const { manager, state } = fakeConfig("http://propr.test");
    const result = await loginWithGithubCli(manager, { interactive: true, persist: false, ...ghStub("gho_good", existingSession) });
    globalThis.fetch = (async () => json({ login: "octocat" })) as typeof fetch;
    const lines: string[] = [];
    const exitCode = await completeLogin(manager, result.token!, { successMessage: result.message, log: line => lines.push(line) });
    assert.equal(exitCode, 0);
    assert.deepEqual(state.saves, ["gho_good"]);
    assert.deepEqual(lines, [
      "Verified against http://propr.test as octocat.",
      "",
      result.message,
      "Token saved to: /home/test/.propr/config.json",
    ]);
  });
}

test("loginWithGithubCli still stores the token by default (setup callers)", async () => {
  const { manager, state } = fakeConfig(undefined);
  const result = await loginWithGithubCli(manager, { interactive: true, ...ghStub("gho_setup", true) });
  assert.equal(result.ok, true);
  assert.deepEqual(state.saves, ["gho_setup"]);
});

test("explicit-token login saves only when the remote does not reject it", async () => {
  const rejected = fakeConfig("http://propr.test");
  globalThis.fetch = (async () => json({ error: "Bad credentials" }, 401)) as typeof fetch;
  assert.equal(await completeLogin(rejected.manager, "ghp_bad", { log: () => {}, error: () => {} }), 1);
  assert.deepEqual(rejected.state.saves, []);

  const unreachable = fakeConfig("http://propr.test");
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.equal(await completeLogin(unreachable.manager, "ghp_maybe", { log: () => {}, error: () => {}, timeoutMs: 50 }), 0);
  assert.deepEqual(unreachable.state.saves, ["ghp_maybe"]);
});

test("a failed save prints no success line, whatever the remote answered", async () => {
  const remotes: Array<[string, string | undefined, () => Promise<Response>]> = [
    ["verified", "http://propr.test", async () => json({ login: "octocat" })],
    ["forbidden", "http://propr.test", async () => json({ error: "Not a member" }, 403)],
    ["unverified", "http://propr.test", async () => { throw new TypeError("fetch failed"); }],
    ["no remote", undefined, async () => { throw new Error("no request expected"); }],
  ];
  for (const [label, remoteUrl, answer] of remotes) {
    for (const successMessage of [undefined, "Authentication successful."]) {
      const { manager, state } = fakeConfig(remoteUrl);
      (manager as unknown as { setGithubToken: () => Promise<void> }).setGithubToken = async () => {
        throw new Error("EACCES: permission denied");
      };
      globalThis.fetch = answer as typeof fetch;
      const lines: string[] = [];
      await assert.rejects(
        completeLogin(manager, "ghp_new", { successMessage, log: line => lines.push(line), error: line => lines.push(line), timeoutMs: 50 }),
        /EACCES/, label);
      assert.deepEqual(lines, [], `${label}${successMessage ? " (gh flow)" : ""}: nothing printed before the save failed`);
      assert.equal(state.token, "ghp_previous", label);
    }
  }
});

function stubClient(): ApiClient {
  return new ApiClient({ getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager);
}

test("the API client rejects plain-text and malformed-JSON error bodies as a non-API remote", async () => {
  const client = stubClient();
  const cases: Array<[string, () => Response]> = [
    ["plain-text 404", () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } })],
    ["malformed JSON 401", () => new Response("{not json", { status: 401, headers: { "content-type": "application/json" } })],
    ["JSON scalar 500", () => new Response("\"oops\"", { status: 500, headers: { "content-type": "application/json" } })],
  ];
  for (const [label, response] of cases) {
    globalThis.fetch = (async () => response()) as typeof fetch;
    await assert.rejects(client.get("/api/tasks"), (error: unknown) => {
      assert.ok(error instanceof InvalidApiResponseError, label);
      assert.equal((error as Error).message, INVALID_API_RESPONSE_MESSAGE, label);
      return true;
    }, label);
  }
});

test("the API client keeps empty and JSON error bodies as ordinary API errors", async () => {
  const client = stubClient();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  await assert.rejects(client.get("/api/tasks"), (error: unknown) =>
    error instanceof ApiError && !(error instanceof InvalidApiResponseError) && error.status === 404);
  globalThis.fetch = (async () => json({ error: "Bad credentials" }, 401)) as typeof fetch;
  await assert.rejects(client.get("/api/tasks"), (error: unknown) =>
    error instanceof ApiError && !(error instanceof InvalidApiResponseError) && error.status === 401);
});
