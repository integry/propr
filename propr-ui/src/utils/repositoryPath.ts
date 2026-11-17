/**
 * The Repositories page keeps its selection in the URL:
 * `/repositories/<owner>/<repo>`, with `?branch=<name>` only when more than one
 * entry tracks the same repository (`?branch=` for the entry without a pinned
 * branch). A reload, a shared link or Back restores the same entry.
 */
export const REPOSITORIES_PATH = '/repositories';

interface RepositoryEntry {
  name: string;
  baseBranch?: string | null;
}

/** The URL of one repository entry; `siblings` decides whether its branch must be named. */
export function repositoryPath(repo: RepositoryEntry, siblings: readonly RepositoryEntry[] = []): string {
  const path = `${REPOSITORIES_PATH}/${repo.name.split('/').map(encodeURIComponent).join('/')}`;
  const shared = siblings.filter(candidate => candidate.name === repo.name).length > 1;
  return shared ? `${path}?branch=${encodeURIComponent(repo.baseBranch || '')}` : path;
}

/**
 * The repository a Repositories URL names, as the selection state the page
 * matches entries with, or null for the list itself. `selectBranch` is left
 * out when the URL names no branch, so the first entry of that name matches.
 */
export function repositorySelectionFromUrl(
  splat: string | undefined,
  search: string,
): { selectRepo: string; selectBranch?: string | null } | null {
  const segments = (splat ?? '').split('/').filter(Boolean);
  if (segments.length === 0) return null;
  let selectRepo: string;
  try {
    selectRepo = segments.map(decodeURIComponent).join('/');
  } catch {
    selectRepo = segments.join('/');
  }
  const branch = new URLSearchParams(search).get('branch');
  if (branch === null) return { selectRepo };
  return { selectRepo, selectBranch: branch || null };
}
