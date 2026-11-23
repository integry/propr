import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ApiClient } from "../packages/cli/src/api/client.js";
import type { ListTasksResponse, TaskSummary } from "../packages/cli/src/api/tasks.js";
import { TASK_LIST_MAX_LIMIT } from "../packages/cli/src/commands/taskCommands.js";
import {
  listRecentRepositoryTasks,
  TASK_DISCOVERY_MAX_PAGES,
  TASK_DISCOVERY_PAGE_SIZE,
  type ListTasksPage,
} from "./e2e/taskDiscovery.js";

const client = {} as ApiClient;

function tasks(count: number, start = 0): TaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({ id: `task-${start + i}`, issueNumber: start + i }) as TaskSummary);
}

/** Fake client over a newest-first task list that enforces the API maximum. */
function fakeList(all: TaskSummary[]) {
  const calls: Array<{ limit: number; offset: number }> = [];
  const list: ListTasksPage = async ({ repository, limit, offset }) => {
    assert.equal(repository, "owner/repo");
    if (limit > TASK_LIST_MAX_LIMIT) throw new Error("Limit cannot exceed 200");
    calls.push({ limit, offset });
    const page = all.slice(offset, offset + limit);
    return { tasks: page, total: all.length, offset, limit } as ListTasksResponse;
  };
  return { list, calls };
}

describe("E2E task discovery paging", () => {
  test("pages at the API maximum and stops on a short page", async () => {
    const { list, calls } = fakeList(tasks(TASK_LIST_MAX_LIMIT + 30));
    const found = await listRecentRepositoryTasks("owner/repo", client, () => false, list);
    assert.equal(TASK_DISCOVERY_PAGE_SIZE, TASK_LIST_MAX_LIMIT);
    assert.deepEqual(calls, [
      { limit: TASK_LIST_MAX_LIMIT, offset: 0 },
      { limit: TASK_LIST_MAX_LIMIT, offset: TASK_LIST_MAX_LIMIT },
    ]);
    assert.equal(found.length, TASK_LIST_MAX_LIMIT + 30);
    assert.equal(found.at(-1)?.id, `task-${TASK_LIST_MAX_LIMIT + 29}`);
  });

  test("stops once the wanted tasks are found", async () => {
    const { list, calls } = fakeList(tasks(TASK_LIST_MAX_LIMIT * 3));
    const found = await listRecentRepositoryTasks("owner/repo", client, (seen) => seen.some((t) => t.id === "task-5"), list);
    assert.equal(calls.length, 1);
    assert.equal(found.length, TASK_LIST_MAX_LIMIT);
  });

  test("caps the pages read per poll", async () => {
    const { list, calls } = fakeList(tasks(TASK_LIST_MAX_LIMIT * (TASK_DISCOVERY_MAX_PAGES + 2)));
    await listRecentRepositoryTasks("owner/repo", client, () => false, list);
    assert.equal(calls.length, TASK_DISCOVERY_MAX_PAGES);
  });
});
