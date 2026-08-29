/**
 * Local setup domain helpers.
 *
 * Pure, side-effect-light helpers that the `propr setup` driver and both
 * renderers (Ink TUI and readline fallback) build on:
 *   - resolving the stack root (reusing the orchestrator's precedence rules),
 *   - inspecting whether the stack is already initialized,
 *   - reading and *safely* editing .env (non-destructive by default),
 *   - constructing and transitioning the {@link SetupState} step model.
 *
 * Nothing here loads a launcher or renders UI, so the module can be imported
 * and unit-tested without Docker, Ink, or readline.
 */

import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveGithubAuthMode, type GithubAuthModeResult } from "@propr/shared";
import { clearEnvKeys as clearEnvFileKeys, upsertEnvVars } from "./envFile.js";
import { readPrivateFile } from "./privateFilesystem.js";
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
  configManager: { getStackRoot(): string | undefined } | undefined,
  flagRoot?: string
): string {
  if (flagRoot) return resolve(flagRoot);
  if (process.env.PROPR_ROOT) return resolve(process.env.PROPR_ROOT);
  const saved = configManager?.getStackRoot();
  return saved ? resolve(saved) : process.cwd();
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

export type DatastoreAdminStatus = "absent" | "no-admin" | "has-admin" | "uninspectable";

/** Result of inspecting the configured SQLite datastore for a durable administrator. */
export interface DatastoreAdminInspection {
  status: DatastoreAdminStatus;
  /** Host path inspected, when the configured path could be resolved. */
  databasePath?: string;
  /** Actionable diagnostic when inspection could not be completed safely. */
  detail?: string;
}

/** Runtime paths used by the app image started by the CLI launcher. */
const APP_WORKDIR = "/usr/src/app";
const CONTAINER_DATA_DIR = join(APP_WORKDIR, "data");

/**
 * Resolve the API's SQLite filename to the corresponding host bind-mount path.
 * This mirrors @propr/core's DB_FILENAME/DATA_DIR precedence and resolves
 * relative values from the app image's working directory. Only files below
 * /usr/src/app/data are inspectable from the host because that is the sole data
 * bind mount supplied by the CLI launcher.
 */
function resolveDatastorePath(
  rootDir: string,
  configuredPath: string | undefined,
  configuredDataDir: string | undefined
): string {
  const dbFilename = configuredPath;
  const runtimePath = dbFilename
    ? resolve(APP_WORKDIR, dbFilename)
    : resolve(APP_WORKDIR, join(configuredDataDir ?? CONTAINER_DATA_DIR, "propr.sqlite"));
  const childPath = relative(CONTAINER_DATA_DIR, runtimePath);
  const outsideDataDir =
    childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath);
  if (outsideDataDir) {
    throw new Error(
      `runtime path ${runtimePath} is outside the mounted data directory ${CONTAINER_DATA_DIR}`
    );
  }
  return resolve(rootDir, "data", childPath);
}

/**
 * Reject symbolic links between the host bind-mount root and the configured
 * datastore. A link that is valid in the host namespace may resolve to a
 * different target inside the container, so following it cannot establish
 * bootstrap eligibility for the datastore the API will actually use.
 */
function assertDatastorePathHasNoSymlinks(rootDir: string, databasePath: string): void {
  const dataRoot = resolve(rootDir, "data");
  const childPath = relative(dataRoot, databasePath);
  let currentPath = dataRoot;

  for (const component of childPath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, component);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`configured datastore path contains a symbolic link: ${currentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Inspect the configured SQLite datastore without creating or migrating it.
 * Missing databases and databases conclusively lacking a durable administrator
 * are bootstrap-eligible. Every resolution, I/O, schema, and query failure is
 * reported as uninspectable so callers can fail closed.
 */
export async function inspectDatastoreAdministrators(rootDir: string): Promise<DatastoreAdminInspection> {
  let databasePath: string;
  try {
    const env = readEnvVars(rootDir);
    databasePath = resolveDatastorePath(rootDir, env.DB_FILENAME, env.DATA_DIR);
  } catch (error) {
    return {
      status: "uninspectable",
      detail: `could not resolve configured datastore: ${(error as Error).message}`,
    };
  }

  try {
    assertDatastorePathHasNoSymlinks(rootDir, databasePath);
    const stat = statSync(databasePath);
    if (!stat.isFile()) {
      return { status: "uninspectable", databasePath, detail: "configured datastore is not a regular file" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent", databasePath };
    }
    return {
      status: "uninspectable",
      databasePath,
      detail: `could not inspect configured datastore: ${(error as Error).message}`,
    };
  }

  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const membersTable = database.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'instance_members' LIMIT 1"
    ).get();
    if (!membersTable) return { status: "no-admin", databasePath };

    const durableAdmin = database.prepare(
      "SELECT 1 AS found FROM instance_members WHERE role = 'admin' LIMIT 1"
    ).get();
    return { status: durableAdmin ? "has-admin" : "no-admin", databasePath };
  } catch (error) {
    return {
      status: "uninspectable",
      databasePath,
      detail: `could not query configured datastore: ${(error as Error).message}`,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // The read query already produced a conclusive result; closing the
      // read-only handle cannot widen authorization and needs no retry here.
    }
  }
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
export function readEnvVars(rootDir: string, signal?: AbortSignal): Record<string, string> {
  signal?.throwIfAborted();
  const envPath = envPathFor(rootDir);
  // Treat anything that is not a regular file (absent, a directory, a broken
  // symlink) as "no vars", matching inspectStackInit's `isFile` guard, so a
  // malformed stack surfaces as not-initialized instead of crashing the read.
  if (!isFile(envPath)) return {};
  const contents = readPrivateFile(envPath);
  if (!contents) return {};
  const vars: Record<string, string> = {};
  for (const line of contents.toString("utf-8").split(/\r?\n/)) {
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
  opts: { overwrite?: boolean } = {},
  signal?: AbortSignal,
): EnvSelectionResult {
  signal?.throwIfAborted();
  const existing = readEnvVars(rootDir, signal);
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
    upsertEnvVars(envPathFor(rootDir), toWrite, signal);
  }
  return { written, skipped };
}

/**
 * Remove `keys` from the stack's `.env` entirely.
 *
 * {@link applyEnvSelection} can only set keys (and deliberately ignores blank
 * values so it never clobbers a value the user set), so it cannot *clear* a key:
 * writing `KEY=` would leave an empty assignment that reads back as a set-but-
 * empty value. Setup steps that must genuinely drop a stale key — clearing the
 * user whitelist back to "none", removing a key when switching modes — call this
 * instead. A missing `.env` or absent keys are no-ops.
 */
export function clearEnvKeys(rootDir: string, keys: string[], signal?: AbortSignal): void {
  signal?.throwIfAborted();
  clearEnvFileKeys(envPathFor(rootDir), keys, signal);
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
    // The CLI stack records the App key as HOST_GH_PRIVATE_KEY (the orchestrator
    // bind-mounts it and sets the in-container GH_PRIVATE_KEY_PATH to that path),
    // so accept either when inferring app mode — otherwise a stack configured by
    // `propr setup` would resolve as "none" despite being fully set up.
    privateKeyPath: env.GH_PRIVATE_KEY_PATH ?? env.HOST_GH_PRIVATE_KEY,
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
