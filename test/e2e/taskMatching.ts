export interface ModelTaskIdentity {
  agent_alias: string;
  model_name: string;
  issueNumber: number;
}

export interface ModelTaskSummary {
  id: string;
  issueNumber: number;
}

/** Find the exact alias/model task without reusing a task claimed by another matrix entry. */
export function findUnclaimedModelTask<T extends ModelTaskSummary>(
  tasks: T[],
  result: ModelTaskIdentity,
  claimedTaskIds: ReadonlySet<string>,
): T | undefined {
  const taskIdMarker = `-${result.agent_alias}-${result.model_name}-`;
  return tasks.find((task) =>
    task.issueNumber === result.issueNumber
    && !claimedTaskIds.has(task.id)
    && task.id.includes(taskIdMarker));
}
