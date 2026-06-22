/**
 * Setup wizard state helpers.
 *
 * Pure, side-effect-free domain logic for `propr setup`: resolving the stack
 * root, inspecting how far scaffolding has progressed, safely editing `.env`,
 * and advancing the per-step model in ./types.ts. None of these import Ink or
 * readline, and none start Docker on their own. The stack-root resolver reuses
 * the orchestrator module's pure {@link resolveStackRoot} — path math over node
 * builtins only, so importing it does not load the Docker-backed orchestrator
 * core. That core (orchestrator.mjs) is loaded lazily by the one helper that
 * needs it ({@link isStackRunning}), so this module stays safe to import (and
 * unit-test) without a running daemon or a TTY.
 *
 * Editing `.env` reuses {@link upsertEnvVars}, which only touches the keys it is
 * given and preserves every other line. The two writers below keep the flow
 * non-destructive by default: {@link seedEnvDefaults} only fills missing or
 * placeholder values, while {@link writeEnvSelection} writes explicit user
 * choices.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { scaffoldStack, type InitStackOptions, type InitStackResult } from "../initStack.js";
import { resolveStackRoot } from "../../orchestrator/index.js";
import type { ConfigManager } from "../../config/index.js";
import { upsertEnvVars } from "../../utils/envFile.js";
import {
  SETUP_STEPS,
  type SetupState,
  type SetupStepId,
  type SetupStepState,
  type SetupStepStatus,
  type StackState,
} from "./types.js";

/**
 * Resolve the stack root for the wizard. Thin wrapper over the shared
 * {@link resolveStackRoot} so the command, TUI and fallback renderer all agree
 * on precedence: explicit flag → PROPR_ROOT → saved config → cwd.
 */
export function resolveSetupRoot(configManager: ConfigManager | undefined, flagRoot?: string): string {
  return resolveStackRoot(configManager, flagRoot);
}

/** True when `path` is an existing regular file (false for dirs / missing). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` is an existing directory (false for files / missing). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Filesystem-only snapshot of scaffolding progress for `rootDir`. Used to keep
 * the init step idempotent: a fully-initialized root needs no re-scaffold. The
 * checks are type-aware — a regular file named `data`/`logs`/`repos` (or a
 * directory named `.env`) does not count, so an invalid root is not mistaken
 * for an initialized one.
 */
export function getStackState(rootDir: string): StackState {
  const envPath = join(rootDir, ".env");
  const envExists = isFile(envPath);
  const dataDirExists = isDirectory(join(rootDir, "data"));
  const logsDirExists = isDirectory(join(rootDir, "logs"));
  const reposDirExists = isDirectory(join(rootDir, "repos"));
  return {
    rootDir,
    envPath,
    envExists,
    dataDirExists,
    logsDirExists,
    reposDirExists,
    initialized: envExists && dataDirExists && logsDirExists && reposDirExists,
  };
}

/** Whether `rootDir` is already scaffolded (.env + data/, logs/, repos/). */
export function isStackInitialized(rootDir: string): boolean {
  return getStackState(rootDir).initialized;
}

export interface InitializeStackOutcome {
  result: InitStackResult;
  state: StackState;
}

/**
 * Idempotently scaffold the stack root. Delegates to {@link scaffoldStack},
 * which skips an existing `.env` unless `force` is set and only creates the
 * directories that are missing, then returns the refreshed {@link StackState}.
 */
export async function initializeStack(options: InitStackOptions = {}): Promise<InitializeStackOutcome> {
  const result = await scaffoldStack(options);
  return { result, state: getStackState(result.rootDir) };
}

/**
 * Whether the control-plane services are already up. This is the only helper
 * that needs the orchestrator, so it is loaded lazily here — importing this
 * module does not touch Docker. Returns false if Docker is unreachable.
 */
export async function isStackRunning(rootDir: string, configManager?: ConfigManager): Promise<boolean> {
  const { getHostConfig } = await import("../../orchestrator/index.js");
  const { orch, cfg } = await getHostConfig({ configManager, root: rootDir });
  if (!orch.dockerAvailable()) return false;
  return orch.isStackRunning(cfg);
}

// --- .env reading -----------------------------------------------------------

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Read raw KEY=VALUE pairs from a `.env`, ignoring comments and blank lines.
 * Values are returned literally (no quote stripping), matching Docker
 * --env-file semantics and {@link upsertEnvVars}. Returns {} if the file is
 * absent so callers can treat "missing" and "empty" the same way.
 */
export function readEnvValues(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const match = line.match(ENV_LINE);
    // First assignment wins, mirroring how dotenv/Docker read a file top-down.
    if (match && !(match[1] in out)) out[match[1]] = match[2];
  }
  return out;
}

/** Read a single `.env` value, or undefined when the key is unset. */
export function getEnvValue(envPath: string, key: string): string | undefined {
  return readEnvValues(envPath)[key];
}

// Matches the unedited .env.example placeholders (your_app_id, path/to/..., x's,
// changeme, example.com). Kept in sync with checkCommands.ts `isPlaceholder` so
// the wizard and the checker agree on what counts as "not yet configured".
const PLACEHOLDER = /^your_|^\.?\/path\/to|^changeme$|^x{4,}$|^example\.com$/i;

/** True when a value is empty or one of the .env.example placeholders. */
export function isPlaceholderEnvValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return PLACEHOLDER.test(trimmed);
}

// --- .env writing -----------------------------------------------------------

/** Outcome of a `.env` write, so renderers can report what changed. */
export interface EnvWriteResult {
  /** Keys whose value was written. */
  written: string[];
  /** Keys left untouched because a real value already existed. */
  preserved: string[];
  /** Keys ignored because the requested value was empty/undefined. */
  skipped: string[];
}

/**
 * A value is "real" only when it is defined and not blank — whitespace-only
 * input (e.g. a prompt answered with spaces) counts as empty so it never gets
 * written as a value, bypassing placeholder/default handling.
 */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Write explicit user selections to `.env`. Empty/blank/undefined values are
 * skipped (so an un-answered prompt never blanks an existing value); everything
 * else is upserted via {@link upsertEnvVars}, replacing any current value. Use
 * this when the user has deliberately chosen a value for a step.
 */
export function writeEnvSelection(envPath: string, selections: Record<string, string | undefined>): EnvWriteResult {
  const result: EnvWriteResult = { written: [], preserved: [], skipped: [] };
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(selections)) {
    if (!hasValue(value)) {
      result.skipped.push(key);
      continue;
    }
    vars[key] = value;
    result.written.push(key);
  }
  if (result.written.length > 0) upsertEnvVars(envPath, vars);
  return result;
}

/**
 * Non-destructively seed default/detected values: a key is written only when it
 * is currently missing or still a placeholder, so existing user-set values are
 * always preserved. Use this for detected agent dirs and other suggestions the
 * wizard offers without an explicit choice.
 */
export function seedEnvDefaults(envPath: string, defaults: Record<string, string | undefined>): EnvWriteResult {
  const existing = readEnvValues(envPath);
  const result: EnvWriteResult = { written: [], preserved: [], skipped: [] };
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!hasValue(value)) {
      result.skipped.push(key);
      continue;
    }
    if (!isPlaceholderEnvValue(existing[key])) {
      result.preserved.push(key);
      continue;
    }
    vars[key] = value;
    result.written.push(key);
  }
  if (result.written.length > 0) upsertEnvVars(envPath, vars);
  return result;
}

// --- step model -------------------------------------------------------------

/**
 * Build the initial wizard model for `rootDir` with every step pending.
 * Renderers start from this and advance it as steps run.
 */
export function createSetupState(rootDir: string): SetupState {
  return {
    rootDir,
    steps: SETUP_STEPS.map((def) => ({ id: def.id, status: "pending" as SetupStepStatus })),
  };
}

/**
 * Return a new {@link SetupState} with one step updated. Immutable so the Ink
 * renderer can diff cheaply; the fallback renderer can ignore the return value
 * structure and just re-read it.
 */
export function updateStep(
  state: SetupState,
  id: SetupStepId,
  status: SetupStepStatus,
  patch: Partial<Omit<SetupStepState, "id" | "status">> = {}
): SetupState {
  return {
    ...state,
    steps: state.steps.map((step) => {
      if (step.id !== id) return step;
      const next: SetupStepState = { ...step, status, ...patch };
      // A step that leaves the "error" state should not keep showing its old
      // failure message (e.g. error → done after a retry). Clear it unless the
      // caller explicitly set a new one in the patch.
      if (status !== "error" && !("error" in patch)) delete next.error;
      return next;
    }),
  };
}

/**
 * The next step that still needs attention, or undefined. A step is actionable
 * when it is pending, currently active, or errored — an `error` step is
 * surfaced ahead of later pending steps because it needs the user to act before
 * the flow can move on.
 */
export function nextActionableStep(state: SetupState): SetupStepState | undefined {
  return state.steps.find(
    (step) => step.status === "pending" || step.status === "active" || step.status === "error"
  );
}

/** Count steps by status — used by both renderers for a one-line summary. */
export function summarizeSetup(state: SetupState): Record<SetupStepStatus, number> {
  const counts: Record<SetupStepStatus, number> = { pending: 0, active: 0, done: 0, skipped: 0, error: 0 };
  for (const step of state.steps) counts[step.status] += 1;
  return counts;
}

/** Ids of the steps that may be skipped without leaving the stack unusable. */
const OPTIONAL_STEP_IDS = new Set<SetupStepId>(
  SETUP_STEPS.filter((def) => def.optional).map((def) => def.id)
);

/**
 * True once setup has settled: every step is either done, or skipped *and*
 * optional. A skipped required step is not "complete" — skipping it leaves the
 * stack unusable, so the flow still has work to do.
 */
export function isSetupComplete(state: SetupState): boolean {
  return state.steps.every(
    (step) => step.status === "done" || (step.status === "skipped" && OPTIONAL_STEP_IDS.has(step.id))
  );
}
