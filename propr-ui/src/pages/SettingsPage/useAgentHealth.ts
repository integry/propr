import { useEffect, useRef, useState } from 'react';
import type { AgentConfig } from '../../api/proprApi';
import { checkAgentHealth, type AgentHealthResult } from '../../api/agentHealthApi';

export type AgentHealthState = AgentHealthResult | { status: 'checking' };

export function useAgentHealth(agents: AgentConfig[], paused: boolean) {
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [results, setResults] = useState<Record<string, AgentHealthState>>({});
  const requests = useRef(new Map<string, Promise<AgentHealthResult>>());
  const configs = JSON.stringify(paused ? [] : agents.filter(agent => agent.enabled));
  const revisionKey = JSON.stringify(revisions);

  useEffect(() => {
    let disposed = false;
    const enabledAgents: AgentConfig[] = JSON.parse(configs);
    const currentRevisions: Record<string, number> = JSON.parse(revisionKey);
    const activeKeys = new Set<string>();
    for (const agent of enabledAgents) {
      const key = JSON.stringify([agent, currentRevisions[agent.id] ?? 0]);
      activeKeys.add(key);
      let request = requests.current.get(key);
      if (!request) {
        request = checkAgentHealth(agent.id, key, (currentRevisions[agent.id] ?? 0) > 0).catch((error: unknown): AgentHealthResult => ({
          agentId: agent.id,
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not check agent health.',
        }));
        requests.current.set(key, request);
      }
      void request.then(result => {
        if (!disposed) setResults(current => ({ ...current, [key]: result }));
      });
    }
    setResults(current => Object.fromEntries(Object.entries(current).filter(([key]) => activeKeys.has(key))));
    // Do not reuse checks after disabling, deleting, or editing an agent.
    for (const key of requests.current.keys()) {
      if (!activeKeys.has(key)) requests.current.delete(key);
    }
    return () => { disposed = true; };
  }, [configs, revisionKey]);

  return {
    health: (agent: AgentConfig): AgentHealthState | undefined => {
      if (paused || !agent.enabled) return undefined;
      return results[JSON.stringify([agent, revisions[agent.id] ?? 0])] ?? { status: 'checking' };
    },
    recheck: (agentId: string) => setRevisions(current => ({ ...current, [agentId]: (current[agentId] ?? 0) + 1 })),
  };
}
