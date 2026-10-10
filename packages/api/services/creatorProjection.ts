/**
 * Creator attribution for goals, plans, automations and to-dos.
 *
 * Each of those stores the GitHub numeric id of the user who created it. This
 * projects that id to the `AttributedUser` every surface renders, read from the
 * profile cache only: a list read never calls GitHub, and a whole page costs one
 * cache read. An id with no cached profile projects to `null`, so an unknown
 * creator is an absent chip rather than a failed response.
 *
 * The creator is a record, not an assignment: nothing here makes it writable.
 */

import { loadGitHubUserProfiles, rememberGitHubUserProfiles } from '@propr/core';
import type { AttributedUser } from '@propr/shared';

type CreatorId = string | number | null | undefined;

/** The authenticated user as it is on the request; fields beyond id and login are optional. */
export interface CreatorProfileSource {
  id?: string | number | null;
  login?: string | null;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/** Batch-reads the cached profiles of creator ids in one query. Never calls GitHub. */
export async function projectCreators(ownerIds: Iterable<CreatorId>): Promise<Map<string, AttributedUser>> {
  return loadGitHubUserProfiles(ownerIds);
}

/** The creator of one row from an already-loaded profile map, or null when it is not cached. */
export function creatorFrom(profiles: ReadonlyMap<string, AttributedUser>, ownerId: CreatorId): AttributedUser | null {
  if (ownerId === null || ownerId === undefined) return null;
  return profiles.get(String(ownerId).trim()) ?? null;
}

/** Resolves a single creator; for detail responses. */
export async function projectCreator(ownerId: CreatorId): Promise<AttributedUser | null> {
  return creatorFrom(await projectCreators([ownerId]), ownerId);
}

/**
 * Attaches the creator of every row under `as` (default `createdBy`), resolving
 * the whole list with one profile read.
 */
export async function attachCreator<T extends object, K extends string = 'createdBy'>(
  rows: readonly T[],
  ownerIdField: keyof T,
  as: K = 'createdBy' as K,
): Promise<Array<T & Record<K, AttributedUser | null>>> {
  const profiles = await projectCreators(rows.map(row => row[ownerIdField] as CreatorId));
  return rows.map(row => ({ ...row, [as]: creatorFrom(profiles, row[ownerIdField] as CreatorId) }) as T & Record<K, AttributedUser | null>);
}

/**
 * Records the authenticated user's profile, so what they create renders with an
 * avatar on the next read without a GitHub call. Fails soft, like the cache.
 */
export async function rememberCreator(user: CreatorProfileSource | null | undefined): Promise<void> {
  if (!user?.id) return;
  const login = user.login || user.username;
  if (!login) return;
  await rememberGitHubUserProfiles([{
    id: user.id,
    login,
    // A field the request user lacks leaves the cached value alone. Some sign-in
    // paths fill `displayName` with the login, which is not a profile name.
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.displayName && user.displayName !== login ? { displayName: user.displayName } : {}),
  }]);
}
