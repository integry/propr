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
  const { interactive = false, onLog } = options;
  const { execSync, spawnSync } = await import("child_process");

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
  const existing = readGhToken(execSync);
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

/** Read the current `gh` token, or null when no session is authenticated. */
function readGhToken(execSync: typeof import("child_process").execSync): string | null {
  try {
    const token = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    return token || null;
  } catch {
    return null;
  }
}
