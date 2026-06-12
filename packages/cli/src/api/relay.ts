/**
 * GitHub token relay API (auth path 2).
 *
 * These call the vendor-run relay's enrollment endpoints (propr-routing's
 * /v1/relay-tokens routes), authenticated by the user's GitHub token (the same
 * token `propr login` stores). They are distinct from the ProPR backend API —
 * the relay is a separate service, and the daemon later uses the issued relay
 * token against /v1/installation-token.
 */

const FETCH_TIMEOUT_MS = 15_000;

export interface RelayClientOptions {
  /** Relay base URL, including the version prefix (e.g. https://relay.example/v1). */
  baseUrl: string;
  /** GitHub user token used to prove identity to the relay. */
  githubToken: string;
}

export interface EnrollRelayTokenResult {
  token: string;
  token_id: string;
  token_prefix: string;
  installation_id: number;
  label: string | null;
}

export interface RelayTokenSummary {
  token_id: string;
  token_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked: boolean;
}

function baseUrl(options: RelayClientOptions): string {
  return options.baseUrl.replace(/\/+$/, "");
}

interface RelayRequestInit {
  notFoundMessage?: string;
}

async function relayRequest<T>(
  options: RelayClientOptions,
  path: string,
  method: string,
  body?: unknown,
  init?: RelayRequestInit
): Promise<T> {
  let response: Response;
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.githubToken}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    response = await fetch(`${baseUrl(options)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Cannot reach the relay at ${options.baseUrl}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    let code = "";
    try {
      const parsed = (await response.json()) as { error?: { code?: string } };
      code = parsed?.error?.code ?? "";
    } catch {
      /* non-JSON error body */
    }
    if (response.status === 401) {
      throw new Error("The relay rejected your GitHub token. Run `propr login` to refresh it.");
    }
    if (response.status === 403) {
      throw new Error(
        "You are not authorized for this installation. Confirm the shared GitHub App is installed and you have access to it."
      );
    }
    if (response.status === 404 && init?.notFoundMessage) {
      throw new Error(init.notFoundMessage);
    }
    throw new Error(`Relay request failed (HTTP ${response.status}${code ? ` ${code}` : ""}).`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("The relay returned a malformed JSON response.");
  }
}

export function enrollRelayToken(
  options: RelayClientOptions,
  params: { installationId: string | number; label?: string | null }
): Promise<EnrollRelayTokenResult> {
  return relayRequest<EnrollRelayTokenResult>(options, "/relay-tokens", "POST", {
    installation_id: params.installationId,
    label: params.label ?? null,
  });
}

export function listRelayTokens(
  options: RelayClientOptions,
  installationId: string | number
): Promise<{ tokens: RelayTokenSummary[] }> {
  const query = encodeURIComponent(String(installationId));
  return relayRequest<{ tokens: RelayTokenSummary[] }>(
    options,
    `/relay-tokens?installation_id=${query}`,
    "GET"
  );
}

export function revokeRelayToken(
  options: RelayClientOptions,
  params: { installationId: string | number; tokenId: string }
): Promise<{ status: string; token_id: string }> {
  return relayRequest<{ status: string; token_id: string }>(
    options,
    "/relay-tokens/revoke",
    "POST",
    { installation_id: params.installationId, token_id: params.tokenId },
    { notFoundMessage: "Relay token not found (already revoked or wrong token id)." }
  );
}
