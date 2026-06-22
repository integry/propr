/**
 * GitHub event-intake + user-whitelist helpers for `propr setup`.
 *
 * Two concerns the setup wizard must guide a new user through, factored out of
 * the engine so the decision logic lives in one tested place and both renderers
 * (Ink + readline) share it:
 *
 *   - **Intake mode** — how the backend learns about GitHub events. Three paths,
 *     each a single `.env` edit:
 *       app      — the shared ProPR App / relay delivers events; no inbound
 *                  webhook listener runs locally (the default where a relay/App
 *                  is already configured).
 *       polling  — the daemon polls GitHub on an interval; webhooks disabled.
 *       webhooks — GitHub posts directly to the local API; requires a signing
 *                  secret so forged payloads are rejected.
 *     {@link buildIntakeEnvVars} turns a chosen mode into the exact `.env` keys
 *     (`ENABLE_GITHUB_WEBHOOKS`, and `GH_WEBHOOK_SECRET` for webhooks), refusing
 *     to produce a webhook config without a secret — the API would otherwise
 *     refuse to boot.
 *
 *   - **User whitelist** — which GitHub users may trigger ProPR. Saved through
 *     the settings API when the backend is running (a partial update that never
 *     clobbers unrelated settings), and mirrored into `.env` so the value
 *     survives a restart. {@link saveWhitelist} owns that routing and degrades to
 *     an `.env`-only write when the backend is down or the API call fails.
 *
 * Like the rest of the setup module these helpers are UI-agnostic and free of
 * Docker/network imports: side effects are passed in as callbacks so the engine
 * binds them to the real API/`.env` and tests drive the whole thing in memory.
 */

import type { GithubAuthMode } from "@propr/shared";

/** How the backend ingests GitHub events. */
export type GithubIntakeMode = "app" | "polling" | "webhooks";

/** Documentation surfaced in the intake prompt's detail text. */
export const INTAKE_DOCS_URL = "https://docs.propr.dev/docs/architecture/daemon";
/** Documentation for configuring direct webhook delivery. */
export const WEBHOOK_DOCS_URL = "https://docs.propr.dev/docs/tutorials/setup-server";

/**
 * Outcome of the intake prompt the renderer hands back to the engine. Mirrors
 * {@link GithubAuthDecision}: a `keep` leaves the current `.env` untouched,
 * otherwise the chosen `mode` (plus a secret for webhooks) is applied.
 */
export interface GithubIntakeDecision {
  /** Keep the existing intake configuration untouched. */
  keep?: boolean;
  /** The intake mode the user picked. */
  mode?: GithubIntakeMode;
  /** Signing secret, required (and only used) when `mode === "webhooks"`. */
  webhookSecret?: string;
}

/** Thrown when an intake selection is missing required input (e.g. a webhook secret). */
export class IntakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeConfigError";
  }
}

/**
 * The intake mode to pre-select for a given GitHub auth mode. A shared App or
 * relay already brings event delivery with it, so the App/relay path is the
 * default there; everything else falls back to polling, which works without any
 * inbound network exposure.
 */
export function defaultIntakeMode(authMode: GithubAuthMode): GithubIntakeMode {
  return authMode === "app" || authMode === "relay" ? "app" : "polling";
}

/**
 * Translate a chosen {@link GithubIntakeMode} into the `.env` keys it implies.
 *
 *   - `app` / `polling` disable the local webhook listener
 *     (`ENABLE_GITHUB_WEBHOOKS=false`) — events arrive via the relay or polling.
 *   - `webhooks` enables it and records the signing secret. An empty/whitespace
 *     secret is rejected with {@link IntakeConfigError}: the API refuses to boot
 *     with webhooks on but no secret, so writing it would only break startup.
 */
export function buildIntakeEnvVars(
  mode: GithubIntakeMode,
  opts: { webhookSecret?: string } = {}
): Record<string, string> {
  switch (mode) {
    case "app":
    case "polling":
      return { ENABLE_GITHUB_WEBHOOKS: "false" };
    case "webhooks": {
      const secret = (opts.webhookSecret ?? "").trim();
      if (!secret) {
        throw new IntakeConfigError(
          "A webhook secret is required for direct webhooks — the API refuses to start without one."
        );
      }
      return { ENABLE_GITHUB_WEBHOOKS: "true", GH_WEBHOOK_SECRET: secret };
    }
  }
}

// ---------------------------------------------------------------------------
// Whitelist persistence.
// ---------------------------------------------------------------------------

/** Where {@link saveWhitelist} persisted the whitelist. */
export interface SaveWhitelistResult {
  /** The store the value was written to as its source of truth. */
  target: "settings" | "env";
  /** Number of users in the saved whitelist (0 means cleared). */
  count: number;
  /**
   * Set when a settings-API save was attempted but failed, after which the
   * helper fell back to `.env`. Surfaced as a warning by the caller.
   */
  error?: string;
}

/** Inputs for {@link saveWhitelist}. Side effects are injected so it stays pure-ish and testable. */
export interface SaveWhitelistParams {
  /** The cleaned, de-duped usernames to persist (may be empty to clear). */
  users: string[];
  /** Whether the local backend is up — gates the settings-API path. */
  backendRunning: boolean;
  /** Persist through the running backend's settings API (partial update). */
  saveViaSettings(users: string[]): Promise<void>;
  /** Persist into `.env` (non-destructive, single key). */
  saveViaEnv(users: string[]): void;
}

/**
 * Persist the user whitelist, preferring the settings API when the backend is
 * running so the change takes effect immediately without a restart, and always
 * mirroring into `.env` so it survives one. If the API call fails we fall back
 * to the `.env` write and report the error rather than abort setup.
 *
 * The settings-API path issues a *partial* update (only the whitelist key), so
 * unrelated settings are never overwritten.
 */
export async function saveWhitelist(params: SaveWhitelistParams): Promise<SaveWhitelistResult> {
  const { users, backendRunning, saveViaSettings, saveViaEnv } = params;
  if (backendRunning) {
    try {
      await saveViaSettings(users);
      // Mirror into `.env` so the whitelist persists across `propr start`.
      saveViaEnv(users);
      return { target: "settings", count: users.length };
    } catch (error) {
      // The backend rejected the update (or was unreachable after all) — keep
      // the value in `.env` so it is not lost, and surface why.
      saveViaEnv(users);
      return { target: "env", count: users.length, error: (error as Error).message };
    }
  }
  saveViaEnv(users);
  return { target: "env", count: users.length };
}
