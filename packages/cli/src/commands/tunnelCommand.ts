import { Command } from "commander";
import { join } from "node:path";
import { PROPR_UI_PROXY_SUFFIX } from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { getHostConfig, resolveStackRoot } from "../orchestrator/index.js";
import type { ConfigManager } from "../config/index.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import { upsertEnvVars } from "../utils/envFile.js";

function normalizeTunnelUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Tunnel URL must be a valid https://<instance>.proxy.propr.dev URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Tunnel URL must use https.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Tunnel URL must be an origin only, without a path, query, or hash.");
  }
  if (!url.hostname.endsWith(PROPR_UI_PROXY_SUFFIX)) {
    throw new Error(`Tunnel URL must end with ${PROPR_UI_PROXY_SUFFIX}.`);
  }

  const instanceId = url.hostname.slice(0, -PROPR_UI_PROXY_SUFFIX.length);
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/i.test(instanceId)) {
    throw new Error("Tunnel URL contains an invalid instance id.");
  }

  return url;
}

function assertTunnelToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Tunnel token is required.");
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error("Tunnel token cannot contain newlines.");
  }
  return trimmed;
}

export async function startOrRestartTunnelStack(
  orch: OrchestratorModule,
  cfg: OrchestratorConfig,
  configManager: Pick<ConfigManager, "getUiEnabled">,
  onLog: (line: string) => void = console.log,
): Promise<void> {
  const running = await orch.isStackRunningAsync(cfg);
  if (running) {
    onLog("Stack is already running; recreating services with hosted UI tunnel settings...");
    const stopped = orch.stopStack(cfg, {
      remove: true,
      onLog,
    });
    if (stopped.failed.length > 0) {
      throw new Error(
        `Failed to stop existing stack services: ${stopped.failed.join(", ")}`
      );
    }
  }

  await orch.ensureNetworkAsync(cfg, onLog);
  await orch.startStackAsync(cfg, {
    ui: configManager.getUiEnabled(),
    docs: cfg.docsEnabled,
    onLog,
  });
}

export function createTunnelCommand(): Command {
  const tunnel = new Command("tunnel")
    .description("Configure the hosted ProPR UI tunnel")
    .addHelpText("after", `
Connect provisions the tunnel token and URL. Paste the setup command shown in
Connect to save those values to the local stack .env.

Examples:
  $ propr tunnel setup --token <token> --url https://abc123.proxy.propr.dev
  $ propr tunnel setup --token <token> --url https://abc123.proxy.propr.dev --start
`);

  tunnel
    .command("setup")
    .description("Save a Connect-provisioned hosted UI tunnel token")
    .requiredOption("--token <token>", "Cloudflare tunnel connector token from Connect")
    .requiredOption("--url <url>", "Hosted tunnel URL, e.g. https://abc123.proxy.propr.dev")
    .option("--root <dir>", "Stack root directory")
    .option("--start", "Start or restart the stack after saving the tunnel settings")
    .action(async (options: { token: string; url: string; root?: string; start?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const rootDir = resolveStackRoot(configManager, options.root);
        const envPath = join(rootDir, ".env");
        const token = assertTunnelToken(options.token);
        const tunnelUrl = normalizeTunnelUrl(options.url);
        const instanceId = tunnelUrl.hostname.slice(0, -PROPR_UI_PROXY_SUFFIX.length);

        upsertEnvVars(envPath, {
          PROPR_UI_TUNNEL_TOKEN: token,
          PROPR_UI_TUNNEL_ENABLED: "true",
          PROPR_INSTANCE_ID: instanceId,
          PROPR_UI_PUBLIC_API_URL: tunnelUrl.origin,
        });
        await configManager.setTunnelEnabled(true);

        console.log("Hosted UI tunnel configured.");
        console.log(`  tunnel URL: ${tunnelUrl.origin}`);
        console.log(`  instance:   ${instanceId}`);
        console.log(`  saved to:   ${envPath}`);
        console.log("");
        console.log("Fallback .env values:");
        console.log(`  PROPR_UI_TUNNEL_TOKEN=${token}`);
        console.log("  PROPR_UI_TUNNEL_ENABLED=true");
        console.log(`  PROPR_INSTANCE_ID=${instanceId}`);
        console.log(`  PROPR_UI_PUBLIC_API_URL=${tunnelUrl.origin}`);

        if (options.start) {
          console.log("");
          console.log("Starting stack with hosted UI tunnel enabled...");
          const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
          await startOrRestartTunnelStack(orch, cfg, configManager);
          console.log("Stack started.");
        } else {
          console.log("");
          console.log("Next: run `propr start` to launch the tunnel sidecar.");
        }
      } catch (error) {
        console.error(`Error configuring tunnel: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return tunnel;
}
