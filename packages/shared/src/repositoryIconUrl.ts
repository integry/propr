const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

function encodeUrlSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Builds a raw GitHub asset URL only from a valid owner/repository identity and safe path. */
export function buildRepositoryIconUrl(
  repository: string,
  iconPath: string,
  revision = 'HEAD',
): string | null {
  const identityParts = repository.split('/');
  if (identityParts.length !== 2) return null;

  const [owner, repo] = identityParts;
  if (
    !owner || !repo
    || owner === '.' || owner === '..' || repo === '.' || repo === '..'
    || !REPOSITORY_PART_PATTERN.test(owner) || !REPOSITORY_PART_PATTERN.test(repo)
  ) return null;

  const normalizedRevision = revision.trim() || 'HEAD';
  if (normalizedRevision === '.' || normalizedRevision === '..') return null;
  const pathSegments = iconPath.split('/');
  if (
    pathSegments.length === 0
    || pathSegments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
  ) return null;

  return [
    'https://raw.githubusercontent.com',
    encodeUrlSegment(owner),
    encodeUrlSegment(repo),
    encodeUrlSegment(normalizedRevision),
    ...pathSegments.map(encodeUrlSegment),
  ].join('/');
}
