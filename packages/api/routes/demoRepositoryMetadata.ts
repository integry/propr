import { db } from '@propr/core';
import * as configManager from '@propr/core';
import { isValidRepoName } from './configRepoValidation.js';

type RepoConfig = Awaited<ReturnType<typeof configManager.loadMonitoredReposRaw>>[number];
type DemoRepositorySource = {
  repository: string;
  defaultBranch?: string | null;
  branch?: string | null;
};
type DemoRepositoryCache = {
  configuredRepos: RepoConfig[];
  databaseSources: DemoRepositorySource[];
  expiresAt: number;
};

export interface DemoRepositoryMetadata {
  repository: string;
  defaultBranch: string;
  branches: string[];
  isPrivate: boolean | null;
  description: string;
}

const DEMO_REPOSITORY_CACHE_TTL_MS = 30_000;
let demoRepositoryCache: DemoRepositoryCache | null = null;
let demoRepositoryCacheLoad: Promise<DemoRepositoryCache> | null = null;

function sortNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function normalizeBranchName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRepositoryName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repository = value.trim();
  return isValidRepoName(repository) ? repository : undefined;
}

function getDemoConfiguredRepoSources(repos: RepoConfig[]): DemoRepositorySource[] {
  return repos
    .filter(repo => repo.enabled === true)
    .map(repo => ({
      repository: repo.name,
      defaultBranch: normalizeBranchName(repo.defaultBranch),
      branch: normalizeBranchName(repo.baseBranch)
    }));
}

function addRepositorySource(sources: DemoRepositorySource[], source: DemoRepositorySource): void {
  const repository = normalizeRepositoryName(source.repository);
  if (!repository) return;
  sources.push({
    repository,
    defaultBranch: normalizeBranchName(source.defaultBranch),
    branch: normalizeBranchName(source.branch)
  });
}

async function loadRepositoryColumnSources(table: string): Promise<DemoRepositorySource[]> {
  if (!await db.schema.hasTable(table)) return [];
  const rows = await db(table).distinct('repository as repository') as Array<{ repository: string | null }>;
  return rows
    .map(row => normalizeRepositoryName(row.repository))
    .filter((repository): repository is string => Boolean(repository))
    .map(repository => ({ repository }));
}

async function loadIndexedRepositorySources(): Promise<DemoRepositorySource[]> {
  if (!await db.schema.hasTable('repositories')) return [];
  const rows = await db('repositories').select('full_name as repository', 'branch') as Array<{ repository: string | null; branch: string | null }>;
  return rows.flatMap(row => {
    const repository = normalizeRepositoryName(row.repository);
    if (!repository) return [];
    return [{ repository, branch: normalizeBranchName(row.branch) }];
  });
}

async function loadDemoDatabaseRepositorySources(): Promise<DemoRepositorySource[]> {
  const tableSources = await Promise.all([
    loadRepositoryColumnSources('task_drafts'),
    loadRepositoryColumnSources('tasks'),
    loadRepositoryColumnSources('plan_issues'),
    loadRepositoryColumnSources('repo_todo_categories'),
    loadRepositoryColumnSources('repo_todos'),
    loadRepositoryColumnSources('repo_chat_messages'),
    loadRepositoryColumnSources('llm_logs'),
  ]);
  return [
    ...await loadIndexedRepositorySources(),
    ...tableSources.flat()
  ];
}

async function loadDemoRepositoryCache(): Promise<DemoRepositoryCache> {
  const now = Date.now();
  if (demoRepositoryCache && demoRepositoryCache.expiresAt > now) return demoRepositoryCache;
  if (demoRepositoryCacheLoad) return demoRepositoryCacheLoad;
  demoRepositoryCacheLoad = Promise.all([
    configManager.loadMonitoredReposRaw(),
    loadDemoDatabaseRepositorySources()
  ]).then(([configuredRepos, databaseSources]) => {
    demoRepositoryCache = {
      configuredRepos,
      databaseSources,
      expiresAt: Date.now() + DEMO_REPOSITORY_CACHE_TTL_MS
    };
    return demoRepositoryCache;
  }).finally(() => {
    demoRepositoryCacheLoad = null;
  });
  return demoRepositoryCacheLoad;
}

export function clearDemoRepositoryMetadataCache(): void {
  demoRepositoryCache = null;
  demoRepositoryCacheLoad = null;
}

function buildDemoRepositorySources(configuredRepos: RepoConfig[], databaseSources: DemoRepositorySource[] = []): DemoRepositorySource[] {
  const sources: DemoRepositorySource[] = [];
  for (const source of getDemoConfiguredRepoSources(configuredRepos)) addRepositorySource(sources, source);
  for (const source of databaseSources) addRepositorySource(sources, source);
  return sources;
}

export function buildDemoRepositoryMetadata(repos: RepoConfig[], repoFullName: string, databaseSources: DemoRepositorySource[] = []): DemoRepositoryMetadata | null {
  const matchingRepos = buildDemoRepositorySources(repos, databaseSources).filter(repo => repo.repository === repoFullName);
  if (matchingRepos.length === 0) return null;

  const configuredBranches = matchingRepos.map(repo => normalizeBranchName(repo.branch)).filter((branch): branch is string => Boolean(branch));
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
  const { configuredRepos, databaseSources } = await loadDemoRepositoryCache();
  return buildDemoRepositoryMetadata(configuredRepos, repoFullName, databaseSources);
}

export async function loadDemoConfiguredRepoNames(): Promise<string[]> {
  const { configuredRepos, databaseSources } = await loadDemoRepositoryCache();
  const names = buildDemoRepositorySources(configuredRepos, databaseSources)
    .map(source => source.repository)
    .filter(Boolean);
  return sortNames(Array.from(new Set(names)));
}
