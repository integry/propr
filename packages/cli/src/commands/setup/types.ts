/**
 * Setup wizard domain types.
 *
 * `propr setup` walks a new user through getting a local control-plane stack
 * running end to end. The flow coordinates several existing commands
 * (environment checks, stack scaffolding, image pulls, agent + GitHub
 * configuration, stack startup, whitelist + repo setup, and UI launch).
 *
 * These types are intentionally free of any rendering concern so the same
 * step/status model can drive an Ink TUI and a plain readline fallback. They
 * carry no Docker, Ink, or readline imports — see ./state.ts for the pure
 * helpers that compute and transition this state.
 */

/** Stable identifiers for each step of the setup flow, in run order. */
export type SetupStepId =
  | "check"
  | "init-stack"
  | "pull-images"
  | "configure-agents"
  | "github-auth"
  | "start-stack"
  | "whitelist"
  | "repo"
  | "launch-ui";

/**
 * Lifecycle status of a single step.
 *   pending — not started yet
 *   active  — currently running
 *   done    — completed successfully
 *   skipped — intentionally not run (already satisfied, or an optional step the
 *             user declined)
 *   warning — completed but with non-fatal issues the user should see
 *   failed  — errored; blocks any step that depends on it
 */
export type SetupStepStatus =
  | "pending"
  | "active"
  | "done"
  | "skipped"
  | "warning"
  | "failed";

/** A single step in the setup flow plus its current presentation state. */
export interface SetupStep {
  id: SetupStepId;
  /** Short label for progress lists. */
  title: string;
  /** One-line explanation of what the step does. */
  description: string;
  /** Optional steps may be skipped without blocking completion. */
  optional: boolean;
  status: SetupStepStatus;
  /** Live detail line (e.g. "pulled 6 images", "Docker daemon unreachable"). */
  detail?: string;
  /**
   * Suggested next action when the step is blocked, failed, or needs user
   * input — shown by both renderers so the user knows how to proceed.
   */
  nextAction?: string;
}

/** Aggregate state for the whole setup flow. */
export interface SetupState {
  /** Resolved stack root where .env, data/, logs/, repos/ live. */
  rootDir: string;
  /** Ordered steps; index order is the intended run order. */
  steps: SetupStep[];
}

/**
 * Patch applied to a step when transitioning its state. Limited to runtime
 * presentation fields — the static flow definition (title, description,
 * optional) is canonical and cannot be altered through a patch.
 */
export type SetupStepPatch = Partial<Pick<SetupStep, "status" | "detail" | "nextAction">>;

/**
 * Canonical, ordered step definitions. All start `pending`; renderers and the
 * command driver transition them via the helpers in ./state.ts.
 */
export const SETUP_STEP_DEFINITIONS: ReadonlyArray<
  Pick<SetupStep, "id" | "title" | "description" | "optional">
> = [
  {
    id: "check",
    title: "Environment checks",
    description: "Verify Docker, images, and agent credentials are ready.",
    optional: false,
  },
  {
    id: "init-stack",
    title: "Initialize stack",
    description: "Scaffold the stack root (.env, data/, logs/, repos/).",
    optional: false,
  },
  {
    id: "pull-images",
    title: "Pull images",
    description: "Download the ProPR service and agent container images.",
    optional: false,
  },
  {
    id: "configure-agents",
    title: "Configure agents",
    description: "Record detected host agent-credential directories in .env.",
    optional: false,
  },
  {
    id: "github-auth",
    title: "GitHub authentication",
    description: "Choose how the backend authenticates to GitHub.",
    optional: false,
  },
  {
    id: "start-stack",
    title: "Start stack",
    description: "Launch the local control-plane services.",
    optional: false,
  },
  {
    id: "whitelist",
    title: "Whitelist setup",
    description: "Authorize the repositories ProPR is allowed to act on.",
    optional: false,
  },
  {
    id: "repo",
    title: "Repository setup",
    description: "Optionally connect a first repository to work on.",
    optional: true,
  },
  {
    id: "launch-ui",
    title: "Launch UI",
    description: "Open the ProPR web UI.",
    optional: true,
  },
];
