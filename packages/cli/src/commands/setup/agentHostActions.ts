import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentSetupActions } from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import { localhostServiceUrl } from "../../utils/dockerPort.js";

/** Bind the portable agent setup engine to the CLI API and Docker launcher. */
export function createDefaultAgentSetupActions(configManager?: ConfigManager): AgentSetupActions {
  const localApiClient = async (rootDir: string): Promise<import("../../api/client.js").ApiClient> => {
    const { getHostConfig } = await import("../../orchestrator/index.js");
    const { cfg } = await getHostConfig({ configManager, root: rootDir });
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
    async loginAgent(rootDir, type) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { planAgentLogin } = await import("../agentValidation.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const temporaryRoot = mkdtempSync(join(tmpdir(), "propr-setup-login-"));
      const workspaceDir = join(temporaryRoot, "workspace");
      mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
      try {
        const { plan, error } = planAgentLogin(type, cfg, workspaceDir, orch.validateDockerBindPath);
        if (error || !plan) return { available: false, success: false, detail: error };
        if (!orch.docker(["images", "-q", plan.image], { capture: true }).stdout.trim()) {
          return { available: true, success: false, detail: `image ${plan.image} not present locally — run \`propr images pull\`` };
        }
        mkdirSync(plan.hostDir, { recursive: true, mode: 0o700 });
        const result = spawnSync("docker", plan.dockerArgs, { stdio: "inherit" });
        return result.status === 0
          ? { available: true, success: true, detail: `${type} login finished — credentials written to ${plan.hostDir}` }
          : { available: true, success: false, detail: `${type} login exited with code ${result.status ?? "?"}` };
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    async validateAgents(rootDir, types) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { validateAgents } = await import("../agentValidation.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const rows = await validateAgents(orch, cfg, { agents: types, skipHost: true });
      return rows.map((row) => ({
        type: row.type,
        status: row.image.status === "ok" ? "ok" as const : row.image.status === "fail" ? "failed" as const : "skipped" as const,
        detail: row.image.detail,
      }));
    },
  };
}
