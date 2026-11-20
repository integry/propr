import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgents, type AgentCliVersionState } from '../../api/proprApi';

export const CLI_VERSION_POLL_INTERVAL_MS = 10_000;

/** A failed preparation that retries on its own (backoff or circuit cooldown) can still become ready. */
const recoversAutomatically = (state: AgentCliVersionState): boolean =>
  state.status === 'failed' && (!!state.automaticRetry || !!state.nextRetryAt);

const needsPolling = (states: AgentCliVersionState[]): boolean =>
  states.some(state => state.status === 'preparing' || recoversAutomatically(state));

/**
 * Tracks which configured agent CLI versions are in effect. While the worker
 * is preparing a new image, or a failed preparation will be retried
 * automatically, the states are re-read periodically, and an agent
 * whose pending version became ready is reported in `becameReady`.
 *
 * `update` is authoritative (a load or save response): it supersedes every
 * poll already in flight, so a slower poll that captured an older
 * configuration cannot overwrite it. Likewise a poll's response is dropped
 * when a later poll's response has already been applied.
 */
export function useCliVersionStates() {
  const [states, setStates] = useState<AgentCliVersionState[]>([]);
  const [becameReady, setBecameReady] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  // Sequence of state sources: each poll takes the next number when it starts,
  // and each authoritative update takes one when it is applied. A response
  // numbered at or below the last applied one is stale.
  const sequenceRef = useRef(0);
  const appliedRef = useRef(0);

  const apply = useCallback((next: AgentCliVersionState[] | undefined) => {
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

  const update = useCallback((next: AgentCliVersionState[] | undefined) => {
    sequenceRef.current += 1;
    appliedRef.current = sequenceRef.current;
    apply(next);
  }, [apply]);

  const polling = needsPolling(states);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      getAgents().then(data => {
        if (sequence <= appliedRef.current) return;
        appliedRef.current = sequence;
        apply(data.cliVersionStates);
      }).catch(() => undefined);
    }, CLI_VERSION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, apply]);

  const stateFor = useCallback(
    (agentId: string) => states.find(state => state.agentId === agentId),
    [states],
  );
  return { states, stateFor, becameReady, update };
}
