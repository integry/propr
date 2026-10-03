import type { Knex } from 'knex';

/** Marks pull request references whose merge has already been observed, so read projections never report a merged PR as open. */
export async function markMergedPullRequests(
  db: Knex, repository: string, items: Record<string, unknown>[],
  fields = { number: 'pr_number', state: 'pr_state' },
): Promise<void> {
  const numbers = [...new Set(items.map(item => Number(item[fields.number]))
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  if (!numbers.length) return;
  const rows = await db('notification_pull_request_state').where({ repository })
    .whereIn('pr_number', numbers).whereNotNull('merged_at').select('pr_number');
  const merged = new Set(rows.map(row => Number(row.pr_number)));
  for (const item of items) if (merged.has(Number(item[fields.number]))) item[fields.state] = 'merged';
}

/** Cross-repository list results carry their own repository, so merge state is resolved per repository. */
export async function markMergedListPullRequests(db: Knex, items: Record<string, unknown>[]): Promise<void> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const repository = typeof item.repository === 'string' ? item.repository : null;
    if (!repository) continue;
    const group = groups.get(repository) ?? [];
    group.push(item);
    groups.set(repository, group);
  }
  for (const [repository, group] of groups) await markMergedPullRequests(db, repository, group);
}
