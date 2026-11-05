import type { HistoryItem } from './types';

/** The `network.egress` timeline event written once a run's containers have exited. */
export const isNetworkEgress = (item: HistoryItem): boolean => item.metadata?.event === 'network.egress' && !!item.metadata.networkEgress;

export function networkEgressLabel(item: HistoryItem): string | null {
  if (!isNetworkEgress(item)) return null;
  const network = item.metadata!.networkEgress!;
  if (network.mode === 'open') return 'Open Network';
  // Labelled by the final outcome: once a container ran behind the proxy, earlier refusals are detail lines.
  const ranRestricted = (network.restrictedContainers ?? (network.refusals?.length ? 0 : 1)) > 0;
  if (!ranRestricted && network.refusals?.length) return 'Restricted Network: Agent Refused';
  if (!ranRestricted && !network.fallbacks?.length) return 'Restricted Network: No Agent Container Started';
  return network.deniedConnections > 0 ? 'Restricted Network: Connections Denied' : 'Restricted Network';
}

/** Denied or failed connections, or a container that fell back to open networking or was refused. */
export function networkEgressNeedsAttention(item: HistoryItem): boolean {
  const network = item.metadata?.networkEgress;
  return !!network && (network.deniedConnections > 0 || !!network.failedConnections || !!network.fallbacks?.length || !!network.refusals?.length || !!network.note);
}
