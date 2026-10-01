/**
 * Every list section loads the same way: a shared skeleton on its first read,
 * and a silent swap on every read after that. This guard reads the sources so
 * a section cannot quietly grow its own spinner or a "Refreshing…" line again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');

/** Files that draw a list section's first read, and the skeleton each must use. */
const SKELETON_USERS: Record<string, 'ListSkeleton' | 'SectionSkeleton'> = {
  'components/Dashboard/sectionPrimitives.tsx': 'ListSkeleton',
  'components/Dashboard/NeedsAttentionPanel.tsx': 'SectionSkeleton',
  'components/Dashboard/HappeningNowSection.tsx': 'SectionSkeleton',
  'components/Dashboard/CompletedFeed.tsx': 'SectionSkeleton',
  'components/Dashboard/HistoricalStatsPanel.tsx': 'SectionSkeleton',
  'pages/GoalsPage.tsx': 'ListSkeleton',
  'pages/PlansPage.tsx': 'ListSkeleton',
  'components/TaskPlanner/PlanIssuesManager.tsx': 'ListSkeleton',
  'components/TaskList/StateComponents.tsx': 'ListSkeleton',
  'pages/InboxPageComponents.tsx': 'ListSkeleton',
  'components/RepositoriesLoadingState.tsx': 'ListSkeleton',
  'pages/LlmLogsPageComponents.tsx': 'ListSkeleton',
  'pages/McpLogsPageComponents.tsx': 'ListSkeleton',
  'pages/AccessManagementPage.tsx': 'ListSkeleton',
};

/** Files that render a list on screen while a background read is in flight. */
const LIST_SECTIONS = [
  ...Object.keys(SKELETON_USERS),
  'components/TaskList.tsx',
  'pages/InboxPage.tsx',
  'pages/LlmLogsPage.tsx',
  'pages/McpLogsPage.tsx',
  'pages/RepositoriesPage.tsx',
  'components/RepositoryListContent.tsx',
];

/** Loading branches that are nothing but a loading state, so no spinner belongs in them. */
const LOADING_ONLY = [
  'components/TaskList/StateComponents.tsx',
  'components/RepositoriesLoadingState.tsx',
  'components/TaskPlanner/PlanIssuesManager.tsx',
];

describe('list loading states', () => {
  it.each(LIST_SECTIONS)('%s never announces a background refresh', path => {
    expect(source(path)).not.toMatch(/Refreshing(…|\.\.\.)/);
  });

  it.each(Object.entries(SKELETON_USERS))('%s draws its first read with the shared %s', (path, component) => {
    expect(source(path)).toMatch(new RegExp(`<${component}\\b`));
  });

  it.each(LOADING_ONLY)('%s draws no spinner', path => {
    expect(source(path)).not.toMatch(/animate-spin|\bLoader2\b|\bLoaderCircle\b/);
  });

  it('keeps list skeleton markup in one place', () => {
    expect(source('components/Dashboard/sectionPrimitives.tsx')).not.toMatch(/animate-pulse/);
    expect(source('components/ui/Skeleton.tsx')).toMatch(/role="status"/);
  });
});
