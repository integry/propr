import type { ContextRepositoryInput } from './types.js';
import { validateContextRepositories } from './validation.js';

interface DraftRepositoryConfiguration {
  repository: string;
  context_config?: unknown;
}

function parseContextConfig(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      throw new Error('Invalid saved context repository configuration');
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function resolveEffectiveContextRepositories(
  contextConfig: unknown,
  requestRepositories: ContextRepositoryInput[] | undefined,
): ContextRepositoryInput[] {
  const configured = requestRepositories === undefined
    ? parseContextConfig(contextConfig).contextRepositories
    : requestRepositories;
  const validation = validateContextRepositories(configured);
  if (!validation.valid) throw new Error(validation.error);
  return validation.repositories ?? [];
}

/**
 * Checks every repository with the user's grant before callers obtain an
 * installation token or start work that may clone repositories in the
 * background.
 */
export async function verifyPlannerRepositoryAccess(
  draft: DraftRepositoryConfiguration,
  requestRepositories: ContextRepositoryInput[] | undefined,
  accessToken: string,
  verifyAccess: (repository: string, accessToken: string) => Promise<void>,
): Promise<ContextRepositoryInput[]> {
  const contextRepositories = resolveEffectiveContextRepositories(
    draft.context_config,
    requestRepositories,
  );
  const repositories = [
    draft.repository,
    ...contextRepositories.map(contextRepository => contextRepository.repository),
  ];
  const distinctRepositories = Array.from(new Map(
    repositories.map(repository => [repository.toLowerCase(), repository]),
  ).values());

  for (const repository of distinctRepositories) {
    await verifyAccess(repository, accessToken);
  }
  return contextRepositories;
}
