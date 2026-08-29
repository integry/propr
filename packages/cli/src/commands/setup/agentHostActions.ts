import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
    async listAgents(rootDir, signal) {
      const { listAgents } = await import("../../api/agents.js");
      return (await listAgents(await localApiClient(rootDir), signal)).agents;
    },
    async addAgent(rootDir, options, signal) {
      const { addAgent } = await import("../../api/agents.js");
      await addAgent(options, await localApiClient(rootDir), signal);
    },
    async loginableAgents() {
      const { loginableAgents } = await import("../agentValidation.js");
      return loginableAgents();
    },
    async loginAgent(rootDir, type, signal) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { planAgentLogin } = await import("../agentValidation.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const temporaryRoot = mkdtempSync(join(tmpdir(), "propr-setup-login-"));
      const workspaceDir = join(temporaryRoot, "workspace");
      mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
      try {
        const { plan, error } = planAgentLogin(type, cfg, workspaceDir, orch.validateDockerBindPath);
        if (error || !plan) return { available: false, success: false, detail: error };
        if (!(await orch.dockerAsync(["images", "-q", plan.image], { signal })).stdout.trim()) {
          return { available: true, success: false, detail: `image ${plan.image} not present locally — run \`propr images pull\`` };
        }
        mkdirSync(plan.hostDir, { recursive: true, mode: 0o700 });
        const status = await new Promise<number | null>((resolve, reject) => {
          signal?.throwIfAborted();
          const child = spawn("docker", plan.dockerArgs, { stdio: "inherit", detached: process.platform !== "win32" });
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
            forceTimer = setTimeout(() => {
              terminate(true);
              forceTimer = setTimeout(() => reject(signal?.reason), 2_000);
            }, 2_000);
          };
          signal?.addEventListener("abort", abort, { once: true });
          child.once("error", reject);
          child.once("close", code => {
            if (forceTimer) clearTimeout(forceTimer);
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) reject(signal.reason);
            else resolve(code);
          });
        });
        return status === 0
          ? { available: true, success: true, detail: `${type} login finished — credentials written to ${plan.hostDir}` }
          : { available: true, success: false, detail: `${type} login exited with code ${status ?? "?"}` };
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    async validateAgents(rootDir, types, signal) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { validateAgents } = await import("../agentValidation.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const rows = await validateAgents(orch, cfg, { agents: types, skipHost: true, signal });
      return rows.map((row) => ({
        type: row.type,
        status: row.image.status === "ok" ? "ok" as const : row.image.status === "fail" ? "failed" as const : "skipped" as const,
        detail: row.image.detail,
      }));
    },
  };
}
