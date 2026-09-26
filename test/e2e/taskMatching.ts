import { sanitizeTaskIdComponent } from '@propr/shared';

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
  const taskIdMarker = `-${sanitizeTaskIdComponent(result.agent_alias, 'agent')}-${sanitizeTaskIdComponent(result.model_name, 'model')}-`;
  return tasks.find((task) =>
    task.issueNumber === result.issueNumber
    && !claimedTaskIds.has(task.id)
    && task.id.includes(taskIdMarker));
}
