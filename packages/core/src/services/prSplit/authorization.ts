export const SPLIT_AUTHORIZED_PERMISSIONS = ['write', 'maintain', 'admin'] as const;

export type SplitAuthorizedPermission = (typeof SPLIT_AUTHORIZED_PERMISSIONS)[number];

export interface PrSplitGitHubResponse {
  data: unknown;
  headers?: Record<string, string | number | undefined>;
}

/** The only GitHub client capability used by `/split` intake. */
export interface PrSplitRequestClient {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<PrSplitGitHubResponse>;
}

export interface SplitAuthorizationRequest {
  owner: string;
  repo: string;
  username: string;
}

export type SplitAuthorizationResult =
  | { authorized: true; permission: SplitAuthorizedPermission }
  | { authorized: false; permission: string | null };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** Map GitHub's collaborator permission levels to `/split` authorization. */
export function isSplitPermissionAuthorized(
  permission: string | null | undefined,
): permission is SplitAuthorizedPermission {
  return SPLIT_AUTHORIZED_PERMISSIONS.includes(permission as SplitAuthorizedPermission);
}

function githubStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function githubErrorMessage(error: unknown): string {
  if (!isRecord(error)) return '';
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = response && isRecord(response.data) ? response.data : undefined;
  const responseMessage = responseData?.message;
  if (typeof responseMessage === 'string') return responseMessage;
  return typeof error.message === 'string' ? error.message : '';
}

function githubErrorHeaders(error: unknown): UnknownRecord {
  if (!isRecord(error)) return {};
  const response = isRecord(error.response) ? error.response : undefined;
  const headers = response && isRecord(response.headers) ? response.headers : error.headers;
  return isRecord(headers) ? headers : {};
}

function headerValue(headers: UnknownRecord, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function isRateLimited403(error: unknown): boolean {
  const headers = githubErrorHeaders(error);
  const message = githubErrorMessage(error);
  return headerValue(headers, 'x-ratelimit-remaining') === '0'
    || headerValue(headers, 'retry-after') !== undefined
    || /(?:secondary |api )?rate limit|abuse detection|temporarily blocked/i.test(message);
}

function isPermission403(error: unknown): boolean {
  return /forbidden|resource not accessible|permission|must have .*access/i.test(
    githubErrorMessage(error),
  );
}

/**
 * Fail-closed repository authorization for a split requester.
 *
 * A definite collaborator/permission refusal returns unauthorized. Rate-limit,
 * abuse-protection, server, and ambiguous 403 responses are rethrown so GitHub
 * can retry the delivery instead of sending a false permission refusal.
 */
export async function authorizeSplitRequester(
  octokit: PrSplitRequestClient,
  request: SplitAuthorizationRequest,
): Promise<SplitAuthorizationResult> {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: request.owner, repo: request.repo, username: request.username },
    );
    const permission = isRecord(data) && typeof data.permission === 'string'
      ? data.permission
      : null;

    return isSplitPermissionAuthorized(permission)
      ? { authorized: true, permission }
      : { authorized: false, permission };
  } catch (error) {
    const status = githubStatus(error);
    if (status === 404 || (status === 403 && !isRateLimited403(error) && isPermission403(error))) {
      return { authorized: false, permission: null };
    }
    throw error;
  }
}
