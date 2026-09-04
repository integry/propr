import {
  runSetup as runLocalSetup,
  retrySetup as retryLocalSetup,
  resolveSetupRoot,
  type RunSetupOptions as LocalRunSetupOptions,
  type SetupActions as LocalSetupActions,
  type SetupReporter,
  type SetupRunResult,
} from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import { localhostServiceUrl } from "../../utils/dockerPort.js";
import { createDefaultActions as createHostActions } from "./hostActions.js";

export * from "@propr/local-setup";

export interface VisualPreviewCredentialSetupResult {
  status: "configured" | "already-configured" | "environment-managed" | "missing" | "unsupported";
  githubUsername?: string;
}

/** CLI setup actions, including host-specific visual-preview credential seeding. */
export interface SetupActions extends LocalSetupActions {
  configureVisualPreviewCredential(rootDir: string): Promise<VisualPreviewCredentialSetupResult>;
}

/** CLI-compatible options layered over the host-neutral package contract. */
export interface RunSetupOptions extends Omit<LocalRunSetupOptions, "actions" | "root"> {
  configManager?: ConfigManager;
  root?: string;
  actions?: Partial<SetupActions>;
}

export function createDefaultActions(configManager?: ConfigManager): SetupActions {
  return {
    ...createHostActions(configManager),
    async configureVisualPreviewCredential(rootDir) {
      const token = configManager?.getGithubToken()?.trim();
      if (!token) return { status: "missing" };
      if (!/^(?:gho_|ghp_|github_pat_)/.test(token)) return { status: "unsupported" };

      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { cfg } = await getHostConfig({ configManager, root: rootDir });
      const { createApiClient, createApiClientWithConfig } = await import("../../api/client.js");
      const clientOptions = { baseUrl: localhostServiceUrl(cfg.apiPort) };
      const client = configManager
        ? createApiClientWithConfig(configManager, clientOptions)
        : await createApiClient(clientOptions);
      const { getVisualPreviewAuthStatus, saveVisualPreviewUploadToken } = await import("../../api/visualPreviewAuth.js");
      const current = await getVisualPreviewAuthStatus(client);
      if (current.status === "active") {
        return { status: "already-configured", githubUsername: current.githubUsername };
      }
      if (current.source === "environment") return { status: "environment-managed" };
      const configured = await saveVisualPreviewUploadToken(token, client);
      return { status: "configured", githubUsername: configured.githubUsername };
    },
  };
}

function reportVisualPreviewCredential(result: VisualPreviewCredentialSetupResult, reporter: SetupReporter): void {
  let line: string | undefined;
  if (result.status === "configured") {
    line = `visual previews: configured from the gh CLI session${result.githubUsername ? ` (@${result.githubUsername})` : ""}`;
  } else if (result.status === "already-configured") {
    line = "visual previews: upload credential already configured";
  } else if (result.status === "unsupported") {
    line = "visual previews: the gh CLI token type cannot upload attachments; add a PAT in Settings";
  } else if (result.status === "environment-managed") {
    line = "visual previews: GITHUB_VISUAL_PREVIEW_TOKEN is invalid; replace or remove that environment override";
  }
  if (!line) return;
  reporter.onLog?.(line);
  reporter.onProgress?.({ type: "log", line });
}

function createSetupActions(
  configManager: ConfigManager | undefined,
  overrides: Partial<SetupActions> | undefined,
  reporter: SetupReporter,
): SetupActions {
  const actions = { ...createDefaultActions(configManager), ...overrides } as SetupActions;
  const checkBackendHealth = actions.checkBackendHealth;
  let previewCredentialAttempted = false;

  return {
    ...actions,
    async checkBackendHealth(params) {
      const health = await checkBackendHealth(params);
      if (!health.healthy || previewCredentialAttempted) return health;
      previewCredentialAttempted = true;

      try {
        if (actions.detectGithubAuthMode(params.rootDir).mode === "demo") return health;
        reportVisualPreviewCredential(await actions.configureVisualPreviewCredential(params.rootDir), reporter);
      } catch {
        const line = "visual previews: could not import the gh CLI token; add a PAT in Settings";
        reporter.onLog?.(line);
        reporter.onProgress?.({ type: "log", line });
      }
      return health;
    },
  };
}

export async function runSetup(options: RunSetupOptions = {}): Promise<SetupRunResult> {
  const { configManager, actions: overrides, root, ...portable } = options;
  const reporter = portable.reporter ?? {};
  const actions = createSetupActions(configManager, overrides, reporter);
  return runLocalSetup({
    ...portable,
    root: resolveSetupRoot(configManager, root),
    actions,
  });
}

export function retrySetup(previous: SetupRunResult, options: Omit<RunSetupOptions, "root"> = {}): Promise<SetupRunResult> {
  const { configManager, actions: overrides, ...portable } = options;
  const reporter = portable.reporter ?? {};
  const actions = createSetupActions(configManager, overrides, reporter);
  return retryLocalSetup(previous, { ...portable, actions });
}
