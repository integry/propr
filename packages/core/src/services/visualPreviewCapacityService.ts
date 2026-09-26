import {
  detectGitHubAttachmentPlan,
  resolveGitHubAttachmentCapacity,
  type GitHubAttachmentCapacity,
  type GitHubAttachmentPlanOverride,
} from '@propr/shared';
import { resolveVisualPreviewUploadToken } from './visualPreviewOAuthCredentialService.js';

type CapacityDependencies = { resolveToken?: () => Promise<string>; fetch?: typeof fetch };

function repositoryOwner(repository: string | undefined): string | undefined {
  if (!repository) return undefined;
  const parts = repository.trim().split('/');
  return parts.length === 2 && parts[0] && parts[1] ? parts[0] : undefined;
}

/**
 * Best effort using the existing attachment uploader's credential. A user's
 * GET /user plan applies only to repositories owned by that same user. Other
 * users and organizations remain unresolved without requesting broader access.
 */
export async function loadGitHubAttachmentCapacity(
  override: GitHubAttachmentPlanOverride = 'auto',
  repositoryOrDependencies?: string | CapacityDependencies,
  injectedDependencies: CapacityDependencies = {},
): Promise<GitHubAttachmentCapacity> {
  if (override !== 'auto') return resolveGitHubAttachmentCapacity(override);
  const repository = typeof repositoryOrDependencies === 'string' ? repositoryOrDependencies : undefined;
  const dependencies = typeof repositoryOrDependencies === 'string' ? injectedDependencies : repositoryOrDependencies ?? {};
  const owner = repositoryOwner(repository);
  if (!owner) return resolveGitHubAttachmentCapacity(override);
  try {
    const token = await (dependencies.resolveToken ?? resolveVisualPreviewUploadToken)();
    const response = await (dependencies.fetch ?? fetch)('https://api.github.com/user', {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'ProPR' },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const user = await response.json() as { login?: unknown };
      if (typeof user.login === 'string' && user.login.toLowerCase() === owner.toLowerCase()) {
        return resolveGitHubAttachmentCapacity(override, detectGitHubAttachmentPlan(user));
      }
    }
  } catch {
    // Missing credentials, denied access, timeouts, malformed responses, and
    // network failures all leave detection unresolved. Do not affect auth state.
  }
  return resolveGitHubAttachmentCapacity(override);
}
