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
import { join } from "node:path";
import { proprTunnelEndpoints, isProprProxyUrl, PROPR_UI_PROXY_SUFFIX } from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { getHostConfig, resolveStackRoot } from "../orchestrator/index.js";
import { parseOnOffState, ParseStateError } from "../utils/index.js";
import { upsertEnvVars } from "../utils/envFile.js";
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

/**
 * Thrown by applyTunnelToggle when `tunnel on` is requested but no public proxy
 * URL can be derived. Hosted UI tunnel mode fundamentally needs an advertised
 * endpoint (`PROPR_INSTANCE_ID` → https://<id>.proxy.propr.dev, or an explicit
 * `PROPR_UI_PUBLIC_API_URL`); without one the sidecar would start and the desired
 * state persist while the hosted UI has no usable endpoint, surfacing only as
 * later status/verify failures. So we refuse up front instead.
 */
export class TunnelPublicUrlMissingError extends Error {
  constructor() {
    super(
      "cannot start the tunnel — no public proxy URL can be derived.\n" +
        "  The hosted UI reaches this stack at https://<id>.proxy.propr.dev, so set\n" +
        "  PROPR_INSTANCE_ID (preferred) or an explicit PROPR_UI_PUBLIC_API_URL in\n" +
        "  your stack .env, then run 'propr tunnel on' again."
    );
    this.name = "TunnelPublicUrlMissingError";
  }
}

/**
 * Thrown by applyTunnelToggle when `tunnel on` is requested with a public proxy
 * URL that is not a hosted `https://<id>.proxy.propr.dev` URL. propr-routing only
 * forwards `/api/*` and `/socket.io/*` on those hosts, so an explicit
 * `PROPR_UI_PUBLIC_API_URL` pointing anywhere else (e.g. https://custom.example.com)
 * would start a sidecar the hosted UI cannot route to. The launcher's
 * `validateEnv()` already rejects this for `propr start`/`propr check`; mirroring
 * it here keeps `propr tunnel on` from persisting and starting an unroutable
 * configuration that those commands would refuse.
 */
export class TunnelPublicUrlInvalidError extends Error {
  constructor(url: string) {
    super(
      `cannot start the tunnel — PROPR_UI_PUBLIC_API_URL ("${url}") is not a\n` +
        `  hosted proxy URL (https://<id>.${PROPR_UI_PROXY_SUFFIX}). The tunnel only\n` +
        `  routes /api/* and /socket.io/* on ${PROPR_UI_PROXY_SUFFIX} hosts, so the\n` +
        "  hosted UI could not reach this stack. Set PROPR_INSTANCE_ID (preferred) or\n" +
        `  a https://<id>.${PROPR_UI_PROXY_SUFFIX} URL, then run 'propr tunnel on' again.`
    );
    this.name = "TunnelPublicUrlInvalidError";
  }
}

/**
 * Thrown by applyTunnelToggle when `tunnel on` is requested while the core stack
 * is down. Starting cloudflared then yields a healthy-looking sidecar pointing at
 * an unavailable api:4000, so we refuse by default and tell the operator to bring
 * the stack up first (or opt in with --force if that is intentional).
 */
export class TunnelCoreStackDownError extends Error {
  constructor() {
    super(
      "cannot start the tunnel — the core stack does not appear to be running.\n" +
        "  cloudflared would route to an unavailable API (api:4000). Run\n" +
        "  'propr start' first, or pass --force to start the tunnel anyway."
    );
    this.name = "TunnelCoreStackDownError";
  }
}

export interface TunnelToggleDeps {
  enable: boolean;
  cfg: OrchestratorConfig;
  orch: Pick<OrchestratorModule, "isStackRunning" | "ensureNetwork" | "startService" | "stopService">;
  configManager: Pick<ConfigManager, "getTunnelEnabled" | "setTunnelEnabled" | "set">;
  /**
   * Start the tunnel even when the core stack is down. Without this, enabling the
   * tunnel while the stack is down throws {@link TunnelCoreStackDownError}.
   */
  force?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export type TunnelSetupStartOrchestrator = Pick<
  OrchestratorModule,
  "isStackRunning" | "startStack" | "stopStack"
>;

export async function startOrRestartTunnelStack(
  orch: TunnelSetupStartOrchestrator,
  cfg: OrchestratorConfig,
  configManager: Pick<ConfigManager, "setTunnelEnabled">,
  log: (message: string) => void = console.log
): Promise<void> {
  await configManager.setTunnelEnabled(true);

  const tunnelCfg = { ...cfg, uiTunnelEnabled: true };
  const wasRunning = orch.isStackRunning(cfg);

  if (wasRunning) {
    log("Recreating the ProPR stack with hosted tunnel settings...");
    const stopped = orch.stopStack(cfg, { remove: true, onLog: log });
    if (stopped.failed.length > 0) {
      throw new Error(
        `failed to stop ${stopped.failed.length} service${stopped.failed.length === 1 ? "" : "s"} before restart`
      );
    }
  } else {
    log("Starting the ProPR stack with hosted tunnel settings...");
  }

  orch.startStack(tunnelCfg, { tunnel: true, onLog: log });
}

/**
 * Core `propr tunnel on|off` behavior, decoupled from CLI wiring (config/orch
 * loading, process.exit) so it can be unit-tested with injected fakes. Throws
 * {@link TunnelTokenMissingError} when enabling without a token, and
 * {@link TunnelCoreStackDownError} when enabling while the core stack is down
 * (unless `force` is set).
 */
export async function applyTunnelToggle({
  enable,
  cfg,
  orch,
  configManager,
  force = false,
  log = console.log,
  warn = console.warn,
}: TunnelToggleDeps): Promise<void> {
  // Validate before touching anything: starting the tunnel needs a token, or
  // cloudflared cannot authenticate.
  if (enable && !cfg.uiTunnelToken) {
    throw new TunnelTokenMissingError();
  }

  // It also needs a derivable public proxy URL — the endpoint the hosted UI uses
  // to reach this stack. Without it the sidecar would run but advertise nothing,
  // so refuse here (a config completeness requirement, not bypassed by --force)
  // rather than letting it surface as a later status/verify failure. Checked
  // before persisting so a refused start leaves no override behind.
  if (enable && !cfg.uiPublicApiUrl) {
    throw new TunnelPublicUrlMissingError();
  }

  // A derived public URL is always a well-formed proxy URL, but an explicit
  // PROPR_UI_PUBLIC_API_URL can be anything. propr-routing only forwards /api/*
  // and /socket.io/* on https://<id>.proxy.propr.dev hosts, so a non-proxy URL
  // would start a sidecar the hosted UI cannot route to. validateEnv() rejects
  // this for `propr start`/`propr check`; mirror it here so `propr tunnel on`
  // doesn't persist/start an unroutable configuration those commands would refuse.
  if (enable && cfg.uiPublicApiUrl && !isProprProxyUrl(cfg.uiPublicApiUrl)) {
    throw new TunnelPublicUrlInvalidError(cfg.uiPublicApiUrl);
  }

  // The tunnel only routes to the core API (api:4000). Starting it while the core
  // stack is down leaves a healthy-looking cloudflared sidecar pointing at an
  // unavailable backend, so refuse unless the operator explicitly opts in with
  // --force. Checked before persisting (like the token guard) so a refused start
  // leaves no override behind.
  const coreStackDown = enable && !orch.isStackRunning(cfg);
  if (coreStackDown && !force) {
    throw new TunnelCoreStackDownError();
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
      // We only reach the start path with the core stack down when --force was
      // given (otherwise applyTunnelToggle threw above). Remind the operator the
      // sidecar will point at an unavailable API until they `propr start`.
      if (coreStackDown) {
        warn(
          "Warning: the core stack does not appear to be running, so the tunnel\n" +
            "  will point at an unavailable API. Starting anyway because --force\n" +
            "  was given; run 'propr start' to bring the core services up."
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
      // Only the cloudflared sidecar was (re)started here. When the core stack was
      // already running, its API/worker containers keep the pre-tunnel
      // API_PUBLIC_URL/FRONTEND_URL until restarted, so say so explicitly rather
      // than a bare "tunnel is up" that reads as fully cut over.
      if (coreStackDown) {
        log("tunnel sidecar is up.");
      } else {
        log("tunnel sidecar is up — run 'propr start --restart' to apply API_PUBLIC_URL/FRONTEND_URL.");
      }
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

export interface TunnelSetupInput {
  token: string;
  url?: string;
  instanceId?: string;
}

export interface TunnelSetupEnv {
  PROPR_UI_TUNNEL_TOKEN: string;
  PROPR_INSTANCE_ID: string;
  PROPR_UI_PUBLIC_API_URL: string;
}

function instanceIdFromProxyUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const suffix = `.${PROPR_UI_PROXY_SUFFIX}`;
  return parsed.protocol === "https:" && parsed.hostname.endsWith(suffix)
    ? parsed.hostname.slice(0, -suffix.length)
    : undefined;
}

export function buildTunnelSetupEnv(input: TunnelSetupInput): TunnelSetupEnv {
  const token = input.token.trim();
  if (!token) throw new Error("--token is required");

  const explicitUrl = input.url?.trim().replace(/\/+$/, "");
  const explicitInstanceId = input.instanceId?.trim();
  if (!explicitUrl && !explicitInstanceId) {
    throw new Error("provide --url https://<id>.proxy.propr.dev or --instance-id <id>");
  }

  const publicUrl = explicitUrl ?? `https://${explicitInstanceId}.${PROPR_UI_PROXY_SUFFIX}`;
  if (!isProprProxyUrl(publicUrl)) {
    throw new Error(`tunnel URL must be a hosted proxy URL such as https://<id>.${PROPR_UI_PROXY_SUFFIX}`);
  }

  const derivedInstanceId = instanceIdFromProxyUrl(publicUrl);
  const instanceId = explicitInstanceId ?? derivedInstanceId;
  if (!instanceId) {
    throw new Error(`could not derive an instance id from ${publicUrl}`);
  }
  if (derivedInstanceId && explicitInstanceId && derivedInstanceId !== explicitInstanceId) {
    throw new Error(`--instance-id (${explicitInstanceId}) does not match --url host (${derivedInstanceId})`);
  }

  return {
    PROPR_UI_TUNNEL_TOKEN: token,
    PROPR_INSTANCE_ID: instanceId,
    PROPR_UI_PUBLIC_API_URL: publicUrl,
  };
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

async function toggleTunnel(stateArg: string, root?: string, force?: boolean): Promise<void> {
  const enable = parseOnOffState(stateArg);
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
    process.exit(1);
  }

  try {
    await applyTunnelToggle({ enable, cfg, orch, configManager, force });
  } catch (error) {
    if (
      error instanceof TunnelTokenMissingError ||
      error instanceof TunnelPublicUrlMissingError ||
      error instanceof TunnelPublicUrlInvalidError ||
      error instanceof TunnelCoreStackDownError
    ) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function runTunnelSetup(options: {
  root?: string;
  token?: string;
  url?: string;
  instanceId?: string;
  start?: boolean;
  force?: boolean;
}): Promise<void> {
  const configManager = await createConfigManager();
  const rootDir = resolveStackRoot(configManager, options.root);
  const envPath = join(rootDir, ".env");
  const vars = buildTunnelSetupEnv({
    token: options.token ?? "",
    url: options.url,
    instanceId: options.instanceId,
  });

  upsertEnvVars(envPath, { ...vars });
  await configManager.set("tunnelEnabled", true);

  console.log("Tunnel configuration saved.");
  console.log(`  saved to: ${envPath}`);
  console.log(`  public API: ${vars.PROPR_UI_PUBLIC_API_URL}`);
  console.log("");

  if (options.start) {
    const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
    if (!orch.dockerAvailable()) {
      console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
      process.exit(1);
    }
    await startOrRestartTunnelStack(orch, cfg, configManager);
    return;
  }

  console.log("Next steps:");
  console.log("  propr start --restart   # apply the hosted UI/API URLs to the stack");
  console.log("  propr tunnel verify     # confirm the public proxy can reach this stack");
  console.log("");
  console.log("Use 'propr tunnel setup --start ...' next time to save config and start or restart the stack in one step.");
}

export function createTunnelCommand(): Command {
  return new Command("tunnel")
    .description("Configure, start, stop, or verify the Cloudflare Tunnel service")
    .argument("<action>", "setup, on, off, or verify")
    .option("--root <dir>", "Stack root directory")
    .option("--force", "Start the tunnel even if the core stack is not running")
    .option("--token <token>", "Connector token from ProPR Connect (setup only)")
    .option("--url <url>", "Public proxy URL from ProPR Connect, e.g. https://<id>.proxy.propr.dev (setup only)")
    .option("--instance-id <id>", "Instance id from ProPR Connect; derives https://<id>.proxy.propr.dev (setup only)")
    .option("--start", "After setup, start or restart the stack with hosted tunnel settings")
    .addHelpText("after", `
Setup writes the tunnel settings to your stack .env for you:

  $ propr tunnel setup --token <connector-token> --url https://<id>.proxy.propr.dev --start

Starting the tunnel requires a token AND a public proxy URL:
  PROPR_UI_TUNNEL_TOKEN    Cloudflare Tunnel token (required to start). This is a
                           live Cloudflare credential — do not commit, log, or share it
  PROPR_INSTANCE_ID        Instance id; derives the public URL
                           https://<id>.proxy.propr.dev (required unless
                           PROPR_UI_PUBLIC_API_URL is set)
  PROPR_UI_PUBLIC_API_URL  Explicit public API URL advertised through the tunnel
                           (overrides the id-derived URL)

Cloudflare forwards the tunnel to the Docker-internal API service at
http://api:4000 (NOT host port 4000), so the published host port is irrelevant
to tunnel routing and the two cannot conflict. Only /api/* and /socket.io/* are
routed; the root URL intentionally returns 404.

  $ propr tunnel setup     Save the token/proxy URL from ProPR Connect to .env
  $ propr tunnel on        Start the cloudflared sidecar (requires the core stack
                           to be running; pass --force to start it regardless)
  $ propr tunnel off       Stop the sidecar (token/env values are left untouched)
  $ propr tunnel verify    Check the sidecar + public /api/status, /, /socket.io/
`)
    .action(async (action: string, options: { root?: string; force?: boolean; token?: string; url?: string; instanceId?: string; start?: boolean }) => {
      try {
        if (action === "setup") {
          await runTunnelSetup(options);
          return;
        }
        if (action === "verify") {
          await runTunnelVerify(options.root);
          return;
        }
        await toggleTunnel(action, options.root, options.force);
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
