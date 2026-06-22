/**
 * Setup wizard domain model.
 *
 * `propr setup` coordinates the existing building blocks — environment checks,
 * stack scaffolding, image pulls, agent/GitHub configuration, stack startup,
 * whitelist setup, optional repo setup and UI launch — into one guided flow.
 *
 * These types are deliberately free of Ink/readline so the same step/status
 * model can drive both the live TUI renderer and a plain sequential (fallback)
 * renderer. They carry only data: progress, details and the next action a user
 * can take. See ./state.ts for the helpers that compute and mutate this model.
 */

/**
 * Lifecycle status of a single setup step. Mirrors the vocabulary of the
 * environment-check statuses (see checkCommands.ts `CheckStatus`) but adds the
 * transitional states a wizard needs (`active`) and the idempotent outcomes
 * (`done`/`skipped`) that keep the flow re-runnable.
 */
export type SetupStepStatus = "pending" | "active" | "done" | "skipped" | "error";

/** Stable identifiers for the ordered steps of `propr setup`. */
export type SetupStepId =
  | "checks"
  | "init-stack"
  | "pull-images"
  | "agents"
  | "github-auth"
  | "start-stack"
  | "whitelist"
  | "repo"
  | "ui";

/** Static description of a setup step (order, label, help, skippability). */
export interface SetupStepDefinition {
  id: SetupStepId;
  /** Short title for headers and progress rows. */
  title: string;
  /** One-line, new-user-friendly explanation of what the step does. */
  description: string;
  /**
   * Whether the step may be skipped without leaving the stack unusable. Steps
   * flagged optional (e.g. repo setup) are safe to skip on a re-run.
   */
  optional: boolean;
}

/**
 * Ordered definitions for the full setup flow. The order is the order the
 * wizard walks; renderers iterate this list to draw progress and decide what to
 * offer next. Each step maps to an existing API the command reuses:
 *   checks       → runChecks
 *   init-stack   → scaffoldStack
 *   pull-images  → orchestrator.pullImages
 *   agents       → .env HOST_*_DIR (via the env helpers in ./state.ts)
 *   github-auth  → .env GH_APP_ID / relay / demo (resolveGithubAuthMode)
 *   start-stack  → orchestrator.startStack
 *   whitelist    → .env GITHUB_USER_WHITELIST
 *   repo         → `propr repo` setup (optional)
 *   ui           → open the UI in a browser
 */
export const SETUP_STEPS: readonly SetupStepDefinition[] = [
  { id: "checks", title: "Check environment", description: "Verify Docker, images, agents and GitHub auth", optional: false },
  { id: "init-stack", title: "Initialize stack", description: "Scaffold .env, data/, logs/ and repos/", optional: false },
  { id: "pull-images", title: "Pull images", description: "Download the ProPR service and agent images", optional: false },
  { id: "agents", title: "Configure agents", description: "Record detected host agent-credential directories", optional: false },
  { id: "github-auth", title: "GitHub authentication", description: "Configure a GitHub App, token relay or demo mode", optional: false },
  { id: "start-stack", title: "Start the stack", description: "Launch the local control-plane services", optional: false },
  { id: "whitelist", title: "User whitelist", description: "Restrict who can trigger processing on this instance", optional: false },
  { id: "repo", title: "Set up a repository", description: "Connect a GitHub repository to ProPR", optional: true },
  { id: "ui", title: "Launch the UI", description: "Open the ProPR dashboard in a browser", optional: true },
] as const;

/** Mutable per-step state the renderers display and the helpers update. */
export interface SetupStepState {
  id: SetupStepId;
  status: SetupStepStatus;
  /** Human-readable detail of the current/last outcome (e.g. ".env created"). */
  detail?: string;
  /** Failure message when status is "error". */
  error?: string;
  /** Suggested next action a user can take for this step (the "↳ fix" line). */
  action?: string;
}

/** The full wizard model: the stack root plus every step's current state. */
export interface SetupState {
  /** Resolved stack root (.env/data/logs/repos live here). */
  rootDir: string;
  /** Steps in {@link SETUP_STEPS} order. */
  steps: SetupStepState[];
}

/**
 * Filesystem-only snapshot of how far stack scaffolding has progressed. Computed
 * without Docker or the orchestrator so idempotency checks stay cheap and safe
 * to run on import. See {@link import("./state.js").getStackState}.
 */
export interface StackState {
  rootDir: string;
  envPath: string;
  envExists: boolean;
  dataDirExists: boolean;
  logsDirExists: boolean;
  reposDirExists: boolean;
  /** True when .env and all of data/, logs/, repos/ already exist. */
  initialized: boolean;
}

/** Glyphs shared by the TUI and the fallback renderer (cf. checkCommands.ts). */
export const SETUP_STATUS_GLYPH: Record<SetupStepStatus, string> = {
  pending: "○",
  active: "▸",
  done: "✓",
  skipped: "—",
  error: "✗",
};

/** Short labels shared by both renderers. */
export const SETUP_STATUS_LABEL: Record<SetupStepStatus, string> = {
  pending: "PENDING",
  active: "ACTIVE",
  done: "DONE",
  skipped: "SKIPPED",
  error: "ERROR",
};
