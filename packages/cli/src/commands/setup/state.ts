/**
 * Setup wizard domain helpers.
 *
 * Pure, side-effect-light helpers that the `propr setup` driver and both
 * renderers (Ink TUI and readline fallback) build on:
 *   - resolving the stack root (reusing the orchestrator's precedence rules),
 *   - inspecting whether the stack is already initialized,
 *   - reading and *safely* editing .env (non-destructive by default),
 *   - constructing and transitioning the {@link SetupState} step model.
 *
 * Nothing here loads the orchestrator's Docker core or renders UI, so the
 * module can be imported and unit-tested without Docker, Ink, or readline.
 * `resolveStackRoot` lives in ../../orchestrator/index.js but only reads config
 * and env — it does not start Docker.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGithubAuthMode, type GithubAuthModeResult } from "@propr/shared";
import { resolveStackRoot } from "../../orchestrator/index.js";
import type { ConfigManager } from "../../config/index.js";
import { upsertEnvVars } from "../../utils/envFile.js";
import {
  SETUP_STEP_DEFINITIONS,
  type SetupState,
  type SetupStep,
  type SetupStepId,
  type SetupStepPatch,
} from "./types.js";

/** Sub-directories scaffoldStack creates under the stack root. */
const STACK_SUBDIRS = ["data", "logs", "repos"] as const;

/**
 * Resolve the stack root for setup, reusing the orchestrator's precedence:
 * explicit flag → PROPR_ROOT env → saved config stackRoot → cwd. Does not load
 * Docker.
 */
export function resolveSetupRoot(
  configManager: ConfigManager | undefined,
  flagRoot?: string
): string {
  return resolveStackRoot(configManager, flagRoot);
}

/** Absolute path to the .env file for a given stack root. */
export function envPathFor(rootDir: string): string {
  return join(rootDir, ".env");
}

/** Snapshot of which scaffolded pieces of a stack root already exist. */
export interface StackInitState {
  rootDir: string;
  envExists: boolean;
  /** Per-subdir existence (data/, logs/, repos/). */
  dirs: Record<(typeof STACK_SUBDIRS)[number], boolean>;
  /** True when .env and all expected sub-directories are present. */
  initialized: boolean;
}

/**
 * Inspect whether the stack at `rootDir` looks initialized. Read-only — never
 * creates anything — so callers can decide whether to skip or re-run
 * scaffolding.
 */
export function inspectStackInit(rootDir: string): StackInitState {
  const envExists = existsSync(envPathFor(rootDir));
  const dirs = {} as StackInitState["dirs"];
  for (const sub of STACK_SUBDIRS) {
    dirs[sub] = existsSync(join(rootDir, sub));
  }
  const initialized = envExists && STACK_SUBDIRS.every((sub) => dirs[sub]);
  return { rootDir, envExists, dirs, initialized };
}

/** Convenience predicate over {@link inspectStackInit}. */
export function isStackInitialized(rootDir: string): boolean {
  return inspectStackInit(rootDir).initialized;
}

/**
 * Parse the .env at `rootDir` into a flat map. Returns `{}` when the file is
 * absent. Mirrors the assignment shape the rest of the stack relies on:
 * `KEY=value`, optionally `export `-prefixed, ignoring blanks and comments.
 * Surrounding quotes are stripped for convenient reads; this is intentionally a
 * lightweight reader, not a full dotenv implementation.
 */
export function readEnvVars(rootDir: string): Record<string, string> {
  const envPath = envPathFor(rootDir);
  if (!existsSync(envPath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    vars[key] = rawValue.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

/** True when `key` is present in .env with a non-empty value. */
export function hasEnvValue(rootDir: string, key: string): boolean {
  const value = readEnvVars(rootDir)[key];
  return value !== undefined && value !== "";
}

/** Outcome of a {@link applyEnvSelection} call. */
export interface EnvSelectionResult {
  /** Keys actually written to .env this call. */
  written: string[];
  /** Keys left untouched because a value already existed (non-overwrite mode). */
  skipped: string[];
}

/**
 * Safely edit .env for a setup step.
 *
 * Non-destructive by default: a key is only written when it is currently
 * absent/empty, so re-running `propr setup` never clobbers values the user
 * already set. Pass `{ overwrite: true }` for steps where the user explicitly
 * selected a new value and intends to replace whatever is there.
 *
 * Empty-string selections are ignored entirely — a step that has nothing to
 * write must not blank out an existing value. Writes go through
 * {@link upsertEnvVars}, which preserves unrelated lines and tightens the
 * file's permissions.
 */
export function applyEnvSelection(
  rootDir: string,
  vars: Record<string, string>,
  opts: { overwrite?: boolean } = {}
): EnvSelectionResult {
  const existing = readEnvVars(rootDir);
  const toWrite: Record<string, string> = {};
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    if (value === "") continue; // never blank out an existing value
    const alreadySet = existing[key] !== undefined && existing[key] !== "";
    if (alreadySet && !opts.overwrite) {
      skipped.push(key);
      continue;
    }
    toWrite[key] = value;
    written.push(key);
  }

  if (written.length > 0) {
    upsertEnvVars(envPathFor(rootDir), toWrite);
  }
  return { written, skipped };
}

/**
 * Infer the current GitHub auth mode from the stack's .env, so the github-auth
 * step can show what is already configured (and skip prompting when valid).
 * Reuses the shared resolver the backend uses, so the two can't drift.
 */
export function detectGithubAuthMode(rootDir: string): GithubAuthModeResult {
  const env = readEnvVars(rootDir);
  const truthy = /^(1|true|yes|on)$/i;
  return resolveGithubAuthMode({
    demoMode: truthy.test(env.PROPR_DEMO_MODE ?? ""),
    ghAuthMode: env.GH_AUTH_MODE,
    relayUrl: env.RELAY_URL,
    relayToken: env.RELAY_TOKEN,
    appId: env.GH_APP_ID,
    privateKeyPath: env.GH_PRIVATE_KEY_PATH,
    installationId: env.GH_INSTALLATION_ID,
  });
}

/** Build the initial, all-`pending` setup state for a resolved stack root. */
export function createSetupState(rootDir: string): SetupState {
  return {
    rootDir,
    steps: SETUP_STEP_DEFINITIONS.map((def) => ({ ...def, status: "pending" })),
  };
}

/** Look up a step by id. */
export function getStep(state: SetupState, id: SetupStepId): SetupStep | undefined {
  return state.steps.find((step) => step.id === id);
}

/**
 * Return a new state with `id`'s step patched. Immutable so renderers can diff
 * by reference; unknown ids return the state unchanged.
 */
export function updateStep(
  state: SetupState,
  id: SetupStepId,
  patch: SetupStepPatch
): SetupState {
  let changed = false;
  const steps = state.steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    return { ...step, ...patch };
  });
  return changed ? { ...state, steps } : state;
}

/**
 * The next step the wizard should act on: the first one still `pending`. Used
 * by the sequential renderer to drive the flow and by the TUI to highlight the
 * current step.
 */
export function nextPendingStep(state: SetupState): SetupStep | undefined {
  return state.steps.find((step) => step.status === "pending");
}

/**
 * True once every required step has reached a terminal, non-failed state.
 * Optional steps never block completion; a single failed required step does.
 */
export function isSetupComplete(state: SetupState): boolean {
  return state.steps.every((step) => {
    if (step.status === "failed") return false;
    if (step.optional) return true;
    return step.status === "done" || step.status === "skipped" || step.status === "warning";
  });
}
