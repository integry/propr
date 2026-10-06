import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentSetupActions } from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import type { AuthenticationCommandHandoff } from "../../auth/githubLogin.js";
import { localhostServiceUrl } from "../../utils/dockerPort.js";
import type { OrchestratorConfig, OrchestratorModule } from "../../orchestrator/index.js";

type HostConfig = { orch: OrchestratorModule; cfg: OrchestratorConfig };

/** Bind the portable agent setup engine to the CLI API and Docker launcher. */
export function createDefaultAgentSetupActions(configManager?: ConfigManager, options: {
  authenticationHandoff?: AuthenticationCommandHandoff;
  /** Test seam for the resolved host orchestrator and configuration. */
  loadHostConfig?: (rootDir: string) => Promise<HostConfig>;
} = {}): AgentSetupActions {
  const loadHostConfig = options.loadHostConfig ?? (async (rootDir: string): Promise<HostConfig> => {
    const { getHostConfig } = await import("../../orchestrator/index.js");
    return getHostConfig({ configManager, root: rootDir });
  });
  const localApiClient = async (rootDir: string): Promise<import("../../api/client.js").ApiClient> => {
    const { cfg } = await loadHostConfig(rootDir);
    const { createApiClient } = await import("../../api/client.js");
    return createApiClient({ baseUrl: localhostServiceUrl(cfg.apiPort) });
  };

  return {
    async listAgents(rootDir) {
      const { listAgents } = await import("../../api/agents.js");
      return (await listAgents(await localApiClient(rootDir))).agents;
    },
    async addAgent(rootDir, options) {
      const { addAgent } = await import("../../api/agents.js");
      await addAgent(options, await localApiClient(rootDir));
    },
    async loginableAgents() {
      const { loginableAgents } = await import("../agentValidation.js");
      return loginableAgents();
    },
    async loginAgent(rootDir, type, loginOptions = {}) {
      const { agentImagePresent, planAgentLogin } = await import("../agentValidation.js");
      const { orch, cfg } = await loadHostConfig(rootDir);
      const temporaryRoot = mkdtempSync(join(tmpdir(), "propr-setup-login-"));
      const workspaceDir = join(temporaryRoot, "workspace");
      mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
      try {
        const { plan, error } = planAgentLogin(type, cfg, workspaceDir, orch.validateDockerBindPath);
        if (error || !plan) return { available: false, success: false, detail: error };
        if (!agentImagePresent(orch, plan.image)) {
          return { available: true, success: false, detail: `image ${plan.image} not present locally — run \`propr images pull\`` };
        }
        mkdirSync(plan.hostDir, { recursive: true, mode: 0o700 });
        const result = options.authenticationHandoff
          ? await options.authenticationHandoff("docker", plan.dockerArgs, {
              title: `ProPR · ${type} authentication`,
              signal: loginOptions.signal,
            })
          : spawnSync("docker", plan.dockerArgs, { stdio: "inherit" });
        loginOptions.signal?.throwIfAborted();
        return result.status === 0
          ? { available: true, success: true, detail: `${type} login finished — credentials written to ${plan.hostDir}` }
          : { available: true, success: false, detail: `${type} login exited with code ${result.status ?? "?"}` };
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    async validateAgents(rootDir, types, validationOptions = {}) {
      const { validateAgents } = await import("../agentValidation.js");
      const { orch, cfg } = await loadHostConfig(rootDir);
      const rows = await validateAgents(orch, cfg, {
        agents: types,
        skipHost: true,
        signal: validationOptions.signal,
      });
      return rows.map((row) => ({
        type: row.type,
        status: row.image.status === "ok" ? "ok" as const : row.image.status === "fail" ? "failed" as const : "skipped" as const,
        detail: row.image.detail,
      }));
    },
  };
}
