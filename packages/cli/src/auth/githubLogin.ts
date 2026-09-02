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
import { spawn } from "node:child_process";
import { rethrowCancellation } from "@propr/local-setup";

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
  signal?: AbortSignal;
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
  const { interactive = false, onLog, signal } = options;

  // Require the gh CLI up front — every path below shells out to it.
  try {
    const version = await runGh(["--version"], false, signal);
    signal?.throwIfAborted();
    if (version.status !== 0) throw version.error;
  } catch (error) {
    signal?.throwIfAborted();
    rethrowCancellation(error);
    return {
      ok: false,
      message:
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com, or run `propr login <token>` with a personal access token.",
    };
  }

  // Reuse an existing gh session when one is already authenticated.
  const existing = await readGhToken(signal);
  if (existing) {
    signal?.throwIfAborted();
    await configManager.setGithubToken(existing, signal);
    signal?.throwIfAborted();
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
  const result = await runGh(["auth", "login", "-s", GH_LOGIN_SCOPES], false, signal, true);
  signal?.throwIfAborted();
  if (result.status !== 0) {
    return { ok: false, message: "GitHub login failed or was cancelled." };
  }

  const token = await readGhToken(signal);
  if (!token) {
    return { ok: false, message: "Could not retrieve a token after login." };
  }
  signal?.throwIfAborted();
  await configManager.setGithubToken(token, signal);
  signal?.throwIfAborted();
  return { ok: true, token, message: "Authentication successful." };
}

/** Read the current `gh` token, or null when no session is authenticated. */
async function readGhToken(signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await runGh(["auth", "token"], true, signal);
    signal?.throwIfAborted();
    const token = result.status === 0 ? result.stdout.trim() : "";
    return token || null;
  } catch (error) {
    signal?.throwIfAborted();
    rethrowCancellation(error);
    return null;
  }
}

function runGh(args: string[], capture: boolean, signal?: AbortSignal, interactive = false): Promise<{ status: number | null; stdout: string; error?: Error }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("gh", args, {
      stdio: interactive ? "inherit" : capture ? ["ignore", "pipe", "ignore"] : "ignore",
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let forceTimer: NodeJS.Timeout | undefined;
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    const terminate = (force = false) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
        killer.unref();
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
      }
    };
    const abort = () => {
      terminate();
      forceTimer = setTimeout(() => {
        terminate(true);
        forceTimer = setTimeout(() => reject(signal?.reason), 2_000);
      }, 2_000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => resolve({ status: null, stdout, error }));
    child.once("close", status => {
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else resolve({ status, stdout });
    });
  });
}
