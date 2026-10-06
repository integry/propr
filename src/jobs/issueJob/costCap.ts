/**
 * Per-run cost cap of an issue job (a replacement attempt receives the lineage's
 * remaining budget, see src/taskReplacement).
 */

import type { Agent, IssueJobData } from '@propr/core';

/**
 * Agent options that enforce the job's cost cap. A capped run never starts
 * unenforced: with no budget left, or on an agent that cannot stop at the cap, it is refused.
 */
export function costCapExecutionOptions(
  agent: Pick<Agent, 'config' | 'enforcesCostCap'>,
  issueRef: Pick<IssueJobData, 'costCapUsd'>,
): { costCapUsd?: number } {
  const cap = issueRef.costCapUsd;
  if (cap === undefined || cap === null) return {};
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(`Cost cap reached: no budget remains for this run (cap: ${String(cap)} USD)`);
  }
  if (agent.enforcesCostCap !== true) {
    throw new Error(`Agent ${agent.config.alias || agent.config.type} cannot enforce the ${cap} USD cost cap of this run`);
  }
  return { costCapUsd: cap };
}
