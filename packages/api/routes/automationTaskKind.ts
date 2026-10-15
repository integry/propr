/** Which phase of an automation run a task is: the report it writes, or the action taken on it. */
export type AutomationTaskKind = 'automation-report' | 'automation-action';

/**
 * Read from the ids the run executors assign (`agent-run-<runId>-report` and
 * `-action`), so tasks recorded before the kind existed are named too.
 */
export function automationTaskKind(taskId: string, taskType: unknown): AutomationTaskKind | undefined {
  if (taskType !== 'agent-run' || !taskId.startsWith('agent-run-')) return undefined;
  if (taskId.endsWith('-report')) return 'automation-report';
  if (taskId.endsWith('-action')) return 'automation-action';
  return undefined;
}
