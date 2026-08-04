import assert from 'node:assert/strict';
import knex, { type Knex } from 'knex';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { up as createPrSplitTables } from '../../packages/core/src/db/migrations/20260804000000_create_pr_split_operations.js';
import type { PrSplitCommandRecord } from '../../packages/core/src/services/prSplit/commandStore.js';
import type {
  CreatePrSplitOperationInput,
  PrSplitOperation,
} from '../../packages/core/src/services/prSplit/operationStore.js';

export const BASE_SPLIT_INPUT: CreatePrSplitOperationInput = {
  repositoryId: 123456,
  repository: 'Integry/ProPR',
  sourcePrNumber: 1735,
  baseRef: '1735-epic-pr-split-rjb',
  baseSha: 'AAA111',
  headSha: 'BBB222',
  requesterId: 7654321,
  requester: 'maintainer',
  originalCommentId: 9001,
  instruction: 'extract auth changes',
};

export async function createSplitTestDatabase(filename = ':memory:'): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  await createPrSplitTables(database);
  return database;
}

export function requiredOperation(record: PrSplitCommandRecord): PrSplitOperation {
  assert.ok(record.operation, `receipt ${record.receipt.event_key} should reference an operation`);
  return record.operation;
}

export function issueCommentPayload(
  body: string,
  options: {
    commentId?: number;
    isPullRequest?: boolean;
    repository?: string;
  } = {},
): IssueCommentEvent {
  const repository = options.repository ?? 'integry/propr';
  const [owner, repo] = repository.split('/');
  return {
    action: 'created',
    issue: {
      number: 1735,
      ...(options.isPullRequest === false
        ? {}
        : { pull_request: { url: 'https://api.github.test/pulls/1735' } }),
    },
    comment: {
      id: options.commentId ?? 9001,
      body,
      user: { id: 7654321, login: 'maintainer' },
    },
    repository: {
      id: 123456,
      name: repo,
      full_name: repository,
      owner: { login: owner },
    },
  } as unknown as IssueCommentEvent;
}

export function openPullRequestData() {
  return {
    base: { ref: '1735-epic-pr-split-rjb', sha: 'aaa111' },
    head: { sha: 'bbb222' },
    state: 'open',
    merged: false,
  };
}
