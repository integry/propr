/**
 * Setup wizard state helpers.
 *
 * Pure, side-effect-free domain logic for `propr setup`: resolving the stack
 * root, inspecting how far scaffolding has progressed, safely editing `.env`,
 * and advancing the per-step model in ./types.ts. None of these import Ink or
 * readline, and none start Docker on their own — the only orchestrator-backed
 * helper ({@link isStackRunning}) loads the orchestrator lazily, so the module
 * is safe to import (and unit-test) without a running daemon or a TTY.
 *
 * Editing `.env` reuses {@link upsertEnvVars}, which only touches the keys it is
 * given and preserves every other line. The two writers below keep the flow
 * non-destructive by default: {@link seedEnvDefaults} only fills missing or
 * placeholder values, while {@link writeEnvSelection} writes explicit user
 * choices.
 */

import { existsSync, readFileSync } from "node:fs";
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

/**
 * Filesystem-only snapshot of scaffolding progress for `rootDir`. Used to keep
 * the init step idempotent: a fully-initialized root needs no re-scaffold.
 */
export function getStackState(rootDir: string): StackState {
  const envPath = join(rootDir, ".env");
  const envExists = existsSync(envPath);
  const dataDirExists = existsSync(join(rootDir, "data"));
  const logsDirExists = existsSync(join(rootDir, "logs"));
  const reposDirExists = existsSync(join(rootDir, "repos"));
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

function isEmpty(value: string | undefined): value is undefined | "" {
  return value === undefined || value === "";
}

/**
 * Write explicit user selections to `.env`. Empty/undefined values are skipped
 * (so an un-answered prompt never blanks an existing value); everything else is
 * upserted via {@link upsertEnvVars}, replacing any current value. Use this when
 * the user has deliberately chosen a value for a step.
 */
export function writeEnvSelection(envPath: string, selections: Record<string, string | undefined>): EnvWriteResult {
  const result: EnvWriteResult = { written: [], preserved: [], skipped: [] };
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(selections)) {
    if (isEmpty(value)) {
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
    if (isEmpty(value)) {
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
    steps: state.steps.map((step) => (step.id === id ? { ...step, status, ...patch } : step)),
  };
}

/** The next step that still needs attention (pending or active), or undefined. */
export function nextActionableStep(state: SetupState): SetupStepState | undefined {
  return state.steps.find((step) => step.status === "pending" || step.status === "active");
}

/** Count steps by status — used by both renderers for a one-line summary. */
export function summarizeSetup(state: SetupState): Record<SetupStepStatus, number> {
  const counts: Record<SetupStepStatus, number> = { pending: 0, active: 0, done: 0, skipped: 0, error: 0 };
  for (const step of state.steps) counts[step.status] += 1;
  return counts;
}

/** True once no step is pending/active/error — i.e. setup has settled. */
export function isSetupComplete(state: SetupState): boolean {
  return state.steps.every((step) => step.status === "done" || step.status === "skipped");
}
