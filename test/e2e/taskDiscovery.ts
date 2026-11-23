import type { ApiClient } from "../../packages/cli/src/api/client.js";
import { listTasks, type ListTasksResponse, type TaskSummary } from "../../packages/cli/src/api/tasks.js";
import { TASK_LIST_MAX_LIMIT } from "../../packages/cli/src/commands/taskCommands.js";

/** Page size for task discovery: the `GET /api/tasks` maximum, never more. */
export const TASK_DISCOVERY_PAGE_SIZE = TASK_LIST_MAX_LIMIT;
/** Pages read per poll; tasks the matrix just created sort first, so a poll stays cheap. */
export const TASK_DISCOVERY_MAX_PAGES = 5;

export type ListTasksPage = (options: { repository: string; limit: number; offset: number }, client: ApiClient) => Promise<ListTasksResponse>;

/**
 * Reads the repository's tasks newest first, one API-maximum page at a time,
 * until `isDone` is satisfied, a page comes back short, or the page cap is hit.
 * The E2E repository accumulates tasks across nightly runs, so one page is not enough.
 */
export async function listRecentRepositoryTasks(
  repository: string,
  client: ApiClient,
  isDone: (tasks: TaskSummary[]) => boolean,
  list: ListTasksPage = (options, apiClient) => listTasks(options, apiClient),
  maxPages = TASK_DISCOVERY_MAX_PAGES,
): Promise<TaskSummary[]> {
  const tasks: TaskSummary[] = [];
  for (let page = 0; page < maxPages; page++) {
    const result = await list({ repository, limit: TASK_DISCOVERY_PAGE_SIZE, offset: page * TASK_DISCOVERY_PAGE_SIZE }, client);
    tasks.push(...result.tasks);
    if (result.tasks.length < TASK_DISCOVERY_PAGE_SIZE || isDone(tasks)) break;
  }
  return tasks;
}
