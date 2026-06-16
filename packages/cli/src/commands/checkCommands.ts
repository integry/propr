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
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { resolveGithubAuthMode, validateRelayUrl } from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { getHostConfig, loadOrchestrator } from "../orchestrator/index.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import { upsertEnvVars } from "../utils/envFile.js";
import { printOutput } from "../utils/index.js";

type CheckStatus = "ok" | "warn" | "fail";
type CheckGroup = "Docker" | "Stack" | "Images" | "Agents" | "GitHub" | "Configuration";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  group?: CheckGroup;
  fix?: string;
  remediation?: CheckRemediation;
}

type CheckRemediation =
  | { kind: "init-stack"; rootDir: string }
  | { kind: "pull-image"; imageKey: string; tag: string }
  | { kind: "add-agent-credential"; envKey: string; path: string; agentType: string }
  | { kind: "start-docker" };

interface RemediationAction {
  key: string;
  label: string;
  detail: string;
  confirm: string;
  run: () => Promise<RemediationResult>;
}

interface RemediationResult {
  changed: boolean;
  ok: boolean;
}

interface AgentDescriptor {
  type: string;
  hostDirKey: keyof OrchestratorConfig;
  envKey: string;
  defaultDir: string;
  imageKey: string;
  bin: string;
}

function agentDescriptors(): AgentDescriptor[] {
  const home = homedir();
  return [
    { type: "claude", hostDirKey: "hostClaudeDir", envKey: "HOST_CLAUDE_DIR", defaultDir: join(home, ".claude"), imageKey: "agent-claude", bin: "claude" },
    { type: "codex", hostDirKey: "hostCodexDir", envKey: "HOST_CODEX_DIR", defaultDir: join(home, ".codex"), imageKey: "agent-codex", bin: "codex" },
    { type: "antigravity", hostDirKey: "hostAntigravityDir", envKey: "HOST_ANTIGRAVITY_DIR", defaultDir: join(home, ".gemini"), imageKey: "agent-antigravity", bin: "gemini" },
    { type: "opencode", hostDirKey: "hostOpencodeXdgDir", envKey: "HOST_OPENCODE_XDG_DIR", defaultDir: join(home, ".config", "opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "opencode-legacy", hostDirKey: "hostOpencodeLegacyDir", envKey: "HOST_OPENCODE_LEGACY_DIR", defaultDir: join(home, ".opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "opencode-data", hostDirKey: "hostOpencodeDataDir", envKey: "HOST_OPENCODE_DATA_DIR", defaultDir: join(home, ".local", "share", "opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "vibe", hostDirKey: "hostVibeDir", envKey: "HOST_VIBE_DIR", defaultDir: join(home, ".vibe"), imageKey: "agent-vibe", bin: "vibe" },
  ];
}

export const STACK_CONFIG_CHECK_NAME = "Stack config (.env)";
const STATUS_GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };
const CHECK_GROUPS: CheckGroup[] = ["Docker", "Stack", "Images", "Agents", "GitHub", "Configuration"];
const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

export interface RunChecksOptions {
  root?: string;
  verify?: boolean;
  agents?: string[];
  skipRemoteImageCheck?: boolean;
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
    results.push({ name: "Docker installed", status: "ok", detail: dockerVersion.stdout.trim(), group: "Docker" });
  } else {
    results.push({
      name: "Docker installed",
      status: "fail",
      detail: "`docker` command not found",
      group: "Docker",
      fix: "Install Docker: https://docs.docker.com/get-docker/",
    });
  }

  const { orch, cfg, rootDir } = await getHostConfig({ configManager, root: options.root });

  // 2. Docker daemon running
  const daemonUp = orch.dockerAvailable();
  results.push(
    daemonUp
      ? { name: "Docker daemon", status: "ok", detail: "daemon is reachable", group: "Docker" }
      : {
          name: "Docker daemon",
          status: "fail",
          detail: "cannot reach the Docker daemon (`docker info` failed)",
          group: "Docker",
          fix: "Start Docker (e.g. `sudo systemctl start docker`) and ensure your user can access it.",
          remediation: { kind: "start-docker" },
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
        ? { name: "Docker socket", status: "ok", detail: socketPath, group: "Docker" }
        : {
            name: "Docker socket",
            status: "warn",
            detail: `${socketPath} is not read/write for the current user`,
            group: "Docker",
            fix: "Add your user to the `docker` group, or run with sufficient privileges.",
          }
    );
  }

  // 4. Stack root + .env
  const envPath = join(rootDir, ".env");
  if (existsSync(envPath)) {
    results.push({ name: STACK_CONFIG_CHECK_NAME, status: "ok", detail: envPath, group: "Stack" });
  } else {
    results.push({
      name: STACK_CONFIG_CHECK_NAME,
      status: "warn",
      detail: `no .env found at ${rootDir}`,
      group: "Stack",
      fix: "Run `propr init stack` to scaffold .env, data/, logs/ and repos/.",
      remediation: { kind: "init-stack", rootDir },
    });
  }

  // 5. Stack images present locally
  if (daemonUp) {
    for (const [key, tag] of Object.entries(cfg.images)) {
      if (key === "docs" && !cfg.docsEnabled) continue;
      const present = imagePresent(orch, tag);
      if (present) {
        if (options.skipRemoteImageCheck) {
          results.push({ name: `Image ${key}`, status: "ok", detail: `${tag} (local; remote check skipped)`, group: "Images" });
          continue;
        }

        const freshness = orch.inspectImageFreshness(tag);
        if (freshness.status === "current") {
          results.push({ name: `Image ${key}`, status: "ok", detail: `${tag} (current)`, group: "Images" });
        } else if (freshness.status === "stale") {
          results.push({
            name: `Image ${key}`,
            status: "warn",
            detail: `${tag} is stale; remote digest ${freshness.remoteDigest}`,
            group: "Images",
            fix: `Pull the updated image: docker pull ${tag}`,
            remediation: { kind: "pull-image", imageKey: key, tag },
          });
        } else if (freshness.status === "unknown") {
          results.push({
            name: `Image ${key}`,
            status: "warn",
            detail: `${tag} is present, but freshness could not be verified: ${freshness.error}`,
            group: "Images",
            fix: "Check registry access or rerun with --skip-remote-image-check for offline environments.",
          });
        } else {
          results.push({
            name: `Image ${key}`,
            status: "warn",
            detail: `${tag} not present locally`,
            group: "Images",
            fix: key.startsWith("agent-")
              ? "Jobs using this agent fail until the image is pulled. `propr start` pulls it, or build with scripts/build-images.sh."
              : "Will be pulled automatically on `propr start`.",
            remediation: { kind: "pull-image", imageKey: key, tag },
          });
        }
      } else {
        const isAgent = key.startsWith("agent-");
        results.push({
          name: `Image ${key}`,
          status: "warn",
          detail: `${tag} not present locally`,
          group: "Images",
          fix: isAgent
            ? "Jobs using this agent fail until the image is pulled. `propr start` pulls it, or build with scripts/build-images.sh."
            : "Will be pulled automatically on `propr start`.",
          remediation: { kind: "pull-image", imageKey: key, tag },
        });
      }
    }
  }

  // 6. Agent credential dirs
  for (const agent of agentDescriptors()) {
    const configured = cfg[agent.hostDirKey] as string | undefined;
    const dir = configured || agent.defaultDir;
    if (configured && existsSync(dir)) {
      results.push({ name: `Agent creds: ${agent.type}`, status: "ok", detail: dir, group: "Agents" });
    } else if (!configured && existsSync(agent.defaultDir)) {
      results.push({
        name: `Agent creds: ${agent.type}`,
        status: "warn",
        detail: `${agent.defaultDir} detected but ${agent.envKey} is not set in .env`,
        group: "Agents",
        fix: `Add ${agent.envKey}=${agent.defaultDir} to .env so containers can mount these credentials.`,
        remediation: { kind: "add-agent-credential", envKey: agent.envKey, path: agent.defaultDir, agentType: agent.type },
      });
    } else {
      results.push({
        name: `Agent creds: ${agent.type}`,
        status: "warn",
        detail: `${dir} not found — ${agent.type} will not authenticate`,
        group: "Agents",
        fix: `Log in with the ${agent.type} CLI on this host, or set ${agent.envKey} in .env.`,
      });
    }
  }

  // 7. GitHub credentials (the backend hard-exits without a valid auth mode)
  const fileEnv = existsSync(envPath) ? orch.readEnvFile(envPath) : {};
  for (const r of checkGithubAuth(fileEnv, cfg)) results.push(r);

  // 8. User whitelist — warn when no whitelist is configured for non-demo stacks
  const whitelistRaw = process.env.GITHUB_USER_WHITELIST ?? fileEnv.GITHUB_USER_WHITELIST;
  const whitelistEntries = (whitelistRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const authMode = (process.env.GH_AUTH_MODE ?? fileEnv.GH_AUTH_MODE ?? "").trim().toLowerCase();
  const isDemo = isTruthy(process.env.PROPR_DEMO_MODE ?? fileEnv.PROPR_DEMO_MODE) || authMode === "demo";
  if (whitelistEntries.length === 0 && !isDemo) {
    results.push({
      name: "User whitelist",
      status: "warn",
      detail: "GITHUB_USER_WHITELIST is not set — any GitHub user who can authenticate to this instance may trigger processing and use the API (within the App's repository access)",
      group: "GitHub",
      fix: "Set GITHUB_USER_WHITELIST to a comma-separated list of allowed GitHub usernames in .env.",
    });
  } else if (whitelistEntries.length > 0) {
    results.push({ name: "User whitelist", status: "ok", detail: `${whitelistEntries.length} user(s) allowed`, group: "GitHub" });
  }

  // 9. Config validation from the orchestrator (bind paths, vibe dirs, etc.)
  const validation = orch.validateEnv(cfg);
  for (const warn of validation.warnings) {
    results.push({ name: "Config warning", status: "warn", detail: warn, group: "Configuration" });
  }
  for (const err of validation.errors) {
    // env file / data dir absence is already surfaced by steps 4–6 above; skip duplicates.
    if (/env file path is not set/i.test(err)) continue;
    if (/data directory.*is not set/i.test(err)) continue;
    results.push({ name: "Config error", status: "fail", detail: err, group: "Configuration" });
  }

  // 10. Deep verify (opt-in): image/CLI smoke test per selected agent
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
          group: "Agents",
        });
        continue;
      }
      const run = spawnSync("docker", ["run", "--rm", "--network=none", "--memory=512m", tag, agent.bin, "--version"], { encoding: "utf-8", timeout: 60000 });
      if (run.status === 0) {
        results.push({ name: `Verify: ${agent.type}`, status: "ok", detail: `image runs (${(run.stdout || "").trim().split("\n")[0]})`, group: "Agents" });
      } else {
        results.push({
          name: `Verify: ${agent.type}`,
          status: "warn",
          detail: `image/CLI smoke test failed: ${(run.stderr || run.stdout || "").trim().split("\n")[0]}`,
          group: "Agents",
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

// Matches the unedited .env.example placeholders (your_app_id, path/to/..., etc.).
// Every alternative is anchored so a real value that merely contains a
// placeholder-looking substring is not misflagged.
function isPlaceholder(value: string | undefined): boolean {
  if (!value || value.trim() === "") return true;
  return /^your_|^\.?\/path\/to|^changeme$|^x{4,}$|^example\.com$/i.test(value.trim());
}

// Forward-compatible relay env names (see the token-relay plan). Presence of the
// relay URL selects relay mode.
const RELAY_URL_KEY = "PROPR_GH_RELAY_URL";
const RELAY_TOKEN_KEY = "PROPR_GH_RELAY_TOKEN";

/**
 * Verify the GitHub credentials the backend needs to boot. The daemon/worker/api
 * import @propr/core's githubAuth, which hard-exits unless one of these is true:
 * demo mode, a token relay, or a configured GitHub App + readable key.
 *
 * The mode itself comes from @propr/shared's resolveGithubAuthMode — the same
 * function the backend uses — so this check cannot drift from boot behavior.
 */
function checkGithubAuth(env: Record<string, string>, cfg: OrchestratorConfig): CheckResult[] {
  const val = (k: string): string | undefined => process.env[k] ?? env[k];
  const out: CheckResult[] = [];

  const relayUrl = val(RELAY_URL_KEY);
  const relayToken = val(RELAY_TOKEN_KEY);
  const { mode, warnings } = resolveGithubAuthMode({
    demoMode: isTruthy(val("PROPR_DEMO_MODE")),
    ghAuthMode: val("GH_AUTH_MODE"),
    relayUrl,
    relayToken,
    appId: val("GH_APP_ID"),
    privateKeyPath: val("GH_PRIVATE_KEY_PATH"),
    installationId: val("GH_INSTALLATION_ID"),
  });
  for (const warning of warnings) {
    out.push({ name: "GitHub auth", status: "warn", detail: warning, group: "GitHub" });
  }

  if (mode === "demo") {
    out.push({ name: "GitHub auth", status: "ok", detail: "demo mode — GitHub access disabled", group: "GitHub" });
    return out;
  }

  if (mode === "none") {
    out.push({
      name: "GitHub auth mode",
      status: "fail",
      detail: "no GitHub auth configured — the backend will exit at startup",
      group: "GitHub",
      fix: "Set GH_APP_ID + GH_INSTALLATION_ID + a private key (own App), or PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN (token relay), or PROPR_DEMO_MODE=true.",
    });
    return out;
  }

  if (mode === "relay") {
    const urlError = relayUrl ? validateRelayUrl(relayUrl) : `${RELAY_URL_KEY} must be set for relay mode`;
    out.push(
      urlError
        ? { name: "GitHub auth mode", status: "fail", detail: urlError, group: "GitHub", fix: "Use an https:// relay URL (http only for localhost)." }
        : { name: "GitHub auth mode", status: "ok", detail: `token relay (${relayUrl})`, group: "GitHub" }
    );
    if (!relayToken) {
      out.push({
        name: "Relay credential",
        status: "fail",
        detail: `${RELAY_TOKEN_KEY} is not set`,
        group: "GitHub",
        fix: `Set ${RELAY_TOKEN_KEY} to the relay credential issued for your installation.`,
      });
    } else {
      out.push({ name: "Relay credential", status: "ok", detail: `${RELAY_TOKEN_KEY} is set`, group: "GitHub" });
    }
    return out;
  }

  // App mode (default).
  out.push({ name: "GitHub auth mode", status: "ok", detail: "GitHub App (own/shared app)", group: "GitHub" });

  const appId = val("GH_APP_ID");
  const installationId = val("GH_INSTALLATION_ID");
  out.push(
    isPlaceholder(appId)
      ? { name: "GH_APP_ID", status: "fail", detail: "missing or placeholder", group: "GitHub", fix: "Set GH_APP_ID from your GitHub App settings." }
      : { name: "GH_APP_ID", status: "ok", detail: appId!, group: "GitHub" }
  );
  out.push(
    isPlaceholder(installationId)
      ? { name: "GH_INSTALLATION_ID", status: "fail", detail: "missing or placeholder", group: "GitHub", fix: "Set GH_INSTALLATION_ID for the App's installation on your account/org." }
      : { name: "GH_INSTALLATION_ID", status: "ok", detail: installationId!, group: "GitHub" }
  );

  // Private key reachability. Prefer the explicit host mount (HOST_GH_PRIVATE_KEY).
  const hostKey = cfg.hostGhPrivateKey;
  const keyPath = val("GH_PRIVATE_KEY_PATH");
  if (hostKey) {
    if (!existsSync(hostKey)) {
      out.push({ name: "GitHub App key", status: "fail", detail: `HOST_GH_PRIVATE_KEY (${hostKey}) does not exist`, group: "GitHub" });
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
          ? { name: "GitHub App key", status: "ok", detail: `${hostKey} (mounted read-only)`, group: "GitHub" }
          : {
              name: "GitHub App key",
              status: "fail",
              detail: readable ? `${hostKey} does not look like a PEM private key` : `${hostKey} is not readable`,
              group: "GitHub",
            }
      );
    }
  } else if (isPlaceholder(keyPath)) {
    out.push({
      name: "GitHub App key",
      status: "fail",
      detail: "no private key configured",
      group: "GitHub",
      fix: "Set HOST_GH_PRIVATE_KEY to your .pem host path (recommended), or stage the key under data/ and set GH_PRIVATE_KEY_PATH.",
    });
  } else {
    out.push({
      name: "GitHub App key",
      status: "warn",
      detail: `GH_PRIVATE_KEY_PATH=${keyPath} — reachability inside the container not verified`,
      group: "GitHub",
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

function shouldUseColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function color(text: string, enabled: boolean, ...codes: string[]): string {
  return enabled ? `${codes.join("")}${text}${ANSI.reset}` : text;
}

function statusColor(status: CheckStatus): string {
  if (status === "ok") return ANSI.green;
  if (status === "warn") return ANSI.yellow;
  return ANSI.red;
}

function formatStatus(status: CheckStatus, colorEnabled: boolean): string {
  const text = `${STATUS_GLYPH[status]} ${STATUS_LABEL[status].padEnd(4)}`;
  return color(text, colorEnabled, statusColor(status), ANSI.bold);
}

function countStatuses(results: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatSummary(counts: Record<CheckStatus, number>, colorEnabled: boolean): string {
  const failures = color(plural(counts.fail, "failure"), colorEnabled && counts.fail > 0, ANSI.red, ANSI.bold);
  const warnings = color(plural(counts.warn, "warning"), colorEnabled && counts.warn > 0, ANSI.yellow, ANSI.bold);
  const ok = color(`${counts.ok} ok`, colorEnabled, ANSI.green);
  return `Summary: ${failures}, ${warnings}, ${ok}`;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function collectRemediationActions(outcome: ChecksOutcome): RemediationAction[] {
  const actions: RemediationAction[] = [];
  const remediations = outcome.results
    .filter((result) => result.status !== "ok")
    .map((result) => result.remediation)
    .filter((remediation): remediation is CheckRemediation => Boolean(remediation));

  if (remediations.some((remediation) => remediation.kind === "init-stack")) {
    actions.push({
      key: "init-stack",
      label: "Show stack initialization guidance",
      detail: `Create the stack root and .env with: propr init stack --root ${outcome.rootDir}`,
      confirm: "Show stack initialization guidance?",
      run: async () => {
        console.log("");
        console.log("Stack root/.env is missing. Run:");
        console.log(`  propr init stack --root ${outcome.rootDir}`);
        console.log("Then review .env and run `propr check` again.");
        return { changed: false, ok: true };
      },
    });
  }

  if (remediations.some((remediation) => remediation.kind === "start-docker")) {
    actions.push({
      key: "start-docker",
      label: "Show Docker daemon guidance",
      detail: "Print commands and checks for starting Docker or fixing daemon access.",
      confirm: "Show Docker daemon guidance?",
      run: async () => {
        console.log("");
        console.log("Docker is installed but the daemon is not reachable.");
        console.log("Start Docker, then make sure this user can run `docker info` without failing.");
        console.log("Common Linux command:");
        console.log("  sudo systemctl start docker");
        console.log("If the socket exists but access fails, add your user to the docker group and start a new shell.");
        return { changed: false, ok: true };
      },
    });
  }

  const imageRemediations = remediations
    .filter((remediation): remediation is Extract<CheckRemediation, { kind: "pull-image" }> => remediation.kind === "pull-image")
    .filter((remediation, index, all) => all.findIndex((other) => other.tag === remediation.tag) === index);
  if (imageRemediations.length > 0) {
    actions.push({
      key: "pull-images",
      label: `Pull ${plural(imageRemediations.length, "Docker image")}`,
      detail: imageRemediations.map((remediation) => remediation.tag).join(", "),
      confirm: `Pull ${plural(imageRemediations.length, "Docker image")} now?`,
      run: async () => pullMissingImages(outcome, imageRemediations),
    });
  }

  const credentialRemediations = remediations
    .filter((remediation): remediation is Extract<CheckRemediation, { kind: "add-agent-credential" }> => remediation.kind === "add-agent-credential")
    .filter((remediation) => existsSync(remediation.path))
    .filter((remediation, index, all) => all.findIndex((other) => other.envKey === remediation.envKey) === index);
  if (credentialRemediations.length > 0 && existsSync(outcome.cfg.envFileLocal)) {
    actions.push({
      key: "add-agent-credentials",
      label: `Add ${plural(credentialRemediations.length, "detected agent credential directory")} to .env`,
      detail: credentialRemediations.map((remediation) => `${remediation.envKey}=${remediation.path}`).join(", "),
      confirm: `Write ${plural(credentialRemediations.length, "agent credential directory")} to ${outcome.cfg.envFileLocal}?`,
      run: async () => addAgentCredentials(outcome, credentialRemediations),
    });
  }

  return actions;
}

async function pullMissingImages(
  outcome: ChecksOutcome,
  remediations: Extract<CheckRemediation, { kind: "pull-image" }>[]
): Promise<RemediationResult> {
  let changed = false;
  let ok = true;
  const orch = await loadOrchestrator();
  for (const remediation of remediations) {
    console.log(`Pulling ${remediation.tag}...`);
    const pulled = orch.docker(["pull", remediation.tag], { capture: true });
    if (pulled.status === 0) {
      changed = true;
      console.log(`  ok: ${remediation.tag}`);
    } else {
      ok = false;
      const reason = (pulled.stderr || pulled.stdout || "docker pull failed").trim().split("\n")[0];
      console.error(`  failed: ${remediation.tag}: ${reason}`);
    }
  }
  return { changed, ok };
}

async function addAgentCredentials(
  outcome: ChecksOutcome,
  remediations: Extract<CheckRemediation, { kind: "add-agent-credential" }>[]
): Promise<RemediationResult> {
  const vars: Record<string, string> = {};
  for (const remediation of remediations) {
    if (existsSync(remediation.path)) {
      vars[remediation.envKey] = remediation.path;
    }
  }
  if (Object.keys(vars).length === 0) {
    console.log("No detected credential directories still exist on this host.");
    return { changed: false, ok: false };
  }
  upsertEnvVars(outcome.cfg.envFileLocal, vars);
  console.log(`Updated ${outcome.cfg.envFileLocal}:`);
  for (const [key, value] of Object.entries(vars)) {
    console.log(`  ${key}=${value}`);
  }
  return { changed: true, ok: true };
}

async function confirmAction(rl: ReadlineInterface, prompt: string): Promise<boolean> {
  const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function promptForAction(rl: ReadlineInterface, actions: RemediationAction[]): Promise<RemediationAction | undefined> {
  console.log("");
  console.log("Available remediations:");
  actions.forEach((action, index) => {
    console.log(`  ${index + 1}. ${action.label}`);
    console.log(`     ${action.detail}`);
  });
  console.log("  q. Quit");

  const answer = (await rl.question("Choose an action: ")).trim().toLowerCase();
  if (answer === "" || answer === "q" || answer === "quit") return undefined;
  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 1 || selected > actions.length) {
    console.log("Invalid selection.");
    return promptForAction(rl, actions);
  }
  return actions[selected - 1];
}

async function runRemediationPrompts(outcome: ChecksOutcome, options: RunChecksOptions): Promise<ChecksOutcome> {
  let current = outcome;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const actions = collectRemediationActions(current);
      if (actions.length === 0) {
        console.log("");
        console.log("No actionable remediations found.");
        return current;
      }

      const action = await promptForAction(rl, actions);
      if (!action) return current;

      if (!(await confirmAction(rl, action.confirm))) {
        console.log("Skipped.");
        continue;
      }

      const result = await action.run();
      if (!result.ok) {
        console.log("Remediation did not fully complete. Continuing with the current check results.");
      }
      if (result.changed) {
        current = await runChecks(options);
        printChecks(current);
      }
    }
  } finally {
    rl.close();
  }
}

/** Print human-readable checks grouped by subsystem. */
export function printChecks(outcome: ChecksOutcome): void {
  const colorEnabled = shouldUseColor();
  const counts = countStatuses(outcome.results);

  console.log("");
  console.log(`${color("ProPR environment check", colorEnabled, ANSI.bold)}  ${color(`(stack root: ${outcome.rootDir})`, colorEnabled, ANSI.dim)}`);
  console.log(formatSummary(counts, colorEnabled));
  console.log("─".repeat(60));

  let printedGroup = false;
  for (const group of CHECK_GROUPS) {
    const groupResults = outcome.results.filter((result) => result.group === group);
    if (groupResults.length === 0) continue;
    const groupCounts = countStatuses(groupResults);
    const nameWidth = Math.max(18, ...groupResults.map((result) => result.name.length));

    if (printedGroup) console.log("");
    printedGroup = true;
    console.log(color(`${group} (${plural(groupCounts.fail, "failure")}, ${plural(groupCounts.warn, "warning")})`, colorEnabled, ANSI.cyan, ANSI.bold));

    for (const r of groupResults) {
      console.log(`  ${formatStatus(r.status, colorEnabled)} ${r.name.padEnd(nameWidth)}  ${r.detail}`);
      if (r.fix && r.status !== "ok") {
        console.log(`         ${color("↳", colorEnabled, ANSI.dim)} ${r.fix}`);
      }
    }
  }

  const ungrouped = outcome.results.filter((result) => !result.group);
  if (ungrouped.length > 0) {
    const nameWidth = Math.max(18, ...ungrouped.map((result) => result.name.length));
    if (printedGroup) console.log("");
    console.log(color("Other", colorEnabled, ANSI.cyan, ANSI.bold));
    for (const r of ungrouped) {
      console.log(`  ${formatStatus(r.status, colorEnabled)} ${r.name.padEnd(nameWidth)}  ${r.detail}`);
      if (r.fix && r.status !== "ok") {
        console.log(`         ${color("↳", colorEnabled, ANSI.dim)} ${r.fix}`);
      }
    }
  }

  console.log("─".repeat(60));
  console.log(formatSummary(counts, colorEnabled));
}

/** Creates the `check` command. */
export function createCheckCommand(): Command {
  return new Command("check")
    .description("Verify the host is ready to run a local ProPR stack (Docker, images, agents)")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--verify", "Also run an image/CLI smoke test for each agent (slower)")
    .option("--agents <list>", "Comma-separated agent types to --verify (default: all)")
    .option("--skip-remote-image-check", "Skip registry freshness checks for local Docker images")
    .option("--json", "Output raw JSON")
    .option("--fix", "Offer interactive remediation prompts for actionable issues")
    .addHelpText("after", `
Examples:
  $ propr check
  $ propr check --fix
  $ propr check --verify
  $ propr check --verify --agents claude,codex
  $ propr check --json
`)
    .action(async (options: { root?: string; verify?: boolean; agents?: string; skipRemoteImageCheck?: boolean; json?: boolean; fix?: boolean }) => {
      try {
        if (options.json && options.fix) {
          console.error("Error: --json cannot be combined with --fix; JSON output is data-only and never prompts.");
          process.exit(1);
        }
        if (options.fix && !isInteractiveTerminal()) {
          console.error("Error: --fix requires an interactive terminal.");
          process.exit(1);
        }

        const runOptions: RunChecksOptions = {
          root: options.root,
          verify: options.verify,
          agents: options.agents ? options.agents.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          skipRemoteImageCheck: options.skipRemoteImageCheck,
        };
        let outcome = await runChecks(runOptions);

        if (options.json) {
          printOutput({ rootDir: outcome.rootDir, results: outcome.results }, true);
        } else {
          printChecks(outcome);
          if (options.fix) {
            outcome = await runRemediationPrompts(outcome, runOptions);
          } else if (isInteractiveTerminal() && collectRemediationActions(outcome).length > 0) {
            console.log("");
            console.log("Run `propr check --fix` to review interactive remediation options.");
          }
        }

        if (outcome.anyFail) process.exit(1);
      } catch (error) {
        console.error(`Error running checks: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
