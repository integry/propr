import { inspectSetupEngineArchitecture, inspectSetupImagePlatform } from "./imagePlatform.js";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { DEFAULT_PROPR_GH_RELAY_URL } from "@propr/shared";
import {
  GITHUB_SIGN_IN_REVOKED_MESSAGE,
  GithubBrowserSignInError,
  applyEnvSelection,
  clearEnvKeys,
  classifyBackendAccessError,
  detectGithubAuthMode,
  inspectDatastoreAdministrators,
  inspectStackInit,
  readEnvVars,
  type GithubUserCredential,
  type PullImagesResult,
  type SetupActions,
} from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import { RelayApiError, type RelayClientOptions } from "../../api/relay.js";
import type { OrchestratorConfig, OrchestratorModule } from "../../orchestrator/types.js";
import { dockerPublishedHostPort, localhostServiceUrl } from "../../utils/dockerPort.js";
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

/** Refresh expiring GitHub tokens this long before GitHub's stated expiry. */
const GITHUB_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

function assertSafeAgentCredentialDir(path: string, name = "Agent credential path"): void {
  if (!isAbsolute(path) || normalize(path) === "/" || path.includes(":") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error(`${name} must be an absolute, non-root POSIX path without ':' or control characters`);
  }
}

/** Probe both addresses browsers can resolve for localhost, independently of Docker's bind address. */
async function loopbackPortAvailable(port: number, signal?: AbortSignal, hosts = ["127.0.0.1", "::1"]): Promise<boolean> {
  for (const host of hosts) {
    signal?.throwIfAborted();
    const available = await new Promise<boolean>((resolve, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(false);
        // Hosts without IPv6 must still be able to run local setup.
        else if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code ?? "")) resolve(true);
        else reject(error);
      });
      server.listen({ host, port, ipv6Only: host === "::1" }, () => {
        server.close(error => error ? reject(error) : resolve(true));
      });
    });
    if (!available) return false;
  }
  signal?.throwIfAborted();
  return true;
}

/** Only exempt bindings actually published by this stack's running UI container. */
async function managedUiLoopbackHosts(orch: OrchestratorModule, cfg: OrchestratorConfig, signal?: AbortSignal): Promise<string[]> {
  const name = `${cfg.stack}-ui`;
  const inspected = await orch.dockerAsync([
    "inspect", "--format", "[{{json .Name}},{{json .State}},{{json .Config.Labels}},{{json .NetworkSettings.Ports}}]", name,
  ], { signal });
  signal?.throwIfAborted();
  if (inspected.status !== 0) return [];
  try {
    const [containerName, state, labels, ports] = JSON.parse(inspected.stdout);
    // Health/startup state does not change ownership of a published binding.
    if (containerName !== `/${name}` || labels?.["propr.stack"] !== cfg.stack || labels?.["propr.service"] !== "ui"
      || state?.Running !== true || state.Paused) return [];
    const bindings = ports?.["5173/tcp"];
    if (!Array.isArray(bindings)) return [];
    const port = dockerPublishedHostPort(cfg.uiPort);
    return ["127.0.0.1", "::1"].filter(host => bindings.some(binding => binding.HostPort === port
      && (binding.HostIp === host || binding.HostIp === (host === "::1" ? "::" : "0.0.0.0"))));
  } catch {
    return [];
  }
}

export function createDefaultActions(configManager?: ConfigManager, options: {
  authenticationHandoff?: AuthenticationCommandHandoff;
  capturedCommand?: CapturedCommandRunner;
  githubBrowserLogin?: (options: { signal?: AbortSignal; onLog?: (line: string) => void }) => Promise<string | GithubUserCredential>;
  /** Rotate an expiring GitHub OAuth credential. Errors must be GithubBrowserSignInError. */
  refreshGithubCredential?: (refreshToken: string, options: { signal?: AbortSignal }) => Promise<GithubUserCredential>;
  now?: () => number;
} = {}): SetupActions {
  let browserLoginFailure: string | undefined;
  let browserTokenSaveFailed = false;
  let refreshing: Promise<string> | undefined;
  const now = options.now ?? Date.now;

  /** An expiring credential remains usable while its access token or refresh grant is live. */
  const githubCredentialUsable = (credential: GithubUserCredential | undefined): boolean => {
    if (!credential) return false;
    if (credential.expiresAt === undefined || credential.expiresAt - now() > GITHUB_TOKEN_REFRESH_MARGIN_MS) return true;
    return Boolean(credential.refreshToken && options.refreshGithubCredential
      && (credential.refreshTokenExpiresAt === undefined || credential.refreshTokenExpiresAt > now()));
  };

  /** Each persisted renewal's rejected access token, mapped to its successor from the same grant. */
  const renewedTokens = new Map<string, string>();
  /** True only when `token` was reached from `rejected` by renewals, never by a different sign-in. */
  const isRenewalOf = (rejected: string, token: string): boolean => {
    let successor = renewedTokens.get(rejected);
    for (let hops = 0; successor !== undefined && hops < renewedTokens.size; hops++) {
      if (successor === token) return true;
      successor = renewedTokens.get(successor);
    }
    return false;
  };

  /** Sign-ins whose credential write has been queued; a refresh compares this to detect a switch. */
  let signInAttempts = 0;

  const rotateGithubCredential = async (credential: GithubUserCredential): Promise<string> => {
    const signInsAtStart = signInAttempts;
    // A sign-in confirmed while the refresh was in flight wins over this
    // attempt's result, success or failure: never let the previous account's
    // grant overwrite, clear, or set recovery state for the new identity.
    // Only committed config counts: a sign-in still being saved may roll back,
    // so wait for queued writes (including sign-ins queued meanwhile) to settle.
    const supersedingToken = async (own: GithubUserCredential): Promise<string | undefined> => {
      let current: GithubUserCredential | undefined;
      let attempts: number;
      do {
        attempts = signInAttempts;
        current = await configManager?.getSettledGithubCredential();
      } while (attempts !== signInAttempts);
      if (current && current.accessToken === own.accessToken && current.refreshToken === own.refreshToken) {
        // A switch attempted meanwhile failed to save: never continue as the old account.
        if (signInAttempts !== signInsAtStart) throw new Error("GitHub sign-in could not be saved. Choose Retry setup to sign in again.");
        return undefined;
      }
      if (!current) throw new Error("Not logged in to GitHub. Run `propr login` first.");
      return current.accessToken;
    };

    const discardRevokedGithubCredential = async (): Promise<string> => {
      // A revoked or expired grant cannot recover; remove it so setup asks for a
      // new sign-in instead of repeatedly presenting a dead identity. Compare-and-set,
      // so a sign-in queued before this clear is kept and inherits no recovery state.
      let cleared = true;
      try {
        cleared = await configManager?.clearGithubToken({ expectedAccessToken: credential.accessToken }) ?? true;
      } catch { browserTokenSaveFailed = true; }
      if (!cleared) {
        const superseding = await supersedingToken(credential);
        if (superseding !== undefined) return superseding;
      }
      renewedTokens.clear();
      browserLoginFailure = GITHUB_SIGN_IN_REVOKED_MESSAGE;
      throw new Error(GITHUB_SIGN_IN_REVOKED_MESSAGE);
    };

    if (!credential.refreshToken || !options.refreshGithubCredential
      || (credential.refreshTokenExpiresAt !== undefined && credential.refreshTokenExpiresAt <= now())) {
      return discardRevokedGithubCredential();
    }
    let rotated: GithubUserCredential;
    try {
      rotated = await options.refreshGithubCredential(credential.refreshToken, {});
    } catch (error) {
      // Provider/transport errors may contain credentials. Only fixed copy escapes.
      const message = GithubBrowserSignInError.safeMessage(error);
      // The clear is conditional, so a sign-in confirmed meanwhile is kept.
      if (message === GITHUB_SIGN_IN_REVOKED_MESSAGE) return discardRevokedGithubCredential();
      const superseding = await supersedingToken(credential);
      if (superseding !== undefined) return superseding;
      throw new Error(message);
    }
    try {
      // GitHub has already invalidated the previous pair: persist before use.
      // Compare-and-set inside the config's serialized mutations, so a sign-in
      // confirmed before or during this write is never overwritten or rolled back.
      const saved = await configManager!.setGithubCredential(rotated, { replacingRefreshToken: credential.refreshToken });
      if (!saved) {
        const superseding = await supersedingToken(credential);
        if (superseding !== undefined) return superseding;
        throw new Error("GitHub sign-in changed while it was being renewed. Retry the request.");
      }
      renewedTokens.set(credential.accessToken, rotated.accessToken);
    } catch {
      const superseding = await supersedingToken(credential);
      if (superseding !== undefined) return superseding;
      browserTokenSaveFailed = true;
      browserLoginFailure = "GitHub sign-in was renewed, but ProPR could not save it on this computer. Check available storage, then sign in again.";
      throw new Error(browserLoginFailure);
    }
    // A sign-in queued behind this write has replaced it by now; hand out that identity instead.
    return (await supersedingToken(rotated)) ?? rotated.accessToken;
  };

  /** Return a live GitHub user token, refreshing an expiring credential once across concurrent callers. */
  const currentGithubToken = async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<string> => {
    if (browserTokenSaveFailed) throw new Error("GitHub sign-in could not be saved. Choose Retry setup to sign in again.");
    if (refreshing) return refreshing;
    const credential = configManager?.getGithubCredential();
    if (!credential) throw new Error("Not logged in to GitHub. Run `propr login` first.");
    if (credential.expiresAt === undefined) return credential.accessToken;
    if (!forceRefresh && credential.expiresAt - now() > GITHUB_TOKEN_REFRESH_MARGIN_MS) return credential.accessToken;
    refreshing = rotateGithubCredential(credential).finally(() => { refreshing = undefined; });
    return refreshing;
  };

  /**
   * Run a relay call with a live token; an expiring token rejected early is
   * retried once with its renewal, whether this call or a concurrent one renewed it.
   */
  const withRelayClient = async <T>(relayUrl: string | undefined, call: (client: RelayClientOptions) => Promise<T>): Promise<T> => {
    const client = relayClient(relayUrl, await currentGithubToken());
    try {
      return await call(client);
    } catch (error) {
      const credential = configManager?.getGithubCredential();
      if (!(error instanceof RelayApiError) || error.status !== 401 || credential?.expiresAt === undefined) throw error;
      const token = await currentGithubToken({ forceRefresh: credential.accessToken === client.githubToken });
      // A different account confirmed meanwhile must never inherit this call.
      if (!isRenewalOf(client.githubToken, token)) throw error;
      return call(relayClient(relayUrl, token));
    }
  };
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
    let { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
    const uiEnabled = ui ?? configManager?.getUiEnabled() ?? true;
    // A free IPv4 Docker binding is insufficient: Chromium may open an
    // unrelated IPv6 listener at the advertised localhost URL after OAuth.
    // Keep the hostname (and therefore the API cookie site) unchanged.
    if (uiEnabled && !cfg.uiTunnelEnabled && cfg.uiPort
      && /^(?:127\.0\.0\.1:|\[::1\]:)?\d+$/.test(String(cfg.uiPort))
      && cfg.frontendUrl === localhostServiceUrl(cfg.uiPort)) {
      const currentPort = Number(dockerPublishedHostPort(cfg.uiPort));
      let selectedPort = currentPort;
      while (!(await loopbackPortAvailable(selectedPort, signal))) {
        if (selectedPort === currentPort) {
          // Repeat starts replace this container later. Its own published port
          // must not move the browser/OAuth URL, but the other address may still
          // belong to an unrelated app and must be probed independently.
          const managedHosts = await managedUiLoopbackHosts(orch, cfg, signal);
          if (managedHosts.length > 0 && await loopbackPortAvailable(currentPort, signal,
            ["127.0.0.1", "::1"].filter(host => !managedHosts.includes(host)))) break;
        }
        if (++selectedPort > 65_535) throw new Error("No available localhost UI port; configure UI_PORT with an available port.");
      }
      if (selectedPort !== currentPort) {
        signal?.throwIfAborted();
        const binding = String(cfg.uiPort).replace(/\d+$/, String(selectedPort));
        if (process.env.UI_PORT || process.env.FRONTEND_URL) {
          throw new Error(`UI port ${currentPort} is occupied on loopback. Remove the process UI_PORT/FRONTEND_URL overrides so setup can choose an available port, or set them to ${binding} and ${localhostServiceUrl(binding)}.`);
        }
        applyEnvSelection(rootDir, { UI_PORT: binding, FRONTEND_URL: localhostServiceUrl(binding) }, { overwrite: true });
        ({ orch, cfg } = await getHostConfig({ configManager, root: rootDir }));
        if (cfg.uiPort !== binding || cfg.frontendUrl !== localhostServiceUrl(binding)) {
          throw new Error("UI port configuration is overridden by the process environment; update UI_PORT and FRONTEND_URL to an available localhost port and retry.");
        }
        onLog?.(`UI port ${currentPort} is occupied on loopback; using ${cfg.frontendUrl}.`);
      }
    }
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
    try {
      await orch.startStackAsync(cfg, {
        ui: uiEnabled,
        docs: docs ?? cfg.docsEnabled,
        onLog,
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (process.platform === "darwin" && error instanceof Error
        && /mounts? denied|(?:bind mount|mounting|mount source path)[^\n]*(?:permission denied|operation not permitted|not shared)|(?:permission denied|operation not permitted)[^\n]*(?:bind mount|mount source path)/i.test(error.message)) error.message += `\nIf Docker reports a denied bind mount, review Docker Desktop Settings → Resources → File sharing for this stack directory. Grant access yourself only if intended, then retry.`;
      throw error;
    }
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

      let architecture: string | undefined;
      let architectureFailed = false;
      for (const [key, tag] of Object.entries(cfg.images)) {
        signal?.throwIfAborted();
        if (key === "docs" && !cfg.docsEnabled) continue;
        const isAgent = key === "agent";
        // Pull the shared agent image when the user selected any agent; core images
        // (api/worker/daemon/redis/…) always pull.
        if (isAgent && selected.size === 0) continue;

        if (process.platform === "darwin") {
          if (architecture === undefined && !architectureFailed) {
            try {
              architecture = await inspectSetupEngineArchitecture(orch, signal);
            } catch (error) {
              signal?.throwIfAborted();
              architectureFailed = true;
              onLog?.(`Cannot prepare images: ${(error as Error).message}`);
            }
          }
          if (architectureFailed) {
            (isAgent ? result.failedAgents : result.failedCore).push(tag);
            continue;
          }
        }

        // A source validation manifest deliberately names images built into the
        // local Docker daemon.  They are never claimed to be published and must
        // not be sent to Docker Hub; inspect the exact tag instead.  A missing
        // image remains a fatal core-image failure and setup stops safely.
        if (sourceBuiltImageKeys.has(key)) {
          onLog?.(`checking source-built image ${tag}…`);
          const inspected = await orch.dockerAsync(["image", "inspect", tag], { signal });
          signal?.throwIfAborted();
          if (inspected.status === 0) {
            try {
              if (process.platform === "darwin") {
                await inspectSetupImagePlatform(orch, tag, isAgent, true, signal, architecture);
              }
              result.pulledCore.push(tag);
            } catch (error) {
              signal?.throwIfAborted();
              onLog?.(`Source-built image ${tag} is unavailable or incompatible: ${(error as Error).message}`);
              result.failedCore.push(tag);
            }
          }
          else result.failedCore.push(tag);
          continue;
        }

        let platform: string | undefined;
        let localPlatformVerified = false;
        if (process.platform === "darwin") {
          try {
            const present = await orch.dockerAsync(["image", "inspect", tag], { signal });
            signal?.throwIfAborted();
            const skipRemote = /^(1|true|yes)$/i.test(process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK ?? "");
            if (present.status === 0) {
              try {
                platform = await inspectSetupImagePlatform(orch, tag, isAgent, true, signal, architecture);
                localPlatformVerified = true;
              } catch (error) {
                signal?.throwIfAborted();
                if (skipRemote) throw error;
                // An incompatible local variant must not prevent pulling the
                // required platform from a published multi-platform manifest.
              }
            }
            if (skipRemote && !localPlatformVerified) throw new Error(`Image ${tag} is not available locally; remote image checks are disabled.`);
            platform ??= await inspectSetupImagePlatform(orch, tag, isAgent, false, signal, architecture);
            onLog?.(`${tag}: ${platform}${isAgent ? " (AMD64 agent; emulation required on Apple Silicon)" : ""}`);
            if (localPlatformVerified && skipRemote) {
              try { orch.tagAgentLatest(key, tag); } catch { /* best-effort local retag */ }
              (isAgent ? result.pulledAgents : result.pulledCore).push(tag);
              continue;
            }
          } catch (error) {
            signal?.throwIfAborted();
            onLog?.(`Cannot prepare image ${tag}: ${(error as Error).message}`);
            (isAgent ? result.failedAgents : result.failedCore).push(tag);
            continue;
          }
        }

        onLog?.(`pulling ${tag}…`);
        // Async exec keeps the event loop free so the wizard's Ink spinner keeps
        // animating while the (often slow) pull runs, instead of freezing.
        const pulled = await orch.dockerAsync(["pull", ...(platform ? ["--platform", platform] : []), tag], { signal });
        signal?.throwIfAborted();
        // A failed pull awaited an external API. Reinspect before relying on
        // local availability; the earlier presence check is not durable proof.
        if (pulled.status !== 0 && localPlatformVerified) {
          try {
            await inspectSetupImagePlatform(orch, tag, isAgent, true, signal, architecture);
          } catch {
            signal?.throwIfAborted();
            localPlatformVerified = false;
          }
        }
        if (pulled.status === 0 || localPlatformVerified) {
          if (pulled.status !== 0) onLog?.(`Using verified local image ${tag}; registry pull unavailable.`);
          try {
            orch.tagAgentLatest(key, tag);
          } catch {
            /* best-effort local retag; the pull itself succeeded */
          }
          (isAgent ? result.pulledAgents : result.pulledCore).push(tag);
        } else {
          onLog?.(`Docker pull failed for ${tag}: ${pulled.stderr || pulled.error?.message || "unknown Docker error"}`);
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
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { cfg } = await getHostConfig({ configManager, root: rootDir });
      // A reused IPv4-only UI may be healthy while localhost opens a different
      // app on IPv6. Use setup's existing managed-container recovery flow;
      // replacing the stack runs port selection again after releasing IPv4.
      if ((configManager?.getUiEnabled() ?? true) && !cfg.uiTunnelEnabled && /^127\.0\.0\.1:\d+$/.test(String(cfg.uiPort))
        && cfg.frontendUrl === localhostServiceUrl(cfg.uiPort)
        && !(await loopbackPortAvailable(Number(dockerPublishedHostPort(cfg.uiPort)), signal, ["::1"]))) {
        return {
          healthy: false,
          detail: "The local UI port is occupied on IPv6 loopback; localhost may open another app. Recreate this managed stack to select an available UI port.",
          nextAction: "Choose Recreate managed stack, then retry setup. The unrelated service can remain running.",
          recoveryAction: "replace-running-stack",
        };
      }
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
    githubLoginRecovery() {
      return options.githubBrowserLogin ? {
        detail: browserLoginFailure ?? "GitHub browser sign-in is required to continue.",
        nextAction: "Choose Retry setup to start a new GitHub browser sign-in, then return to ProPR and confirm the intended account.",
      } : undefined;
    },
    hasGithubToken() {
      return !browserTokenSaveFailed && githubCredentialUsable(configManager?.getGithubCredential());
    },
    async fetchRelayInstallations({ relayUrl }) {
      const { fetchAuthenticatedUser } = await import("../../api/relay.js");
      const me = await withRelayClient(relayUrl, fetchAuthenticatedUser);
      return { username: me.username, installations: me.installations };
    },
    async enrollRelay({ relayUrl, installationId, label }) {
      const { enrollRelayToken } = await import("../../api/relay.js");
      // Default the token label to the hostname, mirroring `propr relay enroll`.
      return withRelayClient(relayUrl, async client => {
        const result = await enrollRelayToken(client, { installationId, label: label ?? hostname() });
        return { relayUrl: client.baseUrl, token: result.token };
      });
    },
    async loginWithGithub({ onLog, signal, force } = {}) {
      if (!configManager) return false;
      if (options.githubBrowserLogin) {
        browserLoginFailure = undefined;
        let credential: GithubUserCredential;
        try {
          const result = await options.githubBrowserLogin({ signal, onLog });
          credential = typeof result === "string" ? { accessToken: result } : result;
        } catch (error) {
          signal?.throwIfAborted();
          // Injected providers/transport errors may contain credentials. Never log them.
          browserLoginFailure = GithubBrowserSignInError.safeMessage(error);
          onLog?.(browserLoginFailure);
          return false;
        }
        signal?.throwIfAborted();
        try {
          // Replace the whole credential so a previous account's refresh token
          // can never be paired with the newly confirmed identity.
          signInAttempts++;
          await configManager.setGithubCredential(credential);
          renewedTokens.clear();
          // An older refresh whose write failed while this sign-in was queued
          // must not leave its recovery state on the newly confirmed account.
          browserTokenSaveFailed = false;
          browserLoginFailure = undefined;
        } catch {
          browserTokenSaveFailed = true;
          browserLoginFailure = "GitHub account was confirmed, but ProPR could not save sign-in on this computer. Check available storage and retry.";
          onLog?.(browserLoginFailure);
          return false;
        }
        return true;
      }
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
  function relayClient(relayUrl: string | undefined, githubToken: string): RelayClientOptions {
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
