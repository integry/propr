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

import { readFileSync, statSync } from "node:fs";
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

/**
 * Sub-directories scaffoldStack creates under the stack root. Exported so the
 * setup driver and tests can create/check the same scaffold shape without
 * duplicating these names.
 */
export const STACK_SUBDIRS = ["data", "logs", "repos"] as const;

/** True only when `path` exists and is a directory. Missing paths read false. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True only when `path` exists and is a regular file. Missing paths read false. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when a value is missing or contains only whitespace. */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

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
 * scaffolding. A plain file standing in for an expected directory (or vice
 * versa) counts as *not* initialized, matching what the runtime requires.
 */
export function inspectStackInit(rootDir: string): StackInitState {
  const envExists = isFile(envPathFor(rootDir));
  const dirs = {} as StackInitState["dirs"];
  for (const sub of STACK_SUBDIRS) {
    dirs[sub] = isDirectory(join(rootDir, sub));
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
 * For unquoted values a trailing ` # comment` is stripped, matching the
 * orchestrator's env-file reader (and the round-trip that {@link upsertEnvVars}
 * guards against); surrounding quotes on quoted values are stripped and their
 * contents kept verbatim. This is intentionally a lightweight reader, not a
 * full dotenv implementation — it does not handle escaped quotes or multiline
 * values.
 */
export function readEnvVars(rootDir: string): Record<string, string> {
  const envPath = envPathFor(rootDir);
  // Treat anything that is not a regular file (absent, a directory, a broken
  // symlink) as "no vars", matching inspectStackInit's `isFile` guard, so a
  // malformed stack surfaces as not-initialized instead of crashing the read.
  if (!isFile(envPath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    const quoted = trimmed.match(/^(["'])(.*)\1$/);
    // Quoted values keep their contents verbatim; unquoted values drop a
    // trailing inline comment so reads agree with what upsertEnvVars allows.
    vars[key] = quoted ? quoted[2] : trimmed.replace(/\s+#.*$/, "");
  }
  return vars;
}

/** True when `key` is present in .env with a non-blank value. */
export function hasEnvValue(rootDir: string, key: string): boolean {
  return !isBlank(readEnvVars(rootDir)[key]);
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
 * Blank selections (empty or whitespace-only) are ignored entirely — a step
 * that has nothing to write must not blank out an existing value. Writes go
 * through
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
    if (isBlank(value)) continue; // never blank out an existing value
    const alreadySet = !isBlank(existing[key]);
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
    relayUrl: env.PROPR_GH_RELAY_URL,
    relayToken: env.PROPR_GH_RELAY_TOKEN,
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
 *
 * A failed required step blocks everything after it (see the `failed` status in
 * ./types.ts), so once one is encountered there is no next step until it is
 * retried — `undefined` is returned. Failed *optional* steps don't block.
 */
export function nextPendingStep(state: SetupState): SetupStep | undefined {
  // Scan for a blocking failure first so the "a failed required step blocks
  // everything after it" contract holds even if state was patched out of
  // order (e.g. a later step failed before an earlier one finished).
  if (state.steps.some((step) => !step.optional && step.status === "failed")) {
    return undefined;
  }
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
