/**
 * Local setup engine.
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
 *     pull, start, health-probe, add repo). A host must inject them explicitly;
 *     tests use in-memory implementations without Docker, network, or a TTY.
 *
 * Safety contract (enforced here, not just by convention):
 *   - The stack is initialized only when `.env` is missing or the user picks a
 *     new root — an existing functional install is left intact on re-run.
 *   - `.env` is never overwritten wholesale; edits go through the non-destructive
 *     {@link applyEnvSelection} (per-key, never blanks an existing value).
 *   - No step deletes user data; a running stack is reused, not recreated.
 *   - Core images pull by default; the agent image pulls when an agent is selected.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  resolveGithubEventIntakeMode,
  validateIntakeModePrerequisites,
  DEFAULT_PROPR_GH_RELAY_URL,
  type GithubAuthMode,
  type GithubAuthModeResult,
} from "@propr/shared";
import {
  buildIntakeEnvVars,
  defaultIntakeChoice,
  intakeModeLabel,
  saveWhitelist,
  type GithubIntakeDecision,
  type GithubIntakeMode,
} from "./github.js";
import {
  runAgentSetup,
  type AgentSetupActions,
} from "./agents.js";
import { isSetupCancellation } from "./cancellation.js";
import {
  createSetupState,
  getStep,
  isSetupComplete,
  updateStep,
  type EnvSelectionResult,
  type DatastoreAdminInspection,
  type StackInitState,
} from "./state.js";
import type { SetupState, SetupStep, SetupStepId, SetupStepPatch } from "./types.js";

const DEFAULT_PROPR_GITHUB_APP_INSTALL_URL = "https://github.com/apps/propr-dev/installations/new";

/** Match the API's distinction between real OAuth credentials and example placeholders. */
function isConfiguredOAuthValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && !normalized.startsWith("your_") && normalized !== "changeme");
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function normalizeServiceUrl(value: string | undefined): string | undefined {
  try {
    if (!value?.trim()) return undefined;
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function isSupportedLoopbackCallback(value: string | undefined): boolean {
  try {
    if (!value?.trim()) return false;
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/api/auth/github/callback" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Catalog of supported agents: the image each one needs and the host
 * credential directories recorded into `.env` when it is selected. Mirrors
 * `agentDescriptors()` in ../checkCommands.ts and `detectCredentials()` in
 * ../initStack.ts — kept local so the engine has no rendering/command imports.
 */
interface AgentDescriptor {
  type: string;
  /** Unified agent manifest image key. */
  imageKey: string;
  /** Host credential dirs mounted into the agent container. */
  credentials: { envKey: string; defaultDir: string }[];
}

/** Reject unsafe Docker bind sources before asking a host to create them. */
function assertSafeAgentCredentialDir(path: string, name = "Agent credential path"): void {
  if (
    !isAbsolute(path) ||
    normalize(path) === "/" ||
    path.includes(":") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(path)
  ) {
    throw new Error(`${name} must be an absolute, non-root Linux path without ':' or control characters`);
  }
}

function agentCatalog(): AgentDescriptor[] {
  const home = homedir();
  return [
    { type: "claude", imageKey: "agent", credentials: [{ envKey: "HOST_CLAUDE_DIR", defaultDir: join(home, ".claude") }] },
    { type: "codex", imageKey: "agent", credentials: [{ envKey: "HOST_CODEX_DIR", defaultDir: join(home, ".codex") }] },
    { type: "antigravity", imageKey: "agent", credentials: [{ envKey: "HOST_ANTIGRAVITY_DIR", defaultDir: join(home, ".gemini") }] },
    {
      type: "opencode",
      imageKey: "agent",
      credentials: [
        { envKey: "HOST_OPENCODE_XDG_DIR", defaultDir: join(home, ".config", "opencode") },
        { envKey: "HOST_OPENCODE_DATA_DIR", defaultDir: join(home, ".local", "share", "opencode") },
      ],
    },
    { type: "vibe", imageKey: "agent", credentials: [{ envKey: "HOST_VIBE_DIR", defaultDir: join(home, ".vibe") }] },
  ];
}

/** Reject unsafe Docker bind sources before any recursive filesystem write. */
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
  /**
   * Relay path: the user chose token relay and wants the engine to enroll on
   * their behalf (discover the installation, mint the token, write the relay
   * env vars) using the stored `propr login` token. `relayUrl` is the relay base
   * URL to enroll against — the hosted default unless overridden. Mutually
   * exclusive with `vars`.
   */
  enrollRelay?: { relayUrl: string };
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
   * Choose which installation to enroll when the relay reports more than one the
   * user can access. Only consulted for the ambiguous (>1) case; a single
   * installation is auto-selected and zero is an error. Default (no hook): the
   * first installation.
   */
  selectInstallation?(ctx: { installations: AuthorizedInstallation[] }): Promise<string>;
  /**
   * Ask whether to run the interactive `propr login` (gh CLI) now when Connect
   * enrollment or protected local API steps need a user token and none is
   * stored. `reason` explains which part of setup needs it.
   */
  confirmGithubLogin?(ctx: { reason: string }): Promise<boolean>;
  /** Offer to open the official hosted ProPR GitHub App installation page. */
  confirmGithubAppInstall?(ctx: { url: string }): Promise<boolean>;
  /** Continue enrollment after the user finishes the browser installation. */
  confirmGithubAppInstalled?(ctx: { url: string }): Promise<boolean>;
  /**
   * Choose how the backend ingests GitHub events (routing WebSocket, polling, or
   * direct webhooks). `defaultMode` is the choice to pre-select: the auth-derived
   * recommendation on a fresh install, but `"keep"` when `.env` already carries
   * an intake decision so a blank Enter never rewrites a working config.
   * `currentMode` is the intake mode `.env` resolves to today. Default: keep.
   */
  configureIntake?(ctx: {
    authMode: GithubAuthMode;
    defaultMode: GithubIntakeMode | "keep";
    currentMode: GithubIntakeMode;
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
  /**
   * Ask whether to open the UI in a browser. Returning `true` makes the engine
   * launch it (via {@link SetupActions.openUrl}); the renderer only collects the
   * yes/no. Default: don't open, just report the URL.
   */
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
  /** Structured event stream for non-renderer hosts such as Electron main. */
  onProgress?(event: SetupProgressEvent): void;
}

export type SetupProgressEvent =
  | { type: "state"; state: SetupState }
  | { type: "step-start"; step: SetupStep }
  | { type: "step-settled"; step: SetupStep }
  | { type: "log"; line: string };

// ---------------------------------------------------------------------------
// Injectable side effects.
// ---------------------------------------------------------------------------

/** Relay installation shape used by setup prompts and enrollment. */
export interface AuthorizedInstallation {
  installation_id: number;
  account_login: string;
  account_type: string;
}

/** Minimal environment-check contract consumed by the setup state machine. */
export interface SetupCheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  group?: string;
}

export interface RunChecksOptions {
  root?: string;
  skipRemoteImageCheck?: boolean;
  signal?: AbortSignal;
}

export interface ChecksOutcome {
  results: SetupCheckResult[];
  rootDir: string;
  anyFail: boolean;
  /** Host-specific configuration returned by a checker; opaque to the engine. */
  cfg?: unknown;
}

export interface InitStackOptions {
  root?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export interface InitStackResult {
  rootDir: string;
  envCreated: boolean;
  envSkipped: boolean;
  envBackedUp: boolean;
  dirsCreated: string[];
  dirsSkipped: string[];
  detected?: Array<{ envKey: string; path: string }>;
  credentialsAppended?: boolean;
  pendingCredentials?: Array<{ envKey: string; path: string }>;
  runtimeModeWarning?: string;
}

export interface PullImagesParams {
  rootDir: string;
  /** Agent types whose images should be pulled (in addition to core images). */
  agentTypes: string[];
  onLog?: (line: string) => void;
  signal?: AbortSignal;
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
  /** Main-process-only anchored path used to read setup files, never mounted. */
  rootOperationsDir?: string;
  ui?: boolean;
  docs?: boolean;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** Main-process authority check invoked at each Docker container handoff. */
  assertRootAuthority?(): void;
}

export interface BackendHealthParams {
  rootDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BackendHealth {
  healthy: boolean;
  detail: string;
  /**
   * Set when the backend answered the probe (it is reachable and running) but
   * rejected the request for authentication or authorization reasons rather
   * than being genuinely unhealthy. The value lets the caller recommend login
   * for a 401 without giving the same incorrect advice for a 403.
   */
  accessFailure?: "unauthorized" | "forbidden";
}

/** Classify an HTTP access failure from the protected backend status route. */
export function classifyBackendAccessError(error: unknown): BackendHealth | undefined {
  const httpStatus = (error as { status?: unknown } | null)?.status;
  if (httpStatus !== 401 && httpStatus !== 403) return undefined;

  const accessFailure = httpStatus === 401 ? "unauthorized" : "forbidden";
  const message = error instanceof Error ? error.message : String(error);
  return {
    healthy: false,
    accessFailure,
    detail: `backend is running but rejected the status request as ${accessFailure} (${message})`,
  };
}

/**
 * The operations the engine performs against the outside world. CLI, desktop,
 * and tests each provide their own implementation.
 */
export interface SetupActions extends AgentSetupActions {
  runChecks(options: RunChecksOptions): Promise<ChecksOutcome>;
  inspectStackInit(rootDir: string, signal?: AbortSignal): StackInitState;
  /** Inspect the configured datastore's durable administrator state without modifying it. */
  inspectDatastoreAdministrators(rootDir: string, signal?: AbortSignal): Promise<DatastoreAdminInspection>;
  scaffoldStack(options: InitStackOptions): Promise<InitStackResult>;
  /**
   * Persist the resolved stack root to the CLI config so later `propr start` /
   * `propr status` invoked without `--root` target this stack. `scaffoldStack`
   * already records it whenever it runs; this exists for the reuse path (an
   * already-initialized root that setup leaves untouched), which would otherwise
   * leave config pointing at a stale root or the cwd. A no-op without a config.
   */
  persistStackRoot(rootDir: string, signal?: AbortSignal): Promise<void>;
  readEnvVars(rootDir: string, signal?: AbortSignal): Record<string, string>;
  applyEnvSelection(rootDir: string, vars: Record<string, string>, opts?: { overwrite?: boolean }, signal?: AbortSignal): EnvSelectionResult;
  /** Remove keys from `.env` entirely (used to clear a value, not blank it). */
  clearEnvKeys(rootDir: string, keys: string[], signal?: AbortSignal): void;
  detectGithubAuthMode(rootDir: string, signal?: AbortSignal): GithubAuthModeResult;
  /** Ensure a selected agent's host credential path is a directory, creating it securely when absent. */
  prepareAgentCredentialDir(path: string, signal?: AbortSignal): void;
  pullImages(params: PullImagesParams): Promise<PullImagesResult>;
  isStackRunning(rootDir: string, signal?: AbortSignal): Promise<boolean>;
  startStack(params: StartStackParams): Promise<void>;
  checkBackendHealth(params: BackendHealthParams): Promise<BackendHealth>;
  addRepository(selection: RepoSelection, rootDir: string, signal?: AbortSignal): Promise<void>;
  resolveUiUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
  /** Open `url` in the host's default browser (best-effort; may reject). */
  openUrl(url: string, signal?: AbortSignal): Promise<void>;
  /**
   * Save the user whitelist through the running backend's settings API. A
   * partial update — only the whitelist key is sent, so unrelated settings are
   * left intact.
   */
  saveWhitelistSetting(rootDir: string, users: string[], signal?: AbortSignal): Promise<void>;
  /** True when a GitHub user token is stored (relay enrollment and protected local API calls need it). */
  hasGithubToken(signal?: AbortSignal): boolean;
  /**
   * List the relay installations the stored GitHub identity can access (drives
   * auto-select / the picker during relay enrollment). Throws if not logged in.
   */
  fetchRelayInstallations(params: {
    relayUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ username: string; installations: AuthorizedInstallation[] }>;
  /**
   * Mint a relay token for `installationId`, returning the token and the relay
   * URL it was minted against (the hosted default unless `relayUrl` overrides).
   */
  enrollRelay(params: {
    relayUrl?: string;
    installationId: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<{ relayUrl: string; token: string }>;
  /** Authenticate with GitHub via the interactive `gh` CLI and store the token. */
  loginWithGithub(params?: { onLog?: (line: string) => void; signal?: AbortSignal }): Promise<boolean>;
  /** Host preference used to select managed browser authentication. */
  getTunnelEnabled?(rootDir: string, signal?: AbortSignal): boolean | undefined;
}

/** Options for {@link runSetup}. */
export interface RunSetupOptions {
  /** Explicit stack root flag (highest precedence). */
  root?: string;
  prompts?: SetupPrompts;
  reporter?: SetupReporter;
  /** All host I/O is supplied explicitly; the engine has no Docker or login dependency. */
  actions: SetupActions;
  skipRemoteImageCheck?: boolean;
  /** Defaults to the current Node platform and is reported for capability presentation. */
  platform?: NodeJS.Platform;
  /** Cooperative cancellation, observed before every setup step. */
  signal?: AbortSignal;
}

export type LocalSetupCapability =
  | { supported: true; kind: "local"; platform: "linux" }
  | { supported: false; kind: "remote-only"; platform: NodeJS.Platform; reason: string };

/** Desktop-facing capability metadata; the platform-neutral engine does not use it as an execution gate. */
export function getLocalSetupCapability(platform: NodeJS.Platform = process.platform): LocalSetupCapability {
  if (platform === "linux") return { supported: true, kind: "local", platform };
  return {
    supported: false,
    kind: "remote-only",
    platform,
    reason: `Local setup is not supported on ${platform}; use a remote ProPR deployment.`,
  };
}

export interface SetupStructuredError {
  code: "local-unsupported" | "step-failed" | "cancelled";
  message: string;
  stepId?: SetupStepId;
  retryable: boolean;
  nextAction?: string;
}

/** Raised when an AbortSignal is observed between setup steps. */
export class SetupCancellation extends Error {
  readonly state: SetupState;

  constructor(state: SetupState) {
    super("Setup was cancelled.");
    this.name = "SetupCancellation";
    this.state = state;
  }
}

/** Final outcome of a setup run. */
export interface SetupRunResult {
  rootDir: string;
  state: SetupState;
  /** Capability metadata for adapters that present local-versus-remote setup choices. */
  capability: LocalSetupCapability;
  /** Environment-check outcome, when the check step ran. */
  checks?: ChecksOutcome;
  /** True when every required step finished without a blocking failure. */
  completed: boolean;
  cancelled: boolean;
  errors: SetupStructuredError[];
}

async function runSetupAttempt(options: RunSetupOptions): Promise<SetupRunResult> {
  const { prompts = {}, reporter = {}, skipRemoteImageCheck, actions } = options;
  const catalog = agentCatalog();

  let rootDir = resolve(options.root ?? process.cwd());
  let state = createSetupState(rootDir);
  let checks: ChecksOutcome | undefined;
  const capability = getLocalSetupCapability(options.platform);
  /** Agents chosen at the pull step, reused when recording credentials. */
  let selectedAgents: string[] = [];
  /** True only when the configured datastore conclusively has no durable administrator. */
  let bootstrapIdentityEligible = false;
  /** Set after this run successfully writes an authenticated identity to the administrator environment. */
  let bootstrapAdministratorSeeded = false;
  let datastoreAdminInspection: DatastoreAdminInspection | undefined;
  /** True only after the local API answers the setup health probe. */
  let backendReady = false;

  const redact = (value: string): string => value
    .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
    .replace(/\b((?:token|secret|password|private[_-]?key)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
  const safeStep = (step: SetupStep): SetupStep => ({
    ...step,
    detail: step.detail ? redact(step.detail) : undefined,
    nextAction: step.nextAction ? redact(step.nextAction) : undefined,
  });
  const safeState = (): SetupState => ({ ...state, steps: state.steps.map(safeStep) });
  const emit = (): void => {
    const snapshot = safeState();
    reporter.onState?.(snapshot);
    reporter.onProgress?.({ type: "state", state: snapshot });
  };
  const stepOf = (id: SetupStepId): SetupStep => getStep(state, id)!;
  const checkCancelled = (): void => {
    if (options.signal?.aborted) {
      state = {
        ...state,
        steps: state.steps.map((step) => step.status === "pending"
          ? { ...step, status: "skipped", detail: "setup cancelled" }
          : step),
      };
      throw new SetupCancellation(state);
    }
  };
  const rethrowIfCancelled = (error: unknown): void => {
    if (!isSetupCancellation(error)) return;
    checkCancelled();
    throw error;
  };
  const begin = (id: SetupStepId): void => {
    checkCancelled();
    state = updateStep(state, id, { status: "active", detail: undefined, nextAction: undefined });
    emit();
    const step = safeStep(stepOf(id));
    reporter.onStepStart?.(step);
    reporter.onProgress?.({ type: "step-start", step });
  };
  const settle = (id: SetupStepId, patch: SetupStepPatch): void => {
    state = updateStep(state, id, patch);
    emit();
    const step = safeStep(stepOf(id));
    reporter.onStepSettled?.(step);
    reporter.onProgress?.({ type: "step-settled", step });
  };
  const log = (line: string): void => {
    const safeLine = redact(line);
    reporter.onLog?.(safeLine);
    reporter.onProgress?.({ type: "log", line: safeLine });
  };
  const finish = (): SetupRunResult => ({
    rootDir,
    state: safeState(),
    capability,
    checks,
    // A terminal-looking step list is not a working installation unless the
    // API actually became healthy during this run.
    completed: isSetupComplete(state) && backendReady,
    cancelled: false,
    errors: state.steps
      .filter((step) => step.status === "failed")
      .map((step) => ({
        code: "step-failed" as const,
        message: redact(step.detail ?? `${step.title} failed`),
        stepId: step.id,
        retryable: true,
        nextAction: step.nextAction ? redact(step.nextAction) : undefined,
      })),
  });

  if (options.signal?.aborted) {
    emit();
    return { ...finish(), cancelled: true, errors: [{ code: "cancelled", message: "Setup was cancelled.", retryable: true }] };
  }

  /**
   * Relay enrollment for the auth step. Ensures a GitHub token (offering the
   * interactive login when a `confirmGithubLogin` hook is present), discovers the
   * installation (auto-select one, pick among many, error on none), mints the
   * relay token, and writes the relay env vars. Returns a success `detail` or a
   * actionable `note`. It never throws for expected problems; the caller marks
   * the auth step failed and stops before launching a backend that cannot boot.
   */
  const enrollRelayForSetup = async (
    relayUrl: string
  ): Promise<{ detail?: string; note?: { detail: string; nextAction?: string } }> => {
    // 1. A stored GitHub token is required. Offer interactive login when the
    //    renderer supports it. The Ink entry point performs this handoff before
    //    enabling raw mode; the sequential renderer prompts through this hook.
    if (!actions.hasGithubToken(options.signal)) {
      const reason = "Relay enrollment needs a GitHub token.";
      const loginConfirmed = prompts.confirmGithubLogin ? await prompts.confirmGithubLogin({ reason }) : false;
      checkCancelled();
      if (loginConfirmed) {
        await actions.loginWithGithub({ onLog: log, signal: options.signal });
        checkCancelled();
      }
      if (!actions.hasGithubToken(options.signal)) {
        return {
          note: {
            detail: "relay not enrolled — not logged in to GitHub",
            nextAction: "Run `propr login`, then re-run `propr setup` and accept ProPR Connect.",
          },
        };
      }
    }

    try {
      // 2. Discover installations: auto-select the only one, pick among many,
      //    error when there are none.
      let { username, installations } = await actions.fetchRelayInstallations({ relayUrl, signal: options.signal });
      checkCancelled();
      const usingHostedRelay =
        relayUrl.replace(/\/+$/, "") === DEFAULT_PROPR_GH_RELAY_URL.replace(/\/+$/, "");
      if (installations.length === 0 && usingHostedRelay && prompts.confirmGithubAppInstall) {
        const installUrl = DEFAULT_PROPR_GITHUB_APP_INSTALL_URL;
        const installConfirmed = await prompts.confirmGithubAppInstall({ url: installUrl });
        checkCancelled();
        if (installConfirmed) {
          await actions.openUrl(installUrl, options.signal);
          checkCancelled();
          const installed = prompts.confirmGithubAppInstalled
            ? await prompts.confirmGithubAppInstalled({ url: installUrl })
            : false;
          checkCancelled();
          if (installed) {
            ({ username, installations } = await actions.fetchRelayInstallations({ relayUrl, signal: options.signal }));
            checkCancelled();
          }
        }
      }
      if (installations.length === 0) {
        return {
          note: {
            detail: "relay not enrolled — no GitHub App installation available",
            nextAction: usingHostedRelay
              ? `Install the default ProPR GitHub App at ${DEFAULT_PROPR_GITHUB_APP_INSTALL_URL}, then re-run setup.`
              : `Ask the administrator of ${relayUrl} for that relay's GitHub App installation URL, install it, then re-run setup.`,
          },
        };
      }
      let installationId: string;
      if (installations.length === 1) {
        installationId = String(installations[0].installation_id);
        log(`relay: using installation ${installationId} (${installations[0].account_login})`);
      } else if (prompts.selectInstallation) {
        installationId = await prompts.selectInstallation({ installations });
        checkCancelled();
      } else {
        installationId = String(installations[0].installation_id);
      }

      // 3. Mint the relay token and write the relay env vars (overwriting only
      //    these keys). PROPR_DEMO_MODE=false ensures the new relay config isn't
      //    shadowed by a leftover demo flag (see detectGithubAuthMode).
      const { relayUrl: resolvedRelayUrl, token } = await actions.enrollRelay({ relayUrl, installationId, signal: options.signal });
      checkCancelled();
      const existingEnv = actions.readEnvVars(rootDir, options.signal);
      const existingAdminUsers = [...new Set(
        (existingEnv.PROPR_ADMIN_USERS ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      )];
      const hasExistingAdminUsers = existingAdminUsers.length > 0;
      const seedBootstrapAdmin = bootstrapIdentityEligible && !hasExistingAdminUsers;
      const existingWhitelist = (existingEnv.GITHUB_USER_WHITELIST ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const whitelistHasIdentity = existingWhitelist.some(
        (value) => value.toLowerCase() === username.trim().toLowerCase()
      );
      const bootstrapWhitelist = seedBootstrapAdmin && !whitelistHasIdentity
        ? [...existingWhitelist, username].join(",")
        : undefined;
      const tunnelOverride = actions.getTunnelEnabled?.(rootDir, options.signal);
      const managedTunnelEnabled = tunnelOverride ?? Boolean(
        existingEnv.PROPR_UI_TUNNEL_TOKEN?.trim() || isTruthyEnvFlag(existingEnv.PROPR_UI_TUNNEL_ENABLED)
      );
      const explicitBrowserAuthMode = existingEnv.PROPR_WEB_AUTH_MODE?.trim().toLowerCase();
      const hasExplicitBrowserAuthMode =
        explicitBrowserAuthMode === "connect" ||
        explicitBrowserAuthMode === "github" ||
        explicitBrowserAuthMode === "disabled";
      const customBrowserOAuthApplies =
        !managedTunnelEnabled &&
        !hasExplicitBrowserAuthMode &&
        isConfiguredOAuthValue(existingEnv.GH_OAUTH_CLIENT_ID) &&
        isConfiguredOAuthValue(existingEnv.GH_OAUTH_CLIENT_SECRET);
      const usesHostedConnect =
        normalizeServiceUrl(resolvedRelayUrl) === normalizeServiceUrl(DEFAULT_PROPR_GH_RELAY_URL) &&
        normalizeServiceUrl(existingEnv.PROPR_CONNECT_URL || "https://connect.propr.dev") ===
          "https://connect.propr.dev";
      const callbackUrl = existingEnv.GH_OAUTH_CALLBACK_URL ||
        "http://localhost:4000/api/auth/github/callback";
      const automaticConnectApplies =
        managedTunnelEnabled ||
        (usesHostedConnect && isSupportedLoopbackCallback(callbackUrl));
      checkCancelled();
      actions.applyEnvSelection(
        rootDir,
        {
          PROPR_DEMO_MODE: "false",
          GH_AUTH_MODE: "relay",
          PROPR_GH_RELAY_URL: resolvedRelayUrl,
          PROPR_GH_RELAY_TOKEN: token,
          GH_INSTALLATION_ID: installationId,
          // Select hosted Connect only for its managed tunnel and exact
          // loopback callback deployments. Explicit modes, custom OAuth, and
          // custom/self-hosted relay paths remain operator-owned.
          ...(automaticConnectApplies && !hasExplicitBrowserAuthMode && !customBrowserOAuthApplies
            ? { PROPR_WEB_AUTH_MODE: "connect" }
            : {}),
          // The relay identity was just authenticated by GitHub and owns this
          // installation, so it is the safe bootstrap administrator only when
          // the configured datastore is absent or conclusively contains no
          // durable administrator. Existing environment administrators and
          // durable database administrators are always preserved.
          ...(seedBootstrapAdmin ? { PROPR_ADMIN_USERS: username } : {}),
          // Preserve every user-managed whitelist entry, adding the enrolled
          // identity only when bootstrap enrollment needs it.
          ...(bootstrapWhitelist ? { GITHUB_USER_WHITELIST: bootstrapWhitelist } : {}),
        },
        { overwrite: true },
        options.signal
      );
      bootstrapAdministratorSeeded = seedBootstrapAdmin;
      const adminDetail = hasExistingAdminUsers
        ? "kept existing administrators"
        : seedBootstrapAdmin
          ? `bootstrap administrator: ${username}`
          : datastoreAdminInspection?.status === "uninspectable"
            ? "left administrators unchanged because the datastore could not be inspected"
            : "left administrators unchanged on existing stack";
      return {
        detail: `auth mode: relay (installation ${installationId}); ${adminDetail}`,
      };
    } catch (error) {
      rethrowIfCancelled(error);
      return {
        note: {
          detail: `relay enrollment failed — ${(error as Error).message}`,
          nextAction: "Confirm the shared GitHub App is installed and you own the installation, then re-run setup.",
        },
      };
    }
  };

  emit();

  // 1. Environment checks — run first; their results steer the rest.
  begin("check");
  try {
    checks = await actions.runChecks({ root: rootDir, skipRemoteImageCheck, signal: options.signal });
    checkCancelled();
  } catch (error) {
      rethrowIfCancelled(error);
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
    let initSettlement: SetupStepPatch;
    let init = actions.inspectStackInit(rootDir, options.signal);
    let userChoseReinit = false;
    if (prompts.resolveStackRoot) {
      const decision = await prompts.resolveStackRoot({ currentRoot: rootDir, init });
      checkCancelled();
      if (decision.rootDir && decision.rootDir !== rootDir) {
        rootDir = decision.rootDir;
        state = { ...state, rootDir };
        init = actions.inspectStackInit(rootDir, options.signal);
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
      const result = await actions.scaffoldStack({ root: rootDir, signal: options.signal });
      checkCancelled();
      // Adopt the absolute root scaffoldStack actually resolved. A root typed at
      // the prompt may be relative or have a trailing slash; without this every
      // later step (env writes, health probe, UI URL) would key off the raw
      // string while the scaffold landed at the resolved path.
      if (result.rootDir && result.rootDir !== rootDir) {
        rootDir = result.rootDir;
        state = { ...state, rootDir };
      }
      // Persist through the active host as well as its scaffold initializer.
      // Otherwise later setup saves can write stale host config and silently
      // discard the root that scaffolding recorded.
      await actions.persistStackRoot(rootDir, options.signal);
      checkCancelled();
      const created = [...result.dirsCreated];
      initSettlement = {
        status: "done",
        detail: result.envCreated
          ? `scaffolded stack at ${rootDir}${created.length ? ` (created ${created.join(", ")})` : ""}`
          : `stack root ready at ${rootDir} (existing .env kept)`,
      };
    } else {
      // Reuse path: scaffolding is skipped, so nothing has recorded this root in
      // config. Persist it now so a later `propr start` / `propr status` without
      // --root targets this stack rather than an old saved root or the cwd.
      await actions.persistStackRoot(rootDir, options.signal);
      checkCancelled();
      initSettlement = { status: "skipped", detail: `using existing stack at ${rootDir} (.env preserved)` };
    }

    // Eligibility comes from the configured datastore itself, not scaffold
    // artifacts. This recovers migrated databases with no durable administrator
    // and follows the runtime's DB_FILENAME/DATA_DIR resolution. Configured
    // paths outside the launcher's data bind mount cannot be safely inspected
    // from the host and remain ineligible (fail closed).
    datastoreAdminInspection = await actions.inspectDatastoreAdministrators(rootDir, options.signal);
    checkCancelled();
    bootstrapIdentityEligible =
      datastoreAdminInspection.status === "absent" || datastoreAdminInspection.status === "no-admin";
    if (datastoreAdminInspection.status === "uninspectable") {
      const inspectionDetail = datastoreAdminInspection.detail ?? "configured datastore is unavailable";
      log(`administrator inspection: ${inspectionDetail}`);
    }
    // Inspect before reporting initialization success so this step has exactly
    // one terminal settlement even when inspection itself throws. An
    // uninspectable datastore is evaluated after auth resolves because demo
    // mode does not require an instance administrator.
    settle("init-stack", initSettlement);
  } catch (error) {
      rethrowIfCancelled(error);
    settle("init-stack", {
      status: "failed",
      detail: `could not initialize stack: ${(error as Error).message}`,
      nextAction: "Check directory permissions and that .env.example is available, then re-run setup.",
    });
    return finish();
  }

  // 3. Pull images — core images by default, plus the shared agent image when
  //    the user selects an agent (defaulting to those detected on this host).
  begin("pull-images");
  const detected = detectInstalledAgents(catalog);
  try {
    const requested = prompts.selectAgents
      ? await prompts.selectAgents({ available: catalog.map((a) => a.type), detected })
      : detected;
    checkCancelled();
    // Guard the engine boundary: a renderer may hand back unknown or duplicate
    // agent names. Keep only types we know about, de-duped (first occurrence
    // wins), so unknown names never reach pullImages() and a duplicate can't
    // double-apply credentials in the configure-agents step below.
    const known = new Set(catalog.map((a) => a.type));
    selectedAgents = [...new Set(requested)].filter((type) => known.has(type));

    const pull = await actions.pullImages({ rootDir, agentTypes: selectedAgents, onLog: log, signal: options.signal });
    checkCancelled();
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
      rethrowIfCancelled(error);
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
      const existingEnv = actions.readEnvVars(rootDir, options.signal);
      for (const type of selectedAgents) {
        const desc = catalog.find((a) => a.type === type);
        if (!desc) continue;
        for (const cred of desc.credentials) {
          // A selected agent may not have logged in yet. Prepare its host mount
          // before the stack starts so Docker never creates a root-owned path,
          // and record it now so the post-login image validation sees exactly
          // the mount the worker will use.
          const configuredDir = existingEnv[cred.envKey];
          const effectiveDir = configuredDir?.trim() ? configuredDir : cred.defaultDir;
          assertSafeAgentCredentialDir(effectiveDir, cred.envKey);
          actions.prepareAgentCredentialDir(effectiveDir, options.signal);
          vars[cred.envKey] = effectiveDir;
        }
      }
      checkCancelled();
      const applied = actions.applyEnvSelection(rootDir, vars, { overwrite: false }, options.signal);
      const detailParts: string[] = [];
      detailParts.push(applied.written.length > 0 ? `recorded ${applied.written.length} credential dir(s)` : "no new credentials to record");
      if (applied.skipped.length > 0) detailParts.push(`${applied.skipped.length} already set`);
      settle("configure-agents", { status: "done", detail: detailParts.join("; ") });
    }
  } catch (error) {
      rethrowIfCancelled(error);
    settle("configure-agents", {
      status: "failed",
      detail: `could not record agent credentials: ${(error as Error).message}`,
      nextAction: "Correct invalid HOST_* credential paths and check write permissions on .env, then re-run setup.",
    });
    return finish();
  }

  // 5. GitHub authentication — keep what works; only write the keys the user
  //    explicitly chose. Missing Connect/App credentials are a hard stop because
  //    every non-demo backend process exits before the health probe can pass.
  begin("github-auth");
  let resolvedAuth: GithubAuthModeResult;
  // Set by the relay path: `relayNote` drives a failed settle (and skips
  // partial writes); `relayDoneDetail` carries the success line. Both stay unset
  // for the keep / custom-App / no-prompt paths, which fall back to the
  // mode-derived settle below.
  let relayNote: { detail: string; nextAction?: string } | undefined;
  let relayDoneDetail: string | undefined;
  try {
    const currentAuth = actions.detectGithubAuthMode(rootDir, options.signal);
    let authDecision: GithubAuthDecision | undefined;
    if (prompts.configureGithubAuth) {
      authDecision = await prompts.configureGithubAuth({ current: currentAuth });
      checkCancelled();
    }
    if (authDecision?.enrollRelay) {
      const outcome = await enrollRelayForSetup(authDecision.enrollRelay.relayUrl);
      relayNote = outcome.note;
      relayDoneDetail = outcome.detail;
    } else if (authDecision?.vars && Object.keys(authDecision.vars).length > 0) {
      checkCancelled();
      actions.applyEnvSelection(rootDir, authDecision.vars, { overwrite: true }, options.signal);
    }
    resolvedAuth = relayDoneDetail
      ? { mode: "relay", warnings: [] }
      : actions.detectGithubAuthMode(rootDir, options.signal);
  } catch (error) {
      rethrowIfCancelled(error);
    settle("github-auth", {
      status: "failed",
      detail: `could not configure GitHub auth: ${(error as Error).message}`,
      nextAction: "Check .env access and your GitHub auth settings, then re-run setup.",
    });
    return finish();
  }
  if (relayNote) {
    settle("github-auth", { status: "failed", detail: relayNote.detail, nextAction: relayNote.nextAction });
    return finish();
  }
  if (resolvedAuth.mode === "none") {
    settle("github-auth", {
      status: "failed",
      detail: "no GitHub auth configured",
      nextAction: "Choose ProPR Connect (default), configure your own GitHub App, or enable demo mode, then re-run setup.",
    });
    return finish();
  }

  // Every non-demo start needs either an environment administrator or a
  // durable one. Relay enrollment above already seeds its authenticated
  // identity when the datastore is conclusively empty. On a keep rerun, the
  // same identity can be recovered safely only when the stored GitHub session
  // can access the installation already configured for this stack.
  const demoModeEnabled = isTruthyEnvFlag(actions.readEnvVars(rootDir, options.signal).PROPR_DEMO_MODE);
  let keptRelayBootstrapIdentity: string | undefined;
  const configuredAdministrators = (): string[] =>
    (actions.readEnvVars(rootDir, options.signal).PROPR_ADMIN_USERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const durableAdministratorExists = datastoreAdminInspection?.status === "has-admin";
  if (
    !demoModeEnabled &&
    !durableAdministratorExists &&
    !bootstrapAdministratorSeeded &&
    configuredAdministrators().length === 0 &&
    bootstrapIdentityEligible &&
    resolvedAuth.mode === "relay" &&
    actions.hasGithubToken(options.signal)
  ) {
    const env = actions.readEnvVars(rootDir, options.signal);
    const installationId = env.GH_INSTALLATION_ID?.trim();
    if (installationId) {
      try {
        const identity = await actions.fetchRelayInstallations({
          relayUrl: env.PROPR_GH_RELAY_URL?.trim() || undefined,
          signal: options.signal,
        });
        checkCancelled();
        const username = identity.username.trim();
        const ownsConfiguredInstallation = identity.installations.some(
          (installation) => String(installation.installation_id) === installationId
        );
        if (username && ownsConfiguredInstallation) {
          const existingWhitelist = (env.GITHUB_USER_WHITELIST ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const whitelistHasIdentity = existingWhitelist.some(
            (value) => value.toLowerCase() === username.toLowerCase()
          );
          actions.applyEnvSelection(
            rootDir,
            {
              PROPR_ADMIN_USERS: username,
              ...(!whitelistHasIdentity
                ? { GITHUB_USER_WHITELIST: [...existingWhitelist, username].join(",") }
                : {}),
            },
            { overwrite: true },
            options.signal
          );
          bootstrapAdministratorSeeded = true;
          keptRelayBootstrapIdentity = username;
        }
      } catch (error) {
      rethrowIfCancelled(error);
        log(`administrator bootstrap: could not verify the configured relay identity: ${(error as Error).message}`);
      }
    }
  }

  if (
    !demoModeEnabled &&
    !durableAdministratorExists &&
    !bootstrapAdministratorSeeded &&
    configuredAdministrators().length === 0
  ) {
    const inspectionDetail = datastoreAdminInspection?.status === "uninspectable"
      ? ` (${datastoreAdminInspection.detail ?? "the configured datastore could not be inspected"})`
      : "";
    settle("github-auth", {
      status: "failed",
      detail: `no instance administrator is configured${inspectionDetail}`,
      nextAction:
        "Set PROPR_ADMIN_USERS to at least one GitHub username, repair the configured datastore, or re-run setup and enroll ProPR Connect with an authenticated GitHub account.",
    });
    return finish();
  }

  // The GitHub App authenticates the backend to GitHub, but it does not
  // authenticate this CLI user to the backend. Everything setup does after the
  // stack starts (/api/status, agent configuration, settings, and repositories)
  // is protected by bearer auth, so obtain the same user token as `propr login`
  // before making any of those calls. Connect enrollment already guarantees a
  // token; this covers custom-App and GitHub-only demo configurations alike.
  if (!demoModeEnabled && !actions.hasGithubToken(options.signal)) {
    const reason = "Finishing setup requires a GitHub user token for protected backend API steps.";
    const loginConfirmed = prompts.confirmGithubLogin ? await prompts.confirmGithubLogin({ reason }) : false;
    checkCancelled();
    if (loginConfirmed) {
      await actions.loginWithGithub({ onLog: log, signal: options.signal });
      checkCancelled();
    }
    if (!actions.hasGithubToken(options.signal)) {
      settle("github-auth", {
        status: "failed",
        detail: `auth mode: ${resolvedAuth.mode}; GitHub user login is required to finish setup`,
        nextAction: "Run `propr login`, then re-run `propr setup`; the existing stack configuration will be reused.",
      });
      return finish();
    }
  }

  if (relayDoneDetail) {
    settle("github-auth", { status: "done", detail: relayDoneDetail });
  } else if (resolvedAuth.warnings.length > 0) {
    // The mode resolves, but the shared detector flagged a partial/ambiguous
    // configuration — surface it so the user can fix it before it bites later.
    settle("github-auth", {
      status: "warning",
      detail: `auth mode: ${resolvedAuth.mode} — ${resolvedAuth.warnings.join("; ")}`,
    });
  } else {
    settle("github-auth", {
      status: "done",
      detail: keptRelayBootstrapIdentity
        ? `auth mode: ${resolvedAuth.mode}; bootstrap administrator: ${keptRelayBootstrapIdentity}`
        : `auth mode: ${resolvedAuth.mode}`,
    });
  }

  // 5b. GitHub event intake — how the backend learns about GitHub events
  //     (routing WebSocket, polling, or direct webhooks). Written before startup
  //     because the API/daemon resolve GITHUB_EVENT_INTAKE_MODE at boot. Demo
  //     mode has no GitHub access, so there is nothing to ingest.
  begin("intake");
  try {
    if (resolvedAuth.mode === "demo") {
      settle("intake", { status: "skipped", detail: "demo mode — no GitHub events to ingest" });
    } else {
      const envNow = actions.readEnvVars(rootDir, options.signal);
      // Resolve the mode the backend would pick from today's `.env` (unset
      // defaults to routing_websocket, the hosted relay path) so the prompt and
      // any "kept current" message reflect what actually runs.
      const { mode: currentMode } = resolveGithubEventIntakeMode({
        eventIntakeMode: envNow.GITHUB_EVENT_INTAKE_MODE,
        enableGithubWebhooks: envNow.ENABLE_GITHUB_WEBHOOKS,
      });
      // When `.env` already records an intake decision, default the prompt to
      // "keep" so a blank Enter on a re-run can't silently flip a working config
      // (e.g. disable existing direct webhooks). This also covers older `.env`
      // files that only carry the legacy `ENABLE_GITHUB_WEBHOOKS` boolean: it
      // still resolves to a real `currentMode`, so a blank Enter must keep that
      // rather than rewrite it to the auth-derived recommendation. Only a truly
      // fresh install (neither key set) falls back to the recommendation.
      const intakeConfigured =
        envNow.GITHUB_EVENT_INTAKE_MODE !== undefined || envNow.ENABLE_GITHUB_WEBHOOKS !== undefined;
      const defaultMode = defaultIntakeChoice(resolvedAuth.mode, { intakeConfigured });
      let decision: GithubIntakeDecision | undefined;
      if (prompts.configureIntake) {
        decision = await prompts.configureIntake({ authMode: resolvedAuth.mode, defaultMode, currentMode });
        checkCancelled();
      }
      // The mode that will be in effect after this step — the explicit pick, or
      // the current `.env` value when the user keeps it. `effectiveEnv` mirrors
      // what `.env` holds *after* any write so the prerequisite check below sees
      // the freshly written secret/mode, not the pre-write snapshot.
      let effectiveMode = currentMode;
      let effectiveEnv = envNow;
      let detail: string;
      if (decision && !decision.keep && decision.mode) {
        // buildIntakeEnvVars rejects an empty webhook secret — caught below and
        // surfaced as a warning rather than writing a config the API won't boot.
        const vars = buildIntakeEnvVars(decision.mode, { webhookSecret: decision.webhookSecret });
        checkCancelled();
        actions.applyEnvSelection(rootDir, vars, { overwrite: true }, options.signal);
        effectiveMode = decision.mode;
        effectiveEnv = { ...envNow, ...vars };
        detail = `intake: ${intakeModeLabel(decision.mode)}`;
      } else {
        detail = `intake: kept current (${intakeModeLabel(currentMode)})`;
      }
      // Validate the resolved mode against the shared prerequisite rules so a
      // silently-broken intake config (most commonly routing_websocket without
      // relay auth + a relay token) surfaces here instead of as a backend boot
      // failure after `propr start`.
      const prereq = validateIntakeModePrerequisites({
        intakeMode: effectiveMode,
        authMode: resolvedAuth.mode,
        routingUrl: effectiveEnv.PROPR_ROUTING_URL,
        relayUrl: effectiveEnv.PROPR_GH_RELAY_URL,
        relayToken: effectiveEnv.PROPR_GH_RELAY_TOKEN,
        webhookSecret: effectiveEnv.GH_WEBHOOK_SECRET,
      });
      if (prereq.valid) {
        settle("intake", { status: "done", detail });
      } else {
        settle("intake", {
          status: "failed",
          detail: `${detail} — ${prereq.errors.join("; ")}`,
          nextAction:
            effectiveMode === "routing_websocket"
              ? "Enroll with the hosted relay (`propr relay enroll`) so routing_websocket has relay auth + a relay token, or choose polling."
              : "Resolve the missing intake prerequisites in .env, then re-run setup.",
        });
        return finish();
      }
    }
  } catch (error) {
      rethrowIfCancelled(error);
    // An IntakeConfigError (e.g. direct webhooks chosen with no secret) is
    // non-blocking: leave intake as-is and tell the user how to finish it.
    settle("intake", {
      status: "warning",
      detail: `could not configure GitHub intake: ${(error as Error).message}`,
      nextAction:
        "Set GITHUB_EVENT_INTAKE_MODE (and GH_WEBHOOK_SECRET for direct_webhook) in .env, then re-run setup.",
    });
  }

  // 6. Start the stack and validate backend health. A running stack is reused,
  //    not recreated, so user data and live work are untouched.
  begin("start-stack");
  try {
    const alreadyRunning = await actions.isStackRunning(rootDir, options.signal);
    checkCancelled();
    const startConfirmed = prompts.confirmStartStack ? await prompts.confirmStartStack({ rootDir, alreadyRunning }) : true;
    checkCancelled();
    if (!startConfirmed) {
      settle("start-stack", {
        status: "skipped",
        detail: "stack not started — setup is incomplete until the backend is running",
        nextAction: "Start it later with `propr start`, or re-run `propr setup` and confirm startup.",
      });
    } else {
      if (alreadyRunning) {
        log("stack already running — leaving it intact");
      } else {
        await actions.startStack({ rootDir, onLog: log, signal: options.signal });
        checkCancelled();
      }
      const health = await actions.checkBackendHealth({ rootDir, signal: options.signal });
      checkCancelled();
      if (health.healthy) {
        backendReady = true;
        settle("start-stack", {
          status: "done",
          detail: alreadyRunning ? `stack already running — ${health.detail}` : health.detail,
        });
      } else {
        settle("start-stack", {
          status: "failed",
          detail: health.detail,
          // The backend answered, so access failures need account-oriented
          // remediation rather than service-health troubleshooting. A 401 calls
          // for login; a 403 calls for permission/configuration checks.
          nextAction: health.accessFailure === "unauthorized"
            ? "Run `propr login` to obtain a GitHub user token, then re-run `propr setup`; the running stack will be reused."
            : health.accessFailure === "forbidden"
              ? "Check the authenticated account, the stack's bootstrap-admin configuration, and its access permissions, then re-run `propr setup`; the running stack will be reused."
            : "Run `propr status` / `propr remote-status` and inspect the API logs, then re-run setup.",
        });
      }
    }
  } catch (error) {
      rethrowIfCancelled(error);
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
  // This step talks to the live backend API, so it only makes sense once the
  // stack is up. When the backend is unavailable, skip rather than fire
  // doomed API calls that would surface as confusing warnings.
  if (!backendReady) {
    settle("enable-agents", {
      status: "skipped",
      detail: "backend is not healthy — agents are enabled through the running backend",
      nextAction: "Start the stack (`propr start`), then re-run `propr setup` to enable and authenticate the selected agents.",
    });
  } else {
  try {
    const outcome = await runAgentSetup({
      rootDir,
      selectedAgents,
      actions,
      confirmLogin: prompts.confirmAgentLogin,
      onLog: log,
      signal: options.signal,
    });
    checkCancelled();
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
      if (outcome.validated.length > 0) parts.push(`connectivity verified: ${outcome.validated.join(", ")}`);
      if (outcome.validationFailed.length > 0) parts.push(`${outcome.validationFailed.length} connectivity check(s) need attention`);
      const detail = parts.length > 0 ? parts.join("; ") : "no changes needed";
      if (outcome.errors.length > 0 || outcome.authFailed.length > 0 || outcome.validationFailed.length > 0) {
        settle("enable-agents", {
          status: "warning",
          detail: outcome.errors.length > 0 ? `${detail}; ${outcome.errors.join("; ")}` : detail,
          nextAction: outcome.nextCommands.length > 0
            ? `Run: ${outcome.nextCommands.map((command) => `\`${command}\``).join("; then ")}`
            : "Enable or authenticate agents later in the UI or with `propr agent add` / `propr agent login`.",
        });
      } else {
        settle("enable-agents", { status: "done", detail });
      }
    }
  } catch (error) {
      rethrowIfCancelled(error);
    // runAgentSetup is built not to throw for expected conditions; anything that
    // escapes is treated as a non-blocking warning so it can't abort setup.
    settle("enable-agents", {
      status: "warning",
      detail: `could not configure agents: ${(error as Error).message}`,
      nextAction: "Enable or authenticate agents later in the UI or with `propr agent add` / `propr agent login`.",
    });
  }
  }

  // 8. Whitelist — restrict who can trigger ProPR. Written non-destructively.
  begin("whitelist");
  try {
    const envNow = actions.readEnvVars(rootDir, options.signal);
    const currentWhitelist = (envNow.GITHUB_USER_WHITELIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const demoMode = resolvedAuth.mode === "demo";
    let whitelist: string[] | null = null;
    if (prompts.configureWhitelist) {
      whitelist = await prompts.configureWhitelist({ current: currentWhitelist, demoMode });
      checkCancelled();
    }
    if (whitelist !== null) {
      // Trim, drop blanks, and de-dupe (first occurrence wins) so the value
      // matches saveWhitelist's "cleaned, de-duped usernames" contract — a
      // duplicate entry would otherwise inflate the saved count and settings.
      const cleaned = [...new Set(whitelist.map((s) => s.trim()).filter(Boolean))];
      // Prefer the settings API when the backend is up so the change applies
      // immediately (and never overwrites unrelated settings); always mirror into
      // .env so it survives a restart. Falls back to .env if the API is down.
      const backendRunning = backendReady && await actions.isStackRunning(rootDir, options.signal);
      checkCancelled();
      const saved = await saveWhitelist({
        users: cleaned,
        backendRunning,
        saveViaSettings: (users) => actions.saveWhitelistSetting(rootDir, users, options.signal),
        saveViaEnv: (users) => {
          // A non-empty list is written; clearing to "none" must *remove* the key
          // rather than blank it. applyEnvSelection ignores blank values (so it
          // never clobbers a value), which means `GITHUB_USER_WHITELIST=""` would
          // be skipped and the old list would survive on the next restart — so we
          // delete the key outright instead.
          if (users.length > 0) {
            actions.applyEnvSelection(rootDir, { GITHUB_USER_WHITELIST: users.join(",") }, { overwrite: true }, options.signal);
          } else {
            actions.clearEnvKeys(rootDir, ["GITHUB_USER_WHITELIST"], options.signal);
          }
        },
        signal: options.signal,
      });
      checkCancelled();
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
      rethrowIfCancelled(error);
    settle("whitelist", {
      status: "failed",
      detail: `could not configure the whitelist: ${(error as Error).message}`,
      nextAction: "Check .env access, then re-run setup.",
    });
    return finish();
  }

  // 9. Repository (optional) — adding a repo must never fail the whole run.
  begin("repo");
  // Adding a repo goes through the running backend's API, so skip it (without
  // even prompting) when the backend is unavailable — there is nothing
  // to add it to yet.
  if (!backendReady) {
    settle("repo", {
      status: "skipped",
      detail: "backend is not healthy — a repository is connected through the running backend",
      nextAction: "Start the stack (`propr start`), then add one with `propr repo add <owner/repo>`.",
    });
  } else {
  try {
    // The prompt itself is part of this optional step — a renderer that throws
    // while collecting the repo must degrade to a warning, not abort the run.
    const repoSelection = prompts.addRepository ? await prompts.addRepository({ rootDir }) : null;
    checkCancelled();
    if (!repoSelection) {
      settle("repo", { status: "skipped", detail: "no repository added" });
    } else {
      try {
        await actions.addRepository(repoSelection, rootDir, options.signal);
        checkCancelled();
        settle("repo", { status: "done", detail: `monitoring ${repoSelection.fullName}` });
      } catch (error) {
      rethrowIfCancelled(error);
        settle("repo", {
          status: "warning",
          detail: `could not add ${repoSelection.fullName}: ${(error as Error).message}`,
          nextAction: "Add it later with `propr repo add <owner/repo>`.",
        });
      }
    }
  } catch (error) {
      rethrowIfCancelled(error);
    settle("repo", {
      status: "warning",
      detail: `could not collect a repository to add: ${(error as Error).message}`,
      nextAction: "Add it later with `propr repo add <owner/repo>`.",
    });
  }
  }

  // 10. UI (optional) — surface the URL and, when the user confirms, actually
  //     open it in their default browser.
  begin("launch-ui");
  if (!backendReady) {
    settle("launch-ui", {
      status: "skipped",
      detail: "UI not opened — the backend is not healthy",
      nextAction: "Resolve the startup failure, then re-run `propr setup`.",
    });
    return finish();
  }
  let uiUrl = "";
  try {
    uiUrl = await actions.resolveUiUrl(rootDir, options.signal);
    checkCancelled();
  } catch (error) {
      rethrowIfCancelled(error);
    /* non-fatal: just omit the URL */
  }
  let opened = false;
  let openFailed = false;
  try {
    // The prompt only asks *whether* to open; the engine performs the open so
    // both renderers behave identically and neither has to import a launcher.
    const wantsOpen = uiUrl && prompts.launchUi ? await prompts.launchUi({ url: uiUrl }) : false;
    checkCancelled();
    if (wantsOpen) {
      try {
        await actions.openUrl(uiUrl, options.signal);
        checkCancelled();
        opened = true;
      } catch (error) {
      rethrowIfCancelled(error);
        // Headless host, no launcher, etc. — fall back to just printing the URL.
        openFailed = true;
      }
    }
  } catch (error) {
      rethrowIfCancelled(error);
    /* opening the UI is best-effort; a failed launch prompt must not fail setup */
  }
  settle("launch-ui", {
    status: opened ? "done" : "skipped",
    detail: uiUrl
      ? openFailed
        ? `UI available at ${uiUrl} (could not open a browser automatically)`
        : opened
          ? `opened ${uiUrl}`
          : `UI available at ${uiUrl}`
      : "UI URL unavailable",
  });

  return finish();
}

/** Run or safely re-run the setup state machine. Existing host state is re-inspected on every call. */
export async function runSetup(options: RunSetupOptions): Promise<SetupRunResult> {
  const capability = getLocalSetupCapability(options.platform);
  if (!capability.supported) {
    const rootDir = resolve(options.root ?? process.cwd());
    return {
      rootDir,
      state: createSetupState(rootDir),
      capability,
      completed: false,
      cancelled: false,
      errors: [{ code: "local-unsupported", message: capability.reason, retryable: false }],
    };
  }
  try {
    return await runSetupAttempt(options);
  } catch (error) {
    if (!(error instanceof SetupCancellation)) throw error;
    const capability = getLocalSetupCapability(options.platform);
    return {
      rootDir: error.state.rootDir,
      state: error.state,
      capability,
      completed: false,
      cancelled: true,
      errors: [{ code: "cancelled", message: error.message, retryable: true }],
    };
  }
}

/** Retry/resume is intentionally a fresh inspection; completed work is detected and preserved by host operations. */
export function retrySetup(previous: SetupRunResult, options: Omit<RunSetupOptions, "root">): Promise<SetupRunResult> {
  return runSetup({ ...options, root: previous.rootDir });
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
