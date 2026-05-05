export interface MonitoredRepoConfig {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

export interface QueueIndexingDecision {
  success: boolean;
  error?: string;
  jobId?: string;
  correlationId?: string;
}

const REPOSITORY_NAME_REGEX = /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/;

export function getEnabledResummarizationTargets(monitoredRepos: MonitoredRepoConfig[]): Array<{ name: string; baseBranch?: string }> {
  return monitoredRepos
    .filter(repo => repo.enabled)
    .map(repo => ({ name: repo.name, baseBranch: repo.baseBranch }));
}

function validateRepositoryName(repository: unknown): string | null {
  if (!repository || typeof repository !== 'string') {
    return 'repository is required and must be a string (e.g., "owner/repo")';
  }
  if (!repository.match(REPOSITORY_NAME_REGEX)) {
    return 'Invalid repository format. Expected "owner/repo"';
  }

  return null;
}

export function validateIndexingInput(body: Record<string, unknown>): string | null {
  const { repository, baseBranch, fullReindex } = body;
  const repositoryError = validateRepositoryName(repository);
  if (repositoryError) {
    return repositoryError;
  }
  if (baseBranch !== undefined && typeof baseBranch !== 'string') {
    return 'baseBranch must be a string';
  }
  if (fullReindex !== undefined && typeof fullReindex !== 'boolean') {
    return 'fullReindex must be a boolean';
  }

  return null;
}

export function shouldPublishOptimisticIndexing(result: QueueIndexingDecision): boolean {
  return result.success;
}

export function validateStopIndexingInput(body: Record<string, unknown>): string | null {
  const { repository, branch } = body;
  const repositoryError = validateRepositoryName(repository);
  if (repositoryError) {
    return repositoryError;
  }
  if (branch !== undefined && typeof branch !== 'string') {
    return 'branch must be a string';
  }

  return null;
}
