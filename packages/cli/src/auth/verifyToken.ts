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

/** What a login outcome says, and whether the token may be stored. Printing is left to the caller. */
export interface LoginVerificationOutcome {
  exitCode: number;
  save: boolean;
  verification: TokenVerification;
  /** Lines for stdout. When `save` is true they describe a stored token, so print them only once it is stored. */
  logLines: string[];
  errorLines: string[];
}

/** Turn a verification into the login's exit code, save decision and report lines. Pure. */
export function describeLoginVerification(
  verification: TokenVerification,
  options: { successReportedSeparately?: boolean } = {},
): LoginVerificationOutcome {
  const outcome = (exitCode: number, save: boolean, logLines: string[], errorLines: string[] = []) =>
    ({ exitCode, save, verification, logLines, errorLines });
  switch (verification.status) {
    case "verified":
      return outcome(0, true, [`${options.successReportedSeparately ? "" : "Authentication successful! "}Verified against ${verification.remoteUrl}${verification.login ? ` as ${verification.login}` : ""}.`]);
    case "rejected":
      return outcome(1, false, [], [`Error: ${verification.remoteUrl} rejected this token. It was not saved.`]);
    case "forbidden":
      return outcome(0, true, [`Token saved. ${verification.remoteUrl} accepted the token but denied access to this account: ${verification.message}`]);
    case "unverified":
      return outcome(0, true, [`Token saved, but it could not be verified against ${verification.remoteUrl}: ${verification.reason}`]);
    case "no_remote":
      return outcome(0, true, ["Token saved. It was not verified because no remote is configured; set one with `propr remote`."]);
  }
}

/**
 * Verify `token` and print the outcome at once. Returns the exit code: 1 only
 * when the remote rejected the token; `save` is then false. The success lines
 * assume the token gets stored; `completeLogin` prints them only after it is.
 */
export async function reportLoginVerification(
  configManager: ConfigManager,
  token: string,
  options: VerifyTokenOptions & {
    /** The caller prints its own success line (the gh CLI flow), so omit the "Authentication successful!" prefix. */
    successReportedSeparately?: boolean;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): Promise<{ exitCode: number; save: boolean; verification: TokenVerification }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const outcome = describeLoginVerification(await verifyTokenWithRemote(configManager, token, options), options);
  outcome.errorLines.forEach(line => error(line));
  outcome.logLines.forEach(line => log(line));
  return { exitCode: outcome.exitCode, save: outcome.save, verification: outcome.verification };
}

/**
 * Verify an obtained, not yet stored token and persist it only when the
 * verification allows it. A rejected token never reaches the config, so a
 * previously stored token survives. Every success line ("Authentication
 * successful", "Token saved") prints only after the save resolved, so a
 * failed save surfaces as its error alone. Returns the process exit code.
 */
export async function completeLogin(
  configManager: ConfigManager,
  token: string,
  options: VerifyTokenOptions & {
    /** Summary from the gh CLI flow, printed once the token is stored. */
    successMessage?: string;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const outcome = describeLoginVerification(await verifyTokenWithRemote(configManager, token, options), {
    successReportedSeparately: options.successMessage !== undefined,
  });
  outcome.errorLines.forEach(line => error(line));
  if (!outcome.save) return outcome.exitCode;
  await configManager.setGithubToken(token);
  outcome.logLines.forEach(line => log(line));
  if (options.successMessage !== undefined) {
    log("");
    log(options.successMessage);
  }
  log(`Token saved to: ${configManager.getConfigFilePath()}`);
  return outcome.exitCode;
}
