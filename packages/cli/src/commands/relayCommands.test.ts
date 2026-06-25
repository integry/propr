/**
 * `propr relay` installation-discovery tests. Run with:
 * `npx tsx --test src/commands/relayCommands.test.ts` (from packages/cli),
 * i.e. the propr-cli package.
 *
 * These pin discoverInstallationId — the fallback that picks a GitHub App
 * installation id when none was passed via --installation / GH_INSTALLATION_ID.
 * The relay HTTP boundary (GET /auth/me) is stubbed at globalThis.fetch, the
 * same seam relayRequest() uses, so no network or worker is involved.
 */

import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { discoverInstallationId } from "./relayCommands.js";
import type { RelayClientOptions, AuthenticatedUser } from "../api/relay.js";

const CLIENT: RelayClientOptions = {
  baseUrl: "https://relay.example/v1",
  githubToken: "gho_testtoken",
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
const realError = console.error;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

// Stub globalThis.fetch with a single /auth/me JSON response and record the call.
function stubAuthMe(
  body: Partial<AuthenticatedUser>,
  status = 200
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;
  return { calls };
}

// Capture console.error lines so the auto-select notice can be asserted on.
// The notice goes to stderr (not stdout) to keep `relay list --json` clean.
function captureErr(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return lines;
}

function installation(id: number, login: string, type = "User") {
  return { installation_id: id, account_login: login, account_type: type };
}

test("auto-selects the sole installation and reports which one", async () => {
  stubAuthMe({ installations: [installation(42, "octo-org", "Organization")] });
  const notices = captureErr();

  const id = await discoverInstallationId(CLIENT);

  assert.equal(id, "42");
  assert.ok(
    notices.some((l) => l.includes("42") && l.includes("octo-org")),
    `expected an auto-select notice mentioning the installation, got: ${JSON.stringify(notices)}`
  );
});

test("queries GET /auth/me with the GitHub bearer token", async () => {
  const { calls } = stubAuthMe({ installations: [installation(7, "solo")] });
  captureErr();

  await discoverInstallationId(CLIENT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example/v1/auth/me");
  assert.equal(calls[0].init?.method, "GET");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer gho_testtoken");
});

test("rejects with install-the-app guidance when there are no installations", async () => {
  stubAuthMe({ installations: [] });

  await assert.rejects(discoverInstallationId(CLIENT), (err: Error) => {
    assert.match(err.message, /No GitHub App installation is available/);
    assert.match(err.message, /--installation/);
    return true;
  });
});

test("rejects and lists candidates when the choice is ambiguous", async () => {
  stubAuthMe({
    installations: [
      installation(100, "acme", "Organization"),
      installation(200, "widgets"),
    ],
  });

  await assert.rejects(discoverInstallationId(CLIENT), (err: Error) => {
    assert.match(err.message, /Multiple installations are available/);
    assert.match(err.message, /pass --installation/);
    // Both candidates, with login + account type, are listed for the user.
    assert.match(err.message, /100\s+acme \(Organization\)/);
    assert.match(err.message, /200\s+widgets \(User\)/);
    return true;
  });
});

test("surfaces the relay's auth failure on a 401", async () => {
  stubAuthMe({ error: { code: "unauthorized" } } as never, 401);

  await assert.rejects(discoverInstallationId(CLIENT), (err: Error) => {
    assert.match(err.message, /propr login/);
    return true;
  });
});
