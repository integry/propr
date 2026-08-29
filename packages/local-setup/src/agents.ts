/**
 * Agent enablement + image-based authentication for local setup.
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

import { AGENT_DEFAULTS, type AgentType } from "@propr/shared";

/** Minimal backend agent shape needed by the setup engine. */
export interface AgentConfig {
  type: AgentType;
}

/** Portable add-agent request emitted by the engine. */
export interface AddAgentOptions {
  alias: string;
  type: AgentType;
  models: string[];
  enabled: boolean;
}

/** Outcome of attempting to authenticate a single agent through its image. */
export interface AgentLoginResult {
  /** False when the agent has no usable image-login plan (nothing was run). */
  available: boolean;
  /** True when an interactive login ran and exited successfully. */
  success: boolean;
  /** Human-readable detail (error reason or status line). */
  detail?: string;
}

export interface AgentConnectivityResult {
  type: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

/**
 * The side effects the agent-setup step performs against the running stack.
 * Hosts bind these operations to their backend and launcher. Tests can provide
 * in-memory implementations without Docker or network access.
 */
export interface AgentSetupActions {
  /** List the agents currently configured in the running backend. */
  listAgents(rootDir: string, signal?: AbortSignal): Promise<AgentConfig[]>;
  /** Add a new agent to the backend configuration. */
  addAgent(rootDir: string, options: AddAgentOptions, signal?: AbortSignal): Promise<void>;
  /** Agent types that support an interactive image login (have a login plan). */
  loginableAgents(signal?: AbortSignal): Promise<string[]>;
  /** Authenticate one agent through its image; interactive (inherits stdio). */
  loginAgent(rootDir: string, type: string, signal?: AbortSignal): Promise<AgentLoginResult>;
  /** Run a live, image-only request that mirrors the worker credential mount. */
  validateAgents(rootDir: string, types: string[], signal?: AbortSignal): Promise<AgentConnectivityResult[]>;
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
  signal?: AbortSignal;
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
  /** Agents whose worker-image connectivity check returned a valid response. */
  validated: string[];
  /** Agents whose live image check failed or could not run. */
  validationFailed: string[];
  /** Exact recovery commands for agents that still need attention. */
  nextCommands: string[];
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
  const { rootDir, selectedAgents, actions, confirmLogin, onLog, signal } = params;
  const outcome: AgentSetupOutcome = {
    added: [],
    alreadyConfigured: [],
    authenticated: [],
    authFailed: [],
    validated: [],
    validationFailed: [],
    nextCommands: [],
    errors: [],
  };

  if (selectedAgents.length === 0) return outcome;

  // 1. Read the current backend configuration. Without it we cannot safely tell
  //    which agents are new, so a read failure stops here (nothing was changed).
  let existing: AgentConfig[];
  try {
    existing = await actions.listAgents(rootDir, signal);
    signal?.throwIfAborted();
  } catch (error) {
    outcome.errors.push(`could not read backend agents: ${(error as Error).message}`);
    return outcome;
  }

  // 2. Add the selected agents that are not yet configured. Match by type so we
  //    never add a second agent for a type the user already runs — existing
  //    agents (enabled or not) are left exactly as they are.
  const configuredTypes = new Set(existing.map((agent) => agent.type));
  for (const type of selectedAgents) {
    signal?.throwIfAborted();
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
      }, signal);
      signal?.throwIfAborted();
      outcome.added.push(type);
      configuredTypes.add(type as AgentType);
    } catch (error) {
      outcome.errors.push(`could not enable ${type}: ${(error as Error).message}`);
    }
  }

  // 3. Image-based authentication — only for selected agents that actually have
  //    a login plan, and only for the ones the user confirms.
  let loginable: Set<string>;
  signal?.throwIfAborted();
  try {
    loginable = new Set(await actions.loginableAgents(signal));
    signal?.throwIfAborted();
  } catch (error) {
    outcome.errors.push(`could not determine which agents support image login: ${(error as Error).message}`);
    loginable = new Set();
  }
  const candidates = selectedAgents.filter((type) => loginable.has(type));
  if (candidates.length > 0 && confirmLogin) {
    let chosen: string[] = [];
    try {
      chosen = await confirmLogin({ candidates, rootDir });
    } catch (error) {
      // A failed/cancelled prompt must not abort the whole run — validation and
      // exact recovery commands are still useful.
      outcome.errors.push(`agent login prompt failed: ${(error as Error).message}`);
    }
    const chosenSet = new Set(chosen.filter((type) => loginable.has(type)));
    // Iterate the candidate order (not the user's), so logins run in a stable order.
    for (const type of candidates) {
      if (!chosenSet.has(type)) continue;
      signal?.throwIfAborted();
      try {
        onLog?.(`authenticating ${type} through its image…`);
        const result = await actions.loginAgent(rootDir, type, signal);
        signal?.throwIfAborted();
        if (result.detail) onLog?.(result.detail);
        if (result.available && result.success) outcome.authenticated.push(type);
        else outcome.authFailed.push(type);
      } catch (error) {
        outcome.authFailed.push(type);
        outcome.errors.push(`login for ${type} failed: ${(error as Error).message}`);
      }
    }
  }

  // 4. Always validate the selected agents from the same image/mount shape the
  // worker uses. This is one live call per agent (host calls are deliberately
  // skipped), so setup catches a successful host login that was not mounted into
  // Docker without doubling subscription usage.
  signal?.throwIfAborted();
  try {
    onLog?.(`checking agent connectivity through worker image${selectedAgents.length === 1 ? "" : "s"}…`);
    const checks = await actions.validateAgents(rootDir, selectedAgents, signal);
    signal?.throwIfAborted();
    for (const check of checks) {
      onLog?.(`${check.type}: ${check.detail}`);
      if (check.status === "ok") {
        outcome.validated.push(check.type);
        continue;
      }
      outcome.validationFailed.push(check.type);
      if (loginable.has(check.type)) outcome.nextCommands.push(`propr agent login ${check.type}`);
      outcome.nextCommands.push(`propr check agents --agents ${check.type}`);
    }
  } catch (error) {
    outcome.errors.push(`could not validate agent connectivity: ${(error as Error).message}`);
    for (const type of selectedAgents) {
      if (loginable.has(type)) outcome.nextCommands.push(`propr agent login ${type}`);
      outcome.nextCommands.push(`propr check agents --agents ${type}`);
    }
  }

  outcome.nextCommands = Array.from(new Set(outcome.nextCommands));

  return outcome;
}
