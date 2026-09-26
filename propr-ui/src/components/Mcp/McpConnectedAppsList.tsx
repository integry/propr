import React from 'react';
import { Loader2, PlugZap } from 'lucide-react';
import { SystemAlert } from '../ui/SystemAlert';
import { McpConnectedAppRow } from './McpConnectedAppRow';
import type { McpConnectedApp } from './mcpAppPresentation';

interface McpConnectedAppsListProps {
  apps: readonly McpConnectedApp[];
  onRevoke: (id: string) => void;
  loading?: boolean;
  /** Grant id whose revoke request is in flight, if any. */
  revokingId?: string | null;
}

/** Card-free surface: full-bleed rows on bg-white separated by hairline dividers. */
export const McpConnectedAppsList: React.FC<McpConnectedAppsListProps> = ({ apps, onRevoke, loading = false, revokingId = null }) => {
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 bg-white px-4 py-6 text-sm text-slate-500 sm:px-6">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading connected apps…
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="bg-white py-12">
        <SystemAlert variant="empty" icon={<PlugZap className="h-5 w-5" aria-hidden="true" />}>No connected apps.</SystemAlert>
      </div>
    );
  }

  return (
    <ul aria-label="Connected apps" className="min-w-0 border-t border-slate-100 bg-white">
      {apps.map(app => (
        <McpConnectedAppRow key={app.id} app={app} onRevoke={onRevoke} revoking={revokingId === app.id} />
      ))}
    </ul>
  );
};
