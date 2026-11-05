import React from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { HistoryItem } from './types';

export const NetworkEgressIcon: React.FC<{ attention: boolean }> = ({ attention }) => (attention
  ? <ShieldAlert className="h-5 w-5 text-amber-500" aria-label="Network policy needs attention" />
  : <ShieldCheck className="h-5 w-5 text-teal-600" aria-label="Network policy" />);

const NETWORK_SOURCE_LABELS = { instance: 'instance setting', workflow: '.propr/workflow.yml', instance_enforced: 'enforced by instance' } as const;

/** Shown when a run's denied list is long; the rest stay counted in the summary line. */
const NETWORK_DENIED_HOSTS_SHOWN = 8;

/** The run's network mode and every host its egress proxy refused. */
export const NetworkEgressDetail: React.FC<{ metadata?: HistoryItem['metadata'] }> = ({ metadata }) => {
  const network = metadata?.event === 'network.egress' ? metadata.networkEgress : undefined;
  if (!network) return null;
  const source = network.source ? ` · ${NETWORK_SOURCE_LABELS[network.source]}` : '';
  const hidden = network.deniedHosts.slice(NETWORK_DENIED_HOSTS_SHOWN);
  const otherHosts = hidden.length + (network.omittedDeniedHosts ?? 0);
  const otherAttempts = hidden.reduce((total, entry) => total + entry.count, 0) + (network.omittedDeniedAttempts ?? 0);
  return (
    <div className="mt-1 break-words text-xs text-slate-500" data-testid="network-egress">
      <div>{`Network: ${network.mode}${source}`}</div>
      {network.note && <div className="text-amber-700">{network.note}</div>}
      {network.fallbacks?.map((fallback, index) => (
        <div key={`${fallback.agentType}-${index}`} className="text-amber-700">{`${fallback.agentType} ran with open network: ${fallback.reason}`}</div>
      ))}
      {network.refusals?.map((refusal, index) => (
        <div key={`refused-${refusal.agentType}-${index}`} className="text-red-700">{`${refusal.agentType} refused (restricted mode is enforced): ${refusal.reason}`}</div>
      ))}
      {network.deniedHosts.length > 0 && (
        <ul className="mt-0.5 list-none p-0" aria-label="Denied hosts">
          {network.deniedHosts.slice(0, NETWORK_DENIED_HOSTS_SHOWN).map(entry => (
            <li key={entry.host} className="font-mono text-[11px] text-red-700">{`${entry.host} × ${entry.count}`}</li>
          ))}
        </ul>
      )}
      {otherHosts > 0 && <div className="text-red-700">{`+${otherHosts} more ${otherHosts === 1 ? 'host' : 'hosts'} (${otherAttempts} ${otherAttempts === 1 ? 'attempt' : 'attempts'})`}</div>}
      {!!network.failedConnections && (
        <div className="text-amber-700">
          {`${network.failedConnections} allowed ${network.failedConnections === 1 ? 'connection' : 'connections'} failed upstream`}
          {network.failedHosts?.length ? `: ${network.failedHosts.slice(0, NETWORK_DENIED_HOSTS_SHOWN).map(entry => `${entry.host} × ${entry.count}`).join(', ')}` : ''}
        </div>
      )}
    </div>
  );
};
