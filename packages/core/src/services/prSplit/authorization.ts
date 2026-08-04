import type { PaginatedOctokitInstance } from '../../auth/githubAuth.js';

export const SPLIT_AUTHORIZED_PERMISSIONS = ['write', 'maintain', 'admin'] as const;

export type SplitAuthorizedPermission = (typeof SPLIT_AUTHORIZED_PERMISSIONS)[number];

export interface SplitAuthorizationRequest {
  owner: string;
  repo: string;
  username: string;
}

export type SplitAuthorizationResult =
  | { authorized: true; permission: SplitAuthorizedPermission }
  | { authorized: false; permission: string | null };

/** Map GitHub's collaborator permission levels to `/split` authorization. */
export function isSplitPermissionAuthorized(
  permission: string | null | undefined,
): permission is SplitAuthorizedPermission {
  return SPLIT_AUTHORIZED_PERMISSIONS.includes(permission as SplitAuthorizedPermission);
}

function githubStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

/**
 * Fail-closed repository authorization for a split requester.
 *
 * GitHub uses 404 for users that are not collaborators and may use 403 when
 * the installation cannot inspect collaboration. Both must result in no split
 * operation. Transient/server failures are rethrown so webhook delivery can be
 * retried instead of permanently refusing a potentially authorized user.
 */
export async function authorizeSplitRequester(
  octokit: Pick<PaginatedOctokitInstance, 'request'>,
  request: SplitAuthorizationRequest,
): Promise<SplitAuthorizationResult> {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: request.owner, repo: request.repo, username: request.username },
    );
    const permission = typeof data.permission === 'string' ? data.permission : null;

    return isSplitPermissionAuthorized(permission)
      ? { authorized: true, permission }
      : { authorized: false, permission };
  } catch (error) {
    const status = githubStatus(error);
    if (status === 403 || status === 404) {
      return { authorized: false, permission: null };
    }
    throw error;
  }
}
