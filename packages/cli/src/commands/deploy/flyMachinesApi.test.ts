/**
 * Machines API client against a stubbed fetch. Run with:
 * `npx tsx --test src/commands/deploy/flyMachinesApi.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FlyApiError, flyAuthorizationHeader, FlyMachinesApi } from "./flyMachinesApi.js";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stubFetch(responses: Array<{ status: number; body?: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: String(init?.method),
      url,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    const text = next.body === undefined ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("authorization header keeps FlyV1 macaroons and bearer-wraps other tokens", () => {
  assert.equal(flyAuthorizationHeader("FlyV1 fm2_abc"), "FlyV1 fm2_abc");
  assert.equal(flyAuthorizationHeader(" personal-token "), "Bearer personal-token");
  assert.throws(() => flyAuthorizationHeader("  "), /empty/);
});

test("app existence, creation and shared IP allocation", async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 404, body: { error: "not found" } },
    { status: 201, body: {} },
    { status: 200, body: { ips: [{ ip: "fdaa:0:1::2" }] } },
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const api = new FlyMachinesApi({ token: "tok", fetchImpl, baseUrl: "https://fly.test/v1" });
  assert.equal(await api.appExists("my-propr"), false);
  await api.createApp("my-propr", "personal");
  assert.deepEqual(await api.ensurePublicIps("my-propr"), ["shared IPv4", "IPv6"]);

  assert.equal(calls[0].url, "https://fly.test/v1/apps/my-propr");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.deepEqual(calls[1].body, { app_name: "my-propr", name: "my-propr", org_slug: "personal" });
  assert.deepEqual(calls[3].body, { type: "shared_v4" });
  assert.deepEqual(calls[4].body, { type: "v6" });
});

test("secrets: names listed, values sent in one update", async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, body: { secrets: [{ name: "SESSION_SECRET", digest: "x" }] } },
    { status: 200, body: { version: 2 } },
  ]);
  const api = new FlyMachinesApi({ token: "tok", fetchImpl });
  assert.deepEqual(await api.listSecretNames("a1"), ["SESSION_SECRET"]);
  await api.setSecrets("a1", { A: "1", B: "2" });
  assert.equal(calls[1].url.endsWith("/apps/a1/secrets"), true);
  assert.deepEqual(calls[1].body, { values: { A: "1", B: "2" } });
  await api.setSecrets("a1", {});
  assert.equal(calls.length, 2, "empty update is skipped");
});

test("volume creation is encrypted and sized", async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 200, body: { id: "vol_1", name: "propr_data", region: "iad", size_gb: 1 } }]);
  const api = new FlyMachinesApi({ token: "tok", fetchImpl });
  const volume = await api.createVolume("a1", { name: "propr_data", region: "iad", sizeGb: 1 });
  assert.equal(volume.id, "vol_1");
  assert.deepEqual(calls[0].body, { name: "propr_data", region: "iad", size_gb: 1, encrypted: true });
});

test("wait retries Fly's 60 s 408 until the Machine is started", async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 408 }, { status: 408 }, { status: 200, body: { ok: true } }]);
  const api = new FlyMachinesApi({ token: "tok", fetchImpl });
  await api.waitForState("a1", { id: "m1", state: "created", region: "iad", instance_id: "i1" }, "started", 300);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/apps\/a1\/machines\/m1\/wait\?state=started&timeout=60&instance_id=i1$/);
});

test("errors carry status and body but never the token", async () => {
  const { fetchImpl } = stubFetch([{ status: 422, body: { error: "volume in use" } }]);
  const api = new FlyMachinesApi({ token: "super-secret-token", fetchImpl });
  await assert.rejects(api.createMachine("a1", { name: "x", region: "iad", config: {} }), (error: unknown) => {
    assert.ok(error instanceof FlyApiError);
    assert.equal(error.status, 422);
    assert.match(error.message, /volume in use/);
    assert.equal(error.message.includes("super-secret-token"), false);
    return true;
  });
});
