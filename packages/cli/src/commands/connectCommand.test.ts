import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProprDesktopDiscovery } from "@propr/shared";
import {
  CONNECT_STATUS_EXIT,
  probeConnectDiscovery,
  readBoundedBody,
  resolveConnectStatus,
  unavailableRootAuthorityStatus,
} from "./connectCommand.js";
import type { OrchestratorConfig } from "../orchestrator/types.js";

const IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENDPOINT = "https://t-abc123.propr.dev";

function cfg(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    uiPublicApiUrl: ENDPOINT,
    proprInstanceId: "abc123",
    uiTunnelEnabled: true,
    ...overrides,
  } as OrchestratorConfig;
}

function discovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "ProPR",
    canonicalEndpoint: ENDPOINT,
    publicInstanceIdentity: IDENTITY,
    version: "0.8.15",
    apiCompatibility: "2026-06-27",
    uiCompatibility: "2026-06-27",
    desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: true,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
    },
    ...overrides,
  };
}

function jsonFetch(body = discovery()): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Connect status exposes stable exit semantics", () => {
  assert.deepEqual(CONNECT_STATUS_EXIT, {
    ready: 0,
    internalFailure: 1,
    notReady: 0,
    incompatible: 2,
    invalidConfig: 1,
    timeout: 0,
  });
});

test("unavailable root authority fails closed before API readiness", () => {
  const status = unavailableRootAuthorityStatus();
  assert.equal(status.status, "invalidConfig");
  assert.equal(status.apiReady, false);
  assert.equal(status.configured, false);
  assert.equal(status.publicInstanceIdentity, null);
  assert.deepEqual(status.reasonCodes, ["ACL_DIAGNOSTIC_UNAVAILABLE"]);
});

test("missing, disabled, and stopped tunnel states do not probe", async () => {
  let probes = 0;
  const fetchImpl = (async () => {
    probes += 1;
    throw new Error("must not probe");
  }) as typeof fetch;

  const missing = await resolveConnectStatus({
    cfg: cfg({ uiPublicApiUrl: undefined, proprInstanceId: undefined, uiTunnelEnabled: false }),
    sidecarRunning: false,
    publicInstanceIdentity: IDENTITY,
    fetchImpl,
  });
  assert.equal(missing.status, "notReady");
  assert.deepEqual(missing.reasonCodes, ["NOT_CONFIGURED", "TUNNEL_DISABLED"]);

  const disabled = await resolveConnectStatus({
    cfg: cfg({ uiTunnelEnabled: false }), sidecarRunning: false, publicInstanceIdentity: IDENTITY, fetchImpl,
  });
  assert.deepEqual(disabled.reasonCodes, ["TUNNEL_DISABLED"]);

  const stopped = await resolveConnectStatus({
    cfg: cfg(), sidecarRunning: false, publicInstanceIdentity: IDENTITY, fetchImpl,
  });
  assert.deepEqual(stopped.reasonCodes, ["SIDECAR_NOT_RUNNING"]);
  assert.equal(probes, 0);
});

test("ready requires matching canonical origin, identity, and compatibility", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(), sidecarRunning: true, publicInstanceIdentity: IDENTITY, fetchImpl: jsonFetch(),
  });
  assert.equal(status.status, "ready");
  assert.equal(status.apiReady, true);
  assert.equal(status.restartRequired, false);
  assert.equal(status.compatibility, "2026-06-27");
  assert.equal(status.version, "0.8.15");
  assert.deepEqual(status.reasonCodes, []);
});

test("same API identity with stale runtime origin requires restart", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(),
    sidecarRunning: true,
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(discovery({ canonicalEndpoint: null })),
  });
  assert.equal(status.status, "notReady");
  assert.equal(status.apiReady, false);
  assert.equal(status.restartRequired, true);
  assert.deepEqual(status.reasonCodes, ["ENDPOINT_MISMATCH", "RESTART_REQUIRED"]);
});

test("a reassigned or stale endpoint cannot pass an identity mismatch", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(),
    sidecarRunning: true,
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(discovery({ publicInstanceIdentity: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })),
  });
  assert.equal(status.status, "notReady");
  assert.deepEqual(status.reasonCodes, ["IDENTITY_MISMATCH"]);
});

test("old discovery compatibility has an incompatible result", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(),
    sidecarRunning: true,
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(discovery({ apiCompatibility: "2025-01-01" })),
  });
  assert.equal(status.status, "incompatible");
  assert.deepEqual(status.reasonCodes, ["API_INCOMPATIBLE"]);
});

test("ready requires every desktop authentication capability", async () => {
  for (const capability of [
    "browserPairing",
    "instanceBearerTokens",
    "socketIoBearerAuthentication",
  ] as const) {
    const status = await resolveConnectStatus({
      cfg: cfg(),
      sidecarRunning: true,
      publicInstanceIdentity: IDENTITY,
      fetchImpl: jsonFetch(discovery({
        desktopAuthentication: {
          protocolVersion: 2,
          browserPairing: capability !== "browserPairing",
          instanceBearerTokens: capability !== "instanceBearerTokens",
          socketIoBearerAuthentication: capability !== "socketIoBearerAuthentication",
        },
      })),
    });

    assert.equal(status.status, "incompatible", capability);
    assert.equal(status.apiReady, false, capability);
    assert.deepEqual(status.reasonCodes, ["DESKTOP_AUTHENTICATION_UNSUPPORTED"], capability);
  }
});

test("probe distinguishes timeout, non-JSON, and capped output", async () => {
  const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  assert.deepEqual(await probeConnectDiscovery(ENDPOINT, never, 10), { kind: "timeout" });

  const nonJson = (async () => new Response("<html>no</html>", {
    headers: { "content-type": "text/html" },
  })) as typeof fetch;
  assert.deepEqual(await probeConnectDiscovery(ENDPOINT, nonJson, 100), { kind: "invalid" });

  const oversized = (async () => new Response("{}", {
    headers: {
      "content-type": "application/json",
      "content-length": "9000",
    },
  })) as typeof fetch;
  assert.deepEqual(await probeConnectDiscovery(ENDPOINT, oversized, 100), { kind: "tooLarge" });
});

test("the shared discovery parser requires every exact canonical field and capability", () => {
  const parsed = parseProprDesktopDiscovery(discovery());
  assert.ok(parsed);
  assert.equal(parsed.desktopAuthentication.protocolVersion, 2);
  const topLevelKeys = Object.keys(discovery());
  for (const key of topLevelKeys) {
    const candidate = discovery();
    delete candidate[key];
    assert.equal(parseProprDesktopDiscovery(candidate), null, `missing ${key}`);
  }
  for (const key of [
    "protocolVersion",
    "browserPairing",
    "instanceBearerTokens",
    "socketIoBearerAuthentication",
  ]) {
    const candidate = discovery();
    const capabilities = { ...(candidate.desktopAuthentication as Record<string, unknown>) };
    delete capabilities[key];
    candidate.desktopAuthentication = capabilities;
    assert.equal(parseProprDesktopDiscovery(candidate), null, `missing desktopAuthentication.${key}`);
  }

  for (const invalid of [
    discovery({ extra: true }),
    discovery({ version: "v0.8.15" }),
    discovery({ version: "00.8.15" }),
    discovery({ version: "0.8" }),
    discovery({ apiCompatibility: "2026-6-27" }),
    discovery({ apiCompatibility: "2026-02-30" }),
    discovery({ uiCompatibility: "" }),
    discovery({ canonicalEndpoint: `${ENDPOINT}/` }),
    discovery({ publicInstanceIdentity: IDENTITY.toUpperCase() }),
    discovery({ desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: 1,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
    } }),
    discovery({ desktopAuthentication: {
      protocolVersion: 2,
      browserPairing: true,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
      omittedCapabilityReplacement: true,
    } }),
  ]) assert.equal(parseProprDesktopDiscovery(invalid), null);

  assert.equal(parseProprDesktopDiscovery(discovery({ desktopAuthentication: {
    protocolVersion: 1,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  } })), null, "legacy desktop authentication protocol v1 must fail closed");
});

function neverEndingResponse(
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  onCancel: () => void,
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      onCancel();
    },
  }), {
    status,
    headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => (
      entry[1] !== undefined
    ))),
  });
}

test("every early response rejection cancels a never-ending body", async () => {
  for (const branch of [
    { status: 404, headers: { "content-type": "application/json" }, kind: "unsupported" },
    { status: 503, headers: { "content-type": "application/json" }, kind: "unreachable" },
    { status: 200, headers: { "content-type": "text/html" }, kind: "invalid" },
    {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "9000" },
      kind: "tooLarge",
    },
  ] as const) {
    let canceled = 0;
    const fetchImpl = (async () => neverEndingResponse(
      branch.status,
      branch.headers,
      () => { canceled += 1; },
    )) as typeof fetch;
    assert.deepEqual(await probeConnectDiscovery(ENDPOINT, fetchImpl, 100), { kind: branch.kind });
    assert.equal(canceled, 1, branch.kind);
  }
});

test("fatal UTF-8, malformed JSON, and incomplete schema are invalid rather than unreachable", async () => {
  const invalidUtf8 = (async () => new Response(Uint8Array.from([0xc3, 0x28]), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  assert.deepEqual(await probeConnectDiscovery(ENDPOINT, invalidUtf8, 100), { kind: "invalid" });

  for (const body of ["{", JSON.stringify({ schemaVersion: 1, product: "ProPR" })]) {
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    assert.deepEqual(await probeConnectDiscovery(ENDPOINT, fetchImpl, 100), { kind: "invalid" });
    assert.equal(signal?.aborted, true);
  }
});

test("timeout cancels an active body and late-settling responses are canceled on arrival", async () => {
  let activeCanceled = 0;
  const active = (async () => neverEndingResponse(
    200,
    { "content-type": "application/json" },
    () => { activeCanceled += 1; },
  )) as typeof fetch;
  assert.deepEqual(await probeConnectDiscovery(ENDPOINT, active, 10), { kind: "timeout" });
  assert.equal(activeCanceled, 1);

  for (const status of [200, 404, 503]) {
    let settle!: (response: Response) => void;
    let lateCanceled = 0;
    const late = (() => new Promise<Response>((resolve) => { settle = resolve; })) as typeof fetch;
    assert.deepEqual(await probeConnectDiscovery(ENDPOINT, late, 10), { kind: "timeout" });
    settle(neverEndingResponse(status, { "content-type": "text/html" }, () => { lateCanceled += 1; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lateCanceled, 1, `late status ${status}`);
  }
});

test("abort between reader acquisition and listener installation cancels without reading or leaking", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancellations = 0;
  let releases = 0;
  let listeners = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];

  const response = {
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        controller.abort();
        return {
          cancel: async () => { cancellations += 1; },
          read: async () => { reads += 1; return { done: true, value: undefined }; },
          releaseLock: () => { releases += 1; },
        };
      },
    },
  } as unknown as Response;

  await assert.rejects(() => readBoundedBody(response, controller.signal), /aborted/);
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  assert.equal(listeners, 0);
});

test("serialized JSON is bounded and cannot include local secret sentinels", async () => {
  const secret = "cloudflare-token-SENTINEL";
  const status = await resolveConnectStatus({
    cfg: cfg({ uiTunnelToken: secret }),
    sidecarRunning: true,
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(),
  });
  const output = JSON.stringify(status);
  assert.ok(output.length < 2048);
  assert.equal(output.includes(secret), false);
  assert.deepEqual(Object.keys(status), [
    "schemaVersion", "status", "canonicalEndpoint", "publicInstanceIdentity",
    "configured", "enabled", "sidecarRunning", "apiReady", "restartRequired",
    "compatibility", "version", "reasonCodes",
  ]);
});
