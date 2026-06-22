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
import { parseTruthyEnvValue, type GithubAuthMode, type GithubAuthModeResult } from "@propr/shared";
import type { ConfigManager } from "../../config/index.js";
import {
  buildIntakeEnvVars,
  defaultIntakeChoice,
  saveWhitelist,
  type GithubIntakeDecision,
  type GithubIntakeMode,
} from "./github.js";
import type { ChecksOutcome, RunChecksOptions } from "../checkCommands.js";
import type { InitStackOptions, InitStackResult } from "../initStack.js";
import {
  createDefaultAgentSetupActions,
  runAgentSetup,
  type AgentSetupActions,
} from "./agents.js";
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
  /**
   * Ensure this root is scaffolded, creating any *missing* `.env`/data/logs/repos
   * pieces. Non-destructive: scaffolding runs without `force`, so an existing
   * `.env` is always preserved — this fills in what is absent, it never resets a
   * working install. (A root with a missing `.env` or sub-directory is scaffolded
   * regardless of this flag; the flag only forces a scaffold pass on a root that
   * already looks complete.)
   */
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
  /**
   * Choose how the backend ingests GitHub events (App/relay, polling, or
   * direct webhooks). `defaultMode` is the choice to pre-select: the auth-derived
   * recommendation on a fresh install, but `"keep"` when `.env` already carries
   * an intake decision so a blank Enter never rewrites a working config.
   * `webhooksEnabled` reflects the current `.env`. Default: keep.
   */
  configureIntake?(ctx: {
    authMode: GithubAuthMode;
    defaultMode: GithubIntakeMode | "keep";
    webhooksEnabled: boolean;
  }): Promise<GithubIntakeDecision>;
  /** Confirm starting the stack. Default: start it. */
  confirmStartStack?(ctx: { rootDir: string; alreadyRunning: boolean }): Promise<boolean>;
  /**
   * Choose which of the selected agents to authenticate through their image
   * (only agents with an image-login plan are offered). Returns the subset to
   * log in. Default: authenticate none.
   */
  confirmAgentLogin?(ctx: { candidates: string[]; rootDir: string }): Promise<string[]>;
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
export interface SetupActions extends AgentSetupActions {
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
  /**
   * Save the user whitelist through the running backend's settings API. A
   * partial update — only the whitelist key is sent, so unrelated settings are
   * left intact.
   */
  saveWhitelistSetting(rootDir: string, users: string[]): Promise<void>;
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
    // Agent enablement + image-login actions, bound to the local stack.
    ...createDefaultAgentSetupActions(configManager),
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
    async saveWhitelistSetting(rootDir, users) {
      const { updateSetting } = await import("../../api/settings.js");
      // Point the client at this stack's API port rather than the saved remote.
      const client = await localApiClient(rootDir);
      await updateSetting("github_user_whitelist", users, client);
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

    // Scaffold whenever the stack is incomplete — `.env` missing *or* a required
    // sub-directory (data/logs/repos) absent — or when the user explicitly chose
    // to (re)initialize a root. Keying off `initialized` (not just `envExists`)
    // means a half-scaffolded root with a stray `.env` but no `data/` still gets
    // its directories created, instead of being silently treated as ready and
    // failing later at startup. scaffoldStack runs without `force`, so an existing
    // `.env` is always preserved — re-running setup never clobbers it.
    const reinitialize = !init.initialized || userChoseReinit;
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
  try {
    const requested = prompts.selectAgents
      ? await prompts.selectAgents({ available: catalog.map((a) => a.type), detected })
      : detected;
    // Guard the engine boundary: a renderer may hand back unknown or duplicate
    // agent names. Keep only types we know about, de-duped (first occurrence
    // wins), so unknown names never reach pullImages() and a duplicate can't
    // double-apply credentials in the configure-agents step below.
    const known = new Set(catalog.map((a) => a.type));
    selectedAgents = [...new Set(requested)].filter((type) => known.has(type));

    const pull = await actions.pullImages({ rootDir, agentTypes: selectedAgents, onLog: log });
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
  try {
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
  } catch (error) {
    settle("configure-agents", {
      status: "failed",
      detail: `could not record agent credentials: ${(error as Error).message}`,
      nextAction: "Check write permissions on .env, then re-run setup.",
    });
    return finish();
  }

  // 5. GitHub authentication — keep what works; only write the keys the user
  //    explicitly chose. An unresolved mode is a warning, not a hard stop: the
  //    health probe after startup is the authoritative signal.
  begin("github-auth");
  let resolvedAuth: GithubAuthModeResult;
  try {
    const currentAuth = actions.detectGithubAuthMode(rootDir);
    let authDecision: GithubAuthDecision | undefined;
    if (prompts.configureGithubAuth) authDecision = await prompts.configureGithubAuth({ current: currentAuth });
    if (authDecision?.vars && Object.keys(authDecision.vars).length > 0) {
      actions.applyEnvSelection(rootDir, authDecision.vars, { overwrite: true });
    }
    resolvedAuth = actions.detectGithubAuthMode(rootDir);
  } catch (error) {
    settle("github-auth", {
      status: "failed",
      detail: `could not configure GitHub auth: ${(error as Error).message}`,
      nextAction: "Check .env access and your GitHub auth settings, then re-run setup.",
    });
    return finish();
  }
  if (resolvedAuth.mode === "none") {
    settle("github-auth", {
      status: "warning",
      detail: "no GitHub auth configured",
      nextAction: "Set a GitHub App, a token relay, or demo mode in .env (the backend will not boot otherwise).",
    });
  } else if (resolvedAuth.warnings.length > 0) {
    // The mode resolves, but the shared detector flagged a partial/ambiguous
    // configuration — surface it so the user can fix it before it bites later.
    settle("github-auth", {
      status: "warning",
      detail: `auth mode: ${resolvedAuth.mode} — ${resolvedAuth.warnings.join("; ")}`,
    });
  } else {
    settle("github-auth", { status: "done", detail: `auth mode: ${resolvedAuth.mode}` });
  }

  // 5b. GitHub event intake — how the backend learns about GitHub events
  //     (App/relay, polling, or direct webhooks). Written before startup because
  //     the API/daemon read ENABLE_GITHUB_WEBHOOKS / GH_WEBHOOK_SECRET at boot.
  //     Demo mode has no GitHub access, so there is nothing to ingest.
  begin("intake");
  try {
    if (resolvedAuth.mode === "demo") {
      settle("intake", { status: "skipped", detail: "demo mode — no GitHub events to ingest" });
    } else {
      const envNow = actions.readEnvVars(rootDir);
      const webhooksEnabled = parseTruthyEnvValue(envNow.ENABLE_GITHUB_WEBHOOKS);
      // When `.env` already records an intake decision, default the prompt to
      // "keep" so a blank Enter on a re-run can't silently flip a working config
      // (e.g. disable existing direct webhooks). Only a fresh install falls back
      // to the auth-derived recommendation.
      const intakeConfigured = envNow.ENABLE_GITHUB_WEBHOOKS !== undefined;
      const defaultMode = defaultIntakeChoice(resolvedAuth.mode, { intakeConfigured });
      let decision: GithubIntakeDecision | undefined;
      if (prompts.configureIntake) {
        decision = await prompts.configureIntake({ authMode: resolvedAuth.mode, defaultMode, webhooksEnabled });
      }
      if (decision && !decision.keep && decision.mode) {
        // buildIntakeEnvVars rejects an empty webhook secret — caught below and
        // surfaced as a warning rather than writing a config the API won't boot.
        const vars = buildIntakeEnvVars(decision.mode, { webhookSecret: decision.webhookSecret });
        actions.applyEnvSelection(rootDir, vars, { overwrite: true });
        const label =
          decision.mode === "webhooks"
            ? "direct webhooks (signing secret recorded)"
            : decision.mode === "polling"
              ? "polling (webhooks disabled)"
              : "ProPR App / shared relay (webhooks disabled)";
        settle("intake", { status: "done", detail: `intake: ${label}` });
      } else {
        settle("intake", {
          status: "done",
          detail: `intake: kept current (${webhooksEnabled ? "direct webhooks" : "polling / relay"})`,
        });
      }
    }
  } catch (error) {
    // An IntakeConfigError (e.g. webhooks chosen with no secret) is non-blocking:
    // leave intake as-is and tell the user how to finish it.
    settle("intake", {
      status: "warning",
      detail: `could not configure GitHub intake: ${(error as Error).message}`,
      nextAction:
        "Set ENABLE_GITHUB_WEBHOOKS (and GH_WEBHOOK_SECRET for webhooks) in .env, then re-run setup.",
    });
  }

  // 6. Start the stack and validate backend health. A running stack is reused,
  //    not recreated, so user data and live work are untouched.
  begin("start-stack");
  try {
    const alreadyRunning = await actions.isStackRunning(rootDir);
    const startConfirmed = prompts.confirmStartStack ? await prompts.confirmStartStack({ rootDir, alreadyRunning }) : true;
    if (!startConfirmed) {
      settle("start-stack", {
        status: "skipped",
        detail: "stack not started (skipped)",
        nextAction: "Start it later with `propr start`.",
      });
    } else {
      if (alreadyRunning) {
        log("stack already running — leaving it intact");
      } else {
        await actions.startStack({ rootDir, onLog: log });
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
  } catch (error) {
    settle("start-stack", {
      status: "failed",
      detail: `could not start the stack: ${(error as Error).message}`,
      nextAction: "Run `propr start` to see the full startup output.",
    });
    return finish();
  }

  // 7. Enable agents in the running backend — add the selected agents that are
  //    missing (existing ones are never disabled or deleted) and, on
  //    confirmation, authenticate the ones that support an image login. This
  //    runs after startup because it talks to the live backend API. Any problem
  //    is a non-blocking warning: agents can always be configured later.
  begin("enable-agents");
  try {
    const outcome = await runAgentSetup({
      rootDir,
      selectedAgents,
      actions,
      confirmLogin: prompts.confirmAgentLogin,
      onLog: log,
    });
    if (selectedAgents.length === 0) {
      settle("enable-agents", {
        status: "skipped",
        detail: "no agents selected",
        nextAction: "Enable agents later in the UI or with `propr agent add`.",
      });
    } else {
      const parts: string[] = [];
      if (outcome.added.length > 0) parts.push(`enabled ${outcome.added.join(", ")}`);
      if (outcome.alreadyConfigured.length > 0) parts.push(`${outcome.alreadyConfigured.length} already configured`);
      if (outcome.authenticated.length > 0) parts.push(`authenticated ${outcome.authenticated.join(", ")}`);
      if (outcome.authFailed.length > 0) parts.push(`${outcome.authFailed.length} login(s) did not complete`);
      const detail = parts.length > 0 ? parts.join("; ") : "no changes needed";
      if (outcome.errors.length > 0 || outcome.authFailed.length > 0) {
        settle("enable-agents", {
          status: "warning",
          detail: outcome.errors.length > 0 ? `${detail}; ${outcome.errors.join("; ")}` : detail,
          nextAction: "Enable or authenticate agents later in the UI or with `propr agent add` / `propr agent login`.",
        });
      } else {
        settle("enable-agents", { status: "done", detail });
      }
    }
  } catch (error) {
    // runAgentSetup is built not to throw for expected conditions; anything that
    // escapes is treated as a non-blocking warning so it can't abort setup.
    settle("enable-agents", {
      status: "warning",
      detail: `could not configure agents: ${(error as Error).message}`,
      nextAction: "Enable or authenticate agents later in the UI or with `propr agent add` / `propr agent login`.",
    });
  }

  // 8. Whitelist — restrict who can trigger ProPR. Written non-destructively.
  begin("whitelist");
  try {
    const envNow = actions.readEnvVars(rootDir);
    const currentWhitelist = (envNow.GITHUB_USER_WHITELIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const demoMode = resolvedAuth.mode === "demo";
    let whitelist: string[] | null = null;
    if (prompts.configureWhitelist) whitelist = await prompts.configureWhitelist({ current: currentWhitelist, demoMode });
    if (whitelist !== null) {
      // Trim, drop blanks, and de-dupe (first occurrence wins) so the value
      // matches saveWhitelist's "cleaned, de-duped usernames" contract — a
      // duplicate entry would otherwise inflate the saved count and settings.
      const cleaned = [...new Set(whitelist.map((s) => s.trim()).filter(Boolean))];
      // Prefer the settings API when the backend is up so the change applies
      // immediately (and never overwrites unrelated settings); always mirror into
      // .env so it survives a restart. Falls back to .env if the API is down.
      const backendRunning = await actions.isStackRunning(rootDir);
      const saved = await saveWhitelist({
        users: cleaned,
        backendRunning,
        saveViaSettings: (users) => actions.saveWhitelistSetting(rootDir, users),
        saveViaEnv: (users) =>
          actions.applyEnvSelection(rootDir, { GITHUB_USER_WHITELIST: users.join(",") }, { overwrite: true }),
      });
      const where = saved.target === "settings" ? "via settings API" : "in .env";
      const summary = cleaned.length > 0 ? `${cleaned.length} user(s) allowed (${where})` : `whitelist cleared (${where})`;
      if (saved.error) {
        settle("whitelist", {
          status: "warning",
          detail: `${summary}; settings update failed: ${saved.error}`,
          nextAction: "The whitelist is in .env; it will apply when the backend restarts.",
        });
      } else {
        settle("whitelist", { status: "done", detail: summary });
      }
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
  } catch (error) {
    settle("whitelist", {
      status: "failed",
      detail: `could not configure the whitelist: ${(error as Error).message}`,
      nextAction: "Check .env access, then re-run setup.",
    });
    return finish();
  }

  // 9. Repository (optional) — adding a repo must never fail the whole run.
  begin("repo");
  try {
    // The prompt itself is part of this optional step — a renderer that throws
    // while collecting the repo must degrade to a warning, not abort the run.
    const repoSelection = prompts.addRepository ? await prompts.addRepository({ rootDir }) : null;
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
  } catch (error) {
    settle("repo", {
      status: "warning",
      detail: `could not collect a repository to add: ${(error as Error).message}`,
      nextAction: "Add it later with `propr repo add <owner/repo>`.",
    });
  }

  // 10. UI (optional) — surface the URL; opening it is the renderer's job.
  begin("launch-ui");
  let uiUrl = "";
  try {
    uiUrl = await actions.resolveUiUrl(rootDir);
  } catch {
    /* non-fatal: just omit the URL */
  }
  let opened = false;
  try {
    opened = prompts.launchUi ? await prompts.launchUi({ url: uiUrl }) : false;
  } catch {
    /* opening the UI is best-effort; a failed launch prompt must not fail setup */
  }
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
 *
 * Keyed off the structured `Docker` check group rather than exact check names,
 * so re-wording a check in checkCommands.ts can't silently let setup continue
 * past a missing/unreachable engine. Within that group only the engine checks
 * ("Docker installed", "Docker daemon") ever report `fail`; the socket check is
 * informational and tops out at `warn`, so a `fail` here always means Docker
 * itself cannot run the stack.
 */
function blockingDockerFailure(outcome: ChecksOutcome): string | undefined {
  return outcome.results.find((r) => r.group === "Docker" && r.status === "fail")?.detail;
}
