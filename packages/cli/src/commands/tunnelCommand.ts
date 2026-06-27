/**
 * Service toggle command: `propr tunnel on|off`.
 *
 * The Cloudflare Tunnel is an optional managed sidecar (the official
 * `cloudflared` image) that exposes this local stack's UI/API to the hosted
 * control plane. Like `propr ui` and `propr docs`, toggling it just
 * starts/stops the container, but with two differences:
 *
 *   - Starting requires a configured token (PROPR_UI_TUNNEL_TOKEN); without one
 *     cloudflared cannot authenticate, so we fail clearly instead of launching a
 *     broken container.
 *   - Stopping only removes the tunnel container; it never touches the token or
 *     any other env value, so a later `propr tunnel on` works without rework.
 *
 * The desired state is persisted in the CLI config so `propr start` and restarts
 * honor a previous toggle.
 */

import { Command } from "commander";
import { proprTunnelEndpoints } from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";
import { parseOnOffState, ParseStateError } from "../utils/index.js";
import type { ConfigManager } from "../config/index.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/types.js";

/** Thrown by applyTunnelToggle when `tunnel on` is requested without a token. */
export class TunnelTokenMissingError extends Error {
  constructor() {
    super(
      "cannot start the tunnel — no token configured.\n" +
        "  Set PROPR_UI_TUNNEL_TOKEN in your stack .env (and optionally\n" +
        "  PROPR_UI_PUBLIC_API_URL), then run 'propr tunnel on' again."
    );
    this.name = "TunnelTokenMissingError";
  }
}

export interface TunnelToggleDeps {
  enable: boolean;
  cfg: OrchestratorConfig;
  orch: Pick<OrchestratorModule, "isStackRunning" | "ensureNetwork" | "startService" | "stopService">;
  configManager: Pick<ConfigManager, "getTunnelEnabled" | "setTunnelEnabled" | "set">;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Core `propr tunnel on|off` behavior, decoupled from CLI wiring (config/orch
 * loading, process.exit) so it can be unit-tested with injected fakes. Throws
 * {@link TunnelTokenMissingError} when enabling without a token.
 */
export async function applyTunnelToggle({
  enable,
  cfg,
  orch,
  configManager,
  log = console.log,
  warn = console.warn,
}: TunnelToggleDeps): Promise<void> {
  // Validate before touching anything: starting the tunnel needs a token, or
  // cloudflared cannot authenticate.
  if (enable && !cfg.uiTunnelToken) {
    throw new TunnelTokenMissingError();
  }

  // Persist the desired state up front (after validation, before Docker) so the
  // recorded override and the actual container can't diverge if the start/stop
  // throws partway through. Roll back to the previous value if the Docker op
  // fails, so a failed toggle leaves the persisted state unchanged.
  const previousEnabled = configManager.getTunnelEnabled();
  await configManager.setTunnelEnabled(enable);
  // The `cfg` passed in was resolved before this toggle persisted, so when we are
  // turning the tunnel ON after a prior `propr tunnel off` it still carries
  // uiTunnelEnabled=false. Reflect the just-persisted desired state in the config
  // used for the start path so any tunnel-enabled-conditional behavior (and the
  // endpoint summary below) sees a consistent, enabled config.
  const effectiveCfg: OrchestratorConfig = { ...cfg, uiTunnelEnabled: enable };
  try {
    if (enable) {
      // PROPR_UI_TUNNEL_TOKEN is a live Cloudflare Tunnel credential: anyone with
      // it can route traffic through this tunnel. It is read from the stack .env,
      // so remind the operator not to commit, log, or share that file.
      warn(
        "Warning: PROPR_UI_TUNNEL_TOKEN is a live Cloudflare credential. Keep it\n" +
          "  in your stack .env only — do not commit, log, or share it."
      );
      // The tunnel only routes to the core API (api:4000). Starting it while the
      // core stack is down leaves a healthy-looking cloudflared sidecar pointing
      // at an unavailable backend, so warn the operator (don't fail — they may be
      // about to `propr start`).
      if (!orch.isStackRunning(effectiveCfg)) {
        warn(
          "Warning: the core stack does not appear to be running, so the tunnel\n" +
            "  will point at an unavailable API. Run 'propr start' to bring the\n" +
            "  core services up."
        );
      } else {
        // The already-running API/worker containers were started with whatever
        // API_PUBLIC_URL/FRONTEND_URL applied at the time. Turning the tunnel on
        // now does not restart them, so their OAuth redirects, cookie security,
        // and attachment links keep pointing at the pre-tunnel values until the
        // stack is restarted.
        warn(
          "Warning: the core stack is already running, so its API_PUBLIC_URL/\n" +
            "  FRONTEND_URL were set before the tunnel was enabled. Run\n" +
            "  'propr start --restart' to re-point OAuth redirects, cookies, and\n" +
            "  attachment links at the public proxy URL."
        );
      }
      log("Starting tunnel…");
      orch.ensureNetwork(effectiveCfg, (l: string) => log(l));
      orch.startService(effectiveCfg, "tunnel", { onLog: (l) => log(l) });
      log("tunnel is up.");
      if (effectiveCfg.uiPublicApiUrl) {
        // Show the concrete endpoints propr-routing forwards rather than the base
        // URL itself: only /api/* and /socket.io/* are routed, so the root URL
        // intentionally returns 404 (it is not the API health target).
        const { apiStatus, socketIo } = proprTunnelEndpoints(effectiveCfg.uiPublicApiUrl);
        log(`  API:      ${apiStatus}`);
        log(`  Realtime: ${socketIo}`);
        log("  Root URL intentionally returns 404.");
      }
    } else {
      log("Stopping tunnel…");
      orch.stopService(effectiveCfg, "tunnel", { remove: true, onLog: (l) => log(l) });
      log("tunnel stopped. Token and env values are unchanged.");
    }
  } catch (error) {
    // Revert to the exact prior value (including an unset "defer to env" state)
    // so a failed toggle doesn't leave a stale persisted override behind.
    await configManager.set("tunnelEnabled", previousEnabled);
    throw error;
  }
}

/** One verification probe and its outcome. */
export interface TunnelCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Aggregate result of `propr tunnel verify`. */
export interface TunnelVerifyResult {
  ok: boolean;
  checks: TunnelCheckResult[];
}

export interface TunnelVerifyDeps {
  cfg: OrchestratorConfig;
  orch: Pick<OrchestratorModule, "getServiceState">;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the HTTP probes. */
  timeoutMs?: number;
}

// GET a URL behind a hard timeout. Resolves the HTTP status, or null on a
// network error / timeout (so the caller can distinguish "no response at all"
// from "responded with a status"). Never throws — verify reports, it does not gate.
async function probeStatus(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Core `propr tunnel verify` checks, decoupled from CLI wiring so they can be
 * unit-tested with an injected fetch/orchestrator. Runs the simple liveness
 * checks from the spec:
 *   - the cloudflared sidecar container is running;
 *   - GET <url>/api/status returns an OK/auth-expected response;
 *   - GET <url>/ returns 404 (the root is intentionally not routed);
 *   - GET <url>/socket.io/ is reachable (not blocked by Cloudflare ingress).
 */
export async function verifyTunnel({
  cfg,
  orch,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: TunnelVerifyDeps): Promise<TunnelVerifyResult> {
  const checks: TunnelCheckResult[] = [];

  // 1. cloudflared container running.
  const state = orch.getServiceState(cfg, "tunnel");
  checks.push({
    name: "cloudflared container running",
    ok: Boolean(state?.running),
    detail: state?.running
      ? `${state.name} is up`
      : "the cloudflared sidecar is not running — start it with 'propr tunnel on'",
  });

  const publicApiUrl = cfg.uiPublicApiUrl;
  if (!publicApiUrl) {
    // Without a public URL there is nothing to probe over HTTP. Record the
    // remaining checks as failed with an actionable detail rather than skipping.
    const detail =
      "no public proxy URL is known — set PROPR_INSTANCE_ID or PROPR_UI_PUBLIC_API_URL";
    checks.push({ name: "GET /api/status", ok: false, detail });
    checks.push({ name: "GET / returns 404", ok: false, detail });
    checks.push({ name: "GET /socket.io/ reachable", ok: false, detail });
    return { ok: false, checks };
  }

  const { apiStatus, socketIo, root } = proprTunnelEndpoints(publicApiUrl);

  // 2. /api/status returns OK or an auth-expected response.
  const apiCode = await probeStatus(apiStatus, fetchImpl, timeoutMs);
  const apiOk = apiCode !== null && (apiCode < 400 || apiCode === 401 || apiCode === 403);
  checks.push({
    name: "GET /api/status",
    ok: apiOk,
    detail:
      apiCode === null
        ? `no response from ${apiStatus} (network error or timeout)`
        : `${apiStatus} → ${apiCode}${apiCode === 401 || apiCode === 403 ? " (auth-expected)" : ""}`,
  });

  // 3. Root path intentionally returns 404 (only /api/* and /socket.io/* route).
  const rootCode = await probeStatus(root, fetchImpl, timeoutMs);
  checks.push({
    name: "GET / returns 404",
    ok: rootCode === 404,
    detail:
      rootCode === null
        ? `no response from ${root} (network error or timeout)`
        : `${root} → ${rootCode}${rootCode === 404 ? " (expected)" : " (expected 404)"}`,
  });

  // 4. Socket.IO path reachable — a Socket.IO server answers a bare GET with a
  // 400 ("Transport unknown"), so a non-404, non-5xx HTTP response proves the
  // path reaches the Socket.IO server through Cloudflare rather than being
  // blocked at ingress. A 404 means the path is not routed; a 5xx means the
  // request reached an edge/proxy that could not reach the backend (e.g. a
  // Cloudflare 502/503 error page), which is not a usable Socket.IO endpoint —
  // both are treated as failures rather than false-positive "routed".
  const socketCode = await probeStatus(socketIo, fetchImpl, timeoutMs);
  const socketOk = socketCode !== null && socketCode !== 404 && socketCode < 500;
  checks.push({
    name: "GET /socket.io/ reachable",
    ok: socketOk,
    detail:
      socketCode === null
        ? `no response from ${socketIo} (network error or timeout)`
        : socketCode === 404
          ? `${socketIo} → 404 (path not routed / blocked at ingress)`
          : socketCode >= 500
            ? `${socketIo} → ${socketCode} (proxy/server error, not reaching Socket.IO)`
            : `${socketIo} → ${socketCode} (routed)`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}

async function runTunnelVerify(root?: string): Promise<void> {
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
    process.exit(1);
  }

  console.log("Verifying tunnel…");
  const { ok, checks } = await verifyTunnel({ cfg, orch });
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  console.log("");
  if (ok) {
    console.log("Tunnel verification passed.");
  } else {
    console.error("Tunnel verification failed.");
    process.exit(1);
  }
}

async function toggleTunnel(stateArg: string, root?: string): Promise<void> {
  const enable = parseOnOffState(stateArg);
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
    process.exit(1);
  }

  try {
    await applyTunnelToggle({ enable, cfg, orch, configManager });
  } catch (error) {
    if (error instanceof TunnelTokenMissingError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

export function createTunnelCommand(): Command {
  return new Command("tunnel")
    .description("Start, stop, or verify the Cloudflare Tunnel service")
    .argument("<action>", "on, off, or verify")
    .option("--root <dir>", "Stack root directory")
    .addHelpText("after", `
Starting the tunnel requires a configured token. Set these in your stack .env:
  PROPR_UI_TUNNEL_TOKEN    Cloudflare Tunnel token (required to start). This is a
                           live Cloudflare credential — do not commit, log, or share it
  PROPR_INSTANCE_ID        Instance id; derives the public URL
                           https://<id>.proxy.propr.dev when no explicit one is set
  PROPR_UI_PUBLIC_API_URL  Explicit public API URL advertised through the tunnel
                           (optional; overrides the id-derived URL)

Cloudflare forwards the tunnel to the Docker-internal API service at
http://api:4000 (NOT host port 4000), so the published host port is irrelevant
to tunnel routing and the two cannot conflict. Only /api/* and /socket.io/* are
routed; the root URL intentionally returns 404.

  $ propr tunnel on        Start the cloudflared sidecar
  $ propr tunnel off       Stop the sidecar (token/env values are left untouched)
  $ propr tunnel verify    Check the sidecar + public /api/status, /, /socket.io/
`)
    .action(async (action: string, options: { root?: string }) => {
      try {
        if (action === "verify") {
          await runTunnelVerify(options.root);
          return;
        }
        await toggleTunnel(action, options.root);
      } catch (error) {
        if (error instanceof ParseStateError) {
          console.error(`Error: ${error.message} (expected on, off, or verify)`);
          process.exit(1);
        }
        console.error(`Error running tunnel command: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
