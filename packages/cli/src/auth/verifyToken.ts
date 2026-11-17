/**
 * Token verification for `propr login`.
 *
 * Saving a token proves nothing about it. When a remote is configured, the
 * token is checked against the remote's `/api/auth/user`, so the login result
 * says whether the ProPR API accepted it, rejected it, or could not be asked.
 */

import { ApiClient } from "../api/client.js";
import { classifyApiError } from "../utils/apiErrorPresentation.js";
import type { ConfigManager } from "../config/index.js";

export type TokenVerification =
  /** The remote accepted the token. */
  | { status: "verified"; remoteUrl: string; login?: string }
  /** The remote answered 401: the token does not authenticate. */
  | { status: "rejected"; remoteUrl: string; message: string }
  /** The token authenticates, but the instance denies this account. */
  | { status: "forbidden"; remoteUrl: string; message: string }
  /** The remote could not be asked (unreachable, not a ProPR API, server error). */
  | { status: "unverified"; remoteUrl: string; reason: string }
  /** No remote is configured, so there is nothing to verify against. */
  | { status: "no_remote" };

export interface VerifyTokenOptions {
  /** Injected in tests; otherwise a client for the configured remote. */
  client?: ApiClient;
  /** Request timeout. Login should not hang on an unreachable remote. */
  timeoutMs?: number;
}

const VERIFY_TIMEOUT_MS = 10_000;

/** Ask the configured remote who `token` belongs to. Never throws. */
export async function verifyTokenWithRemote(
  configManager: ConfigManager,
  token: string,
  options: VerifyTokenOptions = {},
): Promise<TokenVerification> {
  const remoteUrl = options.client?.getBaseUrl() ?? configManager.getRemoteUrl();
  if (!remoteUrl) return { status: "no_remote" };
  const client = options.client ?? new ApiClient(configManager, { baseUrl: remoteUrl, token });
  try {
    const response = await client.get<{ login?: unknown; username?: unknown }>("/api/auth/user", {
      timeout: options.timeoutMs ?? VERIFY_TIMEOUT_MS,
    });
    const body = response.data;
    if (!body || typeof body !== "object") {
      return { status: "unverified", remoteUrl, reason: "the remote did not return a ProPR API response" };
    }
    const login = typeof body.login === "string" ? body.login
      : typeof body.username === "string" ? body.username : undefined;
    return { status: "verified", remoteUrl, login };
  } catch (error) {
    const classification = classifyApiError(error);
    if (classification.status === 401) {
      return { status: "rejected", remoteUrl, message: classification.message };
    }
    if (classification.status === 403) {
      return { status: "forbidden", remoteUrl, message: classification.message };
    }
    return { status: "unverified", remoteUrl, reason: classification.message };
  }
}

/**
 * Print the outcome of a login whose token is already obtained. Returns the
 * exit code: 1 only when the remote rejected the token; `save` is then false.
 */
export async function reportLoginVerification(
  configManager: ConfigManager,
  token: string,
  options: VerifyTokenOptions & {
    /** The token is already stored (the gh CLI flow), so a rejection cannot keep it out. */
    alreadySaved?: boolean;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): Promise<{ exitCode: number; save: boolean; verification: TokenVerification }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const verification = await verifyTokenWithRemote(configManager, token, options);
  switch (verification.status) {
    case "verified":
      log(`${options.alreadySaved ? "" : "Authentication successful! "}Verified against ${verification.remoteUrl}${verification.login ? ` as ${verification.login}` : ""}.`);
      return { exitCode: 0, save: true, verification };
    case "rejected":
      error(`Error: ${verification.remoteUrl} rejected this token.${options.alreadySaved ? "" : " It was not saved."}`);
      return { exitCode: 1, save: false, verification };
    case "forbidden":
      log(`Token saved. ${verification.remoteUrl} accepted the token but denied access to this account: ${verification.message}`);
      return { exitCode: 0, save: true, verification };
    case "unverified":
      log(`Token saved, but it could not be verified against ${verification.remoteUrl}: ${verification.reason}`);
      return { exitCode: 0, save: true, verification };
    case "no_remote":
      log("Token saved. It was not verified because no remote is configured; set one with `propr remote`.");
      return { exitCode: 0, save: true, verification };
  }
}
