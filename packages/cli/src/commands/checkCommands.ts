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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import {
  resolveGithubAuthMode,
  resolveGithubEventIntakeMode,
  validateIntakeModePrerequisites,
  validateRelayUrl,
} from "@propr/shared";
import { createConfigManager } from "../config/index.js";
import { createApiClient, getSystemStatus } from "../api/index.js";
import { getHostConfig, loadOrchestrator } from "../orchestrator/index.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import { upsertEnvVars } from "../utils/envFile.js";
import { printOutput } from "../utils/index.js";
import { validateAgents, validateAgentFilter, validAgentTypes, agentRowsToChecks, getAgentTankUsage, type AgentCell, type AgentValidationRow, type AgentTankUsage } from "./agentValidation.js";

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckGroup = "CLI" | "Docker" | "Stack" | "Images" | "Agents" | "GitHub" | "Configuration";

export interface CheckResult {
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
    { type: "antigravity", hostDirKey: "hostAntigravityDir", envKey: "HOST_ANTIGRAVITY_DIR", defaultDir: join(home, ".gemini"), imageKey: "agent-antigravity", bin: "agy" },
    { type: "opencode", hostDirKey: "hostOpencodeXdgDir", envKey: "HOST_OPENCODE_XDG_DIR", defaultDir: join(home, ".config", "opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "opencode-data", hostDirKey: "hostOpencodeDataDir", envKey: "HOST_OPENCODE_DATA_DIR", defaultDir: join(home, ".local", "share", "opencode"), imageKey: "agent-opencode", bin: "opencode" },
    { type: "vibe", hostDirKey: "hostVibeDir", envKey: "HOST_VIBE_DIR", defaultDir: join(home, ".vibe"), imageKey: "agent-vibe", bin: "vibe" },
  ];
}

export const STACK_CONFIG_CHECK_NAME = "Stack config (.env)";
const STATUS_GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };
export const CHECK_GROUPS: CheckGroup[] = ["CLI", "Docker", "Stack", "Images", "Agents", "GitHub", "Configuration"];

// Display titles for section headers — more descriptive than the internal
// single-word CheckGroup keys (which stay stable for filtering/data).
export const GROUP_TITLES: Record<CheckGroup, string> = {
  CLI: "ProPR CLI",
  Docker: "Docker Engine",
  Stack: "Stack Configuration",
  Images: "Container Images",
  Agents: "Agent Credentials",
  GitHub: "GitHub Authentication",
  Configuration: "Environment Configuration",
};

// One-line, new-user-friendly explanation of what each section verifies.
export const GROUP_DESCRIPTIONS: Record<CheckGroup, string> = {
  CLI: "Local CLI version",
  Docker: "Container engine that runs the stack and agents",
  Stack: "Local stack root and .env configuration",
  Images: "ProPR service and agent container images",
  Agents: "Host credential directories mounted into agent containers",
  GitHub: "Credentials the backend needs to access GitHub",
  Configuration: "Environment variable validation",
};
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
  /** Fired when a slow check begins, so a live UI can show a pending row. */
  onPending?: (slot: { name: string; group?: CheckGroup }) => void;
  /** Fired as each result is finalized, so a live UI can update incrementally. */
  onResult?: (result: CheckResult) => void;
}

export interface ChecksOutcome {
  results: CheckResult[];
  cfg: OrchestratorConfig;
  rootDir: string;
  anyFail: boolean;
}

interface JsonCheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

/** Read this CLI's version from package.json across TS source, workspace dist, and published dist layouts. */
function readCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "package.json"),
    join(here, "..", "..", "..", "package.json"),
    resolve(process.cwd(), "package.json"),
  ];
  try {
    for (const pkgPath of candidates) {
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      if ((pkg.name === "@propr/cli" || pkg.name === "propr-cli" || pkg.name === "propr") && pkg.version) {
        return pkg.version;
      }
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function runCliChecks(emit: (result: CheckResult) => void): void {
  emit({ name: "CLI version", status: "ok", detail: readCliVersion(), group: "CLI" });
}

/** Run all checks and return the structured outcome (no printing). */
export async function runChecks(options: RunChecksOptions = {}): Promise<ChecksOutcome> {
  const results: CheckResult[] = [];
  // Record a finalized result and notify any live presenter immediately.
  const emit = (result: CheckResult, opts: { record?: boolean } = {}): void => {
    if (opts.record !== false) results.push(result);
    options.onResult?.(result);
  };
  const configManager = await createConfigManager();
  const skipRemoteImageCheck = Boolean(options.skipRemoteImageCheck || envSkipsRemoteImageCheck());

  // 0. CLI version (local-only; `propr check` should not phone home by default).
  runCliChecks(emit);

  // 1. Docker installed
  const dockerVersion = spawnSync("docker", ["--version"], { encoding: "utf-8" });
  if (dockerVersion.status === 0) {
    emit({ name: "Docker installed", status: "ok", detail: dockerVersion.stdout.trim(), group: "Docker" });
  } else {
    emit({
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
  emit(
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
    emit(
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
    emit({ name: STACK_CONFIG_CHECK_NAME, status: "ok", detail: envPath, group: "Stack" });
  } else {
    emit({
      name: STACK_CONFIG_CHECK_NAME,
      status: "warn",
      detail: `no .env found at ${rootDir}`,
      group: "Stack",
      fix: "Run `propr init stack` to scaffold .env, data/, logs/ and repos/.",
      remediation: { kind: "init-stack", rootDir },
    });
  }

  // 5. Stack images present locally. The remote freshness probe is the slowest
  // check, so it runs for every image concurrently (off the event loop) instead
  // of serially — results are emitted live as each settles, then appended to the
  // outcome in manifest order so non-streaming consumers stay deterministic.
  if (daemonUp) {
    const missingImageResult = (key: string, tag: string): CheckResult => ({
      name: `Image ${key}`,
      status: "warn",
      detail: `${tag} not present locally`,
      group: "Images",
      fix: key.startsWith("agent-")
        ? "Jobs using this agent fail until the image is pulled. Run `propr images pull`, `propr start`, or build with scripts/build-images.sh."
        : "Run `propr images pull`, or let `propr start` pull it automatically.",
      remediation: { kind: "pull-image", imageKey: key, tag },
    });

    // ProPR only publishes images in its own registry namespace (propr/*).
    // Third-party images (e.g. redis:7-alpine) are pinned by tag and not part of
    // ProPR's update story, so their registry "freshness" is not actionable here
    // — and the remote digest probe for them is the main source of slow timeouts.
    const registry = typeof cfg.manifest?.registry === "string" ? cfg.manifest.registry : "propr";
    const isProprPublished = (tag: string): boolean => tag.startsWith(`${registry}/`);
    const freshnessByTag = new Map<string, Promise<ReturnType<OrchestratorModule["inspectImageFreshness"]>>>();

    const computeImageResult = async (key: string, tag: string): Promise<CheckResult> => {
      // Presence-only for third-party images and when remote checks are skipped.
      if (skipRemoteImageCheck || !isProprPublished(tag)) {
        if (!imagePresent(orch, tag)) return missingImageResult(key, tag);
        const detail = skipRemoteImageCheck ? `${tag} (local; remote check skipped)` : `${tag} (present)`;
        return { name: `Image ${key}`, status: "ok", detail, group: "Images" };
      }

      let freshnessPromise = freshnessByTag.get(tag);
      if (!freshnessPromise) {
        freshnessPromise = orch.inspectImageFreshnessAsync(tag);
        freshnessByTag.set(tag, freshnessPromise);
      }
      const freshness = await freshnessPromise;
      if (freshness.status === "missing") return missingImageResult(key, tag);
      if (freshness.status === "current") {
        return { name: `Image ${key}`, status: "ok", detail: `${tag} (current)`, group: "Images" };
      }
      if (freshness.status === "stale") {
        return {
          name: `Image ${key}`,
          status: "warn",
          detail: `${tag} is stale; remote digest ${freshness.remoteDigest}`,
          group: "Images",
          fix: "Pull the updated image: `propr images pull`.",
          remediation: { kind: "pull-image", imageKey: key, tag },
        };
      }
      if (freshness.localOnly) {
        return {
          name: `Image ${key}`,
          status: "warn",
          detail: `${tag} is local-only; registry freshness not verified`,
          group: "Images",
          fix: "Replace the unverifiable local tag with the registry image: `propr images pull`.",
          remediation: { kind: "pull-image", imageKey: key, tag },
        };
      }
      return {
        name: `Image ${key}`,
        status: "warn",
        detail: `${tag} is present, but freshness could not be verified: ${freshness.error}`,
        group: "Images",
        fix: "Check registry access or rerun with --skip-remote-image-check for offline environments.",
      };
    };

    const imageEntries = Object.entries(cfg.images).filter(([key]) => !(key === "docs" && !cfg.docsEnabled));
    for (const [key] of imageEntries) options.onPending?.({ name: `Image ${key}`, group: "Images" });

    const computed = new Map<string, CheckResult>();
    await Promise.all(
      imageEntries.map(async ([key, tag]) => {
        const result = await computeImageResult(key, tag);
        computed.set(key, result);
        emit(result, { record: false }); // live update in completion order
      })
    );
    // Append in manifest order so outcome.results is stable across runs.
    for (const [key] of imageEntries) {
      const result = computed.get(key);
      if (result) results.push(result);
    }
  }

  // 6. Agent credential dirs
  for (const agent of agentDescriptors()) {
    const configured = cfg[agent.hostDirKey] as string | undefined;
    const dir = configured || agent.defaultDir;
    if (configured && existsSync(dir)) {
      emit({ name: `Agent creds: ${agent.type}`, status: "ok", detail: dir, group: "Agents" });
    } else if (!configured && existsSync(agent.defaultDir)) {
      emit({
        name: `Agent creds: ${agent.type}`,
        status: "warn",
        detail: `${agent.defaultDir} detected but ${agent.envKey} is not set in .env`,
        group: "Agents",
        fix: `Add ${agent.envKey}=${agent.defaultDir} to .env so containers can mount these credentials.`,
        remediation: { kind: "add-agent-credential", envKey: agent.envKey, path: agent.defaultDir, agentType: agent.type },
      });
    } else {
      emit({
        name: `Agent creds: ${agent.type}`,
        status: "warn",
        detail: `${dir} not found — ${agent.type} will not authenticate`,
        group: "Agents",
        fix: `Log in with the ${agent.type} CLI on this host, or set ${agent.envKey} in .env.`,
      });
    }
  }

  // 6b. Agent Tank (optional subscription-usage monitor). Presence only — the
  // actual usage refresh (slow PTY /usage calls) runs in `propr check agents`.
  if (spawnSync("which", ["agent-tank"], { encoding: "utf-8" }).status === 0) {
    const ver = spawnSync("agent-tank", ["--version"], { encoding: "utf-8", timeout: 10000 });
    const version = `${ver.stdout ?? ""}${ver.stderr ?? ""}`.match(/\d+\.\d+\.\d+/)?.[0];
    emit({ name: "Agent Tank", status: "ok", detail: version ? `agent-tank ${version} installed` : "installed", group: "Agents" });
  }

  // 7. GitHub credentials (the backend hard-exits without a valid auth mode)
  const fileEnv = existsSync(envPath) ? orch.readEnvFile(envPath) : {};
  for (const r of checkGithubAuth(fileEnv, cfg)) emit(r);

  // 7b. Mode-specific GitHub intake prerequisites (the resolved intake mode
  // needs the right credentials before the daemon/API can serve it).
  for (const r of checkGithubIntakeMode(fileEnv)) emit(r);

  // 7c. Routing intake diagnostics: routing URL plus live WebSocket state, last
  // delivery id, and last ACK (when the backend is reachable) for the default
  // routing_websocket path.
  for (const r of await checkRoutingDiagnostics(fileEnv)) emit(r);

  // 8. User whitelist — warn when no whitelist is configured for non-demo stacks
  const whitelistRaw = process.env.GITHUB_USER_WHITELIST ?? fileEnv.GITHUB_USER_WHITELIST;
  const whitelistEntries = (whitelistRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const authMode = (process.env.GH_AUTH_MODE ?? fileEnv.GH_AUTH_MODE ?? "").trim().toLowerCase();
  const isDemo = isTruthy(process.env.PROPR_DEMO_MODE ?? fileEnv.PROPR_DEMO_MODE) || authMode === "demo";
  if (whitelistEntries.length === 0 && !isDemo) {
    emit({
      name: "User whitelist",
      status: "warn",
      detail: "GITHUB_USER_WHITELIST is not set — any GitHub user who can authenticate to this instance may trigger processing and use the API (within the App's repository access)",
      group: "GitHub",
      fix: "Set GITHUB_USER_WHITELIST to a comma-separated list of allowed GitHub usernames in .env.",
    });
  } else if (whitelistEntries.length > 0) {
    emit({ name: "User whitelist", status: "ok", detail: `${whitelistEntries.length} user(s) allowed`, group: "GitHub" });
  }

  // 9. Config validation from the orchestrator (bind paths, vibe dirs, etc.)
  const validation = orch.validateEnv(cfg);
  for (const warn of validation.warnings) {
    emit({ name: "Config warning", status: "warn", detail: warn, group: "Configuration" });
  }
  for (const err of validation.errors) {
    // env file / data dir absence is already surfaced by steps 4–6 above; skip duplicates.
    if (/env file path is not set/i.test(err)) continue;
    if (/data directory.*is not set/i.test(err)) continue;
    emit({ name: "Config error", status: "fail", detail: err, group: "Configuration" });
  }

  // 10. Deep verify (opt-in): image/CLI smoke test per selected agent
  if (options.verify && daemonUp) {
    const selected = options.agents && options.agents.length
      ? agentDescriptors().filter((a) => options.agents!.includes(a.type))
      : agentDescriptors();
    for (const agent of selected) {
      const tag = cfg.images[agent.imageKey];
      if (!tag || !imagePresent(orch, tag)) {
        emit({
          name: `Verify: ${agent.type}`,
          status: "warn",
          detail: `image ${tag ?? agent.imageKey} not present — skipped`,
          group: "Agents",
        });
        continue;
      }
      const run = spawnSync("docker", ["run", "--rm", "--network=none", "--memory=512m", tag, agent.bin, "--version"], { encoding: "utf-8", timeout: 60000 });
      if (run.status === 0) {
        emit({ name: `Verify: ${agent.type}`, status: "ok", detail: `image runs (${(run.stdout || "").trim().split("\n")[0]})`, group: "Agents" });
      } else {
        emit({
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

/**
 * Validate the prerequisites for the resolved GitHub event intake mode.
 * Reuses the shared validateIntakeModePrerequisites helper so `propr check`
 * and the backend boot path agree on what each mode requires.
 */
function checkGithubIntakeMode(env: Record<string, string>): CheckResult[] {
  const val = (k: string): string | undefined => process.env[k] ?? env[k];
  const out: CheckResult[] = [];

  // `propr check` is a diagnostic command: a bad value for one variable must
  // surface as a structured failure, never abort the whole run. Both resolvers
  // are therefore guarded — resolveGithubAuthMode is side-effect free today, but
  // guarding it keeps the check resilient if its contract ever changes.
  let authMode;
  try {
    ({ mode: authMode } = resolveGithubAuthMode({
      demoMode: isTruthy(val("PROPR_DEMO_MODE")),
      ghAuthMode: val("GH_AUTH_MODE"),
      relayUrl: val(RELAY_URL_KEY),
      relayToken: val(RELAY_TOKEN_KEY),
      appId: val("GH_APP_ID"),
      privateKeyPath: val("GH_PRIVATE_KEY_PATH"),
      installationId: val("GH_INSTALLATION_ID"),
    }));
  } catch (error) {
    out.push({
      name: "GitHub intake mode",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      group: "GitHub",
      fix: 'Set GH_AUTH_MODE to "app", "relay", or "demo" (or leave it unset to auto-detect).',
    });
    return out;
  }

  let intakeMode;
  try {
    ({ mode: intakeMode } = resolveGithubEventIntakeMode({
      eventIntakeMode: val("GITHUB_EVENT_INTAKE_MODE"),
      enableGithubWebhooks: val("ENABLE_GITHUB_WEBHOOKS"),
    }));
  } catch (error) {
    out.push({
      name: "GitHub intake mode",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      group: "GitHub",
      fix: 'Set GITHUB_EVENT_INTAKE_MODE to "routing_websocket", "polling", or "direct_webhook".',
    });
    return out;
  }

  const { valid, errors, warnings } = validateIntakeModePrerequisites({
    intakeMode,
    authMode,
    routingUrl: val("PROPR_ROUTING_URL"),
    relayUrl: val(RELAY_URL_KEY),
    relayToken: val(RELAY_TOKEN_KEY),
    webhookSecret: val("GH_WEBHOOK_SECRET"),
  });

  for (const warning of warnings) {
    out.push({ name: "GitHub intake mode", status: "warn", detail: warning, group: "GitHub" });
  }
  for (const error of errors) {
    out.push({ name: "GitHub intake mode", status: "fail", detail: error, group: "GitHub" });
  }
  if (valid) {
    out.push({ name: "GitHub intake mode", status: "ok", detail: intakeMode, group: "GitHub" });
  }

  return out;
}

/**
 * Surface the routing intake configuration and, when the backend is reachable,
 * its live connection state. routing_websocket is the default intake mode, so
 * `propr check` reports the routing URL plus the daemon's WebSocket connectivity,
 * last delivery id, and last ACK to make a default deployment diagnosable.
 *
 * The live state is best-effort: it comes from GET /api/status (published there
 * by the daemon), so a host check run before the stack is up simply omits it
 * rather than failing.
 */
async function checkRoutingDiagnostics(env: Record<string, string>): Promise<CheckResult[]> {
  const val = (k: string): string | undefined => process.env[k] ?? env[k];
  const out: CheckResult[] = [];

  let intakeMode;
  try {
    ({ mode: intakeMode } = resolveGithubEventIntakeMode({
      eventIntakeMode: val("GITHUB_EVENT_INTAKE_MODE"),
      enableGithubWebhooks: val("ENABLE_GITHUB_WEBHOOKS"),
    }));
  } catch {
    // An invalid mode is already reported by checkGithubIntakeMode; nothing to add.
    return out;
  }

  // Routing diagnostics only apply to the routing_websocket intake path.
  if (intakeMode !== "routing_websocket") return out;

  // Config-level routing URL (offline-safe). A missing/invalid URL is already
  // reported as a failure by the mode prerequisites check, so only show it here
  // when it is present to avoid duplicating that failure.
  const routingUrl = val("PROPR_ROUTING_URL");
  if (routingUrl && routingUrl.trim() !== "") {
    out.push({ name: "Routing URL", status: "ok", detail: routingUrl, group: "GitHub" });
  }

  // Live routing state from the running backend (best-effort, short timeout).
  // A stopped local backend rejects immediately (ECONNREFUSED); the timeout only
  // bounds the wait when the configured API URL is reachable but slow, so keep it
  // tight to avoid a noticeable stall during offline/pre-start checks.
  try {
    const client = await createApiClient({ defaultTimeout: 1000 });
    const status = await getSystemStatus(client);
    const routing = status.routing;
    if (routing) {
      out.push(
        routing.connected
          ? { name: "Routing WebSocket", status: "ok", detail: "connected to relay", group: "GitHub" }
          : {
              name: "Routing WebSocket",
              status: "warn",
              detail: "disconnected — daemon is not connected to the routing relay",
              group: "GitHub",
              fix: "Check the daemon logs and that PROPR_ROUTING_URL / PROPR_GH_RELAY_TOKEN are valid.",
            }
      );
      out.push({
        name: "Last delivery ID",
        status: "ok",
        detail: routing.lastDeliveryId ?? "no deliveries received yet",
        group: "GitHub",
      });
      out.push({
        name: "Last ACK",
        status: "ok",
        detail: formatRoutingTimestamp(routing.lastAckAt),
        group: "GitHub",
      });
    }
  } catch {
    // Backend not reachable (stack down or not logged in): live routing state is
    // unavailable. This is expected during a pre-start host check, so stay quiet
    // rather than emitting a noisy failure.
  }

  return out;
}

// `lastAckAt` comes from a live Redis value the daemon publishes; a stale or
// malformed entry must not surface as "Invalid Date" in operator output. Parse it
// and fall back to the raw string when it is not a usable timestamp.
function formatRoutingTimestamp(value: string | null): string {
  if (!value) return "no ACK sent yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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

export function countStatuses(results: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

function envSkipsRemoteImageCheck(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROPR_SKIP_REMOTE_IMAGE_CHECK === "true" || env.PROPR_SKIP_REMOTE_IMAGE_CHECK === "1";
}

function jsonResult(result: CheckResult): JsonCheckResult {
  // JSON intentionally stays data-only/stable: UI grouping and remediation
  // metadata are for human renderers and interactive prompts.
  const out: JsonCheckResult = {
    name: result.name,
    status: result.status,
    detail: result.detail,
  };
  if (result.fix) out.fix = result.fix;
  return out;
}

export function plural(count: number, singular: string): string {
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

function warnBillableValidationJson(): void {
  console.error("Warning: agent validation makes real, billable LLM calls even with --json. Restrict with --agents when needed.");
}

function printAgentValidationHint(): void {
  console.log("");
  console.log("To validate agents with live, billable LLM calls, run `propr check agents` or `propr check all`.");
}

/** Static, non-interactive renderer (pipes, CI, NO_COLOR). */
function printStaticChecks(outcome: ChecksOutcome, showRemediationHint: boolean): void {
  printChecks(outcome);
  if (showRemediationHint) {
    console.log("");
    console.log("Run `propr check --fix` to review interactive remediation options.");
  }
}

/**
 * Interactive TTY flow: render a live check pass, and (with --fix) loop —
 * applying the selected remediation outside the Ink tree, then re-rendering a
 * fresh pass — until the user quits or no actions remain. Falls back to the
 * static renderer + readline prompts if the terminal can't drive the live UI.
 */
async function runChecksInteractive(
  runOptions: RunChecksOptions,
  fix: boolean,
  showAgentValidationHint: boolean
): Promise<{ outcome: ChecksOutcome | undefined }> {
  try {
    const { renderLiveChecks } = await import("../tui/app.js");
    let lastOutcome: ChecksOutcome | undefined;
    while (true) {
      const { outcome, selectedKey } = await renderLiveChecks(runOptions, {
        fix,
        showAgentValidationHint,
        getActions: collectRemediationActions,
      });
      lastOutcome = outcome ?? lastOutcome;
      if (!fix || !selectedKey || !outcome) return { outcome: lastOutcome };

      const action = collectRemediationActions(outcome).find((a) => a.key === selectedKey);
      if (!action) return { outcome: lastOutcome };

      console.log("");
      const result = await action.run();
      if (!result.ok) {
        console.log("Remediation did not fully complete. Continuing with the current check results.");
      }
      if (!result.changed) return { outcome: lastOutcome };
      // Loop: re-run a fresh live pass to reflect changes and offer more fixes.
    }
  } catch (error) {
    if (!isLiveRendererFallbackError(error)) throw error;
    // The terminal can't support the live UI (e.g. raw mode unavailable): fall
    // back to the static renderer and readline-based prompts (no Ink to clobber).
    const outcome = await runChecks(runOptions);
    if (fix) {
      printChecks(outcome);
      return { outcome: await runRemediationPrompts(outcome, runOptions) };
    }
    printStaticChecks(outcome, collectRemediationActions(outcome).length > 0);
    if (showAgentValidationHint) printAgentValidationHint();
    return { outcome };
  }
}

function isLiveRendererFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /raw mode|setRawMode|stdin.*tty|not a tty|ink/i.test(message);
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
      run: async () => pullMissingImages(imageRemediations),
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

async function pullMissingImages(remediations: Extract<CheckRemediation, { kind: "pull-image" }>[]): Promise<RemediationResult> {
  let changed = false;
  let ok = true;
  const orch = await loadOrchestrator();
  for (const remediation of remediations) {
    console.log(`Pulling ${remediation.tag}...`);
    const pulled = orch.docker(["pull", remediation.tag], { capture: true });
    if (pulled.status === 0) {
      changed = true;
      try {
        orch.tagAgentLatest(remediation.imageKey, remediation.tag);
        console.log(`  ok: ${remediation.tag}`);
      } catch (error) {
        ok = false;
        console.error(`  failed: ${remediation.tag}: ${(error as Error).message}`);
      }
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
    const countSuffix = groupCounts.fail > 0 || groupCounts.warn > 0 ? ` (${plural(groupCounts.fail, "failure")}, ${plural(groupCounts.warn, "warning")})` : "";
    console.log(color(`${GROUP_TITLES[group]}${countSuffix}`, colorEnabled, ANSI.cyan, ANSI.bold));
    console.log(color(`  ${GROUP_DESCRIPTIONS[group]}`, colorEnabled, ANSI.dim));

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

/** Status badge for an agent cell: plain text + optional ANSI color code. */
function agentBadge(cell: AgentCell | undefined): { text: string; code?: string } {
  if (!cell) return { text: "n/a" };
  if (cell.status === "ok") return { text: "✓ ok", code: ANSI.green };
  if (cell.status === "fail") return { text: "✗ fail", code: ANSI.red };
  return { text: "— skip", code: ANSI.yellow };
}

const DASH = "—";
const driftText = (r: AgentValidationRow): string => r.drift ?? (r.hostVersion && r.imageVersion ? "same" : "");

/** Static (non-TTY) agent table — the live equivalent is AgentTableApp. */
function printAgentTable(rows: AgentValidationRow[], colorEnabled: boolean): void {
  const pad = (s: string, w: number): string => s.padEnd(w);
  const colored = (text: string, w: number, code?: string): string => (code ? color(pad(text, w), colorEnabled, code) : pad(text, w));
  const w = {
    agent: Math.max("Agent".length, ...rows.map((r) => r.type.length)),
    host: Math.max("Host ver".length, ...rows.map((r) => (r.hostVersion ?? DASH).length)),
    image: Math.max("Image ver".length, ...rows.map((r) => (r.imageVersion ?? DASH).length)),
    drift: Math.max("Drift".length, ...rows.map((r) => driftText(r).length)),
    hstat: Math.max("Host".length, ...rows.map((r) => agentBadge(r.host).text.length)),
  };
  console.log("");
  console.log(`  ${color([pad("Agent", w.agent), pad("Host ver", w.host), pad("Image ver", w.image), pad("Drift", w.drift), pad("Host", w.hstat), "Image"].join("  "), colorEnabled, ANSI.bold)}`);
  for (const r of rows) {
    const hb = agentBadge(r.host);
    const ib = agentBadge(r.image);
    const drift = driftText(r);
    const driftCode = drift === "older" ? ANSI.yellow : drift && drift !== "same" ? ANSI.dim : undefined;
    console.log(
      `  ${pad(r.type, w.agent)}  ${pad(r.hostVersion ?? DASH, w.host)}  ${pad(r.imageVersion ?? DASH, w.image)}  ${colored(drift, w.drift, driftCode)}  ${colored(hb.text, w.hstat, hb.code)}  ${colored(ib.text, ib.text.length, ib.code)}`
    );
  }
}

/** Raw host/image responses (and errors) per agent, for debugging. */
function printAgentResponses(rows: AgentValidationRow[], colorEnabled: boolean): void {
  const agentW = Math.max("Agent".length, ...rows.map((r) => r.type.length));
  const pad = (s: string, len: number): string => s.padEnd(len);
  console.log("");
  console.log(`  ${color("Responses", colorEnabled, ANSI.bold)}`);
  for (const r of rows) {
    const entries: Array<[string, AgentCell]> = [];
    if (r.host) entries.push(["host", r.host]);
    entries.push(["image", r.image]);
    entries.forEach(([level, cell], i) => {
      console.log(`  ${pad(i === 0 ? r.type : "", agentW)}  ${pad(level, 5)}  ${cell.detail}`);
      if (cell.fix) console.log(`  ${pad("", agentW)}  ${pad("", 5)}  ${color("↳", colorEnabled, ANSI.dim)} ${cell.fix}`);
    });
  }
}

/** Render Agent Tank subscription usage (or an install hint when absent). */
function printAgentTankUsage(usage: AgentTankUsage, colorEnabled: boolean): void {
  console.log("");
  console.log(color("Subscription Usage (Agent Tank)", colorEnabled, ANSI.cyan, ANSI.bold));
  if (!usage.installed) {
    console.log(color("  Not installed — track Claude/Codex/Antigravity plan usage per task with:", colorEnabled, ANSI.dim));
    console.log("  npm install -g agent-tank");
    return;
  }
  console.log(color(`  agent-tank ${usage.version ?? ""}`.trimEnd(), colorEnabled, ANSI.dim));
  if (usage.error) {
    console.log(`  ${color("!", colorEnabled, ANSI.yellow)} could not read usage: ${usage.error}`);
    return;
  }
  const agents = Object.keys(usage.usage ?? {});
  if (agents.length === 0) {
    console.log(color("  No agents reported.", colorEnabled, ANSI.dim));
    return;
  }
  const nameWidth = Math.max(5, ...agents.map((a) => a.length));
  for (const name of agents) {
    const entry = usage.usage![name];
    if (entry?.error) {
      console.log(`  ${name.padEnd(nameWidth)}  ${color(entry.error, colorEnabled, ANSI.yellow)}`);
      continue;
    }
    const metrics = Object.values(entry?.usage ?? {});
    if (metrics.length === 0) {
      console.log(`  ${name.padEnd(nameWidth)}  (no data)`);
      continue;
    }
    metrics.forEach((m, i) => {
      const label = m.label ?? "usage";
      const pct = m.percent ?? m.percentUsed;
      const resets = m.resetsIn ? ` (resets ${m.resetsIn})` : "";
      console.log(`  ${(i === 0 ? name : "").padEnd(nameWidth)}  ${label}: ${pct ?? "?"}%${resets}`);
    });
  }
}

/**
 * Run agent validation and print results. Uses a live, streaming table on an
 * interactive terminal; a static table otherwise. Raw responses follow. Returns
 * true if any agent failed. Loads its own orchestrator/config so it can run
 * after the main check.
 */
async function runAndPrintValidation(runOptions: RunChecksOptions): Promise<boolean> {
  const colorEnabled = shouldUseColor();
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root: runOptions.root });

  console.log("");
  console.log(color("Agent Validation", colorEnabled, ANSI.cyan, ANSI.bold));
  console.log(color("  Live test calls for configured agents (host CLI + image) to confirm auth works", colorEnabled, ANSI.dim));
  console.log("");

  // Read Agent Tank subscription usage concurrently with the validation (it is
  // slow and independent), then render it after the responses.
  const tankUsagePromise = getAgentTankUsage();

  let rows: AgentValidationRow[];
  const runStaticValidation = async (): Promise<AgentValidationRow[]> => {
    rows = await validateAgents(orch, cfg, {
      agents: runOptions.agents,
      onProgress: (message) => console.log(color(`  … ${message}`, colorEnabled, ANSI.dim)),
    });
    if (rows.length > 0) printAgentTable(rows, colorEnabled);
    return rows;
  };
  if (isInteractiveTerminal() && process.env.NO_COLOR === undefined) {
    try {
      const { renderAgentValidation } = await import("../tui/app.js");
      rows = await renderAgentValidation(orch, cfg, runOptions.agents);
    } catch (error) {
      if (!isLiveRendererFallbackError(error)) throw error;
      rows = await runStaticValidation();
    }
  } else {
    rows = await runStaticValidation();
  }
  if (rows.length === 0) return false;

  printAgentResponses(rows, colorEnabled);
  printAgentTankUsage(await tankUsagePromise, colorEnabled);
  return rows.some((r) => r.host?.status === "fail" || r.image.status === "fail");
}

/** Creates the `check` command. */
export function createCheckCommand(): Command {
  return new Command("check")
    .description("Verify the host is ready to run a local ProPR stack")
    .argument("[mode]", "what to check: system (default) | agents | all", "system")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--verify", "Also run an image/CLI smoke test for each agent (slower)")
    .option("--agents <list>", "Comma-separated agent types to validate (default: configured stack agents)")
    .option("--skip-remote-image-check", "Skip registry image freshness checks (also set by PROPR_SKIP_REMOTE_IMAGE_CHECK=1)")
    .option("--json", "Output raw JSON")
    .option("--fix", "Offer interactive remediation prompts for actionable issues")
    .option("--validate-agents", "Append live agent validation to a system check (makes billable LLM calls; same as `check all`)")
    .addHelpText("after", `
Modes:
  system   Docker, images, stack, agent credentials, GitHub, config (default)
  agents   Live test calls for configured agents (host CLI + image); makes billable LLM calls
  all      Everything: system checks followed by billable agent validation

Examples:
  $ propr check                 # system checks
  $ propr check agents          # only validate agents (billable LLM calls)
  $ propr check all             # system checks + billable agent validation
  $ propr check --fix
  $ propr check agents --agents claude,codex
  $ propr check --json

Notes:
  "check all", "check agents", and --validate-agents run a real prompt through
  configured agents' host CLIs and Docker images (mounts credentials, makes
  billable LLM calls). This is also true with --json. Override with --agents.
  Use --skip-remote-image-check or PROPR_SKIP_REMOTE_IMAGE_CHECK=1 for offline image checks.
`)
    .action(async (mode: string, options: { root?: string; verify?: boolean; agents?: string; skipRemoteImageCheck?: boolean; json?: boolean; fix?: boolean; validateAgents?: boolean }) => {
      try {
        const MODES = ["system", "agents", "all"];
        if (!MODES.includes(mode)) {
          console.error(`Error: unknown check mode '${mode}'. Use one of: ${MODES.join(", ")}.`);
          process.exit(1);
        }
        if (options.json && options.fix) {
          console.error("Error: --json cannot be combined with --fix; JSON output is data-only and never prompts.");
          process.exit(1);
        }
        const runOptions: RunChecksOptions = {
          root: options.root,
          verify: options.verify,
          agents: options.agents ? options.agents.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          skipRemoteImageCheck: options.skipRemoteImageCheck,
        };
        const { agents: agentFilter, unknown } = validateAgentFilter(runOptions.agents);
        if (unknown.length > 0) {
          console.error(`Error: unknown agent type${unknown.length === 1 ? "" : "s"} '${unknown.join(", ")}'. Valid agents: ${validAgentTypes().join(", ")}.`);
          process.exit(1);
        }
        runOptions.agents = agentFilter.length ? agentFilter : undefined;

        // `check agents`: only agent validation, no system checks.
        if (mode === "agents") {
          if (options.fix && !options.json) {
            console.error("Note: --fix has no remediation flow for `propr check agents`; running validation only.");
          }
          if (options.json) {
            warnBillableValidationJson();
            const { cfg, rootDir, orch } = await getHostConfig({ configManager: await createConfigManager(), root: runOptions.root });
            const rows = await validateAgents(orch, cfg, { agents: runOptions.agents });
            const results = agentRowsToChecks(rows);
            printOutput({ rootDir, results: results.map(jsonResult) }, true);
            if (results.some((r) => r.status === "fail")) process.exit(1);
            return;
          }
          if (await runAndPrintValidation(runOptions)) process.exit(1);
          return;
        }

        if (options.fix && !isInteractiveTerminal()) {
          console.error("Error: --fix requires an interactive terminal.");
          process.exit(1);
        }

        // `check` / `check system` / `check all`. Agents run when mode=all or --validate-agents.
        const runAgents = mode === "all" || Boolean(options.validateAgents);

        // JSON: data-only; agent results merged in when requested.
        if (options.json) {
          const outcome = await runChecks(runOptions);
          let results = outcome.results;
          if (runAgents) {
            warnBillableValidationJson();
            const { orch, cfg } = await getHostConfig({ configManager: await createConfigManager(), root: runOptions.root });
            const rows = await validateAgents(orch, cfg, { agents: runOptions.agents });
            results = [...results, ...agentRowsToChecks(rows)];
          }
          printOutput({ rootDir: outcome.rootDir, results: results.map(jsonResult) }, true);
          if (results.some((r) => r.status === "fail")) process.exit(1);
          return;
        }

        // Non-interactive (pipes, CI, NO_COLOR): static one-shot report.
        // With --fix on a TTY, NO_COLOR only disables Ink/color; readline prompts still run.
        if (!isInteractiveTerminal() || process.env.NO_COLOR !== undefined) {
          const outcome = await runChecks(runOptions);
          if (options.fix) {
            printChecks(outcome);
            const remediated = await runRemediationPrompts(outcome, runOptions);
            let anyFail = remediated.anyFail;
            if (runAgents) anyFail = (await runAndPrintValidation(runOptions)) || anyFail;
            if (anyFail) process.exit(1);
            return;
          }
          printStaticChecks(outcome, !options.fix && collectRemediationActions(outcome).length > 0);
          let anyFail = outcome.anyFail;
          if (runAgents) anyFail = (await runAndPrintValidation(runOptions)) || anyFail;
          else printAgentValidationHint();
          if (anyFail) process.exit(1);
          return;
        }

        // Interactive TTY: live, streaming view (+ in-app remediation with --fix,
        // plus a hint showing how to opt into billable agent validation).
        const { outcome } = await runChecksInteractive(runOptions, Boolean(options.fix), !options.fix && !runAgents);
        let anyFail = outcome?.anyFail ?? false;
        if (runAgents) {
          anyFail = (await runAndPrintValidation(runOptions)) || anyFail;
        }
        if (anyFail) process.exit(1);
      } catch (error) {
        console.error(`Error running checks: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
