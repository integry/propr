import { z } from 'zod';
import { loadMonitoredReposRaw } from '@propr/core';
import {
  REPOSITORY_EVENT_ALL_TYPES,
  REPOSITORY_EVENT_DOMAINS,
  REPOSITORY_EVENT_LIST_DEFAULT_LIMIT,
  REPOSITORY_EVENT_LIST_MAX_LIMIT,
  REPOSITORY_EVENT_MAX_TYPE_FILTERS,
  REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS,
  REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS,
} from '@propr/shared';
import {
  RepositoryEventWaitError,
  listRepositoryEventsAfterCursor,
  waitForRepositoryEvents,
} from '../services/repositoryEventWait.js';
import { McpError } from './config.js';
import { assertGrantActive } from './toolsGoalWait.js';
import { type Args, type McpTool, type ToolDeps, repositorySchema, ok } from './tools.js';

/** Built on registration: `tools.ts` imports this module before its own schemas are initialized. */
const filterShape = () => ({
  repository: repositorySchema,
  afterCursor: z.string().min(1).max(512).optional().describe('Opaque cursor returned by an earlier call for this repository.'),
  fromStart: z.boolean().default(false).describe('Without afterCursor, start at the oldest retained event instead of the current end.'),
  domains: z.array(z.enum(REPOSITORY_EVENT_DOMAINS)).min(1).max(REPOSITORY_EVENT_DOMAINS.length).optional(),
  types: z.array(z.enum(REPOSITORY_EVENT_ALL_TYPES as [string, ...string[]])).min(1).max(REPOSITORY_EVENT_MAX_TYPE_FILTERS).optional(),
  pullRequest: z.number().int().positive().optional().describe('Only events of this pull request.'),
  planId: z.string().min(1).max(255).optional().describe('Only events of this plan.'),
  limit: z.number().int().min(1).max(REPOSITORY_EVENT_LIST_MAX_LIMIT).default(REPOSITORY_EVENT_LIST_DEFAULT_LIMIT),
});

/** The journal records the configured spelling of a repository; the grant check is case-insensitive. */
async function journalRepository(repository: string): Promise<string> {
  const configured = (await loadMonitoredReposRaw()).find(repo => repo.name.toLowerCase() === repository.toLowerCase());
  return configured?.name ?? repository;
}

function filters(args: Args) {
  return {
    afterCursor: args.afterCursor, fromStart: args.fromStart, domains: args.domains, types: args.types,
    pullRequest: args.pullRequest, planId: args.planId, limit: args.limit,
  };
}

function mcpError(error: unknown): unknown {
  if (error instanceof RepositoryEventWaitError) {
    return new McpError(error.code, error.message, error.status, { details: { recovery: error.recovery } });
  }
  return error;
}

const CURSOR_CONTRACT = 'Delivery is at-least-once and ordered: pass the cursor of the last event you processed as afterCursor to resume without missing one. Without afterCursor the read starts at the current end of the journal (current cursor, no history) unless fromStart is true. Cursor errors: CURSOR_INVALID, CURSOR_WRONG_REPOSITORY, CURSOR_EXPIRED (older than the retained journal; re-read state, then continue without a cursor).';

export function addRepositoryEventTools(tools: McpTool[], deps: ToolDeps): void {
  tools.push({
    name: 'list_repository_events',
    description: `List durable change events of one repository after a cursor: pull_request (opened, head_changed, review_scored, ultrafix_started, ultrafix_ended, auto_merge_decision, merged, closed), epic_queue (started, advanced, blocked, completed) and plan_issue (status_changed). Filter by domains, types, pullRequest and planId. Returns {events, cursor, truncated}; truncated means more matching events follow the cursor. ${CURSOR_CONTRACT}`,
    scope: 'read',
    readOnly: true,
    schema: z.object(filterShape()).strict(),
    run: async ({ args }) => {
      try {
        return ok(await listRepositoryEventsAfterCursor({ db: deps.db, repository: await journalRepository(args.repository), ...filters(args) }));
      } catch (error) { throw mcpError(error); }
    },
  });
  tools.push({
    name: 'wait_repository_events',
    description: `Wait, bounded, for a matching change event of one repository instead of polling several reads; the same filters as list_repository_events. Returns at once when matching events already exist after the cursor. timeoutSeconds defaults to ${REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS} (max ${REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS}). Returns {outcome: events|timeout, events, cursor, waitedMs, timeoutSeconds}; a timeout returns the cursor unchanged, so wait again with it. Events are hints to re-read: follow with get_pull_request_readiness or the read you need. Concurrent waits per owner are limited (WAIT_LIMIT); cancelling the call releases the wait (WAIT_ABORTED). ${CURSOR_CONTRACT}`,
    scope: 'read',
    readOnly: true,
    schema: z.object({
      ...filterShape(),
      timeoutSeconds: z.number().min(0).max(REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS).default(REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS),
    }).strict(),
    run: async ({ principal, args, signal }) => {
      try {
        return ok(await waitForRepositoryEvents({
          db: deps.db, ownerId: principal.user.id, repository: await journalRepository(args.repository), ...filters(args),
          timeoutSeconds: args.timeoutSeconds, signal,
          authorize: () => assertGrantActive(deps.policy, principal),
        }));
      } catch (error) { throw mcpError(error); }
    },
  });
}
