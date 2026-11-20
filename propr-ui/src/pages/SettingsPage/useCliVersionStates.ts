import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgents, type AgentCliVersionState } from '../../api/proprApi';

export const CLI_VERSION_POLL_INTERVAL_MS = 10_000;

const needsPolling = (states: AgentCliVersionState[]): boolean =>
  states.some(state => state.status === 'preparing' || (state.status === 'failed' && !!state.nextRetryAt));

/**
 * Tracks which configured agent CLI versions are in effect. While the worker
 * is preparing a new image the states are re-read periodically, and an agent
 * whose pending version became ready is reported in `becameReady`.
 */
export function useCliVersionStates() {
  const [states, setStates] = useState<AgentCliVersionState[]>([]);
  const [becameReady, setBecameReady] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());

  const update = useCallback((next: AgentCliVersionState[] | undefined) => {
    const list = next ?? [];
    const previous = pendingRef.current;
    const pending = new Set(list.filter(state => state.status !== 'ready').map(state => state.agentId));
    pendingRef.current = pending;
    setBecameReady(current => {
      const result = new Set([...current].filter(id => !pending.has(id)));
      for (const state of list) if (state.status === 'ready' && previous.has(state.agentId)) result.add(state.agentId);
      return result;
    });
    setStates(list);
  }, []);

  const polling = needsPolling(states);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      getAgents().then(data => update(data.cliVersionStates)).catch(() => undefined);
    }, CLI_VERSION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, update]);

  const stateFor = useCallback(
    (agentId: string) => states.find(state => state.agentId === agentId),
    [states],
  );
  return { states, stateFor, becameReady, update };
}
