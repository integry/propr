export interface MonitoredRepoConfig {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

export interface QueueIndexingDecision {
  success: boolean;
  error?: string;
}

export function getEnabledResummarizationTargets(monitoredRepos: MonitoredRepoConfig[]): Array<{ name: string; baseBranch?: string }> {
  return monitoredRepos
    .filter(repo => repo.enabled)
    .map(repo => ({ name: repo.name, baseBranch: repo.baseBranch }));
}

export function shouldPublishOptimisticIndexing(result: QueueIndexingDecision): boolean {
  return result.success;
}

export function validateStopIndexingInput(body: Record<string, unknown>): string | null {
  const { repository, branch } = body;

  if (!repository || typeof repository !== 'string') {
    return 'Repository is required';
  }
  if (branch !== undefined && typeof branch !== 'string') {
    return 'branch must be a string';
  }

  return null;
}
