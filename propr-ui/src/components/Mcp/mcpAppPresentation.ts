/** View model for one connected MCP app (an OAuth grant) as rendered by the UI. */
export interface McpConnectedApp {
  /** Grant id; the value passed to `onRevoke`. */
  id: string;
  /** Client display name, e.g. "Claude". Several grants may share one name. */
  name: string;
  scopes: readonly string[];
  repositories: readonly string[];
  /** ISO timestamp of when the grant was created. */
  connectedAt: string;
  /** ISO timestamp of the last call, `null` when never used, `undefined` when not tracked. */
  lastUsedAt?: string | null;
}

/** Number of repository chips shown before the row collapses the rest. */
export const REPOSITORY_PREVIEW_LIMIT = 10;

/** Canonical scope family order documented in docs/mcp.md. */
export const MCP_SCOPE_ORDER = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'] as const;

const scopeRank = new Map<string, number>(MCP_SCOPE_ORDER.map((scope, index) => [scope, index]));

/** De-duplicates scopes and orders them canonically; unknown scopes follow, alphabetically. */
export function orderScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort((a, b) => {
    const rankA = scopeRank.get(a) ?? MCP_SCOPE_ORDER.length;
    const rankB = scopeRank.get(b) ?? MCP_SCOPE_ORDER.length;
    return rankA - rankB || a.localeCompare(b);
  });
}

/** De-duplicates repository handles case-insensitively, keeping the first spelling and order. */
export function uniqueRepositories(repositories: readonly string[]): string[] {
  const seen = new Set<string>();
  return repositories.filter(repo => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Splits repositories into the chips to render and the number still collapsed. */
export function visibleRepositories(
  repositories: readonly string[],
  expanded: boolean,
  limit: number = REPOSITORY_PREVIEW_LIMIT,
): { visible: string[]; hiddenCount: number } {
  const unique = uniqueRepositories(repositories);
  if (expanded || unique.length <= limit) return { visible: unique, hiddenCount: 0 };
  return { visible: unique.slice(0, limit), hiddenCount: unique.length - limit };
}

export function repositoryOverflowLabel(hiddenCount: number): string {
  return `+ ${hiddenCount} more ${hiddenCount === 1 ? 'repository' : 'repositories'}`;
}

/** Accessible name that tells apart several grants for the same client. */
export function revokeAccessibleName(app: Pick<McpConnectedApp, 'id' | 'name'>): string {
  return `Revoke access for ${app.name} (ID: ${app.id})`;
}
