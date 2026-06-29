/**
 * `propr tunnel on|off` core-behavior tests. Run with:
 * `npx tsx --test src/commands/tunnelCommand.test.ts` (from packages/cli).
 *
 * These exercise applyTunnelToggle — the dependency-injected core of the command
 * — with fake orchestrator/config-manager doubles, so no Docker or real config
 * file is touched. They pin the parts the CLI wiring can't easily assert:
 * missing-token messaging, persist-before-start ordering with rollback, and the
 * "stop only the tunnel" semantics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTunnelToggle,
  buildTunnelSetupEnv,
  startOrRestartTunnelStack,
  validateTunnelCommandOptions,
  verifyTunnel,
  TunnelTokenMissingError,
  TunnelPublicUrlMissingError,
  TunnelPublicUrlInvalidError,
  TunnelCoreStackDownError,
  type TunnelToggleDeps,
} from "./tunnelCommand.js";
import type { OrchestratorConfig, OrchestratorModule, ServiceState } from "../orchestrator/types.js";

interface OrchCall {
  fn: string;
  service?: string;
  remove?: boolean;
  uiTunnelEnabled?: boolean;
}

// Minimal orchestrator double recording calls; start/stop can be made to throw.
function fakeOrch(opts: {
  stackRunning?: boolean;
  throwOn?: "startService" | "stopService";
} = {}): { orch: TunnelToggleDeps["orch"]; calls: OrchCall[] } {
  const calls: OrchCall[] = [];
  const orch: TunnelToggleDeps["orch"] = {
    isStackRunning: () => opts.stackRunning ?? true,
    ensureNetwork: () => {
      calls.push({ fn: "ensureNetwork" });
    },
    startService: ((cfg, service) => {
      calls.push({ fn: "startService", service, uiTunnelEnabled: cfg.uiTunnelEnabled });
      if (opts.throwOn === "startService") throw new Error("docker start failed");
      return undefined;
    }) as OrchestratorModule["startService"],
    stopService: ((_cfg, service, o) => {
      calls.push({ fn: "stopService", service, remove: o?.remove });
      if (opts.throwOn === "stopService") throw new Error("docker stop failed");
    }) as OrchestratorModule["stopService"],
  };
  return { orch, calls };
}

// Minimal config-manager double tracking the persisted tunnelEnabled value.
function fakeConfigManager(initial?: boolean): {
  configManager: TunnelToggleDeps["configManager"];
  value: () => boolean | undefined;
  sets: Array<boolean | undefined>;
} {
  let stored = initial;
  const sets: Array<boolean | undefined> = [];
  const configManager: TunnelToggleDeps["configManager"] = {
    getTunnelEnabled: () => stored,
    setTunnelEnabled: async (enabled: boolean) => {
      stored = enabled;
      sets.push(enabled);
    },
    set: (async (_key: string, val: boolean | undefined) => {
      stored = val;
      sets.push(val);
    }) as TunnelToggleDeps["configManager"]["set"],
  };
  return { configManager, value: () => stored, sets };
}

function cfgWith(overrides: Partial<OrchestratorConfig>): OrchestratorConfig {
  return overrides as OrchestratorConfig;
}

const sink = () => {};

test("tunnel setup builds env from the Connect proxy URL", () => {
  assert.deepEqual(
    buildTunnelSetupEnv({
      token: "secret-token",
      url: "https://abc123.proxy.propr.dev/",
    }),
    {
      PROPR_UI_TUNNEL_TOKEN: "secret-token",
      PROPR_UI_TUNNEL_ENABLED: "true",
      PROPR_INSTANCE_ID: "abc123",
      PROPR_UI_PUBLIC_API_URL: "https://abc123.proxy.propr.dev",
      API_PUBLIC_URL: "https://abc123.proxy.propr.dev",
      FRONTEND_URL: "https://app.propr.dev",
      GH_OAUTH_CALLBACK_URL: "https://abc123.proxy.propr.dev/api/auth/github/callback",
    }
  );
});

test("tunnel setup builds env from an instance id", () => {
  assert.deepEqual(
    buildTunnelSetupEnv({
      token: "secret-token",
      instanceId: "abc123",
    }),
    {
      PROPR_UI_TUNNEL_TOKEN: "secret-token",
      PROPR_UI_TUNNEL_ENABLED: "true",
      PROPR_INSTANCE_ID: "abc123",
      PROPR_UI_PUBLIC_API_URL: "https://abc123.proxy.propr.dev",
      API_PUBLIC_URL: "https://abc123.proxy.propr.dev",
      FRONTEND_URL: "https://app.propr.dev",
      GH_OAUTH_CALLBACK_URL: "https://abc123.proxy.propr.dev/api/auth/github/callback",
    }
  );
});

test("tunnel setup rejects mismatched URL and instance id", () => {
  assert.throws(
    () =>
      buildTunnelSetupEnv({
        token: "secret-token",
        url: "https://abc123.proxy.propr.dev",
        instanceId: "other",
      }),
    /does not match/
  );
});

test("tunnel setup rejects a non-Connect proxy URL", () => {
  assert.throws(
    () =>
      buildTunnelSetupEnv({
        token: "secret-token",
        url: "https://custom.example.com",
      }),
    /hosted proxy URL/
  );
});

test("tunnel setup rejects a proxy URL carrying a path", () => {
  // A base URL with a path would make proprTunnelEndpoints double up the /api
  // prefix (".../api/api/status"), so it must be rejected as a bare origin.
  assert.throws(
    () =>
      buildTunnelSetupEnv({
        token: "secret-token",
        url: "https://abc123.proxy.propr.dev/api",
      }),
    /hosted proxy URL/
  );
});

test("tunnel setup rejects --force because it only applies to tunnel on", () => {
  assert.throws(
    () => validateTunnelCommandOptions("setup", { force: true }),
    /--force is only supported/
  );
  assert.doesNotThrow(() => validateTunnelCommandOptions("on", { force: true }));
});

test("tunnel setup canonicalizes a mixed-case instance id", () => {
  // DNS is case-insensitive and the launcher lowercases PROPR_INSTANCE_ID, so
  // setup must persist the same canonical (lowercased) id and URL.
  assert.deepEqual(
    buildTunnelSetupEnv({
      token: "secret-token",
      instanceId: "AbC123",
    }),
    {
      PROPR_UI_TUNNEL_TOKEN: "secret-token",
      PROPR_UI_TUNNEL_ENABLED: "true",
      PROPR_INSTANCE_ID: "abc123",
      PROPR_UI_PUBLIC_API_URL: "https://abc123.proxy.propr.dev",
      API_PUBLIC_URL: "https://abc123.proxy.propr.dev",
      FRONTEND_URL: "https://app.propr.dev",
      GH_OAUTH_CALLBACK_URL: "https://abc123.proxy.propr.dev/api/auth/github/callback",
    }
  );
});

test("tunnel setup --start starts a stopped stack with tunnel settings", async () => {
  const calls: Array<{ fn: string; uiTunnelEnabled?: boolean }> = [];
  const { configManager, value } = fakeConfigManager(undefined);
  const orch = {
    validateEnv: () => ({ ok: true, errors: [], warnings: [] }),
    ensureNetwork: () => {
      calls.push({ fn: "ensureNetwork" });
    },
    isStackRunning: () => false,
    stopStack: () => {
      calls.push({ fn: "stopStack" });
      return { failed: [] };
    },
    startStack: ((cfg) => {
      calls.push({ fn: "startStack", uiTunnelEnabled: cfg.uiTunnelEnabled });
      return { services: [] };
    }) as OrchestratorModule["startStack"],
  };

  await startOrRestartTunnelStack(orch, cfgWith({ uiTunnelEnabled: false }), configManager, sink);

  assert.equal(value(), true);
  assert.deepEqual(calls, [
    { fn: "ensureNetwork" },
    { fn: "startStack", uiTunnelEnabled: true },
  ]);
});

test("tunnel setup --start recreates an already-running stack", async () => {
  const calls: Array<{ fn: string; uiTunnelEnabled?: boolean }> = [];
  const { configManager, value } = fakeConfigManager(false);
  const orch = {
    validateEnv: () => ({ ok: true, errors: [], warnings: [] }),
    ensureNetwork: () => {
      calls.push({ fn: "ensureNetwork" });
    },
    isStackRunning: () => true,
    stopStack: () => {
      calls.push({ fn: "stopStack" });
      return { failed: [] };
    },
    startStack: ((cfg) => {
      calls.push({ fn: "startStack", uiTunnelEnabled: cfg.uiTunnelEnabled });
      return { services: [] };
    }) as OrchestratorModule["startStack"],
  };

  await startOrRestartTunnelStack(orch, cfgWith({ uiTunnelEnabled: false }), configManager, sink);

  assert.equal(value(), true);
  assert.deepEqual(calls, [
    { fn: "stopStack" },
    { fn: "ensureNetwork" },
    { fn: "startStack", uiTunnelEnabled: true },
  ]);
});

test("tunnel setup --start fails before starting when an existing stack cannot stop", async () => {
  const calls: string[] = [];
  const { configManager } = fakeConfigManager(false);
  const orch = {
    validateEnv: () => ({ ok: true, errors: [], warnings: [] }),
    ensureNetwork: () => {
      calls.push("ensureNetwork");
    },
    isStackRunning: () => true,
    stopStack: () => {
      calls.push("stopStack");
      return { failed: ["api"] };
    },
    startStack: (() => {
      calls.push("startStack");
      return { services: [] };
    }) as OrchestratorModule["startStack"],
  };

  await assert.rejects(
    startOrRestartTunnelStack(orch, cfgWith({ uiTunnelEnabled: false }), configManager, sink),
    /failed to stop 1 service/
  );
  assert.deepEqual(calls, ["stopStack"]);
});

test("tunnel setup --start rejects invalid env before touching containers", async () => {
  const calls: string[] = [];
  const { configManager, value } = fakeConfigManager(undefined);
  const orch = {
    validateEnv: () => ({
      ok: false,
      errors: ["PROPR_UI_PUBLIC_API_URL is not a hosted proxy URL"],
      warnings: [],
    }),
    ensureNetwork: () => {
      calls.push("ensureNetwork");
    },
    isStackRunning: () => {
      calls.push("isStackRunning");
      return false;
    },
    stopStack: () => {
      calls.push("stopStack");
      return { failed: [] };
    },
    startStack: (() => {
      calls.push("startStack");
      return { services: [] };
    }) as OrchestratorModule["startStack"],
  };

  await assert.rejects(
    startOrRestartTunnelStack(orch, cfgWith({ uiTunnelEnabled: false }), configManager, sink),
    /is not valid/
  );
  // Validation runs before persisting enabled=true or touching any container.
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on without a token throws and does not persist or start", async () => {
  const { orch, calls } = fakeOrch();
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      cfg: cfgWith({ uiTunnelToken: undefined }),
      orch,
      configManager,
      log: sink,
      warn: sink,
    }),
    TunnelTokenMissingError
  );

  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on without a derivable public proxy URL throws and does not persist or start", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: true });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      // Token present but no PROPR_INSTANCE_ID / PROPR_UI_PUBLIC_API_URL, so the
      // hosted UI would have no endpoint to reach this stack.
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: undefined }),
      orch,
      configManager,
      log: sink,
      warn: sink,
    }),
    TunnelPublicUrlMissingError
  );

  // Refused before persisting or touching Docker, like the missing-token guard.
  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on without a public URL is not bypassed by --force", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: false });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: undefined }),
      orch,
      configManager,
      force: true,
      log: sink,
      warn: sink,
    }),
    TunnelPublicUrlMissingError
  );

  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on with a non-proxy public URL throws and does not persist or start", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: true });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      // Explicit PROPR_UI_PUBLIC_API_URL that is a valid URL but not a hosted
      // proxy URL, so propr-routing would not forward to this stack — the same
      // configuration validateEnv() rejects for `propr start`.
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://custom.example.com" }),
      orch,
      configManager,
      log: sink,
      warn: sink,
    }),
    TunnelPublicUrlInvalidError
  );

  // Refused before persisting or touching Docker, like the other start guards.
  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on with a non-proxy public URL is not bypassed by --force", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: false });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://custom.example.com" }),
      orch,
      configManager,
      force: true,
      log: sink,
      warn: sink,
    }),
    TunnelPublicUrlInvalidError
  );

  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on persists desired state before starting the sidecar", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: true });
  const { configManager, value } = fakeConfigManager(undefined);

  await applyTunnelToggle({
    enable: true,
    cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch,
    configManager,
    log: sink,
    warn: sink,
  });

  assert.equal(value(), true);
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["ensureNetwork", "startService"]
  );
  assert.equal(calls.find((c) => c.fn === "startService")?.service, "tunnel");
});

test("tunnel on starts the sidecar with an enabled config even when the input cfg was resolved while disabled", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: true });
  const { configManager } = fakeConfigManager(false);

  // cfg mirrors a config resolved after a prior `propr tunnel off`: token present
  // but uiTunnelEnabled=false. The start path must see the just-enabled state.
  await applyTunnelToggle({
    enable: true,
    cfg: cfgWith({
      uiTunnelToken: "secret-token",
      uiTunnelEnabled: false,
      uiPublicApiUrl: "https://abc123.proxy.propr.dev",
    }),
    orch,
    configManager,
    log: sink,
    warn: sink,
  });

  assert.equal(calls.find((c) => c.fn === "startService")?.uiTunnelEnabled, true);
});

test("tunnel on rolls the persisted state back when the start fails", async () => {
  const { orch } = fakeOrch({ stackRunning: true, throwOn: "startService" });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
      orch,
      configManager,
      log: sink,
      warn: sink,
    }),
    /docker start failed/
  );

  // Persisted true up front, then reverted to the prior unset value.
  assert.deepEqual(sets, [true, undefined]);
  assert.equal(value(), undefined);
});

test("tunnel on with the core stack down throws and does not persist or start", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: false });
  const { configManager, value, sets } = fakeConfigManager(undefined);

  await assert.rejects(
    applyTunnelToggle({
      enable: true,
      cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
      orch,
      configManager,
      log: sink,
      warn: sink,
    }),
    TunnelCoreStackDownError
  );

  // Refused before persisting or touching Docker, like the missing-token guard.
  assert.deepEqual(sets, []);
  assert.equal(value(), undefined);
  assert.deepEqual(calls, []);
});

test("tunnel on --force starts the sidecar even when the core stack is down", async () => {
  const { orch, calls } = fakeOrch({ stackRunning: false });
  const { configManager, value } = fakeConfigManager(undefined);
  const warnings: string[] = [];

  await applyTunnelToggle({
    enable: true,
    cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch,
    configManager,
    force: true,
    log: sink,
    warn: (m) => warnings.push(m),
  });

  assert.equal(value(), true);
  assert.equal(calls.find((c) => c.fn === "startService")?.service, "tunnel");
  assert.match(warnings.join("\n"), /--force/);
});

test("tunnel on warns about stale API env when the stack is already running", async () => {
  const { orch } = fakeOrch({ stackRunning: true });
  const { configManager } = fakeConfigManager(undefined);
  const warnings: string[] = [];

  await applyTunnelToggle({
    enable: true,
    cfg: cfgWith({ uiTunnelToken: "secret-token", uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch,
    configManager,
    log: sink,
    warn: (m) => warnings.push(m),
  });

  assert.match(warnings.join("\n"), /propr start --restart/);
});

// Fake orchestrator exposing only getServiceState, for verifyTunnel.
function verifyOrch(running: boolean): Pick<OrchestratorModule, "getServiceState"> {
  return {
    getServiceState: ((_cfg, service) =>
      service === "tunnel"
        ? ({ name: "propr-tunnel", service: "tunnel", exists: running, running, state: running ? "running" : "exited", status: "", ports: "" } as ServiceState)
        : undefined) as OrchestratorModule["getServiceState"],
  };
}

// Map a base URL's endpoints to canned HTTP statuses for a fake fetch.
function fakeFetch(byPath: Record<string, number | "error">): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const outcome = byPath[path];
    if (outcome === undefined || outcome === "error") throw new Error("network error");
    return { status: outcome, ok: outcome >= 200 && outcome < 300 } as Response;
  }) as typeof fetch;
}

test("verify passes when container runs and endpoints answer as expected", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({ "/api/status": 200, "/": 404, "/socket.io/": 400 }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((c) => c.ok), [true, true, true, true]);
});

test("verify treats an auth-expected /api/status as reachable", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({ "/api/status": 401, "/": 404, "/socket.io/": 400 }),
  });

  assert.equal(result.ok, true);
});

test("verify fails when the root path does not return 404", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({ "/api/status": 200, "/": 200, "/socket.io/": 400 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === "GET / returns 404")?.ok, false);
});

test("verify fails when the cloudflared container is not running", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(false),
    fetchImpl: fakeFetch({ "/api/status": 200, "/": 404, "/socket.io/": 400 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
});

test("verify fails the HTTP checks when no public URL is known", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: undefined }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({}),
  });

  assert.equal(result.ok, false);
  // Container check passes, the three HTTP checks fail for lack of a URL.
  assert.equal(result.checks[0].ok, true);
  assert.deepEqual(result.checks.slice(1).map((c) => c.ok), [false, false, false]);
});

test("verify flags a Socket.IO 404 as blocked at ingress", async () => {
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({ "/api/status": 200, "/": 404, "/socket.io/": 404 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === "GET /socket.io/ reachable")?.ok, false);
});

test("verify flags a Socket.IO 5xx as not reaching the server", async () => {
  // A proxy/edge error page (e.g. Cloudflare 502/503) is a non-404 response, but
  // it does not prove Socket.IO is reachable — it must not be a false-positive
  // "routed".
  const result = await verifyTunnel({
    cfg: cfgWith({ uiPublicApiUrl: "https://abc123.proxy.propr.dev" }),
    orch: verifyOrch(true),
    fetchImpl: fakeFetch({ "/api/status": 200, "/": 404, "/socket.io/": 502 }),
  });

  assert.equal(result.ok, false);
  const socketCheck = result.checks.find((c) => c.name === "GET /socket.io/ reachable");
  assert.equal(socketCheck?.ok, false);
  assert.match(socketCheck?.detail ?? "", /proxy\/server error/);
});

test("tunnel off stops only the tunnel and persists false", async () => {
  const { orch, calls } = fakeOrch();
  const { configManager, value } = fakeConfigManager(true);

  await applyTunnelToggle({
    enable: false,
    cfg: cfgWith({ uiTunnelToken: "secret-token" }),
    orch,
    configManager,
    log: sink,
    warn: sink,
  });

  assert.equal(value(), false);
  assert.deepEqual(calls, [{ fn: "stopService", service: "tunnel", remove: true }]);
});
