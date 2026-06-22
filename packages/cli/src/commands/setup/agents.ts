/**
 * Agent enablement + image-based authentication for `propr setup`.
 *
 * This runs as a setup step *after the stack is up* (the backend must be
 * reachable to read and write agent configuration). It does three things, each
 * non-destructively:
 *
 *   1. Reads the agents already configured in the running backend.
 *   2. Adds any *selected* agent whose type is not yet configured, seeding it
 *      from the shared {@link AGENT_DEFAULTS} metadata (alias + supported
 *      models). Existing agents are never disabled, deleted, or re-aliased — a
 *      re-run only fills in what is missing.
 *   3. For selected agents that support an interactive image login (see
 *      {@link planAgentLogin}), offers to authenticate through the agent's
 *      Docker image and runs the login only for the ones the user confirms.
 *
 * Like the engine, this module is UI-agnostic: the side effects live behind the
 * injectable {@link AgentSetupActions} seam (tests pass mocks so the flow runs
 * without Docker, the network, or a TTY) and the single user decision is
 * collected through the optional {@link AgentSetupParams.confirmLogin} callback
 * (a missing callback means "authenticate nothing", the safe default).
 */

import type { ConfigManager } from "../../config/index.js";
import { AGENT_DEFAULTS, type AgentType } from "@propr/shared";
import type { AddAgentOptions, AgentConfig } from "../../api/agents.js";

/** Outcome of attempting to authenticate a single agent through its image. */
export interface AgentLoginResult {
  /** False when the agent has no usable image-login plan (nothing was run). */
  available: boolean;
  /** True when an interactive login ran and exited successfully. */
  success: boolean;
  /** Human-readable detail (error reason or status line). */
  detail?: string;
}

/**
 * The side effects the agent-setup step performs against the running stack.
 * Defaults bind to the real backend API and orchestrator (see
 * {@link createDefaultAgentSetupActions}); tests override any subset.
 */
export interface AgentSetupActions {
  /** List the agents currently configured in the running backend. */
  listAgents(rootDir: string): Promise<AgentConfig[]>;
  /** Add a new agent to the backend configuration. */
  addAgent(rootDir: string, options: AddAgentOptions): Promise<void>;
  /** Agent types that support an interactive image login (have a login plan). */
  loginableAgents(): Promise<string[]>;
  /** Authenticate one agent through its image; interactive (inherits stdio). */
  loginAgent(rootDir: string, type: string): Promise<AgentLoginResult>;
}

/** Inputs for {@link runAgentSetup}. */
export interface AgentSetupParams {
  rootDir: string;
  /** Agent types the user selected earlier in the flow (pull/configure steps). */
  selectedAgents: string[];
  actions: AgentSetupActions;
  /**
   * Confirm which of the loginable candidates to authenticate now. Returns the
   * subset to log in. Omitted (or returning an empty array) authenticates none.
   */
  confirmLogin?(ctx: { candidates: string[]; rootDir: string }): Promise<string[]>;
  onLog?(line: string): void;
}

/** What the agent-setup step did, for the caller to render as a step status. */
export interface AgentSetupOutcome {
  /** Agent types newly added to the backend configuration. */
  added: string[];
  /** Selected agent types that were already configured (left untouched). */
  alreadyConfigured: string[];
  /** Agents that authenticated successfully through their image. */
  authenticated: string[];
  /** Agents the user chose to authenticate but whose login did not succeed. */
  authFailed: string[];
  /** Non-fatal problems encountered (surfaced as a warning by the caller). */
  errors: string[];
}

/**
 * Enable the selected agents in the running backend and, on confirmation,
 * authenticate the ones that support an image login. Never throws for expected
 * conditions — every failure is captured in {@link AgentSetupOutcome.errors} so
 * the caller can settle the step as a warning rather than aborting setup.
 */
export async function runAgentSetup(params: AgentSetupParams): Promise<AgentSetupOutcome> {
  const { rootDir, selectedAgents, actions, confirmLogin, onLog } = params;
  const outcome: AgentSetupOutcome = {
    added: [],
    alreadyConfigured: [],
    authenticated: [],
    authFailed: [],
    errors: [],
  };

  if (selectedAgents.length === 0) return outcome;

  // 1. Read the current backend configuration. Without it we cannot safely tell
  //    which agents are new, so a read failure stops here (nothing was changed).
  let existing: AgentConfig[];
  try {
    existing = await actions.listAgents(rootDir);
  } catch (error) {
    outcome.errors.push(`could not read backend agents: ${(error as Error).message}`);
    return outcome;
  }

  // 2. Add the selected agents that are not yet configured. Match by type so we
  //    never add a second agent for a type the user already runs — existing
  //    agents (enabled or not) are left exactly as they are.
  const configuredTypes = new Set(existing.map((agent) => agent.type));
  for (const type of selectedAgents) {
    if (configuredTypes.has(type as AgentType)) {
      outcome.alreadyConfigured.push(type);
      continue;
    }
    const defaults = AGENT_DEFAULTS[type as AgentType];
    if (!defaults) continue; // unknown type — guarded, but never trust the input
    try {
      onLog?.(`enabling agent ${type}…`);
      // Seed from shared metadata: alias + the full supported-model set. The
      // backend resolves the default docker image and host config path, so we
      // don't pass them (a literal "~" path would otherwise reach the backend).
      await actions.addAgent(rootDir, {
        alias: defaults.defaultAlias,
        type: type as AgentType,
        models: defaults.defaultModels,
        enabled: true,
      });
      outcome.added.push(type);
      configuredTypes.add(type as AgentType);
    } catch (error) {
      outcome.errors.push(`could not enable ${type}: ${(error as Error).message}`);
    }
  }

  // 3. Image-based authentication — only for selected agents that actually have
  //    a login plan, and only for the ones the user confirms.
  let loginable: Set<string>;
  try {
    loginable = new Set(await actions.loginableAgents());
  } catch (error) {
    outcome.errors.push(`could not determine which agents support image login: ${(error as Error).message}`);
    return outcome;
  }
  const candidates = selectedAgents.filter((type) => loginable.has(type));
  if (candidates.length === 0 || !confirmLogin) return outcome;

  let chosen: string[];
  try {
    chosen = await confirmLogin({ candidates, rootDir });
  } catch (error) {
    // A failed/cancelled prompt must not abort the whole run — just skip login.
    outcome.errors.push(`agent login prompt failed: ${(error as Error).message}`);
    return outcome;
  }
  const chosenSet = new Set(chosen.filter((type) => loginable.has(type)));
  // Iterate the candidate order (not the user's), so logins run in a stable order.
  for (const type of candidates) {
    if (!chosenSet.has(type)) continue;
    try {
      onLog?.(`authenticating ${type} through its image…`);
      const result = await actions.loginAgent(rootDir, type);
      if (result.detail) onLog?.(result.detail);
      if (result.available && result.success) outcome.authenticated.push(type);
      else outcome.authFailed.push(type);
    } catch (error) {
      outcome.authFailed.push(type);
      outcome.errors.push(`login for ${type} failed: ${(error as Error).message}`);
    }
  }

  return outcome;
}

/**
 * Build the production {@link AgentSetupActions}, lazily importing the heavy
 * orchestrator/API/validation modules only when an action runs — keeping the
 * engine import cheap and Docker-free for tests, which replace these anyway.
 */
export function createDefaultAgentSetupActions(configManager?: ConfigManager): AgentSetupActions {
  /** A client pointed at the local stack's API port (not the saved remote URL). */
  const localApiClient = async (rootDir: string): Promise<import("../../api/client.js").ApiClient> => {
    const { getHostConfig } = await import("../../orchestrator/index.js");
    const { cfg } = await getHostConfig({ configManager, root: rootDir });
    const { createApiClient } = await import("../../api/client.js");
    return createApiClient({ baseUrl: `http://localhost:${cfg.apiPort}` });
  };

  return {
    async listAgents(rootDir) {
      const { listAgents } = await import("../../api/agents.js");
      const client = await localApiClient(rootDir);
      const response = await listAgents(client);
      return response.agents;
    },
    async addAgent(rootDir, options) {
      const { addAgent } = await import("../../api/agents.js");
      const client = await localApiClient(rootDir);
      await addAgent(options, client);
    },
    async loginableAgents() {
      const { loginableAgents } = await import("../agentValidation.js");
      return loginableAgents();
    },
    async loginAgent(rootDir, type) {
      const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { planAgentLogin } = await import("../agentValidation.js");

      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const tmp = mkdtempSync(join(tmpdir(), "propr-setup-login-"));
      const workspaceDir = join(tmp, "workspace");
      mkdirSync(workspaceDir, { recursive: true });
      try {
        const { plan, error } = planAgentLogin(type, cfg, workspaceDir, orch.validateDockerBindPath);
        if (error || !plan) return { available: false, success: false, detail: error };
        // The image must be present locally; setup pulls selected agent images
        // earlier, but a failed pull would leave it absent.
        if (orch.docker(["images", "-q", plan.image], { capture: true }).stdout.trim().length === 0) {
          return { available: true, success: false, detail: `image ${plan.image} not present locally — run \`propr images pull\`` };
        }
        mkdirSync(plan.hostDir, { recursive: true, mode: 0o700 });
        const res = spawnSync("docker", plan.dockerArgs, { stdio: "inherit" });
        return res.status === 0
          ? { available: true, success: true, detail: `${type} login finished — credentials written to ${plan.hostDir}` }
          : { available: true, success: false, detail: `${type} login exited with code ${res.status ?? "?"}` };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
