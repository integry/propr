import * as configManager from '@propr/core';

type RepoConfig = Awaited<ReturnType<typeof configManager.loadMonitoredReposRaw>>[number];

export interface DemoRepositoryMetadata {
  repository: string;
  defaultBranch: string;
  branches: string[];
  isPrivate: boolean | null;
  description: string;
}

function sortNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function normalizeBranchName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseConfiguredDemoRepositories(): Set<string> {
  return new Set((process.env.PROPR_DEMO_REPOSITORIES || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean));
}

function isDemoVisibleRepo(repo: RepoConfig, allowlist = parseConfiguredDemoRepositories()): boolean {
  return repo.enabled === true && (repo.demoVisible === true || allowlist.has(repo.name));
}

function getDemoVisibleRepos(repos: RepoConfig[]): RepoConfig[] {
  const allowlist = parseConfiguredDemoRepositories();
  return repos.filter(repo => isDemoVisibleRepo(repo, allowlist));
}

export function buildDemoRepositoryMetadata(repos: RepoConfig[], repoFullName: string): DemoRepositoryMetadata | null {
  const matchingRepos = getDemoVisibleRepos(repos).filter(repo => repo.name === repoFullName);
  if (matchingRepos.length === 0) return null;

  const configuredBranches = matchingRepos.map(repo => normalizeBranchName(repo.baseBranch)).filter((branch): branch is string => Boolean(branch));
  const configuredDefault = matchingRepos.map(repo => normalizeBranchName(repo.defaultBranch)).find(Boolean);
  const defaultBranch = configuredDefault || configuredBranches[0] || 'main';
  const uniqueBranches = sortNames(Array.from(new Set([defaultBranch, ...configuredBranches])));
  const branches = [defaultBranch, ...uniqueBranches.filter(branch => branch !== defaultBranch)];

  return {
    repository: repoFullName,
    defaultBranch,
    branches,
    isPrivate: null,
    description: 'Repository metadata is unavailable in read-only demo mode.'
  };
}

export async function loadDemoRepositoryMetadata(repoFullName: string): Promise<DemoRepositoryMetadata | null> {
  return buildDemoRepositoryMetadata(await configManager.loadMonitoredReposRaw(), repoFullName);
}

export async function loadDemoConfiguredRepoNames(): Promise<string[]> {
  const repos = await configManager.loadMonitoredReposRaw();
  return sortNames(Array.from(new Set(getDemoVisibleRepos(repos).map(repo => repo.name).filter(Boolean))));
}
