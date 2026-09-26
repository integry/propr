import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { DEFAULT_PROPR_GH_RELAY_URL } from "@propr/shared";
import {
  applyEnvSelection,
  clearEnvKeys,
  classifyBackendAccessError,
  detectGithubAuthMode,
  inspectDatastoreAdministrators,
  inspectStackInit,
  readEnvVars,
  type PullImagesResult,
  type SetupActions,
} from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import type { RelayClientOptions } from "../../api/relay.js";
import { localhostServiceUrl } from "../../utils/dockerPort.js";
import { createDefaultAgentSetupActions } from "./agentHostActions.js";
import type { AuthenticationCommandHandoff, CapturedCommandRunner } from "../../auth/githubLogin.js";

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
});

function assertSafeAgentCredentialDir(path: string, name = "Agent credential path"): void {
  if (!isAbsolute(path) || normalize(path) === "/" || path.includes(":") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error(`${name} must be an absolute, non-root Linux path without ':' or control characters`);
  }
}

export function createDefaultActions(configManager?: ConfigManager, options: {
  authenticationHandoff?: AuthenticationCommandHandoff;
  capturedCommand?: CapturedCommandRunner;
} = {}): SetupActions {
  /** A client pointed at the local stack's API port (not the saved remote URL). */
  const localApiClient = async (rootDir: string): Promise<import("../../api/client.js").ApiClient> => {
    const { getHostConfig } = await import("../../orchestrator/index.js");
    const { cfg } = await getHostConfig({ configManager, root: rootDir });
    const { createApiClient, createApiClientWithConfig } = await import("../../api/client.js");
    const options = { baseUrl: localhostServiceUrl(cfg.apiPort) };
    // Keep the local client on setup's active profile and, importantly, the
    // token that an in-progress setup login just stored. Creating an unrelated
    // manager here can otherwise lose profile context and call protected local
    // endpoints without the token setup has already obtained.
    return configManager
      ? createApiClientWithConfig(configManager, options)
      : createApiClient(options);
  };

  const startConfiguredStack = async ({ rootDir, ui, docs, onLog, signal }: {
    rootDir: string;
    ui?: boolean;
    docs?: boolean;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<void> => {
    signal?.throwIfAborted();
    const { getHostConfig } = await import("../../orchestrator/index.js");
    const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
    // Pre-create the host Vibe prompt-cache dir owned by this user so Docker
    // does not auto-create it as root on first bind-mount — a root-owned dir
    // would fail the writability check and block future `propr start` runs.
    try {
      const { ensureVibePromptCacheDir } = await import("../initStack.js");
      ensureVibePromptCacheDir(cfg.hostVibePromptCacheDir);
    } catch {
      /* best-effort: startup validation will surface an actionable error */
    }
    const validation = orch.validateEnv(cfg);
    for (const warning of validation.warnings) onLog?.(`warning: ${warning}`);
    if (!validation.ok) {
      throw new Error(`stack environment is not ready:\n  - ${validation.errors.join("\n  - ")}`);
    }
    await orch.ensureNetworkAsync(cfg, onLog, signal);
    await orch.startStackAsync(cfg, {
      ui: ui ?? configManager?.getUiEnabled() ?? true,
      docs: docs ?? cfg.docsEnabled,
      onLog,
      signal,
    });
    signal?.throwIfAborted();
  };

  return {
    // Agent enablement + image-login actions, bound to the local stack.
    ...createDefaultAgentSetupActions(configManager, { authenticationHandoff: options.authenticationHandoff }),
    async runChecks(options) {
      const { runChecks } = await import("../checkCommands.js");
      return runChecks(options);
    },
    inspectStackInit,
    inspectDatastoreAdministrators,
    async scaffoldStack(options) {
      const { scaffoldStack } = await import("../initStack.js");
      return scaffoldStack(options);
    },
    async persistStackRoot(rootDir) {
      // Mirror scaffoldStack's `configManager.setStackRoot` so the reuse path
      // records the root too. Best-effort: without a config there is nowhere to
      // persist it (tests run this way), so it is simply a no-op.
      await configManager?.setStackRoot(rootDir);
    },
    readEnvVars,
    applyEnvSelection,
    clearEnvKeys,
    detectGithubAuthMode,
    prepareAgentCredentialDir(path) {
      assertSafeAgentCredentialDir(path);
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    async pullImages({ rootDir, agentTypes, onLog, signal }) {
      signal?.throwIfAborted();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const selected = new Set(agentTypes);
      const result: PullImagesResult = { pulledCore: [], pulledAgents: [], failedCore: [], failedAgents: [] };
      const desktopRuntime = cfg.manifest.desktopRuntime as Record<string, unknown> | undefined;
      const sourceBuiltImageKeys = desktopRuntime?.schemaVersion === 1
        && desktopRuntime.distribution === "local"
        ? new Set(["app", "ui"])
        : new Set<string>();

      for (const [key, tag] of Object.entries(cfg.images)) {
        signal?.throwIfAborted();
        if (key === "docs" && !cfg.docsEnabled) continue;
        const isAgent = key === "agent";
        // Pull the shared agent image when the user selected any agent; core images
        // (api/worker/daemon/redis/…) always pull.
        if (isAgent && selected.size === 0) continue;

        // A source validation manifest deliberately names images built into the
        // local Docker daemon.  They are never claimed to be published and must
        // not be sent to Docker Hub; inspect the exact tag instead.  A missing
        // image remains a fatal core-image failure and setup stops safely.
        if (sourceBuiltImageKeys.has(key)) {
          onLog?.(`checking source-built image ${tag}…`);
          const inspected = await orch.dockerAsync(["image", "inspect", tag], { signal });
          signal?.throwIfAborted();
          if (inspected.status === 0) result.pulledCore.push(tag);
          else result.failedCore.push(tag);
          continue;
        }

        onLog?.(`pulling ${tag}…`);
        // Async exec keeps the event loop free so the wizard's Ink spinner keeps
        // animating while the (often slow) pull runs, instead of freezing.
        const pulled = await orch.dockerAsync(["pull", tag], { signal });
        signal?.throwIfAborted();
        if (pulled.status === 0) {
          try {
            orch.tagAgentLatest(key, tag);
          } catch {
            /* best-effort local retag; the pull itself succeeded */
          }
          (isAgent ? result.pulledAgents : result.pulledCore).push(tag);
        } else {
          (isAgent ? result.failedAgents : result.failedCore).push(tag);
        }
      }
      return result;
    },
    async isStackRunning(rootDir, signal) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      return orch.isStackRunningAsync(cfg, signal);
    },
    async startStack({ rootDir, ui, docs, onLog, signal }) {
      // Use the async start path: `propr setup` drives this from behind a live
      // Ink TUI, so the blocking synchronous startStack would freeze the spinner
      // and swallow keystrokes for the seconds-to-minutes a cold start takes.
      await startConfiguredStack({ rootDir, ui, docs, onLog, signal });
    },
    async replaceRunningStack({ rootDir, ui, docs, onLog, signal }) {
      signal?.throwIfAborted();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      await orch.replaceStackContainersAsync(cfg, { onLog, signal });
      signal?.throwIfAborted();
      await startConfiguredStack({ rootDir, ui, docs, onLog, signal });
    },
    async checkBackendHealth({ rootDir, timeoutMs = 60_000, signal }) {
      signal?.throwIfAborted();
      const { getSystemStatus } = await import("../../api/system.js");
      const client = await localApiClient(rootDir);
      const deadline = Date.now() + timeoutMs;
      let lastError = "no response";
      // Containers take a few seconds to report healthy; poll until the deadline.
      do {
        signal?.throwIfAborted();
        try {
          const status = await getSystemStatus(client);
          if (String(status.api).toLowerCase() === "healthy") {
            return { healthy: true, detail: `API healthy (daemon ${status.daemon}, worker ${status.worker})` };
          }
          lastError = `API reports "${status.api}"`;
        } catch (error) {
          // A 401/403 is not an unhealthy backend — the API answered but denied
          // this protected request. Return immediately so setup does not stall
          // on a running backend, while preserving whether remediation requires
          // authentication (401) or an authorization/configuration check (403).
          const accessFailure = classifyBackendAccessError(error);
          if (accessFailure) return accessFailure;
          lastError = (error as Error).message;
        }
        if (Date.now() >= deadline) break;
        await sleep(2_000, signal);
        signal?.throwIfAborted();
      } while (Date.now() < deadline);
      return { healthy: false, detail: `backend not healthy within ${Math.round(timeoutMs / 1000)}s (${lastError})` };
    },
    async addRepository({ fullName, alias, baseBranch }, rootDir) {
      const { addRepo } = await import("../../api/repos.js");
      // Point the client at this stack's API port rather than the saved remote.
      const client = await localApiClient(rootDir);
      await addRepo(fullName, { alias, baseBranch }, client);
    },
    async resolveUiUrl(rootDir) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { cfg } = await getHostConfig({ configManager, root: rootDir });
      return localhostServiceUrl(cfg.uiPort);
    },
    async openUrl(url) {
      // Open in the host's default browser with the platform launcher. Detached
      // and unref'd so the wizard isn't held open by the child, with stdio
      // ignored so the launcher can't scribble over the TUI.
      const { spawn } = await import("node:child_process");
      const platform = process.platform;
      const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
      const args = platform === "win32" ? ["/c", "start", "", url] : [url];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.once("error", reject);
        // The launcher returns immediately; once it has spawned we're done.
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
    async saveWhitelistSetting(rootDir, users) {
      const { updateSetting } = await import("../../api/settings.js");
      // Point the client at this stack's API port rather than the saved remote.
      const client = await localApiClient(rootDir);
      await updateSetting("github_user_whitelist", users, client);
    },
    hasGithubToken() {
      return Boolean(configManager?.getGithubToken());
    },
    async fetchRelayInstallations({ relayUrl }) {
      const { fetchAuthenticatedUser } = await import("../../api/relay.js");
      const me = await fetchAuthenticatedUser(relayClient(relayUrl));
      return { username: me.username, installations: me.installations };
    },
    async enrollRelay({ relayUrl, installationId, label }) {
      const { enrollRelayToken } = await import("../../api/relay.js");
      const client = relayClient(relayUrl);
      // Default the token label to the hostname, mirroring `propr relay enroll`.
      const result = await enrollRelayToken(client, { installationId, label: label ?? hostname() });
      return { relayUrl: client.baseUrl, token: result.token };
    },
    async loginWithGithub({ onLog, signal, force } = {}) {
      if (!configManager) return false;
      const { loginWithGithubCli } = await import("../../auth/githubLogin.js");
      const result = await loginWithGithubCli(configManager, {
        interactive: true, onLog, signal, force,
        authenticationHandoff: options.authenticationHandoff,
        capturedCommand: options.capturedCommand,
      });
      if (!result.ok) onLog?.(result.message);
      return result.ok;
    },
    getTunnelEnabled(rootDir) {
      return configManager?.getTunnelEnabled(rootDir);
    },
  };

  /**
   * Build a relay client bound to the stored GitHub token. The hosted relay is
   * the default base URL; an explicit `relayUrl` (self-hosted) overrides it.
   */
  function relayClient(relayUrl?: string): RelayClientOptions {
    const githubToken = configManager?.getGithubToken();
    if (!githubToken) {
      throw new Error("Not logged in to GitHub. Run `propr login` first.");
    }
    return { baseUrl: relayUrl ?? DEFAULT_PROPR_GH_RELAY_URL, githubToken };
  }
}

/**
 * Run the setup flow end to end, in a safe order, driven by the supplied
 * prompts and reflected through the reporter. Returns the final step state and
 * the environment-check outcome. Never throws for expected conditions (a failed
 * required step stops the flow and is reported in the returned state); only
 * truly unexpected programmer errors propagate.
 */
