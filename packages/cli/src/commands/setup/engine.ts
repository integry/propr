/**
 * Setup wizard engine.
 *
 * `propr setup` walks a new user from a bare host to a running local
 * control-plane stack. It combines what `propr check` and `propr init stack`
 * already do, then sequences the remaining one-time tasks — pulling images,
 * recording agent credentials, choosing GitHub auth, starting the stack and
 * validating its health, configuring the whitelist, optionally connecting a
 * first repository, and surfacing the UI URL.
 *
 * The engine is intentionally UI-agnostic. It owns the *order* of the flow and
 * the *decision logic* (what to run, what to skip, what is safe), but performs
 * no rendering and prompts no user directly. Two seams keep it decoupled:
 *
 *   - {@link SetupPrompts} — callback hooks a renderer supplies to collect user
 *     decisions (which agents, which auth mode, whether to add a repo, …). Every
 *     hook is optional; a missing hook falls back to a safe, non-interactive
 *     default (keep what exists, skip optional work). Ink and the readline
 *     fallback will provide these in later issues.
 *   - {@link SetupActions} — the side-effecting operations (run checks, scaffold,
 *     pull, start, health-probe, add repo). Defaults bind to the real
 *     orchestrator and commands via {@link createDefaultActions}; tests inject
 *     mocks so the whole flow runs without Docker, the network, or a TTY.
 *
 * Safety contract (enforced here, not just by convention):
 *   - The stack is initialized only when `.env` is missing or the user picks a
 *     new root — an existing functional install is left intact on re-run.
 *   - `.env` is never overwritten wholesale; edits go through the non-destructive
 *     {@link applyEnvSelection} (per-key, never blanks an existing value).
 *   - No step deletes user data; a running stack is reused, not recreated.
 *   - Core images pull by default; agent images pull only for selected agents.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GithubAuthMode, GithubAuthModeResult } from "@propr/shared";
import type { ConfigManager } from "../../config/index.js";
import type { ChecksOutcome, RunChecksOptions } from "../checkCommands.js";
import type { InitStackOptions, InitStackResult } from "../initStack.js";
import {
  applyEnvSelection,
  createSetupState,
  detectGithubAuthMode,
  getStep,
  inspectStackInit,
  isSetupComplete,
  readEnvVars,
  resolveSetupRoot,
  updateStep,
  type EnvSelectionResult,
  type StackInitState,
} from "./state.js";
import type { SetupState, SetupStep, SetupStepId, SetupStepPatch } from "./types.js";

/**
 * Catalog of supported agents: the image each one needs and the host
 * credential directories recorded into `.env` when it is selected. Mirrors
 * `agentDescriptors()` in ../checkCommands.ts and `detectCredentials()` in
 * ../initStack.ts — kept local so the engine has no rendering/command imports.
 */
interface AgentDescriptor {
  type: string;
  /** Manifest image key, e.g. "agent-claude". */
  imageKey: string;
  /** Host credential dirs mounted into the agent container. */
  credentials: { envKey: string; defaultDir: string }[];
}

function agentCatalog(): AgentDescriptor[] {
  const home = homedir();
  return [
    { type: "claude", imageKey: "agent-claude", credentials: [{ envKey: "HOST_CLAUDE_DIR", defaultDir: join(home, ".claude") }] },
    { type: "codex", imageKey: "agent-codex", credentials: [{ envKey: "HOST_CODEX_DIR", defaultDir: join(home, ".codex") }] },
    { type: "antigravity", imageKey: "agent-antigravity", credentials: [{ envKey: "HOST_ANTIGRAVITY_DIR", defaultDir: join(home, ".gemini") }] },
    {
      type: "opencode",
      imageKey: "agent-opencode",
      credentials: [
        { envKey: "HOST_OPENCODE_XDG_DIR", defaultDir: join(home, ".config", "opencode") },
        { envKey: "HOST_OPENCODE_DATA_DIR", defaultDir: join(home, ".local", "share", "opencode") },
      ],
    },
    { type: "vibe", imageKey: "agent-vibe", credentials: [{ envKey: "HOST_VIBE_DIR", defaultDir: join(home, ".vibe") }] },
  ];
}

/** Agent types whose default credential directory exists on this host. */
function detectInstalledAgents(catalog: AgentDescriptor[]): string[] {
  return catalog.filter((a) => a.credentials.some((c) => existsSync(c.defaultDir))).map((a) => a.type);
}

// ---------------------------------------------------------------------------
// Decisions the renderer collects from the user.
// ---------------------------------------------------------------------------

/** Where to put the stack, and whether to scaffold it. */
export interface RootDecision {
  /** Stack root to use (absolute). May differ from the resolved default. */
  rootDir: string;
  /** Scaffold `.env`/data/logs/repos here. Only honored when safe to do so. */
  reinitialize: boolean;
}

/** Outcome of the GitHub-auth prompt. */
export interface GithubAuthDecision {
  /** Keep the existing configuration untouched. */
  keep?: boolean;
  /** Informational: the auth mode the user picked. */
  mode?: GithubAuthMode;
  /** Env values to write (non-destructively, overwriting only these keys). */
  vars?: Record<string, string>;
}

/** A repository to start monitoring. */
export interface RepoSelection {
  fullName: string;
  alias?: string;
  baseBranch?: string;
}

/**
 * Hooks a renderer implements to drive user decisions. All optional: a missing
 * hook means "use the safe default" (keep existing config, skip optional work),
 * which is exactly what lets the engine run unattended in tests.
 */
export interface SetupPrompts {
  /** Choose/confirm the stack root. Default: keep resolved root, scaffold only if `.env` is absent. */
  resolveStackRoot?(ctx: { currentRoot: string; init: StackInitState }): Promise<RootDecision>;
  /** Pick which agents to enable. Default: the agents detected on this host. */
  selectAgents?(ctx: { available: string[]; detected: string[] }): Promise<string[]>;
  /** Configure GitHub auth. Default: keep whatever `.env` already has. */
  configureGithubAuth?(ctx: { current: GithubAuthModeResult }): Promise<GithubAuthDecision>;
  /** Confirm starting the stack. Default: start it. */
  confirmStartStack?(ctx: { rootDir: string; alreadyRunning: boolean }): Promise<boolean>;
  /** Provide the user whitelist. Return null to keep the current value. Default: keep. */
  configureWhitelist?(ctx: { current: string[]; demoMode: boolean }): Promise<string[] | null>;
  /** Optionally add a first repository. Return null to skip. Default: skip. */
  addRepository?(ctx: { rootDir: string }): Promise<RepoSelection | null>;
  /** Open the UI. Default: just report the URL. */
  launchUi?(ctx: { url: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Progress reporting.
// ---------------------------------------------------------------------------

/** Progress hooks a renderer implements to reflect engine state. All optional. */
export interface SetupReporter {
  /** Fired after every state transition with the latest immutable snapshot. */
  onState?(state: SetupState): void;
  /** Fired when a step becomes active. */
  onStepStart?(step: SetupStep): void;
  /** Fired when a step reaches a terminal status. */
  onStepSettled?(step: SetupStep): void;
  /** Free-form progress lines (e.g. docker pull output). */
  onLog?(line: string): void;
}

// ---------------------------------------------------------------------------
// Injectable side effects.
// ---------------------------------------------------------------------------

export interface PullImagesParams {
  rootDir: string;
  /** Agent types whose images should be pulled (in addition to core images). */
  agentTypes: string[];
  skipRemoteImageCheck?: boolean;
  onLog?: (line: string) => void;
}

export interface PullImagesResult {
  pulledCore: string[];
  pulledAgents: string[];
  /** Core images that failed to pull — fatal, the stack cannot start. */
  failedCore: string[];
  /** Agent images that failed to pull — non-fatal, only those agents are affected. */
  failedAgents: string[];
}

export interface StartStackParams {
  rootDir: string;
  ui?: boolean;
  docs?: boolean;
  onLog?: (line: string) => void;
}

export interface BackendHealthParams {
  rootDir: string;
  timeoutMs?: number;
}

export interface BackendHealth {
  healthy: boolean;
  detail: string;
}

/**
 * The operations the engine performs against the outside world. Defaults bind
 * to the real orchestrator/commands (see {@link createDefaultActions}); tests
 * override any subset.
 */
export interface SetupActions {
  runChecks(options: RunChecksOptions): Promise<ChecksOutcome>;
  inspectStackInit(rootDir: string): StackInitState;
  scaffoldStack(options: InitStackOptions): Promise<InitStackResult>;
  readEnvVars(rootDir: string): Record<string, string>;
  applyEnvSelection(rootDir: string, vars: Record<string, string>, opts?: { overwrite?: boolean }): EnvSelectionResult;
  detectGithubAuthMode(rootDir: string): GithubAuthModeResult;
  pullImages(params: PullImagesParams): Promise<PullImagesResult>;
  isStackRunning(rootDir: string): Promise<boolean>;
  startStack(params: StartStackParams): Promise<void>;
  checkBackendHealth(params: BackendHealthParams): Promise<BackendHealth>;
  addRepository(selection: RepoSelection, rootDir: string): Promise<void>;
  resolveUiUrl(rootDir: string): Promise<string>;
}

/** Options for {@link runSetup}. */
export interface RunSetupOptions {
  configManager?: ConfigManager;
  /** Explicit stack root flag (highest precedence). */
  root?: string;
  prompts?: SetupPrompts;
  reporter?: SetupReporter;
  /** Override any subset of the default actions (tests inject mocks here). */
  actions?: Partial<SetupActions>;
  skipRemoteImageCheck?: boolean;
}

/** Final outcome of a setup run. */
export interface SetupRunResult {
  rootDir: string;
  state: SetupState;
  /** Environment-check outcome, when the check step ran. */
  checks?: ChecksOutcome;
  /** True when every required step finished without a blocking failure. */
  completed: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the production {@link SetupActions}, lazily importing the heavy
 * orchestrator/command/API modules only when an action actually runs. This
 * keeps `import`ing the engine cheap (and Docker-free) for tests, which replace
 * these actions anyway.
 */
export function createDefaultActions(configManager?: ConfigManager): SetupActions {
  /** A client pointed at the local stack's API port (not the saved remote URL). */
  const localApiClient = async (rootDir: string): Promise<import("../../api/client.js").ApiClient> => {
    const { getHostConfig } = await import("../../orchestrator/index.js");
    const { cfg } = await getHostConfig({ configManager, root: rootDir });
    const { createApiClient } = await import("../../api/client.js");
    return createApiClient({ baseUrl: `http://localhost:${cfg.apiPort}` });
  };

  return {
    async runChecks(options) {
      const { runChecks } = await import("../checkCommands.js");
      return runChecks(options);
    },
    inspectStackInit,
    async scaffoldStack(options) {
      const { scaffoldStack } = await import("../initStack.js");
      return scaffoldStack(options);
    },
    readEnvVars,
    applyEnvSelection,
    detectGithubAuthMode,
    async pullImages({ rootDir, agentTypes, onLog }) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      const selected = new Set(agentTypes);
      const result: PullImagesResult = { pulledCore: [], pulledAgents: [], failedCore: [], failedAgents: [] };

      for (const [key, tag] of Object.entries(cfg.images)) {
        if (key === "docs" && !cfg.docsEnabled) continue;
        const isAgent = key.startsWith("agent-");
        // Only pull agent images for the agents the user selected; core images
        // (api/worker/daemon/redis/…) always pull.
        if (isAgent && !selected.has(key.slice("agent-".length))) continue;

        onLog?.(`pulling ${tag}…`);
        const pulled = orch.docker(["pull", tag], { capture: true });
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
    async isStackRunning(rootDir) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      return orch.isStackRunning(cfg);
    },
    async startStack({ rootDir, ui, docs, onLog }) {
      const { getHostConfig } = await import("../../orchestrator/index.js");
      const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
      orch.ensureNetwork(cfg, onLog);
      orch.startStack(cfg, {
        ui: ui ?? configManager?.getUiEnabled() ?? true,
        docs: docs ?? cfg.docsEnabled,
        onLog,
      });
    },
    async checkBackendHealth({ rootDir, timeoutMs = 60_000 }) {
      const { getSystemStatus } = await import("../../api/system.js");
      const client = await localApiClient(rootDir);
      const deadline = Date.now() + timeoutMs;
      let lastError = "no response";
      // Containers take a few seconds to report healthy; poll until the deadline.
      do {
        try {
          const status = await getSystemStatus(client);
          if (String(status.api).toLowerCase() === "healthy") {
            return { healthy: true, detail: `API healthy (daemon ${status.daemon}, worker ${status.worker})` };
          }
          lastError = `API reports "${status.api}"`;
        } catch (error) {
          lastError = (error as Error).message;
        }
        if (Date.now() >= deadline) break;
        await sleep(2_000);
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
      return `http://localhost:${cfg.uiPort}`;
    },
  };
}

/**
 * Run the setup flow end to end, in a safe order, driven by the supplied
 * prompts and reflected through the reporter. Returns the final step state and
 * the environment-check outcome. Never throws for expected conditions (a failed
 * required step stops the flow and is reported in the returned state); only
 * truly unexpected programmer errors propagate.
 */
export async function runSetup(options: RunSetupOptions = {}): Promise<SetupRunResult> {
  const { configManager, prompts = {}, reporter = {}, skipRemoteImageCheck } = options;
  const actions: SetupActions = { ...createDefaultActions(configManager), ...options.actions };
  const catalog = agentCatalog();

  let rootDir = resolveSetupRoot(configManager, options.root);
  let state = createSetupState(rootDir);
  let checks: ChecksOutcome | undefined;
  /** Agents chosen at the pull step, reused when recording credentials. */
  let selectedAgents: string[] = [];

  const emit = (): void => reporter.onState?.(state);
  const stepOf = (id: SetupStepId): SetupStep => getStep(state, id)!;
  const begin = (id: SetupStepId): void => {
    state = updateStep(state, id, { status: "active", detail: undefined, nextAction: undefined });
    emit();
    reporter.onStepStart?.(stepOf(id));
  };
  const settle = (id: SetupStepId, patch: SetupStepPatch): void => {
    state = updateStep(state, id, patch);
    emit();
    reporter.onStepSettled?.(stepOf(id));
  };
  const log = (line: string): void => reporter.onLog?.(line);
  const finish = (): SetupRunResult => ({ rootDir, state, checks, completed: isSetupComplete(state) });

  emit();

  // 1. Environment checks — run first; their results steer the rest.
  begin("check");
  try {
    checks = await actions.runChecks({ root: rootDir, skipRemoteImageCheck });
  } catch (error) {
    settle("check", {
      status: "failed",
      detail: `could not run environment checks: ${(error as Error).message}`,
      nextAction: "Resolve the error above, then re-run setup.",
    });
    return finish();
  }
  const dockerProblem = blockingDockerFailure(checks);
  if (dockerProblem) {
    settle("check", {
      status: "failed",
      detail: dockerProblem,
      nextAction: "Install/start Docker and ensure this user can run `docker info`, then re-run setup.",
    });
    return finish();
  }
  const fails = checks.results.filter((r) => r.status === "fail").length;
  const warns = checks.results.filter((r) => r.status === "warn").length;
  settle("check", {
    status: warns > 0 || fails > 0 ? "warning" : "done",
    detail: `${checks.results.length} checks (${fails} failing, ${warns} warnings) — addressing them below`,
  });

  // 2. Initialize stack — only when `.env` is missing or the user picks a new
  //    root. An existing functional install is never re-scaffolded or clobbered.
  begin("init-stack");
  try {
    let init = actions.inspectStackInit(rootDir);
    let userChoseReinit = false;
    if (prompts.resolveStackRoot) {
      const decision = await prompts.resolveStackRoot({ currentRoot: rootDir, init });
      if (decision.rootDir && decision.rootDir !== rootDir) {
        rootDir = decision.rootDir;
        state = { ...state, rootDir };
        init = actions.inspectStackInit(rootDir);
      }
      userChoseReinit = decision.reinitialize;
    }

    // Scaffold when `.env` is missing, or when the user explicitly chose to
    // (re)initialize a root. scaffoldStack runs without `force`, so an existing
    // `.env` is always preserved — re-running setup never clobbers it.
    const reinitialize = !init.envExists || userChoseReinit;
    if (reinitialize) {
      // No `force`: scaffoldStack creates a fresh `.env` only when absent and
      // otherwise leaves the existing one in place.
      const result = await actions.scaffoldStack({ root: rootDir });
      const created = [...result.dirsCreated];
      settle("init-stack", {
        status: "done",
        detail: result.envCreated
          ? `scaffolded stack at ${rootDir}${created.length ? ` (created ${created.join(", ")})` : ""}`
          : `stack root ready at ${rootDir} (existing .env kept)`,
      });
    } else {
      settle("init-stack", { status: "skipped", detail: `using existing stack at ${rootDir} (.env preserved)` });
    }
  } catch (error) {
    settle("init-stack", {
      status: "failed",
      detail: `could not initialize stack: ${(error as Error).message}`,
      nextAction: "Check directory permissions and that .env.example is available, then re-run setup.",
    });
    return finish();
  }

  // 3. Pull images — core images by default, agent images only for the agents
  //    the user selects (defaulting to the ones detected on this host).
  begin("pull-images");
  const detected = detectInstalledAgents(catalog);
  selectedAgents = prompts.selectAgents
    ? await prompts.selectAgents({ available: catalog.map((a) => a.type), detected })
    : detected;
  try {
    const pull = await actions.pullImages({ rootDir, agentTypes: selectedAgents, skipRemoteImageCheck, onLog: log });
    if (pull.failedCore.length > 0) {
      settle("pull-images", {
        status: "failed",
        detail: `failed to pull core image(s): ${pull.failedCore.join(", ")}`,
        nextAction: "Check registry access / network and re-run setup; the stack cannot start without core images.",
      });
      return finish();
    }
    const pulledCount = pull.pulledCore.length + pull.pulledAgents.length;
    if (pull.failedAgents.length > 0) {
      settle("pull-images", {
        status: "warning",
        detail: `pulled ${pulledCount} image(s); ${pull.failedAgents.length} agent image(s) unavailable`,
        nextAction: "Jobs using those agents fail until their images pull. Re-run `propr images pull` later.",
      });
    } else {
      settle("pull-images", { status: "done", detail: `pulled ${pulledCount} image(s)` });
    }
  } catch (error) {
    settle("pull-images", {
      status: "failed",
      detail: `could not pull images: ${(error as Error).message}`,
      nextAction: "Check Docker and registry access, then re-run setup.",
    });
    return finish();
  }

  // 4. Configure agents — record detected host credential dirs for the selected
  //    agents, non-destructively (never blanks an existing value).
  begin("configure-agents");
  if (selectedAgents.length === 0) {
    settle("configure-agents", {
      status: "skipped",
      detail: "no agents selected",
      nextAction: "Log in with an agent CLI on this host, then re-run setup to record its credentials.",
    });
  } else {
    const vars: Record<string, string> = {};
    for (const type of selectedAgents) {
      const desc = catalog.find((a) => a.type === type);
      if (!desc) continue;
      for (const cred of desc.credentials) {
        if (existsSync(cred.defaultDir)) vars[cred.envKey] = cred.defaultDir;
      }
    }
    const applied = actions.applyEnvSelection(rootDir, vars, { overwrite: false });
    const detailParts: string[] = [];
    detailParts.push(applied.written.length > 0 ? `recorded ${applied.written.length} credential dir(s)` : "no new credentials to record");
    if (applied.skipped.length > 0) detailParts.push(`${applied.skipped.length} already set`);
    settle("configure-agents", { status: "done", detail: detailParts.join("; ") });
  }

  // 5. GitHub authentication — keep what works; only write the keys the user
  //    explicitly chose. An unresolved mode is a warning, not a hard stop: the
  //    health probe after startup is the authoritative signal.
  begin("github-auth");
  const currentAuth = actions.detectGithubAuthMode(rootDir);
  let authDecision: GithubAuthDecision | undefined;
  if (prompts.configureGithubAuth) authDecision = await prompts.configureGithubAuth({ current: currentAuth });
  if (authDecision?.vars && Object.keys(authDecision.vars).length > 0) {
    actions.applyEnvSelection(rootDir, authDecision.vars, { overwrite: true });
  }
  const resolvedAuth = actions.detectGithubAuthMode(rootDir);
  if (resolvedAuth.mode === "none") {
    settle("github-auth", {
      status: "warning",
      detail: "no GitHub auth configured",
      nextAction: "Set a GitHub App, a token relay, or demo mode in .env (the backend will not boot otherwise).",
    });
  } else {
    settle("github-auth", { status: "done", detail: `auth mode: ${resolvedAuth.mode}` });
  }

  // 6. Start the stack and validate backend health. A running stack is reused,
  //    not recreated, so user data and live work are untouched.
  begin("start-stack");
  const alreadyRunning = await actions.isStackRunning(rootDir);
  const startConfirmed = prompts.confirmStartStack ? await prompts.confirmStartStack({ rootDir, alreadyRunning }) : true;
  if (!startConfirmed) {
    settle("start-stack", {
      status: "skipped",
      detail: "stack not started (skipped)",
      nextAction: "Start it later with `propr start`.",
    });
  } else {
    try {
      if (alreadyRunning) {
        log("stack already running — leaving it intact");
      } else {
        await actions.startStack({ rootDir, onLog: log });
      }
    } catch (error) {
      settle("start-stack", {
        status: "failed",
        detail: `could not start the stack: ${(error as Error).message}`,
        nextAction: "Run `propr start` to see the full startup output.",
      });
      return finish();
    }
    const health = await actions.checkBackendHealth({ rootDir });
    settle(
      "start-stack",
      health.healthy
        ? { status: "done", detail: alreadyRunning ? `stack already running — ${health.detail}` : health.detail }
        : {
            status: "warning",
            detail: health.detail,
            nextAction: "Give the services a moment, then run `propr status` / `propr remote-status` to inspect them.",
          }
    );
  }

  // 7. Whitelist — restrict who can trigger ProPR. Written non-destructively.
  begin("whitelist");
  const envNow = actions.readEnvVars(rootDir);
  const currentWhitelist = (envNow.GITHUB_USER_WHITELIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const demoMode = resolvedAuth.mode === "demo";
  let whitelist: string[] | null = null;
  if (prompts.configureWhitelist) whitelist = await prompts.configureWhitelist({ current: currentWhitelist, demoMode });
  if (whitelist && whitelist.length > 0) {
    const cleaned = whitelist.map((s) => s.trim()).filter(Boolean);
    actions.applyEnvSelection(rootDir, { GITHUB_USER_WHITELIST: cleaned.join(",") }, { overwrite: true });
    settle("whitelist", { status: "done", detail: `${cleaned.length} user(s) allowed` });
  } else if (currentWhitelist.length > 0) {
    settle("whitelist", { status: "done", detail: `${currentWhitelist.length} user(s) already allowed` });
  } else if (demoMode) {
    settle("whitelist", { status: "skipped", detail: "demo mode — whitelist not required" });
  } else {
    settle("whitelist", {
      status: "warning",
      detail: "no whitelist configured — any authenticated GitHub user could trigger processing",
      nextAction: "Set GITHUB_USER_WHITELIST in .env to a comma-separated list of allowed usernames.",
    });
  }

  // 8. Repository (optional) — adding a repo must never fail the whole run.
  begin("repo");
  let repoSelection: RepoSelection | null = null;
  if (prompts.addRepository) repoSelection = await prompts.addRepository({ rootDir });
  if (!repoSelection) {
    settle("repo", { status: "skipped", detail: "no repository added" });
  } else {
    try {
      await actions.addRepository(repoSelection, rootDir);
      settle("repo", { status: "done", detail: `monitoring ${repoSelection.fullName}` });
    } catch (error) {
      settle("repo", {
        status: "warning",
        detail: `could not add ${repoSelection.fullName}: ${(error as Error).message}`,
        nextAction: "Add it later with `propr repo add <owner/repo>`.",
      });
    }
  }

  // 9. UI (optional) — surface the URL; opening it is the renderer's job.
  begin("launch-ui");
  let uiUrl = "";
  try {
    uiUrl = await actions.resolveUiUrl(rootDir);
  } catch {
    /* non-fatal: just omit the URL */
  }
  const opened = prompts.launchUi ? await prompts.launchUi({ url: uiUrl }) : false;
  settle("launch-ui", {
    status: opened ? "done" : "skipped",
    detail: uiUrl ? `UI available at ${uiUrl}` : "UI URL unavailable",
  });

  return finish();
}

/**
 * Detect an environment problem that blocks the entire flow: Docker missing or
 * its daemon unreachable. Other failures (e.g. GitHub auth) are addressed by
 * later steps and must not abort setup here.
 */
function blockingDockerFailure(outcome: ChecksOutcome): string | undefined {
  const failed = (name: string): string | undefined =>
    outcome.results.find((r) => r.name === name && r.status === "fail")?.detail;
  return failed("Docker installed") ?? failed("Docker daemon");
}
