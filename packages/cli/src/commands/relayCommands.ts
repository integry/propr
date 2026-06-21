/**
 * `propr relay` — manage GitHub token relay enrollment (shared-app auth path).
 *
 * enroll  → calls the relay to mint a durable relay token (proving identity with
 *           the GitHub token from `propr login`) and writes PROPR_GH_RELAY_URL /
 *           PROPR_GH_RELAY_TOKEN into the stack .env so the daemon can use it.
 * list    → lists relay tokens for the installation.
 * revoke  → revokes a relay token by id.
 */

import { Command } from "commander";
import { hostname } from "node:os";
import { join } from "node:path";
import { validateRelayUrl, DEFAULT_PROPR_GH_RELAY_URL } from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { loadOrchestrator, resolveStackRoot } from "../orchestrator/index.js";
import { upsertEnvVars } from "../utils/envFile.js";
import {
  enrollRelayToken,
  listRelayTokens,
  revokeRelayToken,
  RelayClientOptions,
} from "../api/relay.js";

interface RelayContext {
  rootDir: string;
  envPath: string;
  relayBaseUrl: string;
  installationId: string;
  client: RelayClientOptions;
}

async function resolveContext(options: {
  root?: string;
  url?: string;
  installation?: string;
}): Promise<RelayContext> {
  const configManager = await createConfigManager();
  const rootDir = resolveStackRoot(configManager, options.root);
  const envPath = join(rootDir, ".env");

  const orch = await loadOrchestrator();
  const fileEnv = orch.readEnvFile(envPath);

  // Falls back to the hosted relay (webhook.propr.dev) so `propr relay enroll`
  // works out of the box; an explicit --url or PROPR_GH_RELAY_URL overrides it
  // for self-hosted relays.
  const relayBaseUrl =
    options.url ??
    process.env.PROPR_GH_RELAY_URL ??
    fileEnv.PROPR_GH_RELAY_URL ??
    DEFAULT_PROPR_GH_RELAY_URL;
  const urlError = validateRelayUrl(relayBaseUrl);
  if (urlError) {
    throw new Error(urlError);
  }

  const installationId =
    options.installation ?? process.env.GH_INSTALLATION_ID ?? fileEnv.GH_INSTALLATION_ID;
  if (!installationId) {
    throw new Error("No installation id. Pass --installation <id> or set GH_INSTALLATION_ID in .env.");
  }

  const githubToken = configManager.getGithubToken();
  if (!githubToken) {
    throw new Error("Not logged in to GitHub. Run `propr login` first.");
  }

  return {
    rootDir,
    envPath,
    relayBaseUrl,
    installationId,
    client: { baseUrl: relayBaseUrl, githubToken },
  };
}

export function createRelayCommand(): Command {
  const relay = new Command("relay")
    .description("Manage GitHub token relay enrollment (shared-app auth path)")
    .addHelpText("after", `
The relay lets a shared-app stack obtain GitHub installation tokens without
holding the App's private key. Enroll once; the token is saved to your .env.

The relay URL defaults to the hosted service (${DEFAULT_PROPR_GH_RELAY_URL});
pass --url only when running a self-hosted relay.

Examples:
  $ propr relay enroll
  $ propr relay enroll --url https://relay.example.com/v1
  $ propr relay list
  $ propr relay revoke <token-id>
`);

  relay
    .command("enroll")
    .description("Mint a relay token and save it to the stack .env")
    .option("--root <dir>", "Stack root directory")
    .option("--url <url>", "Relay base URL incl. version prefix (e.g. https://relay/v1)")
    .option("--installation <id>", "GitHub App installation id")
    .option("--label <label>", "Label for the relay token (default: hostname)")
    .action(async (options: { root?: string; url?: string; installation?: string; label?: string }) => {
      try {
        const ctx = await resolveContext(options);
        const label = options.label ?? hostname();
        const result = await enrollRelayToken(ctx.client, {
          installationId: ctx.installationId,
          label,
        });

        // GH_AUTH_MODE=relay is implied by URL+token, but writing it makes the
        // .env self-describing and keeps relay mode selected even if GitHub App
        // credentials are also present.
        upsertEnvVars(ctx.envPath, {
          GH_AUTH_MODE: "relay",
          PROPR_GH_RELAY_URL: ctx.relayBaseUrl,
          PROPR_GH_RELAY_TOKEN: result.token,
          GH_INSTALLATION_ID: ctx.installationId,
        });

        console.log("Relay enrollment complete.");
        console.log(`  token id:     ${result.token_id}`);
        console.log(`  token prefix: ${result.token_prefix}…`);
        console.log(`  label:        ${result.label ?? label}`);
        console.log(`  saved to:     ${ctx.envPath} (GH_AUTH_MODE, PROPR_GH_RELAY_URL, PROPR_GH_RELAY_TOKEN)`);
        console.log("");
        console.log("Next steps:");
        console.log("  propr check     # confirm relay mode is ready");
        console.log("  propr start     # launch the stack (no private key needed)");
      } catch (error) {
        console.error(`Error enrolling with relay: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  relay
    .command("list")
    .description("List relay tokens for the installation")
    .option("--root <dir>", "Stack root directory")
    .option("--url <url>", "Relay base URL")
    .option("--installation <id>", "GitHub App installation id")
    .option("--json", "Output raw JSON")
    .action(async (options: { root?: string; url?: string; installation?: string; json?: boolean }) => {
      try {
        const ctx = await resolveContext(options);
        const result = await listRelayTokens(ctx.client, ctx.installationId);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.tokens.length === 0) {
          console.log("No relay tokens for this installation.");
          return;
        }
        console.log("");
        console.log(`${"TOKEN ID".padEnd(38)} ${"PREFIX".padEnd(14)} ${"STATE".padEnd(8)} LABEL`);
        for (const t of result.tokens) {
          const state = t.revoked ? "revoked" : "active";
          console.log(`${t.token_id.padEnd(38)} ${`${t.token_prefix}…`.padEnd(14)} ${state.padEnd(8)} ${t.label ?? ""}`);
        }
        console.log("");
      } catch (error) {
        console.error(`Error listing relay tokens: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  relay
    .command("revoke <token-id>")
    .description("Revoke a relay token by id")
    .option("--root <dir>", "Stack root directory")
    .option("--url <url>", "Relay base URL")
    .option("--installation <id>", "GitHub App installation id")
    .action(async (tokenId: string, options: { root?: string; url?: string; installation?: string }) => {
      try {
        const ctx = await resolveContext(options);
        await revokeRelayToken(ctx.client, { installationId: ctx.installationId, tokenId });
        console.log(`Revoked relay token ${tokenId}.`);
      } catch (error) {
        console.error(`Error revoking relay token: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return relay;
}
