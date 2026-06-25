/**
 * GitHub event-intake + user-whitelist helpers for `propr setup`.
 *
 * Two concerns the setup wizard must guide a new user through, factored out of
 * the engine so the decision logic lives in one tested place and both renderers
 * (Ink + readline) share it:
 *
 *   - **Intake mode** — how the backend learns about GitHub events, selected by
 *     the `GITHUB_EVENT_INTAKE_MODE` `.env` key (the legacy `ENABLE_GITHUB_WEBHOOKS`
 *     boolean is deprecated and no longer selects the mode). Three paths:
 *       routing_websocket — events stream over the hosted ProPR routing
 *                           WebSocket; no inbound webhook listener and no own
 *                           GitHub App required. The default, and only usable
 *                           with relay auth (PROPR_GH_RELAY_TOKEN).
 *       polling           — the daemon polls the GitHub API on an interval; works
 *                           with any usable GitHub auth and needs no inbound URL.
 *       direct_webhook    — GitHub posts directly to the local API; requires an
 *                           own GitHub App plus a signing secret so forged
 *                           payloads are rejected.
 *     {@link buildIntakeEnvVars} turns a chosen mode into the exact `.env` keys
 *     (`GITHUB_EVENT_INTAKE_MODE`, and `GH_WEBHOOK_SECRET` for direct webhooks),
 *     refusing to produce a direct_webhook config without a secret — the API
 *     would otherwise refuse to boot.
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

import type { GithubAuthMode, GithubEventIntakeMode } from "@propr/shared";

/**
 * How the backend ingests GitHub events. Aliased to the shared
 * {@link GithubEventIntakeMode} so the wizard and the backend boot path can't
 * drift on the values the `GITHUB_EVENT_INTAKE_MODE` `.env` key accepts:
 *   routing_websocket — events stream over the ProPR routing WebSocket (default)
 *   polling           — the daemon polls the GitHub API; no inbound exposure
 *   direct_webhook    — GitHub posts to a local /webhook endpoint (needs a secret)
 */
export type GithubIntakeMode = GithubEventIntakeMode;

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
  /** Signing secret, required (and only used) when `mode === "direct_webhook"`. */
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
 * The intake mode to pre-select for a given GitHub auth mode. The hosted routing
 * WebSocket is the product default, but it only works with relay auth (it needs
 * a relay token and the shared ProPR App), so it's recommended only when relay
 * auth is configured. Every other auth mode falls back to polling, which works
 * with any usable GitHub auth and needs no inbound network exposure — and unlike
 * direct webhooks requires no public URL or own GitHub App.
 */
export function defaultIntakeMode(authMode: GithubAuthMode): GithubIntakeMode {
  return authMode === "relay" ? "routing_websocket" : "polling";
}

/**
 * The intake choice the prompt should pre-select.
 *
 * On a re-run where `.env` already carries an intake decision
 * (`GITHUB_EVENT_INTAKE_MODE` is set), the safe default is `"keep"`: a blank Enter
 * must never silently rewrite a working config — e.g. an existing
 * `direct_webhook` install must not flip to `routing_websocket` just because the
 * auth-derived recommendation differs. This upholds the setup engine's re-run
 * safety model (keep existing config unless the user explicitly changes it). Only
 * on a fresh install, with no intake config yet, do we fall back to the
 * auth-derived recommendation from {@link defaultIntakeMode}.
 */
export function defaultIntakeChoice(
  authMode: GithubAuthMode,
  opts: { intakeConfigured: boolean }
): GithubIntakeMode | "keep" {
  return opts.intakeConfigured ? "keep" : defaultIntakeMode(authMode);
}

/**
 * Translate a chosen {@link GithubIntakeMode} into the `.env` keys it implies.
 * The mode is selected by `GITHUB_EVENT_INTAKE_MODE`, the value the backend boot
 * path resolves (see resolveGithubEventIntakeMode); the deprecated
 * `ENABLE_GITHUB_WEBHOOKS` boolean is intentionally never written here.
 *
 *   - `routing_websocket` / `polling` set `GITHUB_EVENT_INTAKE_MODE` to the mode
 *     and nothing else — routing events arrive over the relay WebSocket and
 *     polling pulls them from the API, neither needing a local webhook listener.
 *     A previously recorded `GH_WEBHOOK_SECRET` is intentionally *not* cleared:
 *     `applyEnvSelection`/`upsertEnvVars` only set keys, never remove them. The
 *     leftover secret is inert while not in direct_webhook mode (the API never
 *     reads it), but callers wanting a pristine `.env` must remove it by hand.
 *   - `direct_webhook` records the signing secret alongside the mode. An
 *     empty/whitespace secret is rejected with {@link IntakeConfigError}: the API
 *     refuses to boot in direct_webhook mode with no secret, so writing it would
 *     only break startup.
 */
export function buildIntakeEnvVars(
  mode: GithubIntakeMode,
  opts: { webhookSecret?: string } = {}
): Record<string, string> {
  switch (mode) {
    case "routing_websocket":
    case "polling":
      return { GITHUB_EVENT_INTAKE_MODE: mode };
    case "direct_webhook": {
      const secret = (opts.webhookSecret ?? "").trim();
      if (!secret) {
        throw new IntakeConfigError(
          "A webhook secret is required for direct webhooks — the API refuses to start without one."
        );
      }
      return { GITHUB_EVENT_INTAKE_MODE: "direct_webhook", GH_WEBHOOK_SECRET: secret };
    }
  }
}

/** A short, human-readable label for an intake mode, shared by both renderers. */
export function intakeModeLabel(mode: GithubIntakeMode): string {
  switch (mode) {
    case "routing_websocket":
      return "ProPR routing WebSocket (hosted relay)";
    case "polling":
      return "polling (no inbound webhooks)";
    case "direct_webhook":
      return "direct webhooks (signing secret recorded)";
  }
}

/**
 * One intake mode's availability under a given GitHub auth mode, for the intake
 * prompt. Each renderer maps this onto a selectable (or inactive) option.
 */
export interface IntakeModeOption {
  /** The intake mode this entry describes. */
  mode: GithubIntakeMode;
  /** False when the chosen auth mode cannot support this intake path. */
  available: boolean;
  /**
   * A short note for the renderer to surface next to the option: when
   * `available` is false this is *why* the path is closed; when true it is an
   * optional caveat (e.g. polling's production-suitability warning).
   */
  note?: string;
}

/**
 * The intake modes to show for a given GitHub auth mode, in display order, each
 * flagged available or not. Unavailable modes are intentionally still returned
 * so the prompt can show them inactive with the reason — a new user sees the
 * full set and learns why a path is closed rather than wondering where it went.
 *
 * The availability rules mirror {@link validateIntakeModePrerequisites} so the
 * prompt and the backend boot-time check can never disagree:
 *   - routing_websocket needs the ProPR token relay; a custom GitHub App can't use it.
 *   - direct_webhook needs your own GitHub App; the ProPR relay can't deliver to it.
 *   - polling works with either usable auth, but is not recommended for production.
 */
export function intakeModeOptions(authMode: GithubAuthMode): IntakeModeOption[] {
  const relay = authMode === "relay";
  const app = authMode === "app";
  return [
    {
      mode: "routing_websocket",
      available: relay,
      note: relay
        ? undefined
        : "needs the ProPR GitHub App (token relay); not available with a custom GitHub App",
    },
    {
      mode: "polling",
      available: relay || app,
      note:
        relay || app
          ? "not recommended for production: subject to GitHub API rate limits and delayed event detection (depends on the polling interval and the number of repos/PRs/issues)"
          : "needs usable GitHub auth — configure the token relay or a custom GitHub App first",
    },
    {
      mode: "direct_webhook",
      available: app,
      note: app
        ? undefined
        : "needs your own custom GitHub App; not available with the ProPR token relay",
    },
  ];
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
