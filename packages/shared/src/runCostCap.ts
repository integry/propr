/**
 * Where a run's spend cap came from, highest precedence first: an explicit
 * per-task override, the repository's `.propr/workflow.yml`, then the instance
 * `default_max_cost_usd` setting.
 */
export type RunCostCapSource = 'override' | 'workflow' | 'instance_default';

export const RUN_COST_CAP_SOURCE_LABELS: Record<RunCostCapSource, string> = {
  override: 'per-task override',
  workflow: '.propr/workflow.yml',
  instance_default: 'instance default',
};

/** Upper bound for any configured cap, so an absurd value cannot overflow arithmetic or display. */
export const MAX_RUN_COST_CAP_USD = 100_000;

export function formatUsd(amount: number): string {
  return `$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
}

/** The task terminal reason recorded for an agent that stopped before finishing (`timeout`, `cost_cap`), if it has one. */
export function taskTerminalReasonForAgentTermination(reason: string | undefined): 'timed_out' | 'cost_cap_exceeded' | undefined {
  if (reason === 'timeout') return 'timed_out';
  if (reason === 'cost_cap') return 'cost_cap_exceeded';
  return undefined;
}
