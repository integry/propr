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
  rethrowCancellation,
} from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import type { RelayClientOptions } from "../../api/relay.js";
import { localhostServiceUrl } from "../../utils/dockerPort.js";
import { createDefaultAgentSetupActions } from "./agentHostActions.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function assertSafeAgentCredentialDir(path: string, name = "Agent credential path"): void {
  if (!isAbsolute(path) || normalize(path) === "/" || path.includes(":") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error(`${name} must be an absolute, non-root Linux path without ':' or control characters`);
  }
}

function assertStableDockerHandoff(
  rootDir: string,
): void {
  if (!isAbsolute(rootDir) || /(?:^|\/)(?:proc\/[0-9]+\/fd|dev\/fd)(?:\/|$)/.test(rootDir)) {
    throw new Error("Desktop Docker lifecycle requires the stable app-owned runtime root");
  }
}

export function createDefaultActions(configManager?: ConfigManager): SetupActions {
  /** A client pointed at the local stack's API port (not the saved remote URL). */
  const localApiClient = async (rootDir: string, rootOperationsDir?: string, assertRootAuthority?: () => void): Promise<import("../../api/client.js").ApiClient> => {
    assertRootAuthority?.();
    const { getHostConfig } = await import("../../orchestrator/index.js");
    assertRootAuthority?.();
    const { cfg } = await getHostConfig({ configManager, root: rootDir, readRoot: rootOperationsDir });
    assertRootAuthority?.();
    const { createApiClient, createApiClientWithConfig } = await import("../../api/client.js");
    assertRootAuthority?.();
    const options = { baseUrl: localhostServiceUrl(cfg.apiPort) };
    // Keep the local client on setup's active profile and, importantly, the
    // token that an in-progress setup login just stored. Creating an unrelated
    // manager here can otherwise lose profile context and call protected local
    // endpoints without the token setup has already obtained.
    return configManager
      ? createApiClientWithConfig(configManager, options)
      : createApiClient(options);
  };

  return {
    // Agent enablement + image-login actions, bound to the local stack.
    ...createDefaultAgentSetupActions(configManager),
    async runChecks(options) {
      const { runChecks } = await import("../checkCommands.js");
      return runChecks(options);
    },
    inspectStackInit,
    inspectDatastoreAdministrators,
    async scaffoldStack(options) {
      const { scaffoldStack } = await import("../initStack.js");
      // The setup engine persists the display root after scaffolding. Avoid an
      // intermediate descriptor-root path escaping into CLI configuration.
      return scaffoldStack(options, { persistStackRoot: async () => {} });
    },
    async persistStackRoot(rootDir, signal) {
      // Mirror scaffoldStack's `configManager.setStackRoot` so the reuse path
      // records the root too. Best-effort: without a config there is nowhere to
      // persist it (tests run this way), so it is simply a no-op.
      signal?.throwIfAborted();
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
    async pullImages({ rootDir, rootOperationsDir, assertRootAuthority, agentTypes, onLog, signal }) {
      assertRootAuthority?.();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      assertRootAuthority?.();
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir, readRoot: rootOperationsDir });
      assertRootAuthority?.();
      const selected = new Set(agentTypes);
      const result: PullImagesResult = { pulledCore: [], pulledAgents: [], failedCore: [], failedAgents: [] };

      for (const [key, tag] of Object.entries(cfg.images)) {
        if (key === "docs" && !cfg.docsEnabled) continue;
        const isAgent = key === "agent";
        // Pull the shared agent image when the user selected any agent; core images
        // (api/worker/daemon/redis/…) always pull.
        if (isAgent && selected.size === 0) continue;

        onLog?.(`pulling ${tag}…`);
        // Async exec keeps the event loop free so the wizard's Ink spinner keeps
        // animating while the (often slow) pull runs, instead of freezing.
        signal?.throwIfAborted();
        assertRootAuthority?.();
        const pulled = await orch.dockerAsync(["pull", tag], { signal });
        assertRootAuthority?.();
        signal?.throwIfAborted();
        if (pulled.status === 0) {
          try {
            await orch.tagAgentLatestAsync(key, tag, signal);
            assertRootAuthority?.();
          } catch (error) {
            rethrowCancellation(error);
            assertRootAuthority?.();
            /* best-effort local retag; the pull itself succeeded */
          }
          (isAgent ? result.pulledAgents : result.pulledCore).push(tag);
        } else {
          (isAgent ? result.failedAgents : result.failedCore).push(tag);
        }
      }
      return result;
    },
    async isStackRunning(rootDir, signal, root) {
      root?.assertRootAuthority?.();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      root?.assertRootAuthority?.();
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir, readRoot: root?.rootOperationsDir });
      root?.assertRootAuthority?.();
      const running = await orch.isStackRunningAsync(cfg, signal);
      root?.assertRootAuthority?.();
      return running;
    },
    async startStack({ rootDir, rootOperationsDir, ui, docs, onLog, signal, assertRootAuthority }) {
      signal?.throwIfAborted();
      assertRootAuthority?.();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      assertRootAuthority?.();
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir, readRoot: rootOperationsDir });
      assertRootAuthority?.();
      if (assertRootAuthority) {
        assertStableDockerHandoff(rootDir);
        assertRootAuthority();
      }
      // Pre-create the host Vibe prompt-cache dir owned by this user so Docker
      // does not auto-create it as root on first bind-mount — a root-owned dir
      // would fail the writability check and block future `propr start` runs.
      try {
        assertRootAuthority?.();
        const { ensureVibePromptCacheDir } = await import("../initStack.js");
        assertRootAuthority?.();
        ensureVibePromptCacheDir(cfg.hostVibePromptCacheDir);
        assertRootAuthority?.();
      } catch (error) {
        signal?.throwIfAborted();
        assertRootAuthority?.();
        rethrowCancellation(error);
        /* best-effort: startup validation will surface an actionable error */
      }
      assertRootAuthority?.();
      const validation = orch.validateEnv(cfg);
      for (const warning of validation.warnings) onLog?.(`warning: ${warning}`);
      if (!validation.ok) {
        throw new Error(`stack environment is not ready:\n  - ${validation.errors.join("\n  - ")}`);
      }
      // Use the async start path: `propr setup` drives this from behind a live
      // Ink TUI, so the blocking synchronous startStack would freeze the spinner
      // and swallow keystrokes for the seconds-to-minutes a cold start takes.
      assertRootAuthority?.();
      await orch.ensureNetworkAsync(cfg, onLog, { signal, beforeMutation: assertRootAuthority });
      assertRootAuthority?.();
      await orch.startStackAsync(cfg, {
        ui: ui ?? configManager?.getUiEnabled() ?? true,
        docs: docs ?? cfg.docsEnabled,
        onLog,
        signal,
        beforeLaunch: assertRootAuthority,
      });
    },
    async checkBackendHealth({ rootDir, rootOperationsDir, assertRootAuthority, timeoutMs = 60_000, signal }) {
      assertRootAuthority?.();
      const { getSystemStatus } = await import("../../api/system.js");
      assertRootAuthority?.();
      const client = await localApiClient(rootDir, rootOperationsDir, assertRootAuthority);
      assertRootAuthority?.();
      const deadline = Date.now() + timeoutMs;
      let lastError = "no response";
      // Containers take a few seconds to report healthy; poll until the deadline.
      do {
        signal?.throwIfAborted();
        try {
          assertRootAuthority?.();
          const status = await getSystemStatus(client, signal);
          assertRootAuthority?.();
          if (String(status.api).toLowerCase() === "healthy") {
            return { healthy: true, detail: `API healthy (daemon ${status.daemon}, worker ${status.worker})` };
          }
          lastError = `API reports "${status.api}"`;
        } catch (error) {
          rethrowCancellation(error);
          assertRootAuthority?.();
          // A 401/403 is not an unhealthy backend — the API answered but denied
          // this protected request. Return immediately so setup does not stall
          // on a running backend, while preserving whether remediation requires
          // authentication (401) or an authorization/configuration check (403).
          const accessFailure = classifyBackendAccessError(error);
          if (accessFailure) return accessFailure;
          lastError = (error as Error).message;
        }
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2_000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      } while (Date.now() < deadline);
      return { healthy: false, detail: `backend not healthy within ${Math.round(timeoutMs / 1000)}s (${lastError})` };
    },
    async addRepository({ fullName, alias, baseBranch }, rootDir, signal, root) {
      root?.assertRootAuthority?.();
      const { addRepo } = await import("../../api/repos.js");
      // Point the client at this stack's API port rather than the saved remote.
      root?.assertRootAuthority?.();
      const client = await localApiClient(rootDir, root?.rootOperationsDir, root?.assertRootAuthority);
      root?.assertRootAuthority?.();
      await addRepo(fullName, { alias, baseBranch }, client, signal);
      root?.assertRootAuthority?.();
    },
    async resolveUiUrl(rootDir, signal, root) {
      signal?.throwIfAborted();
      root?.assertRootAuthority?.();
      const { getHostConfig } = await import("../../orchestrator/index.js");
      root?.assertRootAuthority?.();
      const { cfg } = await getHostConfig({ configManager, root: rootDir, readRoot: root?.rootOperationsDir });
      root?.assertRootAuthority?.();
      signal?.throwIfAborted();
      return localhostServiceUrl(cfg.uiPort);
    },
    async openUrl(url, signal) {
      // Open in the host's default browser with the platform launcher. Detached
      // and unref'd so the wizard isn't held open by the child, with stdio
      // ignored so the launcher can't scribble over the TUI.
      const { spawn } = await import("node:child_process");
      const platform = process.platform;
      const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
      const args = platform === "win32" ? ["/c", "start", "", url] : [url];
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(command, args, { stdio: "ignore", detached: process.platform !== "win32" });
        let forceTimer: NodeJS.Timeout | undefined;
        const terminate = (force = false) => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
            killer.unref();
          } else {
            try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
          }
        };
        const abort = () => {
          terminate();
          forceTimer = setTimeout(() => { terminate(true); reject(signal?.reason); }, 2_000);
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.once("error", reject);
        child.once("close", code => {
          if (forceTimer) clearTimeout(forceTimer);
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(signal.reason);
          else if (code === 0) resolve();
          else reject(new Error(`browser launcher exited with code ${code ?? "?"}`));
        });
      });
    },
    async saveWhitelistSetting(rootDir, users, signal, root) {
      root?.assertRootAuthority?.();
      const { updateSetting } = await import("../../api/settings.js");
      // Point the client at this stack's API port rather than the saved remote.
      root?.assertRootAuthority?.();
      const client = await localApiClient(rootDir, root?.rootOperationsDir, root?.assertRootAuthority);
      root?.assertRootAuthority?.();
      await updateSetting("github_user_whitelist", users, client, signal);
      root?.assertRootAuthority?.();
    },
    hasGithubToken() {
      return Boolean(configManager?.getGithubToken());
    },
    async fetchRelayInstallations({ relayUrl, signal }) {
      const { fetchAuthenticatedUser } = await import("../../api/relay.js");
      const me = await fetchAuthenticatedUser(relayClient(relayUrl, signal));
      return { username: me.username, installations: me.installations };
    },
    async enrollRelay({ relayUrl, installationId, label, signal }) {
      const { enrollRelayToken } = await import("../../api/relay.js");
      const client = relayClient(relayUrl, signal);
      // Default the token label to the hostname, mirroring `propr relay enroll`.
      const result = await enrollRelayToken(client, { installationId, label: label ?? hostname() });
      return { relayUrl: client.baseUrl, token: result.token };
    },
    async loginWithGithub({ onLog, signal } = {}) {
      if (!configManager) return false;
      const { loginWithGithubCli } = await import("../../auth/githubLogin.js");
      const result = await loginWithGithubCli(configManager, { interactive: true, onLog, signal });
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
  function relayClient(relayUrl?: string, signal?: AbortSignal): RelayClientOptions {
    const githubToken = configManager?.getGithubToken();
    if (!githubToken) {
      throw new Error("Not logged in to GitHub. Run `propr login` first.");
    }
    return { baseUrl: relayUrl ?? DEFAULT_PROPR_GH_RELAY_URL, githubToken, signal };
  }
}

/**
 * Run the setup flow end to end, in a safe order, driven by the supplied
 * prompts and reflected through the reporter. Returns the final step state and
 * the environment-check outcome. Never throws for expected conditions (a failed
 * required step stops the flow and is reported in the returned state); only
 * truly unexpected programmer errors propagate.
 */
