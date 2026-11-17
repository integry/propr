import type { Knex } from 'knex';

/**
 * Restricts `query` to one repository's stored rows in any capitalization.
 *
 * A repository filter resolves to the configured spelling (see
 * `repositoryScope.ts`), while stored rows keep the spelling they were written
 * with and the columns compare BINARY, so a plain equality would drop rows
 * recorded as `integry/propr` under a configured `Integry/ProPR`.
 */
export function whereRepositoryMatches<T extends Knex.QueryBuilder>(query: T, column: string, repository: string): T {
  return query.whereRaw('?? = ? COLLATE NOCASE', [column, repository]) as T;
}
