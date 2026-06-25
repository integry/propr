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

async function toggleTunnel(stateArg: string, root?: string): Promise<void> {
  const enable = parseOnOffState(stateArg);
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
    process.exit(1);
  }

  if (enable) {
    if (!cfg.uiTunnelToken) {
      console.error(
        "Error: cannot start the tunnel — no token configured.\n" +
          "  Set PROPR_UI_TUNNEL_TOKEN in your stack .env (and optionally\n" +
          "  PROPR_UI_PUBLIC_API_URL), then run 'propr tunnel on' again."
      );
      process.exit(1);
    }
    // The tunnel only routes to the core API (api:4000). Starting it while the
    // core stack is down leaves a healthy-looking cloudflared sidecar pointing at
    // an unavailable backend, so warn the operator (don't fail — they may be
    // about to `propr start`).
    if (!orch.isStackRunning(cfg)) {
      console.warn(
        "Warning: the core stack does not appear to be running, so the tunnel\n" +
          "  will point at an unavailable API. Run 'propr start' to bring the\n" +
          "  core services up."
      );
    }
    console.log("Starting tunnel…");
    orch.ensureNetwork(cfg, (l: string) => console.log(l));
    orch.startService(cfg, "tunnel", { onLog: (l) => console.log(l) });
    if (cfg.uiPublicApiUrl) {
      console.log(`tunnel is up — public API at ${cfg.uiPublicApiUrl}`);
    } else {
      console.log("tunnel is up.");
    }
  } else {
    console.log("Stopping tunnel…");
    orch.stopService(cfg, "tunnel", { remove: true, onLog: (l) => console.log(l) });
    console.log("tunnel stopped. Token and env values are unchanged.");
  }

  // Persist desired state after the action succeeds so it survives restarts.
  await configManager.setTunnelEnabled(enable);
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
