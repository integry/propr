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
  try {
    if (enable) {
      // The tunnel only routes to the core API (api:4000). Starting it while the
      // core stack is down leaves a healthy-looking cloudflared sidecar pointing
      // at an unavailable backend, so warn the operator (don't fail — they may be
      // about to `propr start`).
      if (!orch.isStackRunning(cfg)) {
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
      orch.ensureNetwork(cfg, (l: string) => log(l));
      orch.startService(cfg, "tunnel", { onLog: (l) => log(l) });
      if (cfg.uiPublicApiUrl) {
        log(`tunnel is up — public API at ${cfg.uiPublicApiUrl}`);
      } else {
        log("tunnel is up.");
      }
    } else {
      log("Stopping tunnel…");
      orch.stopService(cfg, "tunnel", { remove: true, onLog: (l) => log(l) });
      log("tunnel stopped. Token and env values are unchanged.");
    }
  } catch (error) {
    // Revert to the exact prior value (including an unset "defer to env" state)
    // so a failed toggle doesn't leave a stale persisted override behind.
    await configManager.set("tunnelEnabled", previousEnabled);
    throw error;
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
    .description("Start or stop the Cloudflare Tunnel service")
    .argument("<state>", "on or off")
    .option("--root <dir>", "Stack root directory")
    .addHelpText("after", `
Starting the tunnel requires a configured token. Set these in your stack .env:
  PROPR_UI_TUNNEL_TOKEN    Cloudflare Tunnel token (required to start)
  PROPR_INSTANCE_ID        Instance id; derives the public URL
                           https://<id>.proxy.propr.dev when no explicit one is set
  PROPR_UI_PUBLIC_API_URL  Explicit public API URL advertised through the tunnel
                           (optional; overrides the id-derived URL)

Examples:
  $ propr tunnel on
  $ propr tunnel off
`)
    .action(async (state: string, options: { root?: string }) => {
      try {
        await toggleTunnel(state, options.root);
      } catch (error) {
        if (error instanceof ParseStateError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error toggling tunnel: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
