import type { HistoryItem } from './types';

/** The `agent.runtime` event: recorded as a run starts, shown under the run it belongs to. */
export const isAgentRuntimeEvent = (item: HistoryItem): boolean => item.metadata?.event === 'agent.runtime' && !!item.metadata.agentRuntime;

/**
 * Runtime events carry no lifecycle of their own: fold them into the run step
 * before them so they neither become a step nor split that step's duration.
 */
export function foldAgentRuntimeEvent(previous: HistoryItem | undefined, item: HistoryItem): HistoryItem | null {
  if (!previous || !isAgentRuntimeEvent(item)) return null;
  return { ...previous, metadata: { ...previous.metadata, agentRuntime: item.metadata!.agentRuntime } };
}
