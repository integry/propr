/**
 * Shared GitHub authentication via the `gh` CLI.
 *
 * Both `propr login` (commands wired in index.ts) and `propr setup`'s relay
 * enrollment need a stored GitHub token. This centralises the `gh`-CLI flow —
 * reuse an existing `gh` session, or run the interactive `gh auth login` — so
 * the two callers stay in sync. It returns a result object instead of writing to
 * the console or calling process.exit, leaving presentation to the caller.
 */

import type { ConfigManager } from "../config/index.js";

/** Scopes requested when launching the interactive `gh auth login`. */
const GH_LOGIN_SCOPES = "repo,read:org";

export interface AuthenticationCommandResult {
  status: number | null;
}

export interface AuthenticationCommandHandoff {
  (command: string, args: string[], options: { title: string; signal?: AbortSignal }): Promise<AuthenticationCommandResult>;
}

export interface CapturedCommandResult extends AuthenticationCommandResult {
  stdout: string;
}

export interface CapturedCommandRunner {
  (command: string, args: string[], signal?: AbortSignal): Promise<CapturedCommandResult>;
}

export interface GithubLoginOptions {
  /**
   * When no existing `gh` session is found, launch the interactive
   * `gh auth login` (inherits stdio). When false, return a non-ok result
   * instead — used where an interactive subprocess would be unsafe (e.g. the
   * full-screen Ink wizard).
   */
  interactive?: boolean;
  /** Sink for human-facing progress lines. Defaults to no output. */
  onLog?: (line: string) => void;
  /** Desktop-visible process handoff. Its presence keeps every command asynchronous. */
  authenticationHandoff?: AuthenticationCommandHandoff;
  /** Test seam for the non-interactive probes around a desktop handoff. */
  capturedCommand?: CapturedCommandRunner;
  /** Cooperative desktop cancellation. */
  signal?: AbortSignal;
  /** Start an account-changing login even when gh already has a session. */
  force?: boolean;
}

export interface GithubLoginResult {
  /** True when a token was obtained and stored on the config manager. */
  ok: boolean;
  /** The stored token, when `ok`. */
  token?: string;
  /** Human-facing summary (success note or the reason it could not proceed). */
  message: string;
}

/**
 * Authenticate with GitHub through the `gh` CLI and persist the token.
 *
 * Order: confirm `gh` is installed → reuse an existing `gh auth token` →
 * (interactive only) run `gh auth login` and read the token back.
 */
export async function loginWithGithubCli(
  configManager: ConfigManager,
  options: GithubLoginOptions = {}
): Promise<GithubLoginResult> {
  const { interactive = false, onLog, authenticationHandoff, signal, force = false } = options;
  const { execSync, spawnSync } = await import("child_process");

  if (authenticationHandoff) {
    const capture = options.capturedCommand ?? runCapturedCommand;
    signal?.throwIfAborted();
    let version: CapturedCommandResult;
    try {
      version = await capture("gh", ["--version"], signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      version = { status: null, stdout: "" };
    }
    if (version.status !== 0) {
      return {
        ok: false,
        message: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com and retry setup.",
      };
    }
    const existing = force ? null : await readGhTokenAsync(capture, signal);
    if (existing) {
      signal?.throwIfAborted();
      await configManager.setGithubToken(existing);
      return { ok: true, token: existing, message: "Authenticated using your existing gh CLI session." };
    }
    if (!interactive) {
      return { ok: false, message: "No gh CLI session found. Retry setup to authenticate with GitHub." };
    }
    onLog?.("No existing gh session found. Opening a GitHub login window…");
    const result = await authenticationHandoff("gh", ["auth", "login", "-s", GH_LOGIN_SCOPES], {
      title: "ProPR · GitHub authentication",
      signal,
    });
    signal?.throwIfAborted();
    if (result.status !== 0) return { ok: false, message: "GitHub login failed or was cancelled." };
    const token = await readGhTokenAsync(capture, signal);
    if (!token) return { ok: false, message: "Could not retrieve a token after login." };
    signal?.throwIfAborted();
    await configManager.setGithubToken(token);
    return { ok: true, token, message: "Authentication successful." };
  }

  // Require the gh CLI up front — every path below shells out to it.
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    return {
      ok: false,
      message:
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com, or run `propr login <token>` with a personal access token.",
    };
  }

  // Reuse an existing gh session when one is already authenticated.
  const existing = force ? null : readGhToken(execSync);
  if (existing) {
    await configManager.setGithubToken(existing);
    return { ok: true, token: existing, message: "Authenticated using your existing gh CLI session." };
  }

  if (!interactive) {
    return {
      ok: false,
      message: "No gh CLI session found. Run `propr login` (or `gh auth login`) to authenticate first.",
    };
  }

  // Launch the interactive browser/device login. Inherits stdio so the user can
  // complete the gh prompts directly.
  onLog?.("No existing gh session found. Starting interactive login…");
  const result = spawnSync("gh", ["auth", "login", "-s", GH_LOGIN_SCOPES], { stdio: "inherit" });
  if (result.status !== 0) {
    return { ok: false, message: "GitHub login failed or was cancelled." };
  }

  const token = readGhToken(execSync);
  if (!token) {
    return { ok: false, message: "Could not retrieve a token after login." };
  }
  await configManager.setGithubToken(token);
  return { ok: true, token, message: "Authentication successful." };
}

const runCapturedCommand: CapturedCommandRunner = async (command, args, signal) => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], signal });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { if (stdout.length < 65_536) stdout += String(chunk); });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout: stdout.slice(0, 65_536) }));
  });
};

const readGhTokenAsync = async (run: CapturedCommandRunner, signal?: AbortSignal): Promise<string | null> => {
  try {
    const result = await run("gh", ["auth", "token"], signal);
    signal?.throwIfAborted();
    const token = result.status === 0 ? result.stdout.trim() : "";
    return token || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

/** Read the current `gh` token, or null when no session is authenticated. */
function readGhToken(execSync: typeof import("child_process").execSync): string | null {
  try {
    const token = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    return token || null;
  } catch {
    return null;
  }
}
