import { useEffect, useState } from 'react';
import { getAgentTankUsage, type AgentTankUsageResponse } from '../../api/revertApi';
import { AgentRow } from '../../components/AgentTankSidebar';
import type { AgentConfig } from '../../api/proprApi';

export default function AgentQuotaUsage({ agent, id }: { agent: AgentConfig; id: string }) {
  const [data, setData] = useState<AgentTankUsageResponse>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void getAgentTankUsage({ signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load quota / usage. Try opening it again.');
    });
    return () => controller.abort();
  }, []);

  const usage = Object.values(data?.agents ?? {}).find(provider => provider.name.toLowerCase() === agent.type);
  return (
    <section id={id} aria-label={`${agent.alias} quota / usage`} className="mt-2 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-700">
      <h4 className="mb-2 font-medium">Quota / usage</h4>
      {!data && !error && <p role="status">Loading usage…</p>}
      {error && <p role="status">{error}</p>}
      {data && (data.enabled && usage && (usage.usage || usage.error)
        ? <AgentRow agent={usage} expanded={expanded} onToggle={() => setExpanded(current => !current)} />
        : <p>{data.error || (data.enabled ? 'No usage data available for this provider yet.' : 'Usage tracking is disabled. Enable LLM Usage Tracking in Settings → Integrations to view quota and reset times.')}</p>)}
    </section>
  );
}
