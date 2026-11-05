import type { Request } from 'express';
import { isDemoViewer, isDemoViewerRead } from '../demoMode.js';
import { loadDemoConfiguredRepoNames } from '../routes/demoRepositoryMetadata.js';

export type DemoRepositoryLoader = () => Promise<string[]>;

/**
 * Goals are owner-scoped, and the synthetic demo identity owns none. In demo
 * mode it reads every goal of the demo's repositories instead; other requests,
 * including any demo write, keep the owner scope (null).
 */
export async function demoGoalRepositories(
  req: Request,
  loadRepositories: DemoRepositoryLoader = loadDemoConfiguredRepoNames,
): Promise<string[] | null> {
  if (!isDemoViewer(req.authorization) || !isDemoViewerRead(req.method)) return null;
  return loadRepositories();
}
