import path from 'node:path';

const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_REPOSITORY_COMPONENT_LENGTH = 100;
const MAX_FILESYSTEM_SEGMENT_LENGTH = 255;
const MAX_GENERATED_NAME_COMPONENT_LENGTH = 80;
const MAX_EXTERNAL_IDENTIFIER_LENGTH = 512;

function isAsciiLetterOrDigit(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isNameEdgeSeparator(value: string): boolean {
  return value === '-' || value === '_' || value === '.';
}

/**
 * Convert an external identifier (for example, an agent model ID) into a
 * single component that is safe in both Git refs and worktree paths.
 */
export function sanitizeGeneratedNameComponent(value: string, fallback = 'value'): string {
  const source = value.trim().slice(0, MAX_EXTERNAL_IDENTIFIER_LENGTH);
  let sanitized = '';
  let previousWasDot = false;

  for (const character of source) {
    if (isAsciiLetterOrDigit(character) || character === '_') {
      sanitized += character;
      previousWasDot = false;
    } else if (character === '.') {
      if (previousWasDot) {
        if (sanitized.endsWith('.')) sanitized = sanitized.slice(0, -1);
        if (sanitized && !sanitized.endsWith('-')) sanitized += '-';
      } else if (sanitized && !sanitized.endsWith('-')) {
        sanitized += character;
      }
      previousWasDot = true;
    } else {
      if (sanitized && !sanitized.endsWith('-')) sanitized += '-';
      previousWasDot = false;
    }

    if (sanitized.length >= MAX_GENERATED_NAME_COMPONENT_LENGTH) break;
  }

  while (sanitized && isNameEdgeSeparator(sanitized.at(-1)!)) {
    sanitized = sanitized.slice(0, -1);
  }

  return sanitized || fallback;
}

function assertRepositoryComponent(
  value: string,
  label: 'owner' | 'repository',
  pattern: RegExp,
): void {
  if (!value
      || value.length > MAX_REPOSITORY_COMPONENT_LENGTH
      || value === '.'
      || value === '..'
      || !pattern.test(value)) {
    throw new Error(`Invalid GitHub ${label} name`);
  }
}

export function assertGitHubRepositoryIdentity(owner: string, repoName: string): void {
  assertRepositoryComponent(owner, 'owner', OWNER_PATTERN);
  assertRepositoryComponent(repoName, 'repository', REPOSITORY_PATTERN);
}

export function assertGitHubRepositoryUrl(repoUrl: string, owner: string, repoName: string): void {
  assertGitHubRepositoryIdentity(owner, repoName);

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error('Invalid GitHub repository URL');
  }

  const expectedPath = `/${owner}/${repoName}.git`;
  if (parsed.protocol !== 'https:'
      || parsed.hostname !== 'github.com'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.pathname !== expectedPath
      || parsed.search
      || parsed.hash) {
    throw new Error('GitHub repository URL does not match the requested repository');
  }
}

function resolveWithinRoot(rootPath: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Resolved repository path escapes its configured root');
  }
  return resolvedPath;
}

export function resolveRepositoryClonePath(rootPath: string, owner: string, repoName: string): string {
  assertGitHubRepositoryIdentity(owner, repoName);
  return resolveWithinRoot(rootPath, owner, repoName);
}

export function assertRepositoryClonePath(
  candidatePath: string,
  rootPath: string,
  owner: string,
  repoName: string,
): void {
  const expectedPath = resolveRepositoryClonePath(rootPath, owner, repoName);
  if (path.resolve(candidatePath) !== expectedPath) {
    throw new Error('Repository path does not match the requested repository');
  }
}

export function resolveRepositoryWorktreePath(
  rootPath: string,
  owner: string,
  repoName: string,
  worktreeDirName: string,
): string {
  assertGitHubRepositoryIdentity(owner, repoName);
  if (!worktreeDirName
      || worktreeDirName.length > MAX_FILESYSTEM_SEGMENT_LENGTH
      || worktreeDirName === '.'
      || worktreeDirName === '..'
      || /[\\/\0\r\n]/.test(worktreeDirName)) {
    throw new Error('Invalid worktree directory name');
  }
  return resolveWithinRoot(rootPath, owner, repoName, worktreeDirName);
}
