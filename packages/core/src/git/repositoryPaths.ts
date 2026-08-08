import path from 'node:path';

const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_REPOSITORY_COMPONENT_LENGTH = 100;
const MAX_FILESYSTEM_SEGMENT_LENGTH = 255;

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
