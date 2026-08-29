import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECT_STATUS_EXIT,
  probeConnectDiscovery,
  resolveConnectStatus,
} from "./connectCommand.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/types.js";

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

function orch(running: boolean): Pick<OrchestratorModule, "getServiceState"> {
  return {
    getServiceState: () => running ? {
      name: "propr-tunnel",
      service: "tunnel",
      exists: true,
      running: true,
      state: "running",
      status: "Up",
      ports: "",
    } : undefined,
  };
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
      protocolVersion: 1,
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
    notReady: 2,
    incompatible: 3,
    invalidConfig: 4,
    timeout: 5,
  });
});

test("missing, disabled, and stopped tunnel states do not probe", async () => {
  let probes = 0;
  const fetchImpl = (async () => {
    probes += 1;
    throw new Error("must not probe");
  }) as typeof fetch;

  const missing = await resolveConnectStatus({
    cfg: cfg({ uiPublicApiUrl: undefined, proprInstanceId: undefined, uiTunnelEnabled: false }),
    orch: orch(false),
    publicInstanceIdentity: IDENTITY,
    fetchImpl,
  });
  assert.equal(missing.status, "notReady");
  assert.deepEqual(missing.reasonCodes, ["NOT_CONFIGURED", "TUNNEL_DISABLED"]);

  const disabled = await resolveConnectStatus({
    cfg: cfg({ uiTunnelEnabled: false }), orch: orch(false), publicInstanceIdentity: IDENTITY, fetchImpl,
  });
  assert.deepEqual(disabled.reasonCodes, ["TUNNEL_DISABLED"]);

  const stopped = await resolveConnectStatus({
    cfg: cfg(), orch: orch(false), publicInstanceIdentity: IDENTITY, fetchImpl,
  });
  assert.deepEqual(stopped.reasonCodes, ["SIDECAR_NOT_RUNNING"]);
  assert.equal(probes, 0);
});

test("ready requires matching canonical origin, identity, and compatibility", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(), orch: orch(true), publicInstanceIdentity: IDENTITY, fetchImpl: jsonFetch(),
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
    orch: orch(true),
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
    orch: orch(true),
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(discovery({ publicInstanceIdentity: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })),
  });
  assert.equal(status.status, "notReady");
  assert.deepEqual(status.reasonCodes, ["IDENTITY_MISMATCH"]);
});

test("old discovery compatibility has an incompatible result", async () => {
  const status = await resolveConnectStatus({
    cfg: cfg(),
    orch: orch(true),
    publicInstanceIdentity: IDENTITY,
    fetchImpl: jsonFetch(discovery({ apiCompatibility: "2025-01-01" })),
  });
  assert.equal(status.status, "incompatible");
  assert.deepEqual(status.reasonCodes, ["API_INCOMPATIBLE"]);
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

test("serialized JSON is bounded and cannot include local secret sentinels", async () => {
  const secret = "cloudflare-token-SENTINEL";
  const status = await resolveConnectStatus({
    cfg: cfg({ uiTunnelToken: secret }),
    orch: orch(true),
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
