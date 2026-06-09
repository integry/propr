/**
 * Environment Check (doctor)
 *
 * `propr check` verifies the host is ready to run a local ProPR stack: Docker is
 * installed and running, the stack images are available, and agent credentials
 * are present. It is also what bare `propr` runs.
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, accessSync, readFileSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import { printOutput } from "../utils/index.js";

type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

interface AgentDescriptor {
  type: string;
  hostDirKey: keyof OrchestratorConfig;
  defaultDir: string;
  imageKey: string;
  bin: string;
}

function agentDescriptors(): AgentDescriptor[] {
  const home = homedir();
  return [
    { type: "claude", hostDirKey: "hostClaudeDir", defaultDir: join(home, ".claude"), imageKey: "agent-claude", bin: "claude" },
    { type: "codex", hostDirKey: "hostCodexDir", defaultDir: join(home, ".codex"), imageKey: "agent-codex", bin: "codex" },
    { type: "antigravity", hostDirKey: "hostAntigravityDir", defaultDir: join(home, ".gemini"), imageKey: "agent-antigravity", bin: "gemini" },
    { type: "opencode", hostDirKey: "hostOpencodeXdgDir", defaultDir: join(home, ".config", "opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "vibe", hostDirKey: "hostVibeDir", defaultDir: join(home, ".vibe"), imageKey: "agent-vibe", bin: "vibe" },
  ];
}

const STATUS_GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export interface RunChecksOptions {
  root?: string;
  verify?: boolean;
  agents?: string[];
}

export interface ChecksOutcome {
  results: CheckResult[];
  cfg: OrchestratorConfig;
  rootDir: string;
  anyFail: boolean;
}

/** Run all checks and return the structured outcome (no printing). */
export async function runChecks(options: RunChecksOptions = {}): Promise<ChecksOutcome> {
  const results: CheckResult[] = [];
  const configManager = await createConfigManager();

  // 1. Docker installed
  const dockerVersion = spawnSync("docker", ["--version"], { encoding: "utf-8" });
  if (dockerVersion.status === 0) {
    results.push({ name: "Docker installed", status: "ok", detail: dockerVersion.stdout.trim() });
  } else {
    results.push({
      name: "Docker installed",
      status: "fail",
      detail: "`docker` command not found",
      fix: "Install Docker: https://docs.docker.com/get-docker/",
    });
  }

  const { orch, cfg, rootDir } = await getHostConfig({ configManager, root: options.root });

  // 2. Docker daemon running
  const daemonUp = orch.dockerAvailable();
  results.push(
    daemonUp
      ? { name: "Docker daemon", status: "ok", detail: "daemon is reachable" }
      : {
          name: "Docker daemon",
          status: "fail",
          detail: "cannot reach the Docker daemon (`docker info` failed)",
          fix: "Start Docker (e.g. `sudo systemctl start docker`) and ensure your user can access it.",
        }
  );

  // 3. Docker socket (informational — only relevant for the default socket setup)
  const socketPath = "/var/run/docker.sock";
  if (existsSync(socketPath)) {
    let accessible = true;
    try {
      accessSync(socketPath, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      accessible = false;
    }
    results.push(
      accessible
        ? { name: "Docker socket", status: "ok", detail: socketPath }
        : {
            name: "Docker socket",
            status: "warn",
            detail: `${socketPath} is not read/write for the current user`,
            fix: "Add your user to the `docker` group, or run with sufficient privileges.",
          }
    );
  }

  // 4. Stack root + .env
  const envPath = join(rootDir, ".env");
  if (existsSync(envPath)) {
    results.push({ name: "Stack config (.env)", status: "ok", detail: envPath });
  } else {
    results.push({
      name: "Stack config (.env)",
      status: "warn",
      detail: `no .env found at ${rootDir}`,
      fix: "Run `propr init stack` to scaffold .env, data/, logs/ and repos/.",
    });
  }

  // 5. Stack images present locally
  if (daemonUp) {
    for (const [key, tag] of Object.entries(cfg.images)) {
      if (key === "docs" && !cfg.docsEnabled) continue;
      const present = imagePresent(orch, tag);
      if (present) {
        results.push({ name: `Image ${key}`, status: "ok", detail: tag });
      } else {
        const isAgent = key.startsWith("agent-");
        results.push({
          name: `Image ${key}`,
          status: "warn",
          detail: `${tag} not present locally`,
          fix: isAgent
            ? "Jobs using this agent fail until the image is pulled. `propr start` pulls it, or build with scripts/build-images.sh."
            : "Will be pulled automatically on `propr start`.",
        });
      }
    }
  }

  // 6. Agent credential dirs
  for (const agent of agentDescriptors()) {
    const configured = cfg[agent.hostDirKey] as string | undefined;
    const dir = configured || agent.defaultDir;
    if (existsSync(dir)) {
      results.push({ name: `Agent creds: ${agent.type}`, status: "ok", detail: dir });
    } else {
      results.push({
        name: `Agent creds: ${agent.type}`,
        status: "warn",
        detail: `${dir} not found — ${agent.type} will not authenticate`,
        fix: `Log in with the ${agent.type} CLI on this host, or set HOST_${agent.type.toUpperCase()}_DIR in .env.`,
      });
    }
  }

  // 7. GitHub credentials (the backend hard-exits without a valid auth mode)
  const envPath2 = join(rootDir, ".env");
  const fileEnv = existsSync(envPath2) ? orch.readEnvFile(envPath2) : {};
  for (const r of checkGithubAuth(fileEnv, cfg)) results.push(r);

  // 8. Vibe / bind-path validation from the orchestrator
  const validation = orch.validateEnv(cfg);
  for (const warn of validation.warnings) {
    results.push({ name: "Config warning", status: "warn", detail: warn });
  }
  for (const err of validation.errors) {
    // env file / data dir absence is already covered above; surface vibe-style errors only
    if (/vibe|VIBE/.test(err)) {
      results.push({ name: "Config error", status: "fail", detail: err });
    }
  }

  // 9. Deep verify (opt-in): image/CLI smoke test per selected agent
  if (options.verify && daemonUp) {
    const selected = options.agents && options.agents.length
      ? agentDescriptors().filter((a) => options.agents!.includes(a.type))
      : agentDescriptors();
    for (const agent of selected) {
      const tag = cfg.images[agent.imageKey];
      if (!tag || !imagePresent(orch, tag)) {
        results.push({
          name: `Verify: ${agent.type}`,
          status: "warn",
          detail: `image ${tag ?? agent.imageKey} not present — skipped`,
        });
        continue;
      }
      const run = spawnSync("docker", ["run", "--rm", tag, agent.bin, "--version"], { encoding: "utf-8", timeout: 60000 });
      if (run.status === 0) {
        results.push({ name: `Verify: ${agent.type}`, status: "ok", detail: `image runs (${(run.stdout || "").trim().split("\n")[0]})` });
      } else {
        results.push({
          name: `Verify: ${agent.type}`,
          status: "warn",
          detail: `image/CLI smoke test failed: ${(run.stderr || run.stdout || "").trim().split("\n")[0]}`,
        });
      }
    }
  }

  const anyFail = results.some((r) => r.status === "fail");
  return { results, cfg, rootDir, anyFail };
}

function imagePresent(orch: OrchestratorModule, tag: string): boolean {
  const res = orch.docker(["images", "-q", tag], { capture: true });
  return res.stdout.trim().length > 0;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

// Matches the unedited .env.example placeholders (your_app_id, path/to/..., etc.)
function isPlaceholder(value: string | undefined): boolean {
  if (!value || value.trim() === "") return true;
  return /your_|path\/to|changeme|xxxx|example\.com/i.test(value);
}

// Forward-compatible relay env names (see the token-relay plan). Presence of the
// relay URL selects relay mode.
const RELAY_URL_KEY = "PROPR_GH_RELAY_URL";
const RELAY_TOKEN_KEY = "PROPR_GH_RELAY_TOKEN";

// Mirrors the backend's relay URL validation (packages/core/src/auth/githubAuth.ts):
// https required except for localhost.
function validateRelayUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${RELAY_URL_KEY} ("${url}") is not a valid URL`;
  }
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalhost) {
    return `${RELAY_URL_KEY} must use https:// (http only allowed for localhost)`;
  }
  return null;
}

/**
 * Verify the GitHub credentials the backend needs to boot. The daemon/worker/api
 * import @propr/core's githubAuth, which hard-exits unless one of these is true:
 * demo mode, a (future) token relay, or a configured GitHub App + readable key.
 *
 * GH_AUTH_MODE takes precedence over inference, matching the backend's behavior.
 */
function checkGithubAuth(env: Record<string, string>, cfg: OrchestratorConfig): CheckResult[] {
  const val = (k: string): string | undefined => process.env[k] ?? env[k];
  const out: CheckResult[] = [];

  if (isTruthy(val("PROPR_DEMO_MODE"))) {
    out.push({ name: "GitHub auth", status: "ok", detail: "demo mode — GitHub access disabled" });
    return out;
  }

  // Honor explicit GH_AUTH_MODE to match the backend's resolveAuthMode().
  const explicitMode = (val("GH_AUTH_MODE") ?? "").trim().toLowerCase();
  if (explicitMode === "demo") {
    out.push({ name: "GitHub auth", status: "ok", detail: "demo mode (GH_AUTH_MODE=demo) — GitHub access disabled" });
    return out;
  }

  // Relay mode: explicit GH_AUTH_MODE=relay, or inferred when both URL+token are present.
  const relayUrl = val(RELAY_URL_KEY);
  const relayToken = val(RELAY_TOKEN_KEY);
  const useRelay = explicitMode === "relay" || (explicitMode !== "app" && relayUrl && relayToken);
  if (useRelay) {
    const urlError = relayUrl ? validateRelayUrl(relayUrl) : `${RELAY_URL_KEY} must be set for relay mode`;
    out.push(
      urlError
        ? { name: "GitHub auth mode", status: "fail", detail: urlError, fix: "Use an https:// relay URL (http only for localhost)." }
        : { name: "GitHub auth mode", status: "ok", detail: `token relay (${relayUrl})` }
    );
    if (!relayToken) {
      out.push({
        name: "Relay credential",
        status: "fail",
        detail: `${RELAY_TOKEN_KEY} is not set`,
        fix: `Set ${RELAY_TOKEN_KEY} to the relay credential issued for your installation.`,
      });
    } else {
      out.push({ name: "Relay credential", status: "ok", detail: `${RELAY_TOKEN_KEY} is set` });
    }
    return out;
  }

  // App mode (default).
  out.push({ name: "GitHub auth mode", status: "ok", detail: "GitHub App (own/shared app)" });

  const appId = val("GH_APP_ID");
  const installationId = val("GH_INSTALLATION_ID");
  out.push(
    isPlaceholder(appId)
      ? { name: "GH_APP_ID", status: "fail", detail: "missing or placeholder", fix: "Set GH_APP_ID from your GitHub App settings." }
      : { name: "GH_APP_ID", status: "ok", detail: appId! }
  );
  out.push(
    isPlaceholder(installationId)
      ? { name: "GH_INSTALLATION_ID", status: "fail", detail: "missing or placeholder", fix: "Set GH_INSTALLATION_ID for the App's installation on your account/org." }
      : { name: "GH_INSTALLATION_ID", status: "ok", detail: installationId! }
  );

  // Private key reachability. Prefer the explicit host mount (HOST_GH_PRIVATE_KEY).
  const hostKey = cfg.hostGhPrivateKey;
  const keyPath = val("GH_PRIVATE_KEY_PATH");
  if (hostKey) {
    if (!existsSync(hostKey)) {
      out.push({ name: "GitHub App key", status: "fail", detail: `HOST_GH_PRIVATE_KEY (${hostKey}) does not exist` });
    } else {
      let readable = true;
      try {
        accessSync(hostKey, fsConstants.R_OK);
      } catch {
        readable = false;
      }
      const looksLikePem = readable && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(safeRead(hostKey));
      out.push(
        readable && looksLikePem
          ? { name: "GitHub App key", status: "ok", detail: `${hostKey} (mounted read-only)` }
          : {
              name: "GitHub App key",
              status: "fail",
              detail: readable ? `${hostKey} does not look like a PEM private key` : `${hostKey} is not readable`,
            }
      );
    }
  } else if (isPlaceholder(keyPath)) {
    out.push({
      name: "GitHub App key",
      status: "fail",
      detail: "no private key configured",
      fix: "Set HOST_GH_PRIVATE_KEY to your .pem host path (recommended), or stage the key under data/ and set GH_PRIVATE_KEY_PATH.",
    });
  } else {
    out.push({
      name: "GitHub App key",
      status: "warn",
      detail: `GH_PRIVATE_KEY_PATH=${keyPath} — reachability inside the container not verified`,
      fix: "Prefer HOST_GH_PRIVATE_KEY (bind-mounts the key), or ensure this path resolves inside the container (e.g. under data/).",
    });
  }

  return out;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8").slice(0, 200);
  } catch {
    return "";
  }
}

/** Print a human-readable check table. */
export function printChecks(outcome: ChecksOutcome): void {
  console.log("");
  console.log(`ProPR environment check  (stack root: ${outcome.rootDir})`);
  console.log("─".repeat(60));
  for (const r of outcome.results) {
    const glyph = STATUS_GLYPH[r.status];
    console.log(`${glyph}  ${r.name.padEnd(24)} ${r.detail}`);
    if (r.fix && r.status !== "ok") {
      console.log(`   ↳ ${r.fix}`);
    }
  }
  console.log("─".repeat(60));
  const counts = outcome.results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {} as Record<CheckStatus, number>
  );
  console.log(`${counts.ok ?? 0} ok, ${counts.warn ?? 0} warning(s), ${counts.fail ?? 0} failure(s)`);
}

/** Creates the `check` command. */
export function createCheckCommand(): Command {
  return new Command("check")
    .description("Verify the host is ready to run a local ProPR stack (Docker, images, agents)")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--verify", "Also run an image/CLI smoke test for each agent (slower)")
    .option("--agents <list>", "Comma-separated agent types to --verify (default: all)")
    .option("--json", "Output raw JSON")
    .addHelpText("after", `
Examples:
  $ propr check
  $ propr check --verify
  $ propr check --verify --agents claude,codex
  $ propr check --json
`)
    .action(async (options: { root?: string; verify?: boolean; agents?: string; json?: boolean }) => {
      try {
        const outcome = await runChecks({
          root: options.root,
          verify: options.verify,
          agents: options.agents ? options.agents.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        });

        if (options.json) {
          printOutput({ rootDir: outcome.rootDir, results: outcome.results }, true);
        } else {
          printChecks(outcome);
        }

        if (outcome.anyFail) process.exit(1);
      } catch (error) {
        console.error(`Error running checks: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
