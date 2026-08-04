import { normalizeGitHubId } from './keys.js';

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
  requesterId: number;
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

/**
 * Fail-closed repository authorization for a split requester.
 *
 * GitHub's 404 response is a definitive negative collaborator result. A 403
 * can instead describe the App/token's own missing access, so every 403 is
 * rethrown and remains retryable rather than becoming a permanent refusal.
 */
export async function authorizeSplitRequester(
  octokit: PrSplitRequestClient,
  request: SplitAuthorizationRequest,
): Promise<SplitAuthorizationResult> {
  const requesterId = normalizeGitHubId(request.requesterId, 'requesterId');
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: request.owner, repo: request.repo, username: request.username },
    );
    const permission = isRecord(data) && typeof data.permission === 'string'
      ? data.permission
      : null;
    const responseUserId = isRecord(data) && isRecord(data.user) && typeof data.user.id === 'number'
      ? data.user.id
      : null;

    return responseUserId === requesterId && isSplitPermissionAuthorized(permission)
      ? { authorized: true, permission }
      : { authorized: false, permission };
  } catch (error) {
    const status = githubStatus(error);
    if (status === 404) {
      return { authorized: false, permission: null };
    }
    throw error;
  }
}
